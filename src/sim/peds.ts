import { MAX_PEDS, PED_FLAG_UMBRELLA, PED_STRIDE } from '../shared/constants';
import type { Terrain } from './terrain';

export const PED_FLAG_BIKE = 256;

/** Walkers and cyclists following waypoint polylines along sidewalks. */
export class Peds {
  readonly max = MAX_PEDS;
  active = new Uint8Array(MAX_PEDS);
  gen = new Uint16Array(MAX_PEDS);
  citizen = new Int32Array(MAX_PEDS);
  flags = new Uint16Array(MAX_PEDS);
  speed = new Float32Array(MAX_PEDS);
  pts: (Float32Array | null)[] = new Array(MAX_PEDS).fill(null);
  seg = new Int32Array(MAX_PEDS);
  u = new Float32Array(MAX_PEDS);
  pause = new Float32Array(MAX_PEDS);
  x = new Float32Array(MAX_PEDS); z = new Float32Array(MAX_PEDS); h = new Float32Array(MAX_PEDS);
  color = new Float32Array(MAX_PEDS);
  kind = new Uint8Array(MAX_PEDS); // 0 citizen, 1 tourist, 2 worker, 3 funeral, 4 waiting
  private free: number[] = [];
  count = 0;
  onArrive: (slot: number) => void = () => {};
  rain = 0;

  constructor(private T: Terrain) { for (let i = MAX_PEDS - 1; i >= 0; i--) this.free.push(i); }
  get capacityLeft() { return this.free.length; }

  spawn(pts: number[], citizen: number, speed: number, flags: number, color: number, kind = 0): number {
    if (!this.free.length || pts.length < 4) return -1;
    const i = this.free.pop()!;
    this.active[i] = 1;
    this.gen[i] = (this.gen[i] + 1) & 0xffff;
    this.citizen[i] = citizen;
    this.flags[i] = flags;
    this.speed[i] = speed;
    this.pts[i] = new Float32Array(pts);
    this.seg[i] = 0; this.u[i] = 0; this.pause[i] = 0;
    this.x[i] = pts[0]; this.z[i] = pts[1]; this.h[i] = 0;
    this.color[i] = color;
    this.kind[i] = kind;
    this.count++;
    return i;
  }
  despawn(i: number) {
    if (!this.active[i]) return;
    this.active[i] = 0;
    this.pts[i] = null;
    this.free.push(i);
    this.count--;
  }

  remainingTime(i: number): number {
    const p = this.pts[i];
    if (!p) return 0;
    let d = 0;
    for (let k = this.seg[i]; k < p.length / 2 - 1; k++) d += Math.hypot(p[k * 2 + 2] - p[k * 2], p[k * 2 + 3] - p[k * 2 + 1]);
    return d / this.speed[i];
  }

  step(dt: number) {
    for (let i = 0; i < this.max; i++) {
      if (!this.active[i]) continue;
      if (this.pause[i] > 0) { this.pause[i] -= dt; continue; }
      const p = this.pts[i]!;
      let k = this.seg[i];
      let move = this.speed[i] * dt * (this.flags[i] & PED_FLAG_BIKE ? 1 : 1 - this.rain * 0.15);
      const n = p.length / 2;
      while (move > 0 && k < n - 1) {
        const ax = p[k * 2], az = p[k * 2 + 1], bx = p[k * 2 + 2], bz = p[k * 2 + 3];
        const L = Math.hypot(bx - ax, bz - az) || 0.001;
        const remain = L * (1 - this.u[i]);
        if (move < remain) { this.u[i] += move / L; move = 0; }
        else { move -= remain; k++; this.u[i] = 0; }
        this.h[i] = Math.atan2(bz - az, bx - ax);
      }
      this.seg[i] = k;
      if (k >= n - 1) { this.x[i] = p[(n - 1) * 2]; this.z[i] = p[(n - 1) * 2 + 1]; this.onArrive(i); this.despawn(i); continue; }
      const ax = p[k * 2], az = p[k * 2 + 1], bx = p[k * 2 + 2], bz = p[k * 2 + 3];
      this.x[i] = ax + (bx - ax) * this.u[i];
      this.z[i] = az + (bz - az) * this.u[i];
    }
  }

  fillSnapshot(out: Float32Array, cam: { x: number; z: number; h: number }): number {
    // level of detail: only walkers reasonably close to the camera are streamed
    const R = Math.max(500, cam.h * 3.5);
    let n = 0;
    for (let i = 0; i < this.max; i++) {
      const o = i * PED_STRIDE;
      if (!this.active[i] || Math.abs(this.x[i] - cam.x) > R || Math.abs(this.z[i] - cam.z) > R) { out[o + 4] = -1; continue; }
      out[o] = this.x[i]; out[o + 1] = Math.max(0.2, this.T.heightAt(this.x[i], this.z[i])) + 0.15; out[o + 2] = this.z[i];
      out[o + 3] = this.h[i]; out[o + 4] = this.gen[i];
      out[o + 5] = this.flags[i] | (this.rain > 0.3 && !(this.flags[i] & PED_FLAG_BIKE) && (i % 3 !== 0) ? PED_FLAG_UMBRELLA : 0);
      out[o + 6] = this.citizen[i];
      n++;
    }
    return n;
  }
}
