import * as THREE from 'three';

class LowPass {
  y = 0;
  ready = false;
  filter(x: number, a: number) {
    if (!this.ready) { this.y = x; this.ready = true; } else this.y = a * x + (1 - a) * this.y;
    return this.y;
  }
}

/** One Euro filter (Casiez et al.): smooth when still, responsive when moving fast. */
export class OneEuro {
  private x = new LowPass();
  private dx = new LowPass();
  private t = -1;
  constructor(public minCutoff = 1.0, public beta = 0.0, public dCutoff = 1.0) {}
  private alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(v: number, t: number) {
    if (this.t < 0) { this.t = t; this.dx.filter(0, 1); return this.x.filter(v, 1); }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const dv = (v - this.x.y) / dt;
    const edx = this.dx.filter(dv, this.alpha(this.dCutoff, dt));
    return this.x.filter(v, this.alpha(this.minCutoff + this.beta * Math.abs(edx), dt));
  }
  get value() { return this.x.y; }
  reset() { this.x = new LowPass(); this.dx = new LowPass(); this.t = -1; }
}

/** One Euro filter for 3D points, with frame-to-frame jump rejection. */
export class PointFilter {
  private f: OneEuro[];
  readonly out = new THREE.Vector3();
  private last = new THREE.Vector3();
  private lastT = -1;
  private rejected = 0;
  ready = false;
  constructor(minCutoff: number, beta: number, private maxJumpPerSec = Infinity, private minJump = Infinity) {
    this.f = [0, 1, 2].map(() => new OneEuro(minCutoff, beta));
  }
  /** Returns false when the sample was rejected as a jump (the previous value is kept). */
  push(x: number, y: number, z: number, t: number): boolean {
    if (this.ready && this.lastT >= 0) {
      const dt = Math.max(t - this.lastT, 1e-3);
      const d = Math.hypot(x - this.last.x, y - this.last.y, z - this.last.z);
      if (d > this.minJump && d > this.maxJumpPerSec * dt && this.rejected < 3) { this.rejected++; return false; }
      if (this.rejected >= 3 && d > this.minJump) this.reset();
    }
    this.rejected = 0;
    this.last.set(x, y, z); this.lastT = t;
    this.out.set(this.f[0].filter(x, t), this.f[1].filter(y, t), this.f[2].filter(z, t));
    this.ready = true;
    return true;
  }
  reset() { this.f.forEach((f) => f.reset()); this.ready = false; this.lastT = -1; this.rejected = 0; }
}
