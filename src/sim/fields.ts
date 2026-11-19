import { FIELD_CELL } from '../shared/constants';
import { FIELD_NAMES, type FieldName } from '../shared/catalog';
import { clamp } from '../shared/rng';
import type { Terrain } from './terrain';

/** Scalar fields on a regular grid ("heatmaps"). All emergent behaviour reads from here. */
export class Fields {
  readonly G: number;
  readonly cell = FIELD_CELL;
  f: Record<FieldName, Float32Array>;
  private tmp: Float32Array;
  private tmp2: Float32Array;
  // static helpers
  waterDist: Float32Array;
  relElev: Float32Array;
  riverCell: Int32Array; // index of nearest river point if close to river, else -1
  /** pollution per river polyline point (downstream propagation) */
  riverPol: Float32Array;

  constructor(public terrain: Terrain) {
    this.G = Math.ceil(terrain.size / FIELD_CELL);
    const n = this.G * this.G;
    this.f = {} as Record<FieldName, Float32Array>;
    for (const name of FIELD_NAMES) this.f[name] = new Float32Array(n);
    this.tmp = new Float32Array(n);
    this.tmp2 = new Float32Array(n);
    this.waterDist = new Float32Array(n);
    this.relElev = new Float32Array(n);
    this.riverCell = new Int32Array(n).fill(-1);
    this.riverPol = new Float32Array(terrain.river.length);
    this.initStatic();
  }

