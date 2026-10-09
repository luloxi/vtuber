import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { NormalizedLandmark, Landmark } from '@mediapipe/tasks-vision';

type Side = 'left' | 'right';
const CHAIN = ['UpperArm', 'LowerArm', 'Hand'] as const;
const CHILD: Record<(typeof CHAIN)[number], string> = { UpperArm: 'LowerArm', LowerArm: 'Hand', Hand: 'MiddleProximal' };

// MediaPipe pose indices. The avatar is a mirror: the user's left arm drives the avatar's right arm.
const LM = {
  right: { shoulder: 11, elbow: 13, wrist: 15, pinky: 17, index: 19 }, // avatar right <- user's left
  left: { shoulder: 12, elbow: 14, wrist: 16, pinky: 18, index: 20 },  // avatar left  <- user's right
};

interface BoneInfo { node: THREE.Object3D; restDir: THREE.Vector3; restWorldQ: THREE.Quaternion; restLocal: THREE.Quaternion; cur: THREE.Quaternion; target: THREE.Quaternion }

const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
const va = new THREE.Vector3(), vb = new THREE.Vector3();

/** Drives upperArm / lowerArm / hand from MediaPipe pose world landmarks, with rest-pose fallback. */
export class ArmRig {
  private bones: Record<Side, (BoneInfo | null)[]> = { left: [], right: [] };
  private tracked: Record<Side, number> = { left: 0, right: 0 };
  private dirs: Record<Side, THREE.Vector3[]> = { left: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], right: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] };
  private hasDirs: Record<Side, boolean> = { left: false, right: false };
  lastSeen: Record<Side, number> = { left: 0, right: 0 };

  /** restLocal: relaxed pose quaternions (already in the bone's local space) keyed by bone name. */
  constructor(vrm: VRM, restLocal: Record<string, THREE.Quaternion>) {
    vrm.scene.updateMatrixWorld(true);
    for (const side of ['left', 'right'] as Side[]) {
      this.bones[side] = CHAIN.map((part) => {
        const name = `${side}${part}` as VRMHumanBoneName;
        const node = vrm.humanoid.getNormalizedBoneNode(name);
        const child = vrm.humanoid.getNormalizedBoneNode(`${side}${CHILD[part]}` as VRMHumanBoneName);
        if (!node || !child) return null;
        const a = node.getWorldPosition(new THREE.Vector3());
        const b = child.getWorldPosition(new THREE.Vector3());
        const rest = restLocal[name] ?? new THREE.Quaternion();
        return {
          node, restDir: b.sub(a).normalize(), restWorldQ: node.getWorldQuaternion(new THREE.Quaternion()),
          restLocal: rest.clone(), cur: rest.clone(), target: rest.clone(),
        };
      });
    }
  }

  get anyTracked() { return this.hasDirs.left || this.hasDirs.right; }

  /** Feed pose world landmarks (meters, hip centred, x right / y down in the raw camera image). */
  setPose(world: Landmark[] | undefined, image: NormalizedLandmark[] | undefined, now: number) {
    for (const side of ['left', 'right'] as Side[]) {
      const ids = LM[side];
      const ok = !!world && !!image && [ids.shoulder, ids.elbow, ids.wrist].every((i) => (image[i]?.visibility ?? 0) > 0.55)
        && [ids.elbow, ids.wrist].every((i) => image[i].y < 1.02 && image[i].y > -0.02 && image[i].x > -0.02 && image[i].x < 1.02);
      if (!ok) { this.hasDirs[side] = false; continue; }
      // Mirror into avatar world space (avatar faces +Z, x to the screen right, y up).
      const P = (i: number) => new THREE.Vector3(-world![i].x, -world![i].y, -world![i].z * 0.5);
      const sh = P(ids.shoulder), el = P(ids.elbow), wr = P(ids.wrist);
      const hand = P(ids.index).add(P(ids.pinky)).multiplyScalar(0.5);
      const sign = side === 'left' ? 1 : -1; // the avatar's left arm points to +X at rest
      const up = el.clone().sub(sh).normalize();
      // Joint limits: do not reach far across the chest or far behind the back.
      up.x = sign > 0 ? Math.max(up.x, -0.25) : Math.min(up.x, 0.25);
      up.z = Math.max(up.z, -0.35);
      up.normalize();
      const low = wr.clone().sub(el).normalize();
      low.z = Math.max(low.z, -0.5); low.normalize();
      // Elbows only bend so far (about 150 degrees).
      if (up.dot(low) < Math.cos((150 * Math.PI) / 180)) low.lerp(up, 0.4).normalize();
      const hd = hand.sub(wr).normalize();
      if (hd.dot(low) < Math.cos(Math.PI / 3)) hd.lerp(low, 0.6).normalize();
      this.dirs[side][0].copy(up); this.dirs[side][1].copy(low); this.dirs[side][2].copy(hd);
      this.hasDirs[side] = true;
      this.lastSeen[side] = now;
    }
  }

  clear() { this.hasDirs.left = this.hasDirs.right = false; }

  /** Call every frame after the torso bones are posed. */
  update(dt: number, now: number) {
    for (const side of ['left', 'right'] as Side[]) {
      const active = this.hasDirs[side] && now - this.lastSeen[side] < 500;
      this.tracked[side] += ((active ? 1 : 0) - this.tracked[side]) * (1 - Math.exp(-dt * 6));
      const rate = 1 - Math.exp(-dt * (active ? 14 : 5));
      this.bones[side].forEach((b, i) => {
        if (!b) return;
        if (active) {
          // desired world rotation = (rest dir -> tracked dir) applied on top of the rest world rotation
          qa.setFromUnitVectors(va.copy(b.restDir), vb.copy(this.dirs[side][i]));
          qa.multiply(b.restWorldQ);
          b.node.parent!.getWorldQuaternion(qb);
          b.target.copy(qb.invert().multiply(qa));
        } else {
          b.target.copy(b.restLocal);
        }
        b.cur.slerp(b.target, rate);
        b.node.quaternion.copy(b.cur);
        b.node.updateMatrixWorld(true);
      });
    }
  }

  /** Small idle sway on top of the rest pose. */
  get trackedAmount() { return Math.max(this.tracked.left, this.tracked.right); }
}
