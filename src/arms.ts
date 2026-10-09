import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { NormalizedLandmark, Landmark } from '@mediapipe/tasks-vision';
import { BodyColliders, closestOnSegment, type Collider } from './colliders';
import { OneEuro, PointFilter } from './filters';

export type Side = 'left' | 'right';
export type ArmMode = 'rest' | 'track' | 'face' | 'clasp';
export interface HandObs { image: NormalizedLandmark[]; world: Landmark[]; label: string; score: number }
export interface FaceBox { minX: number; minY: number; maxX: number; maxY: number }

// The avatar mirrors the user: the user's RIGHT arm (pose 12/14/16) drives the avatar's LEFT arm.
const POSE = { left: { sh: 12, el: 14, wr: 16 }, right: { sh: 11, el: 13, wr: 15 } };
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;
const FINGER_LM = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const SEGS = ['Proximal', 'Intermediate', 'Distal'];
const ARM_R = 0.032, HAND_R = 0.038;
const PEN_TOL = 0.0015;

const tq = new THREE.Quaternion(), tq2 = new THREE.Quaternion();
const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), corr = new THREE.Vector3();
const tm = new THREE.Matrix4(), tm2 = new THREE.Matrix4();

/** Mirror a MediaPipe point (x right / y down / z away, raw camera) into avatar space (x screen right, y up, z toward camera). */
const mirror = (p: { x: number; y: number; z: number }, zScale = 1) => new THREE.Vector3(-p.x, -p.y, -p.z * zScale);

function boneName(side: Side, part: string) { return `${side}${part}` as VRMHumanBoneName; }

class Arm {
  side: Side;
  sign: number;
  upper: THREE.Object3D; lower: THREE.Object3D; hand: THREE.Object3D;
  L1: number; L2: number; handLen: number;
  restLocal: THREE.Quaternion[];
  restDir: THREE.Vector3[]; restWorldQ: THREE.Quaternion[];
  restHandBasis: THREE.Matrix4;
  fingers: { node: THREE.Object3D; finger: number; seg: number; rest: THREE.Quaternion }[] = [];
  fingerCur = new Float32Array(15);
  fingerTarget = new Float32Array(15);
  mode: ArmMode = 'rest';
  weight = 0;
  // observations
  handObs: HandObs | null = null;
  handSeen = 0; handLast = -1e9; handVisible = false;
  handWorld = Array.from({ length: 21 }, () => new PointFilter(1.5, 4));
  handWrist = new PointFilter(1.2, 3, 3.5, 0.18);   // image space (normalized)
  handCenter = new PointFilter(1.2, 3);
  handBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  faceTouch = false;
  trackTarget = new THREE.Vector3(); hasTrack = false;
  lastTrack = new THREE.Vector3(); lastTrackT = -1; jumpRejects = 0;
  target = new THREE.Vector3(); targetInit = false;
  hint = new THREE.Vector3();
  trackedHint: THREE.Vector3 | null = null;
  S = new THREE.Vector3(); E = new THREE.Vector3(); W = new THREE.Vector3(); H = new THREE.Vector3();
  handDir = new THREE.Vector3();
  handQ: THREE.Quaternion | null = null;
  maxPen = 0;
  penWith = '';

