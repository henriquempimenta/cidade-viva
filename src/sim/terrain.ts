import { Noise2D, RNG, clamp, smoothstep, lerp } from '../shared/rng';
import type { TerrainType } from '../shared/params';

export class Terrain {
  readonly size: number;
  readonly hres: number;
  readonly step: number;
  heights: Float32Array;
  water: Uint8Array;
  forest: Float32Array;
  flood: Uint8Array;
  riverDist: Float32Array;
  river: { x: number; z: number }[] = []; // ordered upstream -> downstream
  riverWidth = 40;
  seaLevel = 0;
  windDir: number;
  type: TerrainType;
  trees: Float32Array = new Float32Array(0);
  treeAlive: Uint8Array = new Uint8Array(0);
  coastSide = -1; // 0..3 when litoral

  constructor(size: number, type: TerrainType, seed: number) {
    this.size = size;
    this.type = type;
    this.step = 12.5;
    this.hres = Math.round(size / this.step) + 1;
    const n = this.hres * this.hres;
    this.heights = new Float32Array(n);
    this.water = new Uint8Array(n);
    this.forest = new Float32Array(n);
    this.flood = new Uint8Array(n);
    this.riverDist = new Float32Array(n);
    const rng = new RNG(seed ^ 0x51ed);
    this.windDir = rng.range(0, Math.PI * 2);
    this.generate(rng, seed);
  }

  private generate(rng: RNG, seed: number) {
    const { size, hres, step } = this;
    const nz = new Noise2D(seed);
    const nz2 = new Noise2D(seed + 7);
    const nz3 = new Noise2D(seed + 13);
    const amp = { litoral: 38, vale: 45, serra: 110, planicie: 14 }[this.type];
    if (this.type === 'litoral') this.coastSide = rng.int(0, 3);

    // --- river polyline ---
    const axisVertical = this.type === 'litoral' ? this.coastSide % 2 === 0 : rng.chance(0.5);
    const start = rng.range(0.25, 0.75) * size;
    const end = rng.range(0.25, 0.75) * size;
    const samples = 220;
    const ph1 = rng.range(0, 6.28), ph2 = rng.range(0, 6.28);
    const meander = this.type === 'planicie' ? 220 : this.type === 'serra' ? 120 : 170;
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const base = lerp(start, end, t);
      const off = Math.sin(t * 9 + ph1) * meander * 0.6 + Math.sin(t * 17 + ph2) * meander * 0.25 + nz3.noise(t * 4, 3.3) * meander * 0.5;
      const along = t * (size + 200) - 100;
      pts.push(axisVertical ? { x: base + off, z: along } : { x: along, z: base + off });
    }
    // Downstream end must reach the coast (litoral) or a random edge
    if (this.type === 'litoral') {
      if (this.coastSide === 0 || this.coastSide === 3) pts.reverse();
    } else if (rng.chance(0.5)) pts.reverse();
    this.river = pts;
    this.riverWidth = this.type === 'serra' ? 30 : 44;

