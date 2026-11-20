import { PED_FLAG_UMBRELLA, PED_STRIDE } from '../shared/constants';
import { MinHeap } from './heap';
import type { Terrain } from './terrain';

export const PED_FLAG_BIKE = 256;

/**
 * Walkers and cyclists following waypoint polylines along sidewalks.
 *
 * Pedestrians do not interact with each other, so their motion is analytic:
 * a walker is (start time, speed, cumulative polyline lengths). The position is
 * evaluated only when somebody looks (snapshot near the camera, follow mode,
 * inspector), and arrivals come out of a priority queue. The per-step cost is
 * O(arrivals) instead of O(walkers), which removes any practical cap on how
 * many people can be on the streets at once. Storage grows on demand.
 */
export class Peds {
  max = 0;
  active = new Uint8Array(0);
  gen = new Uint16Array(0);
  citizen = new Int32Array(0);
  flags = new Uint16Array(0);
  speed = new Float32Array(0);
  pts: (Float32Array | null)[] = [];
  cum: (Float32Array | null)[] = [];
  t0 = new Float64Array(0);
  arrive = new Float64Array(0);
  color = new Float32Array(0);
  kind = new Uint8Array(0); // 0 citizen, 1 tourist, 2 worker, 3 funeral, 4 waiting
  // pose cache (evaluated lazily)
  x = new Float32Array(0); z = new Float32Array(0); h = new Float32Array(0);
  // tight path AABB for cheap spatial rejection (gates & snapshot culling)
  private minX = new Float32Array(0); private maxX = new Float32Array(0);
  private minZ = new Float32Array(0); private maxZ = new Float32Array(0);
  private delayed = new Uint8Array(0);
  private free: number[] = [];
  private q = new MinHeap();
  count = 0;
  time = 0;
  onArrive: (slot: number) => void = () => {};
  rain = 0;
  /** closed railway level crossings: position, road unit axis (ux,uz) and carriageway+sidewalk half-width */
  closedGates: { x: number; z: number; ux?: number; uz?: number; halfW?: number }[] = [];

  constructor(private T: Terrain) { this.grow(2048); }

  private grow(n: number) {
    const old = this.max;
    const g = <A extends { length: number; set(a: ArrayLike<number>): void }>(a: A, C: new (n: number) => A) => { const b = new C(n); b.set(a); return b; };
    this.active = g(this.active, Uint8Array); this.gen = g(this.gen, Uint16Array); this.citizen = g(this.citizen, Int32Array);
    this.flags = g(this.flags, Uint16Array); this.speed = g(this.speed, Float32Array); this.t0 = g(this.t0, Float64Array);
    this.arrive = g(this.arrive, Float64Array); this.color = g(this.color, Float32Array); this.kind = g(this.kind, Uint8Array);
    this.x = g(this.x, Float32Array); this.z = g(this.z, Float32Array); this.h = g(this.h, Float32Array);
    this.minX = g(this.minX, Float32Array); this.maxX = g(this.maxX, Float32Array);
    this.minZ = g(this.minZ, Float32Array); this.maxZ = g(this.maxZ, Float32Array);
    this.delayed = g(this.delayed, Uint8Array);
    for (let i = old; i < n; i++) { this.pts.push(null); this.cum.push(null); }
    for (let i = n - 1; i >= old; i--) this.free.push(i);
    this.max = n;
  }

  /** soft budget only: storage grows, so callers are never refused for lack of slots */
  get capacityLeft() { return 1e9; }

  spawn(pts: number[], citizen: number, speed: number, flags: number, color: number, kind = 0): number {
    if (pts.length < 4) return -1;
    if (!this.free.length) this.grow(this.max * 2);
    const i = this.free.pop()!;
    const n = pts.length / 2;
    const P = new Float32Array(pts), C = new Float32Array(n);
    let x0 = P[0], x1 = P[0], z0 = P[1], z1 = P[1];
    for (let k = 1; k < n; k++) {
      const px = P[k * 2], pz = P[k * 2 + 1];
      C[k] = C[k - 1] + Math.hypot(px - P[k * 2 - 2], pz - P[k * 2 - 1]);
      if (px < x0) x0 = px; else if (px > x1) x1 = px;
      if (pz < z0) z0 = pz; else if (pz > z1) z1 = pz;
    }
    this.minX[i] = x0; this.maxX[i] = x1; this.minZ[i] = z0; this.maxZ[i] = z1;
    const v = Math.max(0.005, speed * (flags & PED_FLAG_BIKE ? 1 : 1 - this.rain * 0.15));
    this.active[i] = 1;
    this.gen[i] = (this.gen[i] + 1) & 0xffff;
    this.citizen[i] = citizen;
    this.flags[i] = flags;
    this.speed[i] = v;
    this.pts[i] = P; this.cum[i] = C;
    this.t0[i] = this.time;
    this.arrive[i] = this.time + C[n - 1] / v;
    this.delayed[i] = 0;
    this.q.push(i, this.arrive[i]);
    this.x[i] = P[0]; this.z[i] = P[1]; this.h[i] = Math.atan2(P[3] - P[1], P[2] - P[0]);
    this.color[i] = color;
    this.kind[i] = kind;
    this.count++;
    return i;
  }
  /** keep a walker standing where it is until explicitly removed (queues at stops) */
  hold(i: number) { if (this.active[i]) this.arrive[i] = Infinity; }
  despawn(i: number) {
    if (!this.active[i]) return;
    this.active[i] = 0;
    this.delayed[i] = 0;
    this.pts[i] = null; this.cum[i] = null;
    this.free.push(i);
    this.count--;
  }