  constructor(vrm: VRM, side: Side, restLocal: Record<string, THREE.Quaternion>, isVRM0: boolean) {
    this.side = side; this.sign = side === 'left' ? 1 : -1;
    const n = (p: string) => vrm.humanoid.getNormalizedBoneNode(boneName(side, p));
    this.upper = n('UpperArm')!; this.lower = n('LowerArm')!; this.hand = n('Hand')!;
    const wp = (o: THREE.Object3D | null) => (o ? o.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3());
    const pU = wp(this.upper), pL = wp(this.lower), pH = wp(this.hand);
    const mid = n('MiddleProximal'), idx = n('IndexProximal'), lit = n('LittleProximal');
    const pM = mid ? wp(mid) : pH.clone().add(new THREE.Vector3(this.sign * 0.08, 0, 0));
    this.L1 = pU.distanceTo(pL); this.L2 = pL.distanceTo(pH); this.handLen = Math.max(pH.distanceTo(pM) * 2, 0.12);
    this.restDir = [pL.clone().sub(pU).normalize(), pH.clone().sub(pL).normalize(), pM.clone().sub(pH).normalize()];
    this.restWorldQ = [this.upper, this.lower, this.hand].map((o) => o.getWorldQuaternion(new THREE.Quaternion()));
    this.restLocal = ['UpperArm', 'LowerArm', 'Hand'].map((p) => (restLocal[boneName(side, p)] ?? new THREE.Quaternion()).clone());
    const sideV = idx && lit ? wp(idx).sub(wp(lit)) : new THREE.Vector3(0, 0, 1);
    this.restHandBasis = basis(this.restDir[2], sideV);
    FINGERS.forEach((f, fi) => {
      const segs = f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : SEGS;
      segs.forEach((s, si) => {
        const node = n(`${f}${s}`);
        if (node) this.fingers.push({ node, finger: fi, seg: si, rest: node.quaternion.clone() });
      });
    });
    this.isVRM0 = isVRM0;
    this.fingerCur.fill(0.15); this.fingerTarget.fill(0.15);
  }
  isVRM0: boolean;

  pose(i: number, q: THREE.Quaternion) { [this.upper, this.lower, this.hand][i].quaternion.copy(q); }

  /** Writes the finger curls (radians per joint) to the VRM finger bones. */
  applyFingers(dt: number) {
    const k = 1 - Math.exp(-dt * 14);
    for (let i = 0; i < 15; i++) this.fingerCur[i] += (this.fingerTarget[i] - this.fingerCur[i]) * k;
    for (const f of this.fingers) {
      const a = this.fingerCur[f.finger * 3 + f.seg];
      // VRM 1.0 space: left fingers point +X with the palm down, so curling is a -Z rotation (mirrored for the right).
      const e = f.finger === 0
        ? new THREE.Euler(0, this.sign * a * 0.7, -this.sign * a * 0.25)
        : new THREE.Euler(0, 0, -this.sign * a);
      if (this.isVRM0) { e.x = -e.x; e.z = -e.z; }
      f.node.quaternion.setFromEuler(e);
    }
  }
}