    // --- heights ---
    const H = this.heights;
    for (let j = 0; j < hres; j++) {
      for (let i = 0; i < hres; i++) {
        const x = i * step, z = j * step;
        const k = j * hres + i;
        const d = this.distToRiver(x, z);
        this.riverDist[k] = d;
        const fx = x / size, fz = z / size;
        let h: number;
        const base = nz.fbm(fx * 3.2, fz * 3.2, 5) * 0.5 + 0.5;
        if (this.type === 'serra') {
          const ridge = 1 - Math.abs(nz2.fbm(fx * 2.4, fz * 2.4, 4));
          h = 6 + amp * (0.45 * base + 0.55 * ridge * ridge) * smoothstep(60, 700, d);
        } else if (this.type === 'planicie') {
          h = 3 + amp * base + 6 * smoothstep(100, 900, d);
        } else {
          const valley = smoothstep(40, 1100, d);
          h = 3 + amp * (0.35 * base + 0.75 * valley * (0.6 + 0.6 * base));
          const hills = Math.max(0, nz2.fbm(fx * 4, fz * 4, 4));
          h += hills * amp * 0.5 * valley;
        }
        if (this.type === 'litoral') {
          const c = this.coastDist(x, z, nz3);
          h = Math.min(h, lerp(-14, h, smoothstep(-40, 380, c)));
          if (c > -40 && c < 120) h = Math.min(h, lerp(-2, 3.2, smoothstep(-40, 120, c)) + base * 0.6); // beaches
        }
        // Carve river channel
        const half = this.riverWidth / 2;
        const bed = -4;
        if (d < half) h = bed;
        else h = Math.min(h, lerp(0.6, h, smoothstep(half, half + 120, d)) + (d < half + 12 ? -1.2 : 0));
        // lakes (not in serra highlands)
        const lake = nz3.noise(fx * 5 + 11, fz * 5 - 4);
        if (lake > 0.72 && this.type !== 'serra') h = Math.min(h, lerp(h, -3, smoothstep(0.72, 0.8, lake)));
        // keep map edges sane
        H[k] = h;
      }
    }
    // --- masks ---
    for (let j = 0; j < hres; j++) {
      for (let i = 0; i < hres; i++) {
        const k = j * hres + i;
        const h = H[k];
        this.water[k] = h < this.seaLevel ? 1 : 0;
        const slope = this.slopeIdx(i, j);
        const fx = (i * step) / size, fz = (j * step) / size;
        const f = nz2.fbm(fx * 6 + 40, fz * 6 + 40, 4);
        this.forest[k] = this.water[k] ? 0 : clamp((f + 0.05) * 2.2 + slope * 1.5, 0, 1) * (h > 0.8 ? 1 : 0);
        this.flood[k] = !this.water[k] && h < 2.4 && this.riverDist[k] < 320 ? 1 : 0;
      }
    }
    // --- trees ---
    const tr: number[] = [];
    const ts = 11;
    for (let z = ts / 2; z < size; z += ts) {
      for (let x = ts / 2; x < size; x += ts) {
        const px = x + rng.range(-4, 4), pz = z + rng.range(-4, 4);
        const f = this.sample(this.forest, px, pz);
        const h = this.heightAt(px, pz);
        if (h < 0.6) continue;
        if (rng.next() < f * 0.75 + 0.012) {
          const type = h > 45 || this.type === 'serra' ? (rng.chance(0.7) ? 1 : 0) : rng.chance(0.2) ? 1 : 0;
          tr.push(px, h, pz, rng.range(0.7, 1.4), this.type === 'litoral' && h < 6 && rng.chance(0.5) ? 2 : type);
        }
      }
    }
    this.trees = new Float32Array(tr);
    this.treeAlive = new Uint8Array(tr.length / 5).fill(1);
  }

  private coastDist(x: number, z: number, nz: Noise2D): number {
    // positive = inland distance from the coastline
    const s = this.size;
    const wob = nz.fbm((this.coastSide % 2 === 0 ? x : z) / s * 3, 7.7, 3) * 160;
    const line = s * 0.2 + wob;
    switch (this.coastSide) {
      case 0: return z - line; // sea at z=0
      case 1: return s - x - line; // sea at x=size
      case 2: return s - z - line;
      default: return x - line;
    }
  }

  distToRiver(x: number, z: number): number {
    let best = Infinity;
    const p = this.river;
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const l2 = dx * dx + dz * dz;
      let t = ((x - a.x) * dx + (z - a.z) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = a.x + dx * t - x, ez = a.z + dz * t - z;
      const d = ex * ex + ez * ez;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  /** index of the river polyline point nearest to (x,z) */
  riverIndex(x: number, z: number): number {
    let best = Infinity, bi = 0;
    for (let i = 0; i < this.river.length; i++) {
      const dx = this.river[i].x - x, dz = this.river[i].z - z;
      const d = dx * dx + dz * dz;
      if (d < best) { best = d; bi = i; }
    }
    return bi;
  }

  private slopeIdx(i: number, j: number): number {
    const { hres, heights: H, step } = this;
    const i0 = Math.max(0, i - 1), i1 = Math.min(hres - 1, i + 1);
    const j0 = Math.max(0, j - 1), j1 = Math.min(hres - 1, j + 1);
    const dx = (H[j * hres + i1] - H[j * hres + i0]) / ((i1 - i0) * step);
    const dz = (H[j1 * hres + i] - H[j0 * hres + i]) / ((j1 - j0) * step);
    return Math.sqrt(dx * dx + dz * dz);
  }

  sample(arr: Float32Array, x: number, z: number): number {
    const { hres, step } = this;
    const fx = clamp(x / step, 0, hres - 1.001), fz = clamp(z / step, 0, hres - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const k = j * hres + i;
    const a = arr[k], b = arr[k + 1], c = arr[k + hres], d = arr[k + hres + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  heightAt(x: number, z: number): number {
    return this.sample(this.heights, x, z);
  }

  /** Height matching the exact planar triangles of Three.js PlaneGeometry (same diagonal as TerrainView.meshY). */
  meshY(x: number, z: number): number {
    const { hres, step, heights } = this;
    const fx = clamp(x / step, 0, hres - 1.0001);
    const fz = clamp(z / step, 0, hres - 1.0001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const ha = heights[j * hres + i];
    const hd = heights[j * hres + i + 1];
    const hb = heights[(j + 1) * hres + i];
    const hc = heights[(j + 1) * hres + i + 1];
    return u + v <= 1 ? ha + (hd - ha) * u + (hb - ha) * v : hc + (hb - hc) * (1 - u) + (hd - hc) * (1 - v);
  }

  slopeAt(x: number, z: number): number {
    const e = 6;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return Math.sqrt(dx * dx + dz * dz);
  }

  isWater(x: number, z: number): boolean {
    return this.heightAt(x, z) < this.seaLevel + 0.2;
  }

  isFlood(x: number, z: number): boolean {
    const { hres, step } = this;
    const i = clamp(Math.round(x / step), 0, hres - 1), j = clamp(Math.round(z / step), 0, hres - 1);
    return this.flood[j * hres + i] === 1;
  }

  inside(x: number, z: number, margin = 0): boolean {
    return x > margin && z > margin && x < this.size - margin && z < this.size - margin;
  }

  /** Flatten terrain under a rectangle (dike / terraform). Returns true if changed. */
  raiseRect(cx: number, cz: number, r: number, h: number) {
    const { hres, step } = this;
    const i0 = Math.max(0, Math.floor((cx - r) / step)), i1 = Math.min(hres - 1, Math.ceil((cx + r) / step));
    const j0 = Math.max(0, Math.floor((cz - r) / step)), j1 = Math.min(hres - 1, Math.ceil((cz + r) / step));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * hres + i;
      if (this.water[k]) continue;
      if (this.heights[k] < h) { this.heights[k] = h; this.flood[k] = 0; }
    }
  }
}
