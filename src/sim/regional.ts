import { MinHeap } from './heap';
import type { Terrain } from './terrain';

export interface P2 { x: number; z: number }

/** A* on a coarse terrain grid. Used for the regional highway, railway and long roads. */
export function terrainPath(T: Terrain, from: P2, to: P2, opts: { cell?: number; slopeW: number; waterW: number; maxSlope?: number; avoid?: (x: number, z: number) => number }): P2[] {
  const c = opts.cell ?? 25;
  const G = Math.ceil(T.size / c);
  const N = G * G;
  const g = new Float32Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const H = new Float32Array(N);
  const W = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    const x = ((k % G) + 0.5) * c, z = (Math.floor(k / G) + 0.5) * c;
    H[k] = T.heightAt(x, z);
    W[k] = H[k] < T.seaLevel + 0.3 ? 1 : 0;
  }
  const idx = (p: P2) => Math.min(G - 1, Math.max(0, Math.floor(p.z / c))) * G + Math.min(G - 1, Math.max(0, Math.floor(p.x / c)));
  const s = idx(from), t = idx(to);
  const tx = t % G, tz = Math.floor(t / G);
  const heap = new MinHeap();
  g[s] = 0;
  heap.push(s, 0);
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 1], [1, 2], [-2, 1], [-1, 2], [2, -1], [1, -2], [-2, -1], [-1, -2]];
  const closed = new Uint8Array(N);
  while (heap.size) {
    const u = heap.pop();
    if (closed[u]) continue;
    closed[u] = 1;
    if (u === t) break;
    const ux = u % G, uz = Math.floor(u / G);
    for (const [dx, dz] of dirs) {
      const vx = ux + dx, vz = uz + dz;
      if (vx < 0 || vz < 0 || vx >= G || vz >= G) continue;
      const v = vz * G + vx;
      if (closed[v]) continue;
      const dist = Math.hypot(dx, dz) * c;
      const slope = Math.abs(Math.max(0, H[v]) - Math.max(0, H[u])) / dist;
      if (opts.maxSlope && slope > opts.maxSlope && !W[v] && !W[u]) continue;
      let cost = dist * (1 + slope * opts.slopeW) + (W[v] ? opts.waterW * dist : 0);
      if (opts.avoid) cost += opts.avoid(vx * c, vz * c) * dist;
      const ng = g[u] + cost;
      if (ng < g[v]) {
        g[v] = ng; prev[v] = u;
        heap.push(v, ng + Math.hypot(vx - tx, vz - tz) * c);
      }
    }
  }
  const out: P2[] = [];
  let u = t;
  while (u >= 0) {
    out.push({ x: ((u % G) + 0.5) * c, z: (Math.floor(u / G) + 0.5) * c });
    if (u === s) break;
    u = prev[u];
  }
  out.reverse();
  out[0] = { ...from };
  out[out.length - 1] = { ...to };
  return out;
}

export function simplify(pts: P2[], tol: number): P2[] {
  if (pts.length < 3) return pts.slice();
  let maxD = 0, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointSegDist(pts[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= tol) return [a, b];
  const l = simplify(pts.slice(0, idx + 1), tol);
  const r = simplify(pts.slice(idx), tol);
  return l.slice(0, -1).concat(r);
}

export function chaikin(pts: P2[], iters: number): P2[] {
  let p = pts;
  for (let it = 0; it < iters; it++) {
    const o: P2[] = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      o.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      o.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    o.push(p[p.length - 1]);
    p = o;
  }
  return p;
}

export function resample(pts: P2[], step: number): P2[] {
  const out: P2[] = [pts[0]];
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    let pos = step - acc;
    while (pos < l) {
      const t = pos / l;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      pos += step;
    }
    acc = l - (pos - step);
  }
  const last = pts[pts.length - 1];
  const pl = out[out.length - 1];
  if (Math.hypot(last.x - pl.x, last.z - pl.z) < step * 0.4) out[out.length - 1] = last; else out.push(last);
  return out;
}

export function pointSegDist(p: P2, a: P2, b: P2): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const l2 = dx * dx + dz * dz || 1;
  let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z);
}

export function polyLength(p: P2[]): number {
  let l = 0;
  for (let i = 0; i < p.length - 1; i++) l += Math.hypot(p[i + 1].x - p[i].x, p[i + 1].z - p[i].z);
  return l;
}

/** point on the map border, side 0..3 */
export function borderPoint(size: number, side: number, t: number, inset = 8): P2 {
  switch (side) {
    case 0: return { x: t * size, z: inset };
    case 1: return { x: size - inset, z: t * size };
    case 2: return { x: t * size, z: size - inset };
    default: return { x: inset, z: t * size };
  }
}
