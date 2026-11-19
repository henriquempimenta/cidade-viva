import { OCC_CELL } from '../shared/constants';
import type { Terrain } from './terrain';

export const OCC_FREE = 0, OCC_ROAD = 1, OCC_BUILD = 2, OCC_WATER = 3, OCC_RAIL = 4, OCC_RESERVED = 5;

/** Fine raster of what occupies the ground. Used to keep geometry from overlapping. */
export class Occupancy {
  readonly n: number;
  readonly grid: Uint8Array;
  owner: Int32Array; // building id for OCC_BUILD cells
  constructor(public size: number, terrain: Terrain) {
    this.n = Math.ceil(size / OCC_CELL);
    this.grid = new Uint8Array(this.n * this.n);
    this.owner = new Int32Array(this.n * this.n).fill(-1);
    for (let j = 0; j < this.n; j++) for (let i = 0; i < this.n; i++) {
      const x = (i + 0.5) * OCC_CELL, z = (j + 0.5) * OCC_CELL;
      if (terrain.heightAt(x, z) < terrain.seaLevel + 0.4) this.grid[j * this.n + i] = OCC_WATER;
    }
  }

  idx(x: number, z: number): number {
    const i = Math.floor(x / OCC_CELL), j = Math.floor(z / OCC_CELL);
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return -1;
    return j * this.n + i;
  }
  get(x: number, z: number): number {
    const k = this.idx(x, z);
    return k < 0 ? 255 : this.grid[k];
  }

  /** Iterate cells covered by an oriented rectangle. */
  forRect(cx: number, cz: number, angle: number, w: number, d: number, fn: (k: number) => boolean | void): boolean {
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const ex = (Math.abs(ca) * w + Math.abs(sa) * d) / 2, ez = (Math.abs(sa) * w + Math.abs(ca) * d) / 2;
    const i0 = Math.floor((cx - ex) / OCC_CELL), i1 = Math.floor((cx + ex) / OCC_CELL);
    const j0 = Math.floor((cz - ez) / OCC_CELL), j1 = Math.floor((cz + ez) / OCC_CELL);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * OCC_CELL - cx, z = (j + 0.5) * OCC_CELL - cz;
        // local coords: u along angle (width), v across (depth)
        const u = x * ca + z * sa, v = -x * sa + z * ca;
        if (Math.abs(u) > w / 2 || Math.abs(v) > d / 2) continue;
        if (i < 0 || j < 0 || i >= this.n || j >= this.n) { if (fn(-1) === false) return false; continue; }
        if (fn(j * this.n + i) === false) return false;
      }
    }
    return true;
  }

  rectFree(cx: number, cz: number, angle: number, w: number, d: number, allowRoad = false): boolean {
    return this.forRect(cx, cz, angle, w, d, (k) => {
      if (k < 0) return false;
      const g = this.grid[k];
      if (g === OCC_FREE) return;
      if (allowRoad && g === OCC_ROAD) return;
      return false;
    });
  }

  markRect(cx: number, cz: number, angle: number, w: number, d: number, val: number, owner = -1) {
    this.forRect(cx, cz, angle, w, d, (k) => {
      if (k < 0) return;
      if (val === OCC_FREE) { if (this.grid[k] === OCC_BUILD || this.grid[k] === OCC_RESERVED) { this.grid[k] = 0; this.owner[k] = -1; } return; }
      if (this.grid[k] === OCC_WATER && val !== OCC_ROAD && val !== OCC_RAIL) return;
      if (val === OCC_BUILD && this.grid[k] === OCC_ROAD) return;
      this.grid[k] = val;
      this.owner[k] = owner;
    });
  }

  /** Corridor along a segment */
  segRect(ax: number, az: number, bx: number, bz: number, halfW: number) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    return { cx: (ax + bx) / 2, cz: (az + bz) / 2, angle: Math.atan2(dz, dx), w: len, d: halfW * 2 };
  }

  segFree(ax: number, az: number, bx: number, bz: number, halfW: number, trim: number): { ok: boolean; water: number; blockedBy: number } {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len <= trim * 2) return { ok: true, water: 0, blockedBy: 0 };
    const ux = dx / len, uz = dz / len;
    const r = this.segRect(ax + ux * trim, az + uz * trim, bx - ux * trim, bz - uz * trim, halfW);
    let water = 0, blocked = 0;
    this.forRect(r.cx, r.cz, r.angle, r.w, r.d, (k) => {
      if (k < 0) { blocked++; return; }
      const g = this.grid[k];
      if (g === OCC_WATER) water++;
      else if (g === OCC_BUILD || g === OCC_RESERVED) blocked++;
      else if (g === OCC_ROAD || g === OCC_RAIL) blocked += 0; // crossings handled by graph checks
    });
    return { ok: blocked === 0, water: water * OCC_CELL, blockedBy: blocked };
  }

  ownersInRect(cx: number, cz: number, angle: number, w: number, d: number): Set<number> {
    const s = new Set<number>();
    this.forRect(cx, cz, angle, w, d, (k) => { if (k >= 0 && this.owner[k] >= 0 && this.grid[k] === OCC_BUILD) s.add(this.owner[k]); });
    return s;
  }
}
