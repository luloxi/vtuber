import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

export interface Collider {
  name: string;
  kind: 'sphere' | 'capsule';
  bone: THREE.Object3D | null;
  la: THREE.Vector3; lb: THREE.Vector3; lf: THREE.Vector3; // bone-local endpoints and forward direction
  r: number;
  torso: boolean;
  a: THREE.Vector3; b: THREE.Vector3; f: THREE.Vector3;   // world-space, updated every frame
}

const tA = new THREE.Vector3(), tB = new THREE.Vector3(), tQ = new THREE.Vector3(), tV = new THREE.Vector3();
const tM = new THREE.Matrix3();

export function closestOnSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3) {
  tA.subVectors(b, a);
  const len2 = tA.lengthSq();
  const t = len2 > 1e-9 ? THREE.MathUtils.clamp(tV.subVectors(p, a).dot(tA) / len2, 0, 1) : 0;
  return out.copy(a).addScaledVector(tA, t);
}

/** Body colliders (torso bands, neck, head) sized from the model's own mesh and bones. */
export class BodyColliders {
  list: Collider[] = [];
  debug = new THREE.Group();
  private debugMeshes: THREE.Mesh[] = [];

  constructor(vrm: VRM) {
    vrm.scene.updateMatrixWorld(true);
    const node = (n: string) => vrm.humanoid.getNormalizedBoneNode(n as VRMHumanBoneName);
    const pos = (n: string) => { const o = node(n); return o ? o.getWorldPosition(new THREE.Vector3()) : null; };
    const hips = pos('hips')!, head = pos('head') ?? hips.clone().add(new THREE.Vector3(0, 0.5, 0));
    const neck = pos('neck') ?? head.clone().add(new THREE.Vector3(0, -0.06, 0));
    const upperChest = pos('upperChest') ?? pos('chest') ?? hips.clone().lerp(neck, 0.7);
    const shoulderX = Math.abs((pos('leftUpperArm') ?? new THREE.Vector3(0.17, 0, 0)).x - hips.x);

    // Sample torso vertices (vertices whose main bone is hips, spine, chest or a bust bone).
    const pts: THREE.Vector3[] = [];
    const v = new THREE.Vector3();
    vrm.scene.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh || !m.visible || /^(Face|Hair)/i.test(o.name)) return;
      const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
      if (!si || !sw) return;
      const bones = m.skeleton.bones;
      const step = Math.max(1, Math.floor(m.geometry.attributes.position.count / 6000));
      for (let i = 0; i < m.geometry.attributes.position.count; i += step) {
        let best = 0, bi = 0;
        for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > best) { best = w; bi = si.getComponent(i, k); } }
        const name = bones[bi]?.name ?? '';
        if (!/(Hips|Spine|Chest|Bust)/i.test(name) || /Skirt|Leg|Arm|Shoulder/i.test(name)) continue;
        m.getVertexPosition(i, v); m.applyBoneTransform(i, v); v.applyMatrix4(m.matrixWorld);
        if (Math.abs(v.x - hips.x) < shoulderX * 1.05) pts.push(v.clone());
      }
    });

    const torsoBones = (['hips', 'spine', 'chest', 'upperChest'] as const)
      .map((n) => ({ n, o: node(n), y: pos(n)?.y ?? -Infinity })).filter((b) => b.o);
    const top = upperChest.y + (neck.y - upperChest.y) * 0.4;
    const bottom = hips.y - 0.02;
    const bands = 6;
    const h = (top - bottom) / bands;
    for (let i = 0; i < bands; i++) {
      const yc = bottom + h * (i + 0.5);
      const band = pts.filter((p) => Math.abs(p.y - yc) < h * 0.75);
      let xmax: number, zf: number, zb: number;
      if (band.length > 20) {
        const xs = band.map((p) => Math.abs(p.x - hips.x)).sort((a, b) => a - b);
        const zs = band.map((p) => p.z).sort((a, b) => a - b);
        xmax = xs[Math.floor(xs.length * 0.97)]; zf = zs[Math.floor(zs.length * 0.97)]; zb = zs[Math.floor(zs.length * 0.03)];
      } else { xmax = shoulderX * 0.75; zf = hips.z + 0.1; zb = hips.z - 0.1; }
      const r = THREE.MathUtils.clamp(Math.min((zf - zb) / 2, xmax), 0.05, 0.16);
      const cz = (zf + zb) / 2;
      const half = Math.max(0, xmax - r);
      const bone = [...torsoBones].reverse().find((b) => b.y <= yc + 0.02) ?? torsoBones[0];
      this.add(`torso${i}`, 'capsule', bone.o!, new THREE.Vector3(hips.x - half, yc, cz), new THREE.Vector3(hips.x + half, yc, cz), r, true);
    }
    this.add('neck', 'capsule', node('neck') ?? node('head'), neck, head, 0.045, false);

    // Head sphere from the face mesh box.
    const box = new THREE.Box3();
    vrm.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && /^Face/i.test(o.name)) box.expandByObject(o, true); });
    const c = box.isEmpty() ? head.clone().add(new THREE.Vector3(0, 0.09, 0)) : box.getCenter(new THREE.Vector3());
    const size = box.isEmpty() ? new THREE.Vector3(0.17, 0.22, 0.19) : box.getSize(new THREE.Vector3());
    this.add('head', 'sphere', node('head'), c, c, Math.max(size.x, size.z) * 0.55, false);
    this.update();
  }

  private add(name: string, kind: Collider['kind'], bone: THREE.Object3D | null, a: THREE.Vector3, b: THREE.Vector3, r: number, torso: boolean) {
    const inv = bone ? bone.matrixWorld.clone().invert() : new THREE.Matrix4();
    const f = new THREE.Vector3(0, 0, 1).applyMatrix3(tM.setFromMatrix4(inv)).normalize();
    this.list.push({ name, kind, bone, la: a.clone().applyMatrix4(inv), lb: b.clone().applyMatrix4(inv), lf: f, r, torso, a: a.clone(), b: b.clone(), f: new THREE.Vector3(0, 0, 1) });
  }

  get head() { return this.list.find((c) => c.name === 'head')!; }
  get torso() { return this.list.filter((c) => c.torso); }

  update() {
    for (const c of this.list) {
      if (!c.bone) continue;
      c.a.copy(c.la).applyMatrix4(c.bone.matrixWorld);
      c.b.copy(c.lb).applyMatrix4(c.bone.matrixWorld);
      c.f.copy(c.lf).applyMatrix3(tM.setFromMatrix4(c.bone.matrixWorld)).normalize();
    }
    if (this.debug.visible && this.debug.children.length) this.updateDebug();
  }

  /** Correction that moves a sphere (p, r) out of one collider. Torso pushes go to the front. */
  static push(c: Collider, p: THREE.Vector3, r: number, out: THREE.Vector3): number {
    closestOnSegment(p, c.a, c.b, tQ);
    tV.subVectors(p, tQ);
    const d = tV.length();
    const R = c.r + r;
    if (d >= R) { out.set(0, 0, 0); return 0; }
    if (c.kind === 'capsule' && c.torso) {
      // Resolve along the body's forward axis (to the front surface) unless the point is clearly at the side,
      // above or below. Moving along fwd keeps the closest point on the (horizontal) axis fixed, so this is exact.
      const axis = tA.subVectors(c.b, c.a);
      if (axis.lengthSq() > 1e-10) axis.normalize(); else axis.set(1, 0, 0);
      const fwd = tB.copy(c.f).addScaledVector(axis, -c.f.dot(axis)).normalize();
      const vf = tV.dot(fwd);
      const perp2 = d * d - vf * vf;
      if (perp2 < 0.6 * R * R) {
        out.copy(fwd).multiplyScalar(Math.sqrt(R * R - perp2) - vf);
        return R - d;
      }
    }
    if (d < 1e-6) out.copy(c.f).multiplyScalar(R);
    else out.copy(tV).multiplyScalar((R - d) / d);
    return R - d;
  }

  static depth(c: Collider, p: THREE.Vector3, r: number) {
    closestOnSegment(p, c.a, c.b, tQ);
    return Math.max(0, c.r + r - p.distanceTo(tQ));
  }

  // ---------- debug view (press D) ----------
  setDebug(on: boolean, scene: THREE.Object3D) {
    this.debug.visible = on;
    if (on && !this.debug.parent) scene.add(this.debug);
    if (on && !this.debug.children.length) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x46e0ff, wireframe: true, transparent: true, opacity: 0.45, depthTest: false });
      for (const c of this.list) {
        const len = c.la.distanceTo(c.lb);
        const geo = c.kind === 'sphere' || len < 1e-4 ? new THREE.SphereGeometry(c.r, 14, 10) : new THREE.CapsuleGeometry(c.r, len, 6, 14);
        const m = new THREE.Mesh(geo, mat);
        m.renderOrder = 10;
        this.debug.add(m); this.debugMeshes.push(m);
      }
    }
    if (on) this.updateDebug();
  }

  private updateDebug() {
    this.list.forEach((c, i) => {
      const m = this.debugMeshes[i];
      if (!m) return;
      m.position.addVectors(c.a, c.b).multiplyScalar(0.5);
      const dir = tA.subVectors(c.b, c.a);
      if (dir.lengthSq() > 1e-8) m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    });
  }

  dispose() { this.debug.removeFromParent(); this.debug.traverse((o) => (o as THREE.Mesh).geometry?.dispose()); }
}