function basis(dir: THREE.Vector3, side: THREE.Vector3) {
  const x = dir.clone().normalize();
  const y = side.clone().addScaledVector(x, -side.dot(x)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Matrix4().makeBasis(x, y, z);
}

/**
 * Arm and hand driver. Fuses pose + hand landmarks, decides per arm whether to track, rest, clasp or touch the face
 * (with hysteresis), solves a two-bone IK and pushes elbows, forearms and hands out of the body colliders.
 */
export class ArmSystem {
  arms: Record<Side, Arm>;
  colliders: BodyColliders;
  handsAvailable = false;
  private pose = {
    world: Array.from({ length: 33 }, () => new PointFilter(1.0, 1.5, 4, 0.25)),
    image: Array.from({ length: 33 }, () => new PointFilter(1.0, 2.5)),
    vis: new Float32Array(33), t: -1e9,
  };
  private face: FaceBox | null = null; private faceT = -1e9;
  private clasp = false;
  aspect = 4 / 3;
  private userArm = new OneEuro(0.3, 0);
  stats = { maxPen: 0, clasp: false };

  constructor(private vrm: VRM, restLocal: Record<string, THREE.Quaternion>, isVRM0: boolean) {
    vrm.scene.updateMatrixWorld(true);
    this.arms = { left: new Arm(vrm, 'left', restLocal, isVRM0), right: new Arm(vrm, 'right', restLocal, isVRM0) };
    this.colliders = new BodyColliders(vrm);
  }

  get anyTracked() { return this.arms.left.mode !== 'rest' || this.arms.right.mode !== 'rest'; }

  // ---------- observations ----------
  setPose(world: Landmark[] | undefined, image: NormalizedLandmark[] | undefined, t: number) {
    if (!world || !image) { this.pose.vis.fill(0); return; }
    for (const i of [11, 12, 13, 14, 15, 16]) {
      const vis = image[i]?.visibility ?? 0;
      const inFrame = image[i].x > -0.02 && image[i].x < 1.02 && image[i].y > -0.02 && image[i].y < 1.02;
      this.pose.vis[i] = inFrame ? vis : 0;
      if (this.pose.vis[i] < 0.3) continue;
      if (!this.pose.world[i].push(world[i].x, world[i].y, world[i].z, t)) this.pose.vis[i] *= 0.5; // rejected jump
      this.pose.image[i].push(image[i].x, image[i].y, 0, t);
    }
    this.pose.t = t;
  }

  setFace(box: FaceBox | null, t: number) { if (box) { this.face = box; this.faceT = t; } }

  setHands(hands: HandObs[], t: number) {
    this.handsAvailable = true;
    const wristImg = (s: Side) => (this.pose.vis[POSE[s].wr] > 0.3 ? this.pose.image[POSE[s].wr].out : null);
    const assigned: Record<Side, HandObs | null> = { left: null, right: null };
    const pool = hands.filter((h) => h.score > 0.5);
    // 1) nearest pose wrist, 2) handedness label (MediaPipe assumes a mirrored image, so on our raw camera
    //    "Left" is the user's right hand, which drives the avatar's left arm), 3) side of the image.
    for (const h of [...pool].sort((a, b) => b.score - a.score)) {
      let best: Side | null = null, bestD = 0.15;
      for (const s of ['left', 'right'] as Side[]) {
        const w = wristImg(s);
        if (!w || assigned[s]) continue;
        const d = Math.hypot(h.image[0].x - w.x, h.image[0].y - w.y);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (!best) {
        const byLabel: Side = h.label === 'Left' ? 'left' : 'right';
        const bySide: Side = h.image[0].x < 0.5 ? 'left' : 'right';
        best = !assigned[byLabel] ? byLabel : !assigned[bySide] ? bySide : null;
      }
      if (best) assigned[best] = h;
    }
    for (const s of ['left', 'right'] as Side[]) {
      const arm = this.arms[s], h = assigned[s];
      if (h) {
        const ok = arm.handWrist.push(h.image[0].x, h.image[0].y, 0, t);
        if (!ok) continue;
        let cx = 0, cy = 0;
        const box = { minX: 1, minY: 1, maxX: 0, maxY: 0 };
        for (const p of h.image) { cx += p.x; cy += p.y; box.minX = Math.min(box.minX, p.x); box.minY = Math.min(box.minY, p.y); box.maxX = Math.max(box.maxX, p.x); box.maxY = Math.max(box.maxY, p.y); }
        arm.handCenter.push(cx / 21, cy / 21, 0, t);
        arm.handBox = box;
        h.world.forEach((p, i) => arm.handWorld[i].push(p.x, p.y, p.z, t));
        arm.handObs = h;
        arm.handSeen++; arm.handLast = t;
      } else {
        arm.handSeen = 0;
      }
      // hysteresis: two hits to appear, 0.3 s without a hit to disappear
      if (!arm.handVisible && arm.handSeen >= 2) arm.handVisible = true;
      if (arm.handVisible && t - arm.handLast > 0.3) { arm.handVisible = false; arm.handWrist.reset(); arm.handCenter.reset(); arm.handWorld.forEach((f) => f.reset()); }
    }
  }

  // ---------- per frame ----------
  update(dt: number, nowMs: number) {
    const t = nowMs / 1000;
    this.colliders.update();
    const poseFresh = t - this.pose.t < 0.5;
    const faceFresh = t - this.faceT < 0.5 ? this.face : null;
    const L = this.arms.left, R = this.arms.right;

    // Visibility: with the hand model we only trust an arm when its hand is really seen.
    for (const arm of [L, R]) {
      const p = POSE[arm.side];
      const poseConfident = poseFresh && this.pose.vis[p.sh] > 0.6 && this.pose.vis[p.el] > 0.75 && this.pose.vis[p.wr] > 0.85;
      const visible = this.handsAvailable ? arm.handVisible : poseConfident;
      arm.hasTrack = visible && this.computeTrackTarget(arm, t, faceFresh);
      // hand over the face (hysteresis on overlap ratio)
      if (arm.hasTrack && faceFresh && arm.handVisible) {
        const ov = overlap(arm.handBox, faceFresh);
        if (!arm.faceTouch && ov > 0.3) arm.faceTouch = true;
        else if (arm.faceTouch && ov < 0.12) arm.faceTouch = false;
      } else arm.faceTouch = false;
    }
    // hands together (both visible, wrists close relative to shoulder width)
    if (L.hasTrack && R.hasTrack && L.handVisible && R.handVisible) {
      const sw = this.shoulderWidthPx() || 0.25;
      const d = Math.hypot((L.handWrist.out.x - R.handWrist.out.x) * this.aspect, L.handWrist.out.y - R.handWrist.out.y) / sw;
      if (!this.clasp && d < 0.45) this.clasp = true;
      else if (this.clasp && d > 0.7) this.clasp = false;
    } else this.clasp = false;
    this.stats.clasp = this.clasp;

    for (const arm of [L, R]) {
      const prev = arm.mode;
      arm.mode = !arm.hasTrack ? 'rest' : arm.faceTouch ? 'face' : this.clasp ? 'clasp' : 'track';
      if (arm.mode === 'clasp' && (L.faceTouch || R.faceTouch)) arm.mode = arm.faceTouch ? 'face' : 'track';
      const goal = arm.mode === 'face' ? this.faceTarget(arm, faceFresh!) : arm.mode === 'clasp' ? this.claspTarget(arm) : arm.trackTarget;
      if (arm.mode !== 'rest') {
        if (!arm.targetInit || (prev === 'rest' && arm.weight < 0.05)) { arm.target.copy(goal); arm.targetInit = true; }
        else arm.target.lerp(goal, 1 - Math.exp(-dt * 12));
      }
      arm.weight += ((arm.mode === 'rest' ? 0 : 1) - arm.weight) * (1 - Math.exp(-dt * (arm.mode === 'rest' ? 5 : 8)));
      if (arm.weight < 0.01 && arm.mode === 'rest') arm.targetInit = false;
      // finger targets
      if (arm.mode === 'clasp') arm.fingerTarget.fill(0.85);
      else if (arm.mode !== 'rest' && arm.handVisible) this.fingerCurls(arm);
      else arm.fingerTarget.fill(0.15);
    }

    // Solve left, right (against the left), then left again (against the right).
    this.solve(L, R, dt); this.solve(R, L, dt); this.solve(L, R, dt);
    L.applyFingers(dt); R.applyFingers(dt);
    this.stats.maxPen = Math.max(this.measure(L, R), this.measure(R, L));
  }

  private shoulderWidthPx() {
    if (this.pose.vis[11] < 0.5 || this.pose.vis[12] < 0.5) return 0;
    const a = this.pose.image[11].out, b = this.pose.image[12].out;
    return Math.hypot((a.x - b.x) * this.aspect, a.y - b.y);
  }

  /** Target wrist position in avatar world space from fused pose + hand landmarks. */
  private computeTrackTarget(arm: Arm, t: number, face: FaceBox | null): boolean {
    const p = POSE[arm.side];
    const shOk = this.pose.vis[p.sh] > 0.5 && this.pose.vis[11] > 0.5 && this.pose.vis[12] > 0.5;
    let rel: THREE.Vector3 | null = null; // user wrist relative to user shoulder, avatar axes (metres)
    let mpp = 0; // metres per image unit (x scaled by aspect)
    const sw = this.shoulderWidthPx();
    if (shOk && sw > 0.02) mpp = this.pose.world[11].out.distanceTo(this.pose.world[12].out) / sw;
    else if (face) mpp = 0.15 / ((face.maxX - face.minX) * this.aspect || 0.1);
    const imgDelta = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      new THREE.Vector3(-(a.x - b.x) * this.aspect * mpp, -(a.y - b.y) * mpp, 0);

    if (shOk) {
      const sh = this.pose.world[p.sh].out;
      if (this.pose.vis[p.wr] > 0.5) {
        rel = mirror(tv.subVectors(this.pose.world[p.wr].out, sh), 0.6);
        if (arm.handVisible) rel.add(imgDelta(arm.handWrist.out, this.pose.image[p.wr].out)); // fuse: hand wrist is sharper in 2D
      } else if (arm.handVisible) {
        rel = imgDelta(arm.handWrist.out, this.pose.image[p.sh].out).setZ(0.15);
      }
      if (this.pose.vis[p.el] > 0.6) arm.trackedHint = mirror(tv2.subVectors(this.pose.world[p.el].out, sh), 0.6).normalize();
      else arm.trackedHint = null;
      if (this.pose.vis[p.el] > 0.6 && this.pose.vis[p.wr] > 0.6) {
        const len = this.pose.world[p.sh].out.distanceTo(this.pose.world[p.el].out) + this.pose.world[p.el].out.distanceTo(this.pose.world[p.wr].out);
        this.userArm.filter(THREE.MathUtils.clamp(len, 0.4, 0.75), t);
      }
    } else if (arm.handVisible && face) {
      // No shoulders: estimate them from the face box.
      const fw = face.maxX - face.minX, fh = face.maxY - face.minY;
      const shImg = { x: (face.minX + face.maxX) / 2 + (arm.side === 'left' ? -1 : 1) * fw * 1.3, y: face.maxY + fh * 0.6 };
      rel = imgDelta(arm.handWrist.out, shImg).setZ(0.15);
      arm.trackedHint = null;
    }
    if (!rel) return false;
    const userArm = this.userArm.value || 0.55;
    const scale = (arm.L1 + arm.L2) / userArm;
    arm.upper.getWorldPosition(arm.S);
    const goal = tv.copy(arm.S).addScaledVector(rel, scale);
    // reject sudden jumps of the fused target
    if (arm.lastTrackT > 0 && t - arm.lastTrackT < 0.15 && goal.distanceTo(arm.lastTrack) > 0.3 && arm.jumpRejects < 3) {
      arm.jumpRejects++;
      return arm.hasTrack;
    }
    arm.jumpRejects = 0;
    arm.lastTrack.copy(goal); arm.lastTrackT = t;
    arm.trackTarget.copy(goal);
    return true;
  }

  private faceTarget(arm: Arm, face: FaceBox) {
    const head = this.colliders.head;
    const fw = Math.max(face.maxX - face.minX, 1e-3), fh = Math.max(face.maxY - face.minY, 1e-3);
    const c = arm.handCenter.out;
    const ox = THREE.MathUtils.clamp(-((c.x - (face.minX + face.maxX) / 2) / fw) * head.r * 1.4, -head.r * 0.75, head.r * 0.75);
    const oy = THREE.MathUtils.clamp(-((c.y - (face.minY + face.maxY) / 2) / fh) * head.r * 1.4, -head.r * 0.9, head.r * 0.4);
    // offset in the head's facing frame: in front of the face, then lower to where the wrist sits
    const fwd = head.f.clone();
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(fwd, -fwd.y).normalize();
    const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
    return head.a.clone().addScaledVector(right, -ox).addScaledVector(up, oy - 0.085).addScaledVector(fwd, head.r + 0.03);
  }

  private claspTarget(arm: Arm) {
    const torso = this.colliders.torso;
    // pick the band closest to the average tracked wrist height, limited to belly..chest
    const L = this.arms.left.trackTarget, R = this.arms.right.trackTarget;
    const y = (L.y + R.y) / 2;
    const lo = Math.max(1, Math.floor(torso.length * 0.3)), hi = Math.max(lo, torso.length - 2);
    let best = torso[lo];
    for (let i = lo; i <= hi; i++) if (Math.abs((torso[i].a.y + torso[i].b.y) / 2 - y) < Math.abs((best.a.y + best.b.y) / 2 - y)) best = torso[i];
    const axis = tv2.subVectors(best.b, best.a);
    const axisN = axis.lengthSq() > 1e-8 ? axis.clone().normalize() : new THREE.Vector3(1, 0, 0);
    return best.a.clone().lerp(best.b, 0.5)
      .addScaledVector(best.f, best.r + HAND_R + 0.05)
      .addScaledVector(axisN, arm.sign * (HAND_R + 0.012));
  }

  private fingerCurls(arm: Arm) {
    const w = arm.handWorld.map((f) => f.out);
    if (!arm.handWorld[0].ready) return;
    FINGER_LM.forEach((ids, fi) => {
      for (let s = 0; s < 3; s++) {
        const a = s === 0 ? (fi === 0 ? w[0] : w[0]) : w[ids[s - 1]];
        const b = w[ids[s]], c = w[ids[s + 1]];
        const v1 = tv.subVectors(b, a), v2 = tv2.subVectors(c, b);
        let ang = v1.angleTo(v2);
        if (s === 0 && fi > 0) ang = Math.max(0, ang - 0.15); // knuckles are a little bent in a flat hand
        arm.fingerTarget[fi * 3 + s] = THREE.MathUtils.clamp(ang, 0, fi === 0 ? 1.0 : 1.6);
      }
    });
  }

  /** Two-bone IK + collision projection, then writes upper arm, forearm and hand rotations. */
  private solve(arm: Arm, other: Arm, dt: number) {
    // rest positions this frame (forward kinematics with the rest rotations)
    for (let i = 0; i < 3; i++) arm.pose(i, arm.restLocal[i]);
    arm.upper.updateMatrixWorld(true);
    arm.upper.getWorldPosition(arm.S);
    const Erest = arm.lower.getWorldPosition(new THREE.Vector3());
    const Wrest = arm.hand.getWorldPosition(new THREE.Vector3());
    const w = arm.weight;
    const goal = Wrest.clone().lerp(arm.target, arm.targetInit ? w : 0);
    // Hands always pass in FRONT of the body: a goal inside or behind the torso's silhouette is moved to its front.
    for (const c of this.colliders.list) {
      if (!c.torso) continue;
      const q = closestOnSegment(goal, c.a, c.b, new THREE.Vector3());
      const off = tv.subVectors(goal, q);
      const fwd = tv2.copy(c.f).normalize();
      const vf = off.dot(fwd);
      const perp = Math.sqrt(Math.max(0, off.lengthSq() - vf * vf));
      const R = c.r + HAND_R + 0.01;
      if (perp < R * 0.8 && vf < Math.sqrt(R * R - perp * perp)) goal.addScaledVector(fwd, Math.sqrt(R * R - perp * perp) - vf);
    }
    const restHint = Erest.clone().sub(arm.S).normalize();
    const defHint = new THREE.Vector3(arm.sign * 0.45, -1, -0.35).normalize();
    const trackHint = arm.mode === 'clasp' || arm.mode === 'face' || !arm.trackedHint ? defHint : arm.trackedHint;
    arm.hint.copy(restHint).lerp(trackHint, w).normalize();

    if (arm.handDir.lengthSq() < 0.5) arm.handDir.copy(arm.restDir[2]);
    const all: Collider[] = [...this.colliders.list, ...this.armColliders(other)];
    const setDir = (i: number, from: THREE.Vector3, to: THREE.Vector3) => {
      const node = [arm.upper, arm.lower, arm.hand][i];
      tq.setFromUnitVectors(arm.restDir[i], tv.subVectors(to, from).normalize()).multiply(arm.restWorldQ[i]);
      node.parent!.getWorldQuaternion(tq2);
      node.quaternion.copy(tq2.invert().multiply(tq));
      node.updateMatrixWorld(true);
    };
    const mid = this.vrm.humanoid.getNormalizedBoneNode(boneName(arm.side, 'MiddleProximal'));
    const updateHand = () => {
      arm.hand.updateMatrixWorld(true);
      if (mid) arm.handDir.copy(mid.getWorldPosition(tv)).sub(arm.hand.getWorldPosition(tv2)).normalize();
      arm.H.copy(arm.W).addScaledVector(arm.handDir, arm.handLen * 0.5);
    };
    const restQ = arm.restLocal[2];
    let pen = 0;
    // A few passes: the hand's final direction feeds back into the collision solve.
    for (let pass = 0; pass < 3; pass++) {
      // If the projection cannot fully clear the body (e.g. a hand jammed against the shoulder), fall back to the
      // closest goal on the line towards the rest pose that is collision free (bisection). Arms never pass through.
      if (this.chain(arm, goal, all) > PEN_TOL) {
        let lo = 0, hi = 1;
        const g = new THREE.Vector3();
        for (let k = 0; k < 6; k++) {
          const m = (lo + hi) / 2;
          if (this.chain(arm, g.copy(Wrest).lerp(goal, m), all) > PEN_TOL) hi = m; else lo = m;
        }
        this.chain(arm, g.copy(Wrest).lerp(goal, lo), all);
      }
      setDir(0, arm.S, arm.E);
      setDir(1, arm.E, arm.W);
      if (pass === 0) {
        // hand orientation: rest, or the tracked basis limited to 75 degrees from rest, blended by weight
        let handLocal = restQ.clone();
        if (arm.mode !== 'rest' && arm.handVisible && arm.handWorld[0].ready) {
          const hw = arm.handWorld.map((f) => f.out);
          const tDir = mirror(tv.subVectors(hw[9], hw[0]));
          const tSide = mirror(tv2.subVectors(hw[5], hw[17]));
          const Bt = basis(tDir, tSide);
          const rot = tm.multiplyMatrices(Bt, tm2.copy(arm.restHandBasis).transpose());
          const worldQ = new THREE.Quaternion().setFromRotationMatrix(rot).multiply(arm.restWorldQ[2]);
          arm.lower.getWorldQuaternion(tq2);
          const local = tq2.invert().multiply(worldQ);
          const ang = restQ.angleTo(local);
          const lim = (75 * Math.PI) / 180;
          handLocal = ang > lim ? restQ.clone().slerp(local, lim / ang) : local.clone();
        }
        arm.handQ = arm.handQ ? arm.handQ.slerp(handLocal, 1 - Math.exp(-dt * 12)) : handLocal.clone();
      }
      arm.hand.quaternion.copy(restQ).slerp(arm.handQ!, w);
      updateHand();
      pen = this.penetration(arm, all);
      if (pen <= PEN_TOL) break;
    }
    // last resort: relax the wrist rotation towards rest until the hand is clear
    for (let k = 1; pen > PEN_TOL && k <= 4; k++) {
      arm.hand.quaternion.copy(restQ).slerp(arm.handQ!, w * (1 - k / 4));
      updateHand();
      pen = this.penetration(arm, all);
    }
  }

  /** Two-bone IK towards goal plus collision projection. Returns the remaining penetration depth (m). */
  private chain(arm: Arm, goal: THREE.Vector3, all: Collider[]): number {
    // two-bone IK
    const S = arm.S, L1 = arm.L1, L2 = arm.L2;
    const toT = goal.clone().sub(S);
    const d = THREE.MathUtils.clamp(toT.length(), Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-4);
    const dir = toT.lengthSq() > 1e-9 ? toT.normalize() : new THREE.Vector3(0, -1, 0);
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    const n = arm.hint.clone().addScaledVector(dir, -arm.hint.dot(dir));
    if (n.lengthSq() < 1e-6) n.set(0, -1, 0).addScaledVector(dir, -dir.y);
    n.normalize();
    const E = arm.E.copy(S).addScaledVector(dir, a).addScaledVector(n, h);
    const W = arm.W.copy(S).addScaledVector(dir, d);

    // collision projection (position based, lengths re-enforced every iteration)
    const H = arm.H;
    for (let it = 0; it < 16; it++) {
      let moved = false;
      for (const c of all) {
        // elbow and the outer upper arm
        for (const tt of [0.7, 1]) {
          const p = tv.copy(S).lerp(E, tt);
          if (BodyColliders.push(c, p, ARM_R, corr) > 0) { E.addScaledVector(corr, 1 / tt); moved = true; }
        }
        // forearm samples
        for (const tt of [0, 0.35, 0.7, 1]) {
          const p = tv.copy(E).lerp(W, tt);
          if (BodyColliders.push(c, p, ARM_R, corr) > 0) { E.addScaledVector(corr, 1 - tt); W.addScaledVector(corr, tt); moved = true; }
        }
        // hand
        H.copy(W).addScaledVector(arm.handDir, arm.handLen * 0.5);
        if (BodyColliders.push(c, H, HAND_R, corr) > 0) { W.add(corr); moved = true; }
      }
      // lengths
      E.sub(S).setLength(L1).add(S);
      W.sub(E).setLength(L2).add(E);
      if (!moved) break;
    }

    H.copy(W).addScaledVector(arm.handDir, arm.handLen * 0.5);
    return this.penetration(arm, all);
  }

  private penetration(arm: Arm, all: Collider[]) {
    let worst = 0;
    for (const c of all) {
      for (const tt of [0.7, 1]) worst = Math.max(worst, BodyColliders.depth(c, tv.copy(arm.S).lerp(arm.E, tt), ARM_R));
      for (const tt of [0, 0.35, 0.7, 1]) worst = Math.max(worst, BodyColliders.depth(c, tv.copy(arm.E).lerp(arm.W, tt), ARM_R));
      worst = Math.max(worst, BodyColliders.depth(c, arm.H, HAND_R));
    }
    return worst;
  }

  private armColliders(other: Arm): Collider[] {
    const mk = (name: string, a: THREE.Vector3, b: THREE.Vector3, r: number): Collider =>
      ({ name, kind: 'capsule', bone: null, la: a, lb: b, lf: new THREE.Vector3(0, 0, 1), r, torso: false, a: a.clone(), b: b.clone(), f: new THREE.Vector3(0, 0, 1) });
    if (other.E.lengthSq() === 0) return [];
    return [mk('otherForearm', other.E, other.W, ARM_R), mk('otherHand', other.H, other.H, HAND_R)];
  }

  /** Deepest penetration (metres) of this arm's sample spheres into the body and the other arm. */
  private measure(arm: Arm, other: Arm) {
    const all = [...this.colliders.list, ...this.armColliders(other)];
    let worst = 0;
    const pts: [THREE.Vector3, number][] = [];
    for (const tt of [0.7, 1]) pts.push([arm.S.clone().lerp(arm.E, tt), ARM_R]);
    for (const tt of [0, 0.35, 0.7, 1]) pts.push([arm.E.clone().lerp(arm.W, tt), ARM_R]);
    pts.push([arm.H.clone(), HAND_R]);
    for (const c of all) for (const [p, r] of pts) {
      const dd = BodyColliders.depth(c, p, r);
      if (dd > worst) { worst = dd; arm.penWith = c.name; }
    }
    if (worst === 0) arm.penWith = '';
    arm.maxPen = worst;
    return worst;
  }

  debugInfo() {
    const a = (arm: Arm) => ({ mode: arm.mode, weight: +arm.weight.toFixed(2), handVisible: arm.handVisible, pen: +arm.maxPen.toFixed(4), penWith: arm.penWith,
      shoulder: arm.S.toArray().map((x) => +x.toFixed(3)), elbow: arm.E.toArray().map((x) => +x.toFixed(3)), wrist: arm.W.toArray().map((x) => +x.toFixed(3)), hand: arm.H.toArray().map((x) => +x.toFixed(3)) });
    return { left: a(this.arms.left), right: a(this.arms.right), clasp: this.clasp, maxPen: +this.stats.maxPen.toFixed(4),
      colliders: this.colliders.list.map((c) => ({ name: c.name, r: +c.r.toFixed(3), a: c.a.toArray().map((x) => +x.toFixed(3)), b: c.b.toArray().map((x) => +x.toFixed(3)) })) };
  }

  setDebug(on: boolean, scene: THREE.Object3D) { this.colliders.setDebug(on, scene); }
  dispose() { this.colliders.dispose(); }
}

function overlap(a: FaceBox, b: FaceBox) {
  const w = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const h = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  const area = Math.max((a.maxX - a.minX) * (a.maxY - a.minY), 1e-6);
  return (w * h) / area;
}
