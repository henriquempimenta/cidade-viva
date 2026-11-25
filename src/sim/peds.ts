import { PED_FLAG_UMBRELLA, PED_FLAG_WAITING, PED_STRIDE } from '../shared/constants';
import {
  edgeHalfWidth, sampleRoadSurfaceY, sampleUnderpassWalkY, SIDEWALK_WIDTH,
  UNDERPASS_DEPTH, UNDERPASS_FLAT_HALF, UNDERPASS_HALF_LEN,
} from '../shared/roadGeom';
import { MinHeap } from './heap';
import type { RoadNetwork } from './roads';
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
  ptsY: (Float32Array | null)[] = [];
  cum: (Float32Array | null)[] = [];
  t0 = new Float64Array(0);
  arrive = new Float64Array(0);
  color = new Float32Array(0);
  kind = new Uint8Array(0); // 0 citizen, 1 tourist, 2 worker, 3 funeral, 4 waiting
  // pose cache (evaluated lazily)
  x = new Float32Array(0); y = new Float32Array(0); z = new Float32Array(0); h = new Float32Array(0);
  // tight path AABB for cheap spatial rejection (gates & snapshot culling)
  private minX = new Float32Array(0); private maxX = new Float32Array(0);
  private minZ = new Float32Array(0); private maxZ = new Float32Array(0);
  private delayed = new Uint8Array(0);
  gateHeld = new Uint8Array(0);
  private free: number[] = [];
  private q = new MinHeap();
  count = 0;
  time = 0;
  onArrive: (slot: number) => void = () => {};
  rain = 0;
  /** closed railway level crossings: position (including 3D rail elevation y), road unit axis (ux,uz) and carriageway+sidewalk half-width */
  closedGates: { x: number; z: number; y?: number; ux?: number; uz?: number; halfW?: number }[] = [];

  constructor(private T: Terrain, private elevation?: (x: number, z: number) => number) { this.grow(2048); }

  private grow(n: number) {
    const old = this.max;
    const g = <A extends { length: number; set(a: ArrayLike<number>): void }>(a: A, C: new (n: number) => A) => { const b = new C(n); b.set(a); return b; };
    this.active = g(this.active, Uint8Array); this.gen = g(this.gen, Uint16Array); this.citizen = g(this.citizen, Int32Array);
    this.flags = g(this.flags, Uint16Array); this.speed = g(this.speed, Float32Array); this.t0 = g(this.t0, Float64Array);
    this.arrive = g(this.arrive, Float64Array); this.color = g(this.color, Float32Array); this.kind = g(this.kind, Uint8Array);
    this.x = g(this.x, Float32Array); this.y = g(this.y, Float32Array); this.z = g(this.z, Float32Array); this.h = g(this.h, Float32Array);
    this.minX = g(this.minX, Float32Array); this.maxX = g(this.maxX, Float32Array);
    this.minZ = g(this.minZ, Float32Array); this.maxZ = g(this.maxZ, Float32Array);
    this.delayed = g(this.delayed, Uint8Array);
    this.gateHeld = g(this.gateHeld, Uint8Array);
    for (let i = old; i < n; i++) { this.pts.push(null); this.ptsY.push(null); this.cum.push(null); }
    for (let i = n - 1; i >= old; i--) this.free.push(i);
    this.max = n;
  }

  /** soft budget only: storage grows, so callers are never refused for lack of slots */
  get capacityLeft() { return 1e9; }

  spawn(pts: number[], citizen: number, speed: number, flags: number, color: number, kind = 0, yPts?: number[]): number {
    if (pts.length < 4) return -1;
    if (!this.free.length) this.grow(this.max * 2);
    const i = this.free.pop()!;
    const n = pts.length / 2;
    const P = new Float32Array(pts), C = new Float32Array(n);
    const Y = yPts && yPts.length === n ? new Float32Array(yPts) : null;
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
    this.pts[i] = P; this.ptsY[i] = Y; this.cum[i] = C;
    this.t0[i] = this.time;
    this.arrive[i] = this.time + C[n - 1] / v;
    this.delayed[i] = 0;
    this.gateHeld[i] = 0;
    this.q.push(i, this.arrive[i]);
    this.x[i] = P[0]; this.z[i] = P[1]; this.h[i] = Math.atan2(P[3] - P[1], P[2] - P[0]);
    this.y[i] = Y ? Y[0] : (this.elevation ? this.elevation(P[0], P[1]) : Math.max(0.2, this.T.meshY(P[0], P[1])) + 0.15);
    this.color[i] = color;
    this.kind[i] = kind;
    this.count++;
    return i;
  }
  /** keep a walker frozen at its exact current 3D pose until explicitly repositioned or removed (queues / crash hold) */
  hold(i: number) {
    if (!this.active[i]) return;
    if (Number.isFinite(this.arrive[i])) this.pose(i);
    this.arrive[i] = Infinity;
    this.speed[i] = 0;
    this.t0[i] = this.time;
    this.flags[i] |= PED_FLAG_WAITING;
    const x = this.x[i], y = this.y[i], z = this.z[i], h = this.h[i];
    const x2 = x + Math.cos(h) * 0.05, z2 = z + Math.sin(h) * 0.05;
    this.pts[i] = new Float32Array([x, z, x2, z2]);
    this.ptsY[i] = new Float32Array([y, y]);
    this.cum[i] = new Float32Array([0, 0.05]);
    this.minX[i] = Math.min(x, x2); this.maxX[i] = Math.max(x, x2);
    this.minZ[i] = Math.min(z, z2); this.maxZ[i] = Math.max(z, z2);
  }
  /** reposition a held pedestrian (e.g. FIFO bus-stop queue shifting forward) without despawning */
  setHeldPose(i: number, x: number, z: number, h: number, y?: number) {
    if (!this.active[i]) return;
    const x2 = x + Math.cos(h) * 0.05;
    const z2 = z + Math.sin(h) * 0.05;
    const P = this.pts[i];
    if (P && P.length >= 4) {
      P[0] = x; P[1] = z; P[2] = x2; P[3] = z2;
    }
    const Y = this.ptsY[i];
    if (y !== undefined) {
      if (Y && Y.length >= 2) { Y[0] = y; Y[1] = y; }
      this.y[i] = y;
    } else if (Y && Y.length >= 2) {
      const gy = this.elevation ? this.elevation(x, z) : Math.max(0.2, this.T.meshY(x, z)) + 0.15;
      Y[0] = gy; Y[1] = gy; this.y[i] = gy;
    }
    this.minX[i] = Math.min(x, x2); this.maxX[i] = Math.max(x, x2);
    this.minZ[i] = Math.min(z, z2); this.maxZ[i] = Math.max(z, z2);
    this.x[i] = x; this.z[i] = z; this.h[i] = h;
    this.t0[i] = this.time;
  }
  despawn(i: number) {
    if (!this.active[i]) return;
    this.active[i] = 0;
    this.delayed[i] = 0;
    this.gateHeld[i] = 0;
    this.pts[i] = null; this.ptsY[i] = null; this.cum[i] = null;
    this.free.push(i);
    this.count--;
  }

  /** distance walked so far → pose cache (including exact level-aware 3D elevation y) */
  pose(i: number) {
    if (!Number.isFinite(this.arrive[i])) return; // held pedestrian stays frozen at (x, y, z, h) until setHeldPose() or despawn()
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
    const Y = this.ptsY[i];
    if (Y) {
      this.y[i] = Y[lo] + (Y[hi] - Y[lo]) * u;
    } else {
      this.y[i] = this.elevation ? this.elevation(this.x[i], this.z[i]) : Math.max(0.2, this.T.meshY(this.x[i], this.z[i])) + 0.15;
    }
  }

  remainingTime(i: number): number {
    if (!this.active[i]) return 0;
    return Number.isFinite(this.arrive[i]) ? Math.max(0, this.arrive[i] - this.time) : 0;
  }

  /**
   * Reproject `ptsY` (subdividing collinear segments where needed) for ALL active pedestrians
   * whose trajectory crosses a newly opened or updated rail underpass (`c.under`), so walkers
   * already en route descend smoothly along the sunken ramp instead of walking in mid-air.
   */
  reprojectUnderpasses(roads: RoadNetwork) {
    interface UnderZone {
      ax: number; az: number; ux: number; uz: number; nx: number; nz: number;
      hw: number; latMax: number; urban: boolean;
      sCenter: number; halfLenNeg: number; halfLenPos: number; flatHalf: number; depth: number; ry: number;
      minX: number; maxX: number; minZ: number; maxZ: number;
    }
    const zones: UnderZone[] = [];
    let uMinX = Infinity, uMaxX = -Infinity, uMinZ = Infinity, uMaxZ = -Infinity;
    for (const e of roads.edges) {
      if (!e.alive || !e.underpasses?.length) continue;
      const a = roads.nodes[e.a], b = roads.nodes[e.b];
      if (!a || !b) continue;
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
      const ux = dx / len, uz = dz / len, nx = -uz, nz = ux;
      const hw = edgeHalfWidth(e);
      const urban = roads.hasSidewalk(e.id);
      const latMax = hw + (urban ? SIDEWALK_WIDTH + 1.5 : 1.8);
      for (const up of e.underpasses) {
        const sCenter = up.t * e.len;
        const halfLenNeg = up.halfLenNeg ?? UNDERPASS_HALF_LEN;
        const halfLenPos = up.halfLenPos ?? UNDERPASS_HALF_LEN;
        const flatHalf = up.flatHalf ?? UNDERPASS_FLAT_HALF;
        const depth = up.depth ?? UNDERPASS_DEPTH;
        const cx = a.x + ux * sCenter, cz = a.z + uz * sCenter;
        // Include 12 m approach margin beyond both mouths so stale 10 m chords approaching the mouth are also conformed
        const pad = Math.max(halfLenNeg, halfLenPos) + 12 + latMax + 2;
        const zMinX = cx - pad, zMaxX = cx + pad, zMinZ = cz - pad, zMaxZ = cz + pad;
        if (zMinX < uMinX) uMinX = zMinX; if (zMaxX > uMaxX) uMaxX = zMaxX;
        if (zMinZ < uMinZ) uMinZ = zMinZ; if (zMaxZ > uMaxZ) uMaxZ = zMaxZ;
        zones.push({
          ax: a.x, az: a.z, ux, uz, nx, nz, hw, latMax, urban,
          sCenter, halfLenNeg, halfLenPos, flatHalf, depth, ry: up.ry,
          minX: zMinX, maxX: zMaxX, minZ: zMinZ, maxZ: zMaxZ,
        });
      }
    }
    if (!zones.length) return;

    const meshGround = (gx: number, gz: number) => this.T.meshY(gx, gz);
    const evalZoneY = (px: number, pz: number, curY: number): number | null => {
      let bestY: number | null = null;
      for (const z of zones) {
        if (px < z.minX || px > z.maxX || pz < z.minZ || pz > z.maxZ) continue;
        const rx = px - z.ax, rz = pz - z.az;
        const s = rx * z.ux + rz * z.uz;
        const u = s - z.sCenter;
        if (u < -z.halfLenNeg - 12 || u > z.halfLenPos + 12) continue;
        const across = Math.abs(rx * z.nx + rz * z.nz);
        if (across > z.latMax) continue;
        const cx = z.ax + z.ux * s, cz = z.az + z.uz * s;
        const surfRoadY = sampleRoadSurfaceY(cx, cz, z.nx, z.nz, z.hw, meshGround);
        // Never pull down walkers crossing an elevated viaduct overhead
        if (curY > surfRoadY + 2.8) continue;
        const wy = sampleUnderpassWalkY(
          u, surfRoadY, meshGround(px, pz), z.ry,
          z.halfLenNeg, z.halfLenPos, z.flatHalf, z.depth, z.urban,
        );
        if (bestY === null || wy < bestY) bestY = wy;
      }
      return bestY;
    };

    for (let i = 0; i < this.max; i++) {
      if (!this.active[i]) continue;
      if (this.maxX[i] < uMinX || this.minX[i] > uMaxX || this.maxZ[i] < uMinZ || this.minZ[i] > uMaxZ) continue;
      const P = this.pts[i];
      const C = this.cum[i];
      if (!P || !C || P.length < 4) continue;
      const nPts = P.length / 2;
      const oldY = this.ptsY[i];
      const getY = (idx: number) => (oldY ? oldY[idx] : (this.elevation ? this.elevation(P[idx * 2], P[idx * 2 + 1]) : Math.max(0.2, meshGround(P[idx * 2], P[idx * 2 + 1])) + 0.15));

      // Held pedestrian: update its held elevation directly if inside an underpass
      if (!Number.isFinite(this.arrive[i])) {
        const ny = evalZoneY(this.x[i], this.z[i], this.y[i]);
        if (ny !== null && Math.abs(ny - this.y[i]) > 0.01) {
          this.y[i] = ny;
          if (oldY) for (let k = 0; k < oldY.length; k++) oldY[k] = ny;
          else this.ptsY[i] = new Float32Array(nPts).fill(ny);
        }
        continue;
      }

      const newP: number[] = [];
      const newY: number[] = [];
      let changed = false;

      for (let k = 0; k < nPts - 1; k++) {
        const ax = P[k * 2], az = P[k * 2 + 1], ya = getY(k);
        const bx = P[(k + 1) * 2], bz = P[(k + 1) * 2 + 1], yb = getY(k + 1);
        const sMinX = Math.min(ax, bx), sMaxX = Math.max(ax, bx);
        const sMinZ = Math.min(az, bz), sMaxZ = Math.max(az, bz);
        let hitsZone = false;
        for (const z of zones) {
          if (sMaxX >= z.minX && sMinX <= z.maxX && sMaxZ >= z.minZ && sMinZ <= z.maxZ) { hitsZone = true; break; }
        }
        const segLen = Math.hypot(bx - ax, bz - az);
        const sub = hitsZone ? Math.max(1, Math.ceil(segLen / 1.0)) : 1;
        for (let st = 0; st < sub; st++) {
          const f = st / sub;
          const px = ax + (bx - ax) * f, pz = az + (bz - az) * f;
          const pyOrig = ya + (yb - ya) * f;
          const ny = hitsZone ? evalZoneY(px, pz, pyOrig) : null;
          const py = ny !== null ? ny : pyOrig;
          if (ny !== null && Math.abs(ny - pyOrig) > 0.01) changed = true;
          newP.push(px, pz);
          newY.push(py);
        }
      }
      // Final endpoint
      const lx = P[(nPts - 1) * 2], lz = P[(nPts - 1) * 2 + 1], lyOrig = getY(nPts - 1);
      const lny = evalZoneY(lx, lz, lyOrig);
      const ly = lny !== null ? lny : lyOrig;
      if (lny !== null && Math.abs(lny - lyOrig) > 0.01) changed = true;
      newP.push(lx, lz);
      newY.push(ly);

      if (!changed) continue;
      const mNew = newY.length;
      const nextP = new Float32Array(newP);
      const nextY = new Float32Array(newY);
      const nextC = new Float32Array(mNew);
      for (let k = 1; k < mNew; k++) {
        nextC[k] = nextC[k - 1] + Math.hypot(nextP[k * 2] - nextP[k * 2 - 2], nextP[k * 2 + 1] - nextP[k * 2 - 1]);
      }
      this.pts[i] = nextP;
      this.ptsY[i] = nextY;
      this.cum[i] = nextC;
      this.pose(i);
    }
  }

  step(dt: number) {
    this.time += dt;
    this.gateHeld.fill(0);
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
        const px = this.x[i], py = this.y[i], pz = this.z[i];
        const hx = Math.cos(this.h[i]), hz = Math.sin(this.h[i]);
        for (let k = 0; k < ng; k++) {
          const g = gates[k];
          // 3D level separation: pedestrians on viaducts above or underpasses below are never held by at-grade gates
          if (g.y !== undefined && Math.abs(py - g.y) >= 3.0) continue;
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
              this.gateHeld[i] = 1;
              break;
            }
          } else {
            const d = Math.hypot(dx, dz);
            if (d >= 2.5 && d <= halfW && ((-dx * hx - dz * hz) / d) > 0.2) {
              this.t0[i] += dt;
              this.arrive[i] += dt;
              this.delayed[i] = 1;
              this.gateHeld[i] = 1;
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
      out[o] = this.x[i]; out[o + 1] = this.y[i]; out[o + 2] = this.z[i];
      out[o + 3] = this.h[i]; out[o + 4] = this.gen[i];
      let fl = this.flags[i];
      if (this.gateHeld[i] === 1 || !Number.isFinite(this.arrive[i])) fl |= PED_FLAG_WAITING;
      if (this.rain > 0.3 && !(fl & PED_FLAG_BIKE) && (i % 3 !== 0)) fl |= PED_FLAG_UMBRELLA;
      out[o + 5] = fl;
      out[o + 6] = this.citizen[i];
      n++;
    }
    return n;
  }
}