  idx(x: number, z: number): number {
    const i = clamp(Math.floor(x / this.cell), 0, this.G - 1), j = clamp(Math.floor(z / this.cell), 0, this.G - 1);
    return j * this.G + i;
  }
  center(k: number): [number, number] {
    return [((k % this.G) + 0.5) * this.cell, (Math.floor(k / this.G) + 0.5) * this.cell];
  }
  sample(name: FieldName, x: number, z: number): number {
    const a = this.f[name];
    const G = this.G;
    const fx = clamp(x / this.cell - 0.5, 0, G - 1.001), fz = clamp(z / this.cell - 0.5, 0, G - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const k = j * G + i;
    return (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - tz) + (a[k + G] * (1 - tx) + a[k + G + 1] * tx) * tz;
  }
  /** average over a disc */
  avg(name: FieldName, x: number, z: number, r: number): number {
    const a = this.f[name], G = this.G, c = this.cell;
    const i0 = clamp(Math.floor((x - r) / c), 0, G - 1), i1 = clamp(Math.floor((x + r) / c), 0, G - 1);
    const j0 = clamp(Math.floor((z - r) / c), 0, G - 1), j1 = clamp(Math.floor((z + r) / c), 0, G - 1);
    let s = 0, n = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { s += a[j * G + i]; n++; }
    return n ? s / n : 0;
  }
  sum(name: FieldName, x: number, z: number, r: number): number {
    const a = this.f[name], G = this.G, c = this.cell;
    const i0 = clamp(Math.floor((x - r) / c), 0, G - 1), i1 = clamp(Math.floor((x + r) / c), 0, G - 1);
    const j0 = clamp(Math.floor((z - r) / c), 0, G - 1), j1 = clamp(Math.floor((z + r) / c), 0, G - 1);
    let s = 0;
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) * c - x, dz = (j + 0.5) * c - z;
      if (dx * dx + dz * dz <= r2) s += a[j * G + i];
    }
    return s;
  }

  private splatW = new Float32Array(0);
  splat(arr: Float32Array, x: number, z: number, v: number, r = 0) {
    const G = this.G, c = this.cell;
    if (r <= c * 0.6) { arr[this.idx(x, z)] += v; return; }
    const i0 = clamp(Math.floor((x - r) / c), 0, G - 1), i1 = clamp(Math.floor((x + r) / c), 0, G - 1);
    const j0 = clamp(Math.floor((z - r) / c), 0, G - 1), j1 = clamp(Math.floor((z + r) / c), 0, G - 1);
    const W = i1 - i0 + 1, n = W * (j1 - j0 + 1);
    if (this.splatW.length < n) this.splatW = new Float32Array(n * 2);
    const wb = this.splatW, ir = 1 / r;
    let wsum = 0;
    for (let j = j0, m = 0; j <= j1; j++) {
      const dz = (j + 0.5) * c - z;
      for (let i = i0; i <= i1; i++, m++) {
        const dx = (i + 0.5) * c - x;
        const w = 1 - Math.sqrt(dx * dx + dz * dz) * ir;
        wb[m] = w > 0 ? w : 0; wsum += wb[m];
      }
    }
    if (wsum === 0) { arr[this.idx(x, z)] += v; return; }
    const s = v / wsum;
    for (let j = j0, m = 0; j <= j1; j++) for (let i = i0; i <= i1; i++, m++) if (wb[m] > 0) arr[j * G + i] += wb[m] * s;
  }

  /** separable box blur, applied twice ≈ gaussian */
  blur(src: Float32Array, dst: Float32Array, radiusCells: number) {
    const G = this.G, r = Math.max(1, Math.round(radiusCells));
    const t = this.tmp;
    for (let pass = 0; pass < 2; pass++) {
      const from = pass === 0 ? src : dst;
      // horizontal into t
      for (let j = 0; j < G; j++) {
        let acc = 0, cnt = 0;
        for (let i = -r; i <= r; i++) if (i >= 0 && i < G) { acc += from[j * G + i]; cnt++; }
        for (let i = 0; i < G; i++) {
          t[j * G + i] = acc / cnt;
          const add = i + r + 1, rem = i - r;
          if (add < G) { acc += from[j * G + add]; cnt++; }
          if (rem >= 0) { acc -= from[j * G + rem]; cnt--; }
        }
      }
      // vertical into dst
      for (let i = 0; i < G; i++) {
        let acc = 0, cnt = 0;
        for (let j = -r; j <= r; j++) if (j >= 0 && j < G) { acc += t[j * G + i]; cnt++; }
        for (let j = 0; j < G; j++) {
          dst[j * G + i] = acc / cnt;
          const add = j + r + 1, rem = j - r;
          if (add < G) { acc += t[add * G + i]; cnt++; }
          if (rem >= 0) { acc -= t[rem * G + i]; cnt--; }
        }
      }
    }
  }

  /**
   * Air pollution transport: semi-lagrangian advection by the dominant wind + diffusion + decay.
   * Plumes therefore stretch downwind of their sources — nobody tells industry where to go.
   */
  advectAir(src: Float32Array, windSpeedCells: number, steps = 6) {
    const G = this.G;
    const a = this.f.airPollution;
    const t = this.tmp2;
    const wx = Math.cos(this.terrain.windDir) * windSpeedCells, wz = Math.sin(this.terrain.windDir) * windSpeedCells;
    for (let s = 0; s < steps; s++) {
      for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
        const fx = clamp(i - wx, 0, G - 1.001), fz = clamp(j - wz, 0, G - 1.001);
        const i0 = Math.floor(fx), j0 = Math.floor(fz), tx = fx - i0, tz = fz - j0;
        const k0 = j0 * G + i0;
        const v = (a[k0] * (1 - tx) + a[k0 + 1] * tx) * (1 - tz) + (a[k0 + G] * (1 - tx) + a[k0 + G + 1] * tx) * tz;
        t[j * G + i] = v;
      }
      for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
        const k = j * G + i;
        const l = i > 0 ? t[k - 1] : t[k], r = i < G - 1 ? t[k + 1] : t[k];
        const u = j > 0 ? t[k - G] : t[k], d = j < G - 1 ? t[k + G] : t[k];
        a[k] = (t[k] * 0.6 + (l + r + u + d) * 0.1) * 0.86 + src[k] * 0.22;
      }
    }
  }

  /** River pollution flows downstream along the polyline */
  propagateRiver(inputs: Float32Array) {
    const p = this.riverPol;
    let carry = 0;
    for (let i = 0; i < p.length; i++) {
      carry = carry * 0.985 + inputs[i];
      p[i] = p[i] * 0.5 + carry * 0.5;
    }
    const wp = this.f.waterPollution;
    for (let k = 0; k < wp.length; k++) {
      const rc = this.riverCell[k];
      wp[k] = rc >= 0 ? clamp(p[rc], 0, 3) * (1 - this.waterDist[k] / 260) : wp[k] * 0.9;
    }
  }

  private initStatic() {
    const G = this.G, T = this.terrain, c = this.cell;
    const water = new Float32Array(G * G);
    const elev = this.f.elevation;
    for (let k = 0; k < G * G; k++) {
      const [x, z] = this.center(k);
      const h = T.heightAt(x, z);
      water[k] = h < T.seaLevel + 0.3 ? 1 : 0;
      elev[k] = h;
    }
    // distance to water via two-pass chamfer
    const d = this.waterDist;
    for (let k = 0; k < G * G; k++) d[k] = water[k] ? 0 : 1e9;
    for (let it = 0; it < 2; it++) {
      for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
        const k = j * G + i;
        if (i > 0) d[k] = Math.min(d[k], d[k - 1] + c);
        if (j > 0) d[k] = Math.min(d[k], d[k - G] + c);
        if (i > 0 && j > 0) d[k] = Math.min(d[k], d[k - G - 1] + c * 1.414);
        if (i < G - 1 && j > 0) d[k] = Math.min(d[k], d[k - G + 1] + c * 1.414);
      }
      for (let j = G - 1; j >= 0; j--) for (let i = G - 1; i >= 0; i--) {
        const k = j * G + i;
        if (i < G - 1) d[k] = Math.min(d[k], d[k + 1] + c);
        if (j < G - 1) d[k] = Math.min(d[k], d[k + G] + c);
        if (i < G - 1 && j < G - 1) d[k] = Math.min(d[k], d[k + G + 1] + c * 1.414);
        if (i > 0 && j < G - 1) d[k] = Math.min(d[k], d[k + G - 1] + c * 1.414);
      }
    }
    // relative elevation: height above local mean (hills with a view)
    const mean = new Float32Array(G * G);
    this.blur(elev, mean, Math.round(400 / c));
    let maxRel = 1;
    for (let k = 0; k < G * G; k++) { this.relElev[k] = Math.max(0, elev[k] - mean[k]); maxRel = Math.max(maxRel, this.relElev[k]); }
    for (let k = 0; k < G * G; k++) this.relElev[k] /= maxRel;
    // river mapping
    for (let k = 0; k < G * G; k++) {
      const [x, z] = this.center(k);
      if (T.distToRiver(x, z) < 280) this.riverCell[k] = T.riverIndex(x, z);
    }
  }

  /** static part of beauty: water view, hills, forest */
  staticBeauty(k: number): number {
    const [x, z] = this.center(k);
    const wd = this.waterDist[k];
    const waterView = wd > 0 ? Math.max(0, 1 - wd / 260) : 0;
    const forest = this.terrain.sample(this.terrain.forest, x, z);
    return 0.55 * waterView + 0.9 * this.relElev[k] + 0.2 * forest;
  }
}