  /** distance walked so far → pose cache */
  pose(i: number) {
    const P = this.pts[i], C = this.cum[i];
    if (!P || !C) return;
    const n = C.length;
    const d = Math.min(C[n - 1], (this.time - this.t0[i]) * this.speed[i]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (C[m] <= d) lo = m; else hi = m; }
    const L = C[hi] - C[lo] || 0.001, u = Math.min(1, (d - C[lo]) / L);
    const ax = P[lo * 2], az = P[lo * 2 + 1], bx = P[hi * 2], bz = P[hi * 2 + 1];
    this.x[i] = ax + (bx - ax) * u; this.z[i] = az + (bz - az) * u;
    if (bx !== ax || bz !== az) this.h[i] = Math.atan2(bz - az, bx - ax);
  }

  remainingTime(i: number): number {
    if (!this.active[i]) return 0;
    return Number.isFinite(this.arrive[i]) ? Math.max(0, this.arrive[i] - this.time) : 0;
  }

  step(dt: number) {
    this.time += dt;
    // hold pedestrians approaching a closed level crossing (tight AABB reject; zero heap pushes while waiting)
    if (this.closedGates.length) {
      const gates = this.closedGates;
      const ng = gates.length;
      for (let i = 0; i < this.max; i++) {
        if (!this.active[i] || !Number.isFinite(this.arrive[i])) continue;
        let hit = false;
        const x0 = this.minX[i], x1 = this.maxX[i], z0 = this.minZ[i], z1 = this.maxZ[i];
        for (let k = 0; k < ng; k++) {
          const g = gates[k];
          const pad = (g.halfW ?? 10) + 10;
          if (g.x >= x0 - pad && g.x <= x1 + pad && g.z >= z0 - pad && g.z <= z1 + pad) { hit = true; break; }
        }
        if (!hit) continue;
        this.pose(i);
        const px = this.x[i], pz = this.z[i];
        const hx = Math.cos(this.h[i]), hz = Math.sin(this.h[i]);
        for (let k = 0; k < ng; k++) {
          const g = gates[k];
          const dx = px - g.x, dz = pz - g.z;
          const ux = g.ux ?? 0, uz = g.uz ?? 0;
          const halfW = g.halfW ?? 10;
          if (ux !== 0 || uz !== 0) {
            // oriented box across road + sidewalks: works for 1, 2 and 3-lane avenues alike
            const along = dx * ux + dz * uz;
            const across = Math.abs(-dx * uz + dz * ux);
            const approaching = -along * (hx * ux + hz * uz) > 0.2 * Math.abs(along);
            if (across <= halfW && Math.abs(along) >= 2.5 && Math.abs(along) <= 10.5 && approaching) {
              this.t0[i] += dt;
              this.arrive[i] += dt;
              this.delayed[i] = 1;
              break;
            }
          } else {
            const d = Math.hypot(dx, dz);
            if (d >= 2.5 && d <= halfW && ((-dx * hx - dz * hz) / d) > 0.2) {
              this.t0[i] += dt;
              this.arrive[i] += dt;
              this.delayed[i] = 1;
              break;
            }
          }
        }
      }
    }
    const q = this.q;
    while (q.size && q.peekPri() <= this.time) {
      const pri = q.peekPri();
      const i = q.pop();
      if (!this.active[i]) continue;
      if (this.delayed[i] && this.arrive[i] > this.time) {
        // delayed by a closed gate: re-enqueue once at the new arrival time
        this.delayed[i] = 0;
        if (Number.isFinite(this.arrive[i])) q.push(i, this.arrive[i]);
        continue;
      }
      if (this.arrive[i] !== pri) continue; // stale entry (slot reused / held)
      const P = this.pts[i]!;
      this.x[i] = P[P.length - 2]; this.z[i] = P[P.length - 1];
      this.onArrive(i);
      this.despawn(i);
    }
  }

  fillSnapshot(out: Float32Array, cam: { x: number; z: number; h: number }): number {
    // level of detail: only walkers reasonably close to the camera are evaluated and streamed
    const R = Math.max(500, cam.h * 3.5);
    let n = 0;
    for (let i = 0; i < this.max; i++) {
      const o = i * PED_STRIDE;
      if (!this.active[i]) { out[o + 4] = -1; continue; }
      const P = this.pts[i]!;
      // cheap reject: no point of the path can be farther than its length from the start before evaluating the pose
      const C = this.cum[i]!, L = R + C[C.length - 1];
      if (Math.abs(P[0] - cam.x) > L || Math.abs(P[1] - cam.z) > L) { out[o + 4] = -1; continue; }
      this.pose(i);
      if (Math.abs(this.x[i] - cam.x) > R || Math.abs(this.z[i] - cam.z) > R) { out[o + 4] = -1; continue; }
      out[o] = this.x[i]; out[o + 1] = Math.max(0.2, this.T.heightAt(this.x[i], this.z[i])) + 0.15; out[o + 2] = this.z[i];
      out[o + 3] = this.h[i]; out[o + 4] = this.gen[i];
      out[o + 5] = this.flags[i] | (this.rain > 0.3 && !(this.flags[i] & PED_FLAG_BIKE) && (i % 3 !== 0) ? PED_FLAG_UMBRELLA : 0);
      out[o + 6] = this.citizen[i];
      n++;
    }
    return n;
  }
}
