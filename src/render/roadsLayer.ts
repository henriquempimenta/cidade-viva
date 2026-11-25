import * as THREE from 'three';
import { LANE_WIDTH, RoadClass } from '../shared/constants';
import {
  computeUrbanSidewalkSet, CROSSWALK_HALF_LEN, CROSSWALK_INSET, edgeHalfWidth, hasEndCrosswalk,
  nodeRenderRadius, resolveViaductPierPlacement, sampleCutsMinY, sampleRoadSurfaceY, SIDEWALK_WIDTH,
  STOP_LINE_GAP, widthTaperLength, type RoadClearanceHit, type TerrainCut,
} from '../shared/roadGeom';
import type { EdgeView, NodeView } from '../shared/protocol';
import { GB } from './geomBuilder';
import { U } from './uniforms';
import { bendLine, junction, type Arm } from './junctions';

export { edgeHalfWidth, resolveViaductPierPlacement };

const COL = {
  asphalt: new THREE.Color(0x3d4044), asphaltOld: new THREE.Color(0x5c5f64),
  patchDark: new THREE.Color(0x2b2d30), patchLight: new THREE.Color(0x6b6e73),
  dirt: new THREE.Color(0x9b7f5a), earth: new THREE.Color(0x7d6243),
  walk: new THREE.Color(0xb9b4aa), walkOld: new THREE.Color(0x9c988e),
  curb: new THREE.Color(0xd2cdc2), retain: new THREE.Color(0x8e8980),
  white: new THREE.Color(0xf2f2ee), yellow: new THREE.Color(0xf2c230),
  median: new THREE.Color(0x6f9e4c), bus: new THREE.Color(0x9c3b34), concrete: new THREE.Color(0xb8b3aa), concreteDark: new THREE.Color(0x969188),
  tunnel: new THREE.Color(0x1d1f22), rail: new THREE.Color(0x777777),
};

interface PL { x: number[]; y: number[]; z: number[]; s: number[] }
function toPL(pts: number[]): PL {
  const pl: PL = { x: [], y: [], z: [], s: [] };
  let acc = 0;
  for (let i = 0; i < pts.length; i += 3) {
    if (i > 0) acc += Math.hypot(pts[i] - pts[i - 3], pts[i + 2] - pts[i - 1]);
    pl.x.push(pts[i]); pl.y.push(pts[i + 1]); pl.z.push(pts[i + 2]); pl.s.push(acc);
  }
  return pl;
}
function at(pl: PL, s: number): [number, number, number, number, number] {
  const n = pl.s.length;
  if (s <= 0) { const tx = pl.x[1] - pl.x[0], tz = pl.z[1] - pl.z[0], l = Math.hypot(tx, tz) || 1; return [pl.x[0], pl.y[0], pl.z[0], tx / l, tz / l]; }
  for (let i = 1; i < n; i++) {
    if (pl.s[i] >= s || i === n - 1) {
      const t = Math.min(1, (s - pl.s[i - 1]) / Math.max(1e-6, pl.s[i] - pl.s[i - 1]));
      const tx = pl.x[i] - pl.x[i - 1], tz = pl.z[i] - pl.z[i - 1], l = Math.hypot(tx, tz) || 1;
      return [pl.x[i - 1] + tx * t, pl.y[i - 1] + (pl.y[i] - pl.y[i - 1]) * t, pl.z[i - 1] + tz * t, tx / l, tz / l];
    }
  }
  return [pl.x[n - 1], pl.y[n - 1], pl.z[n - 1], 1, 0];
}

/** Lift a polyline's center heights so the full width [-hw, +hw] clears the exact triangle meshY everywhere. */
function liftSurfacePL(
  pl: PL, hw: number, ground: (x: number, z: number) => number, step = 4, onlyEnds = false,
  skipRanges?: { s0: number; s1: number }[],
): PL {
  const len = pl.s[pl.s.length - 1];
  const n = Math.max(1, Math.ceil(len / step));
  const sVals: number[] = [];
  for (let i = 0; i <= n; i++) sVals.push((len * i) / n);
  // Explicitly anchor exact underpass mouth coordinates so interpolation never sags across a cut seam
  if (skipRanges?.length) {
    for (const r of skipRanges) {
      if (r.s0 > 0.01 && r.s0 < len - 0.01) sVals.push(r.s0);
      if (r.s1 > 0.01 && r.s1 < len - 0.01) sVals.push(r.s1);
    }
    sVals.sort((a, b) => a - b);
  }
  const out: PL = { x: [], y: [], z: [], s: [] };
  for (let i = 0; i < sVals.length; i++) {
    const s = sVals[i];
    if (out.s.length && Math.abs(s - out.s[out.s.length - 1]) < 1e-4) continue;
    const q = at(pl, s);
    let y = q[1];
    const skipped = skipRanges?.some((r) => s > r.s0 + 0.01 && s < r.s1 - 0.01) ?? false;
    if (!skipped && (!onlyEnds || s <= 14 || s >= len - 14)) {
      const sy = sampleRoadSurfaceY(q[0], q[2], -q[4], q[3], hw, ground, y);
      if (sy > y) y = sy;
    }
    out.x.push(q[0]); out.y.push(y); out.z.push(q[2]); out.s.push(s);
  }
  return out;
}

/**
 * Adaptive terrain-conforming quad emitter (P1-04 + P1-03):
 * Emits 2 triangles immediately when flat/clear (fast path, ~85%+ of city roads), and recursively
 * subdivides ONLY where a convex heightmap ridge pokes > 0.02 m into the quad. Zero temporary arrays
 * in the hot path; leaf quads guarantee 0.000 m terrain intrusion at all centroids and edge midpoints.
 */
function emitAdaptiveQuad(
  g: GB,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
  col: THREE.Color,
  ground: (x: number, z: number) => number,
  minClear: number,
  depth: number,
  minSplit2 = 4.0,
) {
  const lenS2 = Math.max((bx - ax) * (bx - ax) + (bz - az) * (bz - az), (cx - dx) * (cx - dx) + (cz - dz) * (cz - dz));
  const lenW2 = Math.max((cx - bx) * (cx - bx) + (cz - bz) * (cz - bz), (dx - ax) * (dx - ax) + (dz - az) * (dz - az));

  const abx = (ax + bx) * 0.5, abz = (az + bz) * 0.5, aby = (ay + by) * 0.5;
  const cdx = (cx + dx) * 0.5, cdz = (cz + dz) * 0.5, cdy = (cy + dy) * 0.5;

  // Fast path for narrow strips (curbs, yellow lines, dashes <= 0.6 m wide): sample only centerline (3-4 lookups vs 15+)
  if (lenW2 < 0.4) {
    const mx = (abx + cdx) * 0.5, mz = (abz + cdz) * 0.5, my = (aby + cdy) * 0.5;
    const gM = ground(mx, mz);
    let maxNeed = gM + minClear - my;
    if (lenS2 > 16) {
      const m0x = (ax + dx) * 0.5, m0z = (az + dz) * 0.5, m0y = (ay + dy) * 0.5;
      const m1x = (bx + cx) * 0.5, m1z = (bz + cz) * 0.5, m1y = (by + cy) * 0.5;
      const n1 = ground(m0x * 0.75 + m1x * 0.25, m0z * 0.75 + m1z * 0.25) + minClear - (m0y * 0.75 + m1y * 0.25);
      if (n1 > maxNeed) maxNeed = n1;
      const n3 = ground(m0x * 0.25 + m1x * 0.75, m0z * 0.25 + m1z * 0.75) + minClear - (m0y * 0.25 + m1y * 0.75);
      if (n3 > maxNeed) maxNeed = n3;
    }
    if (maxNeed <= 0) {
      g.quadUp(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, col);
      return;
    }
    if (depth > 0 && maxNeed > 0.015 && lenS2 > minSplit2) {
      const mABy = Math.max(aby, ground(abx, abz) + minClear);
      const mCDy = Math.max(cdy, ground(cdx, cdz) + minClear);
      emitAdaptiveQuad(g, ax, ay, az, abx, mABy, abz, cdx, mCDy, cdz, dx, dy, dz, col, ground, minClear, depth - 1, minSplit2);
      emitAdaptiveQuad(g, abx, mABy, abz, bx, by, bz, cx, cy, cz, cdx, mCDy, cdz, col, ground, minClear, depth - 1, minSplit2);
      return;
    }
    const bump = maxNeed + 0.005;
    g.quadUp(ax, ay + bump, az, bx, by + bump, bz, cx, cy + bump, cz, dx, dy + bump, dz, col);
    return;
  }

  const bcx = (bx + cx) * 0.5, bcz = (bz + cz) * 0.5, bcy = (by + cy) * 0.5;
  const dax = (dx + ax) * 0.5, daz = (dz + az) * 0.5, day = (dy + ay) * 0.5;
  const acx = (ax + cx) * 0.5, acz = (az + cz) * 0.5, acy = (ay + cy) * 0.5;

  const gAB = ground(abx, abz), gBC = ground(bcx, bcz), gCD = ground(cdx, cdz), gDA = ground(dax, daz), gAC = ground(acx, acz);
  let maxNeed = gAB + minClear - aby;
  const nBC = gBC + minClear - bcy; if (nBC > maxNeed) maxNeed = nBC;
  const nCD = gCD + minClear - cdy; if (nCD > maxNeed) maxNeed = nCD;
  const nDA = gDA + minClear - day; if (nDA > maxNeed) maxNeed = nDA;
  const nAC = gAC + minClear - acy; if (nAC > maxNeed) maxNeed = nAC;

  if (lenS2 > 16 || lenW2 > 16) {
    // 4 interior quarter-points + quarter-edge samples on long edges (> 4 m) catch every heightmap grid ridge
    const q1x = (ax * 9 + bx * 3 + cx + dx * 3) * 0.0625, q1z = (az * 9 + bz * 3 + cz + dz * 3) * 0.0625, q1y = (ay * 9 + by * 3 + cy + dy * 3) * 0.0625;
    const q2x = (ax * 3 + bx * 9 + cx * 3 + dx) * 0.0625, q2z = (az * 3 + bz * 9 + cz * 3 + dz) * 0.0625, q2y = (ay * 3 + by * 9 + cy * 3 + dy) * 0.0625;
    const q3x = (ax + bx * 3 + cx * 9 + dx * 3) * 0.0625, q3z = (az + bz * 3 + cz * 9 + dz * 3) * 0.0625, q3y = (ay + by * 3 + cy * 9 + dy * 3) * 0.0625;
    const q4x = (ax * 3 + bx + cx * 3 + dx * 9) * 0.0625, q4z = (az * 3 + bz + cz * 3 + dz * 9) * 0.0625, q4y = (ay * 3 + by + cy * 3 + dy * 9) * 0.0625;
    let nQ = ground(q1x, q1z) + minClear - q1y; if (nQ > maxNeed) maxNeed = nQ;
    nQ = ground(q2x, q2z) + minClear - q2y; if (nQ > maxNeed) maxNeed = nQ;
    nQ = ground(q3x, q3z) + minClear - q3y; if (nQ > maxNeed) maxNeed = nQ;
    nQ = ground(q4x, q4z) + minClear - q4y; if (nQ > maxNeed) maxNeed = nQ;
    if (lenS2 > 16) {
      nQ = ground(ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25) + minClear - (ay * 0.75 + by * 0.25); if (nQ > maxNeed) maxNeed = nQ;
      nQ = ground(ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75) + minClear - (ay * 0.25 + by * 0.75); if (nQ > maxNeed) maxNeed = nQ;
      nQ = ground(dx * 0.75 + cx * 0.25, dz * 0.75 + cz * 0.25) + minClear - (dy * 0.75 + cy * 0.25); if (nQ > maxNeed) maxNeed = nQ;
      nQ = ground(dx * 0.25 + cx * 0.75, dz * 0.25 + cz * 0.75) + minClear - (dy * 0.25 + cy * 0.75); if (nQ > maxNeed) maxNeed = nQ;
    }
    if (lenW2 > 16) {
      nQ = ground(ax * 0.75 + dx * 0.25, az * 0.75 + dz * 0.25) + minClear - (ay * 0.75 + dy * 0.25); if (nQ > maxNeed) maxNeed = nQ;
      nQ = ground(ax * 0.25 + dx * 0.75, az * 0.25 + dz * 0.75) + minClear - (ay * 0.25 + dy * 0.75); if (nQ > maxNeed) maxNeed = nQ;
      nQ = ground(bx * 0.75 + cx * 0.25, bz * 0.75 + cz * 0.25) + minClear - (by * 0.75 + cy * 0.25); if (nQ > maxNeed) maxNeed = nQ;
      nQ = ground(bx * 0.25 + cx * 0.75, bz * 0.25 + cz * 0.75) + minClear - (by * 0.25 + cy * 0.75); if (nQ > maxNeed) maxNeed = nQ;
    }
  } else {
    const c1x = (ax + bx + cx) / 3, c1z = (az + bz + cz) / 3, c1y = (ay + by + cy) / 3;
    const c2x = (ax + cx + dx) / 3, c2z = (az + cz + dz) / 3, c2y = (ay + cy + dy) / 3;
    const nC1 = ground(c1x, c1z) + minClear - c1y; if (nC1 > maxNeed) maxNeed = nC1;
    const nC2 = ground(c2x, c2z) + minClear - c2y; if (nC2 > maxNeed) maxNeed = nC2;
  }

  if (maxNeed <= 0) {
    g.quadUp(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, col);
    return;
  }

  if (depth > 0 && maxNeed > 0.015) {
    const splitS = lenS2 > minSplit2;
    const splitW = lenW2 > minSplit2;
    if (splitS && splitW) {
      const mABy = Math.max(aby, gAB + minClear);
      const mBCy = Math.max(bcy, gBC + minClear);
      const mCDy = Math.max(cdy, gCD + minClear);
      const mDAy = Math.max(day, gDA + minClear);
      const mx = (ax + bx + cx + dx) * 0.25, mz = (az + bz + cz + dz) * 0.25;
      const my = Math.max((ay + by + cy + dy) * 0.25, ground(mx, mz) + minClear);
      emitAdaptiveQuad(g, ax, ay, az, abx, mABy, abz, mx, my, mz, dax, mDAy, daz, col, ground, minClear, depth - 1, minSplit2);
      emitAdaptiveQuad(g, abx, mABy, abz, bx, by, bz, bcx, mBCy, bcz, mx, my, mz, col, ground, minClear, depth - 1, minSplit2);
      emitAdaptiveQuad(g, mx, my, mz, bcx, mBCy, bcz, cx, cy, cz, cdx, mCDy, cdz, col, ground, minClear, depth - 1, minSplit2);
      emitAdaptiveQuad(g, dax, mDAy, daz, mx, my, mz, cdx, mCDy, cdz, dx, dy, dz, col, ground, minClear, depth - 1, minSplit2);
      return;
    }
    if (splitS) {
      const mABy = Math.max(aby, gAB + minClear);
      const mCDy = Math.max(cdy, gCD + minClear);
      emitAdaptiveQuad(g, ax, ay, az, abx, mABy, abz, cdx, mCDy, cdz, dx, dy, dz, col, ground, minClear, depth - 1, minSplit2);
      emitAdaptiveQuad(g, abx, mABy, abz, bx, by, bz, cx, cy, cz, cdx, mCDy, cdz, col, ground, minClear, depth - 1, minSplit2);
      return;
    }
    if (splitW) {
      const mBCy = Math.max(bcy, gBC + minClear);
      const mDAy = Math.max(day, gDA + minClear);
      emitAdaptiveQuad(g, ax, ay, az, bx, by, bz, bcx, mBCy, bcz, dax, mDAy, daz, col, ground, minClear, depth - 1, minSplit2);
      emitAdaptiveQuad(g, dax, mDAy, daz, bcx, mBCy, bcz, cx, cy, cz, dx, dy, dz, col, ground, minClear, depth - 1, minSplit2);
      return;
    }
  }

  // Leaf guarantee: raise minimally so every centroid & edge midpoint clears ground + minClear
  const bump = maxNeed + 0.005;
  g.quadUp(ax, ay + bump, az, bx, by + bump, bz, cx, cy + bump, cz, dx, dy + bump, dz, col);
}

function ribbon(
  g: GB, pl: PL, s0: number, s1: number, o0: number, o1: number, dy: number, c: THREE.Color, step = 8,
  ground?: (x: number, z: number) => number, minClear = 0.18,
) {
  if (s1 - s0 < 0.2) return;
  if (!ground) {
    const n = Math.max(1, Math.ceil((s1 - s0) / step));
    let prev = at(pl, s0);
    for (let i = 1; i <= n; i++) {
      const cur = at(pl, s0 + ((s1 - s0) * i) / n);
      g.quadUp(
        prev[0] - prev[4] * o1, prev[1] + dy, prev[2] + prev[3] * o1,
        cur[0] - cur[4] * o1, cur[1] + dy, cur[2] + cur[3] * o1,
        cur[0] - cur[4] * o0, cur[1] + dy, cur[2] + cur[3] * o0,
        prev[0] - prev[4] * o0, prev[1] + dy, prev[2] + prev[3] * o0,
        c,
      );
      prev = cur;
    }
    return;
  }

  // Adaptive terrain-conforming ribbon: lightweight coarse spans on flat roads, local refinement strictly on ridges
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  let prev = at(pl, s0);
  let p0x = prev[0] - prev[4] * o0, p0z = prev[2] + prev[3] * o0;
  let p0y = Math.max(prev[1] + dy, ground(p0x, p0z) + minClear);
  let p1x = prev[0] - prev[4] * o1, p1z = prev[2] + prev[3] * o1;
  let p1y = Math.max(prev[1] + dy, ground(p1x, p1z) + minClear);
  const maxDepth = Math.abs(o1 - o0) > 4 || step > 5 ? 3 : 2;
  const minSplit2 = step <= 1.0 ? 0.64 : 4.0;
  for (let i = 1; i <= n; i++) {
    const cur = at(pl, s0 + ((s1 - s0) * i) / n);
    const c0x = cur[0] - cur[4] * o0, c0z = cur[2] + cur[3] * o0;
    const c0y = Math.max(cur[1] + dy, ground(c0x, c0z) + minClear);
    const c1x = cur[0] - cur[4] * o1, c1z = cur[2] + cur[3] * o1;
    const c1y = Math.max(cur[1] + dy, ground(c1x, c1z) + minClear);
    emitAdaptiveQuad(g, p1x, p1y, p1z, c1x, c1y, c1z, c0x, c0y, c0z, p0x, p0y, p0z, c, ground, minClear, maxDepth, minSplit2);
    p0x = c0x; p0y = c0y; p0z = c0z;
    p1x = c1x; p1y = c1y; p1z = c1z;
  }
}

/** Vertical retaining/curb skirt along offset `o` from lifted top down to ground (when top - ground > threshold). */
function groundSkirt(
  g: GB, pl: PL, s0: number, s1: number, o: number, dy: number, c: THREE.Color,
  ground: (x: number, z: number) => number, minClear = 0.16, thresh = 0.12, step = 4,
) {
  if (s1 - s0 < 0.2) return;
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  let prev = at(pl, s0);
  const sd = Math.sign(o || 1);
  for (let i = 1; i <= n; i++) {
    const cur = at(pl, s0 + ((s1 - s0) * i) / n);
    const ax = prev[0] - prev[4] * o, az = prev[2] + prev[3] * o;
    const bx = cur[0] - cur[4] * o, bz = cur[2] + cur[3] * o;
    const ga = ground(ax, az), gb = ground(bx, bz);
    const ya = Math.max(prev[1] + dy, ga + minClear);
    const yb = Math.max(cur[1] + dy, gb + minClear);
    if (ga > -1e8 && gb > -1e8 && (ya - ga > thresh || yb - gb > thresh)) {
      const nx = -cur[4] * sd, nz = cur[3] * sd;
      g.quad([[ax, ga - 0.35, az], [bx, gb - 0.35, bz], [bx, yb, bz], [ax, ya, az]], [nx, 0, nz], c);
    }
    prev = cur;
  }
}

/** vertical wall along a polyline at lateral offset o, from dy0 to dy1 above it (double-sided material) */
function wall(g: GB, pl: PL, s0: number, s1: number, o: number, dy0: number, dy1: number, c: THREE.Color, step = 6) {
  if (s1 - s0 < 0.2) return;
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  let prev = at(pl, s0);
  for (let i = 1; i <= n; i++) {
    const cur = at(pl, s0 + ((s1 - s0) * i) / n);
    const P = (q: [number, number, number, number, number], dy: number) => [q[0] - q[4] * o, q[1] + dy, q[2] + q[3] * o];
    const nx = -cur[4] * Math.sign(o || 1), nz = cur[3] * Math.sign(o || 1);
    g.quad([P(prev, dy0), P(cur, dy0), P(cur, dy1), P(prev, dy1)], [nx, 0, nz], c);
    prev = cur;
  }
}
/** parts of [s0,s1] outside the given holes */
function spans(s0: number, s1: number, holes: { s0: number; s1: number }[]): [number, number][] {
  let out: [number, number][] = [[s0, s1]];
  for (const h of holes) {
    const next: [number, number][] = [];
    for (const [a, b] of out) {
      if (h.s1 <= a || h.s0 >= b) { next.push([a, b]); continue; }
      if (h.s0 > a) next.push([a, h.s0]);
      if (h.s1 < b) next.push([h.s1, b]);
    }
    out = next;
  }
  return out.filter(([a, b]) => b - a > 0.3);
}
function dashes(
  g: GB, pl: PL, s0: number, s1: number, off: number, w: number, dash: number, gap: number, dy: number, c: THREE.Color,
  ground?: (x: number, z: number) => number, minClear = 0.215,
) {
  for (let s = s0; s + dash <= s1; s += dash + gap) ribbon(g, pl, s, s + dash, off - w / 2, off + w / 2, dy, c, dash, ground, minClear);
}

export class RoadsLayer {
  group = new THREE.Group();
  /** terrain height sampler (set by the app to TerrainView.meshY) so roads & junctions never sink under triangles */
  ground: (x: number, z: number) => number = () => -1e9;
  /** carved terrain height sampler including all active `setCuts` trenches (set by App to TerrainView.cutY) */
  cutGround?: (x: number, z: number) => number;
  nodes = new Map<number, NodeView>();
  edges = new Map<number, EdgeView>();
  private mesh: THREE.Mesh | null = null;
  private bridgeMesh: THREE.Mesh | null = null;
  private dirty = false;
  private lastBuild = 0;
  private mat: THREE.MeshStandardMaterial;
  private bridgeMat: THREE.MeshStandardMaterial;
  private poles: THREE.InstancedMesh;
  private lamps: THREE.InstancedMesh;
  private pools: THREE.InstancedMesh;
  private works = new Map<number, THREE.Group>();
  private cones: THREE.InstancedMesh;
  edgeMeshIndex: { start: number; end: number; id: number }[] = [];
  signals: THREE.InstancedMesh;
  private signalSlots: { node: number; edge: number; idx: number }[] = [];
  private signalPhase = new Map<number, number>();
  private elevatedPillars: THREE.InstancedMesh;

  constructor() {
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.mat.onBeforeCompile = (sh) => {
      sh.uniforms.uRain = U.uRain; sh.uniforms.uSnow = U.uSnow;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uRain; uniform float uSnow;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.25, uRain);')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9,0.92,0.95), uSnow*0.35);');
    };
    this.bridgeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide });
    const poleG = new THREE.CylinderGeometry(0.1, 0.14, 7, 5).translate(0, 3.5, 0);
    const armG = new THREE.BoxGeometry(1.8, 0.12, 0.12).translate(0.9, 7, 0);
    const pg = mergeSimple([poleG, armG]);
    this.poles = new THREE.InstancedMesh(pg, new THREE.MeshStandardMaterial({ color: 0x55595e, roughness: 0.6 }), 12000);
    this.poles.count = 0; this.poles.frustumCulled = false;
    this.lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, 0.18, 0.35), new THREE.MeshBasicMaterial({ color: 0xffd9a0 }), 12000);
    this.lamps.count = 0; this.lamps.frustumCulled = false;
    const poolG = new THREE.CircleGeometry(7, 12).rotateX(-Math.PI / 2);
    this.pools = new THREE.InstancedMesh(poolG, new THREE.MeshBasicMaterial({ color: 0xffb860, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }), 12000);
    this.pools.count = 0; this.pools.frustumCulled = false;
    this.pools.renderOrder = 3;
    const coneG = new THREE.ConeGeometry(0.25, 0.7, 6).translate(0, 0.35, 0);
    this.cones = new THREE.InstancedMesh(coneG, new THREE.MeshStandardMaterial({ color: 0xff6a10 }), 3000);
    this.cones.count = 0; this.cones.frustumCulled = false;
    this.signals = new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffffff }), 4000);
    this.signals.count = 0; this.signals.frustumCulled = false;
    const pil = new THREE.BoxGeometry(1.4, 1, 1.4).translate(0, 0.5, 0);
    this.elevatedPillars = new THREE.InstancedMesh(pil, new THREE.MeshStandardMaterial({ color: 0xb0aba2 }), 6000);
    this.elevatedPillars.count = 0;
    this.elevatedPillars.castShadow = true;
    this.elevatedPillars.receiveShadow = true;
    this.elevatedPillars.frustumCulled = false;
    this.group.add(this.poles, this.lamps, this.pools, this.cones, this.signals, this.elevatedPillars);
  }

  /** Force an immediate rebuild on next update (e.g. after terrain heights update). */
  markDirty() { this.dirty = true; this.lastBuild = 0; }

  private surfaceGeomCache: {
    nodes: { id: number; x: number; z: number; pavedR: number; edgeIds: number[] }[];
    bendArcs: { pts: number[]; hw: number; edgeIds: [number, number] }[];
  } | null = null;
  upsertNode(n: NodeView) { this.nodes.set(n.id, n); this.surfaceGeomCache = null; this.dirty = true; }
  upsertEdge(e: EdgeView) {
    const prev = this.edges.get(e.id);
    this.edges.set(e.id, e);
    this.surfaceGeomCache = null;
    const ptsMoved = !prev || prev.pts.length !== e.pts.length
      || Math.abs((prev.pts[1] ?? 0) - (e.pts[1] ?? 0)) > 0.02
      || Math.abs((prev.pts[prev.pts.length - 2] ?? 0) - (e.pts[e.pts.length - 2] ?? 0)) > 0.02;
    const wearMoved = !prev || Math.abs((prev.wear ?? 0) - (e.wear ?? 0)) >= 0.07;
    if (ptsMoved || wearMoved || prev.progress < 1 !== e.progress < 1 || prev.cls !== e.cls || prev.lanes !== e.lanes || prev.busLane !== e.busLane || prev.oneway !== e.oneway || prev.upgrading !== e.upgrading || prev.elevated !== e.elevated || prev.hole !== e.hole || prev.deck !== e.deck) this.dirty = true;
    this.updateWork(e);
  }
  removeEdge(id: number) { this.edges.delete(id); this.surfaceGeomCache = null; this.dirty = true; const w = this.works.get(id); if (w) { this.group.remove(w); this.works.delete(id); } }

  /** External terrain cuts (e.g. rail underpass trenches) that open a gap in at-grade street ribbons. */
  private externalCuts: TerrainCut[] = [];
  private externalCutsKey = '';
  setExternalCuts(cuts: TerrainCut[]) {
    const key = cuts.map((c) => c.hw.toFixed(1) + ':' + c.pts.map((v) => v.toFixed(1)).join(',')).join('|');
    if (key === this.externalCutsKey) return;
    this.externalCutsKey = key;
    this.externalCuts = cuts;
    this.dirty = true;
  }

  /** Carved terrain elevation for viaduct pier/column footings (accounts for road & rail `setCuts` trenches). */
  private pierGroundY(x: number, z: number): number {
    let y = this.ground(x, z);
    if (this.cutGround) y = Math.min(y, this.cutGround(x, z));
    if (this.cuts.length) y = Math.min(y, sampleCutsMinY(x, z, y, this.cuts));
    if (this.externalCuts.length) y = Math.min(y, sampleCutsMinY(x, z, y, this.externalCuts));
    return y;
  }

  private getSurfaceGeom() {
    if (this.surfaceGeomCache) return this.surfaceGeomCache;
    const byNode = new Map<number, EdgeView[]>();
    for (const e of this.edges.values()) {
      if (e.progress < 1 || e.bridge || e.elevated || e.tunnel || e.deck !== undefined) continue;
      for (const nid of [e.a, e.b]) {
        let arr = byNode.get(nid);
        if (!arr) byNode.set(nid, (arr = []));
        arr.push(e);
      }
    }
    const nodes: { id: number; x: number; z: number; pavedR: number; edgeIds: number[] }[] = [];
    const bendArcs: { pts: number[]; hw: number; edgeIds: [number, number] }[] = [];
    const armFromRaw = (nid: number, e: EdgeView, r: number): Arm => {
      const pl = toPL(e.pts), len = pl.s[pl.s.length - 1];
      const fromA = e.a === nid;
      const q0 = at(pl, fromA ? Math.min(r, len) : Math.max(0, len - r));
      return { x: q0[0], y: q0[1], z: q0[2], dx: fromA ? q0[3] : -q0[3], dz: fromA ? q0[4] : -q0[4], hw: edgeHalfWidth(e), walk: false };
    };
    for (const [nid, inc] of byNode) {
      const n = this.nodes.get(nid);
      if (!n) continue;
      const pavedR = inc.length >= 3
        ? nodeRenderRadius(n.control, inc)
        : Math.max(...inc.map((q0) => edgeHalfWidth(q0)));
      if (pavedR > 0) nodes.push({ id: nid, x: n.x, z: n.z, pavedR, edgeIds: inc.map((q0) => q0.id) });
      // Also cache curved Bezier bend arcs for deg === 2 nodes so viaduct piers never land on curved bend asphalt
      if (inc.length === 2 && inc[0].pts.length >= 6 && inc[1].pts.length >= 6) {
        const A0 = armFromRaw(nid, inc[0], 0), B0 = armFromRaw(nid, inc[1], 0);
        const turn = Math.acos(Math.max(-1, Math.min(1, -(A0.dx * B0.dx + A0.dz * B0.dz))));
        if (turn >= 0.1) {
          const lenA = toPL(inc[0].pts).s.at(-1)!, lenB = toPL(inc[1].pts).s.at(-1)!;
          const hw = Math.max(A0.hw, B0.hw);
          const br = Math.min(hw * (1 + turn) + 3, lenA * 0.35, lenB * 0.35);
          const A = armFromRaw(nid, inc[0], br), B = armFromRaw(nid, inc[1], br);
          bendArcs.push({ pts: bendLine(A, B, n.x, n.y, n.z, 10), hw, edgeIds: [inc[0].id, inc[1].id] });
        }
      }
    }
    this.surfaceGeomCache = { nodes, bendArcs };
    return this.surfaceGeomCache;
  }

  /**
   * Check whether a viaduct pier at `(x, z)` with clearance radius `r` obstructs ANY completed at-grade road,
   * curved deg=2 bend arc, junction polygon, or roundabout carriageway below. Shared with `RailLayer` via `App`.
   */
  queryRoadClearance(x: number, z: number, r = 1.6, excludeEdgeId = -1): RoadClearanceHit {
    let worst: RoadClearanceHit = { blocked: false };
    let bestMargin = Infinity;
    for (const below of this.edges.values()) {
      if (below.id === excludeEdgeId || below.progress < 1) continue;
      if (below.bridge || below.elevated || below.tunnel || below.deck !== undefined) continue;
      const pts = below.pts;
      if (pts.length < 6) continue;
      const hw = edgeHalfWidth(below);
      const thresh = hw + r;
      for (let k = 0; k + 3 < pts.length; k += 3) {
        const ax = pts[k], az = pts[k + 2], bx = pts[k + 3], bz = pts[k + 5];
        if (x < Math.min(ax, bx) - thresh || x > Math.max(ax, bx) + thresh || z < Math.min(az, bz) - thresh || z > Math.max(az, bz) + thresh) continue;
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
        if (d < thresh && d - hw < bestMargin) {
          bestMargin = d - hw;
          const l = Math.sqrt(l2) || 1;
          worst = { blocked: true, clearHalfW: hw + 1.6, ux: dx / l, uz: dz / l };
        }
      }
    }
    const { nodes, bendArcs } = this.getSurfaceGeom();
    // Cover curved Bezier bend pavement at deg === 2 nodes
    for (const arc of bendArcs) {
      if (excludeEdgeId >= 0 && arc.edgeIds[0] === excludeEdgeId && arc.edgeIds[1] === excludeEdgeId) continue;
      const pts = arc.pts;
      const thresh = arc.hw + r;
      for (let k = 0; k + 3 < pts.length; k += 3) {
        const ax = pts[k], az = pts[k + 2], bx = pts[k + 3], bz = pts[k + 5];
        if (x < Math.min(ax, bx) - thresh || x > Math.max(ax, bx) + thresh || z < Math.min(az, bz) - thresh || z > Math.max(az, bz) + thresh) continue;
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
        if (d < thresh && d - arc.hw < bestMargin) {
          bestMargin = d - arc.hw;
          const l = Math.sqrt(l2) || 1;
          worst = { blocked: true, clearHalfW: arc.hw + 1.6, ux: dx / l, uz: dz / l };
        }
      }
    }
    // Also cover paved junction polygons and roundabout carriageways (`nodeRenderRadius`)
    for (const nd of nodes) {
      if (excludeEdgeId >= 0 && nd.edgeIds.length === 1 && nd.edgeIds[0] === excludeEdgeId) continue;
      const thresh = nd.pavedR + r;
      const dx = x - nd.x, dz = z - nd.z;
      if (Math.abs(dx) > thresh || Math.abs(dz) > thresh) continue;
      const d = Math.hypot(dx, dz);
      if (d < thresh && d - nd.pavedR < bestMargin) {
        bestMargin = d - nd.pavedR;
        const l = d || 1;
        worst = { blocked: true, clearHalfW: nd.pavedR + 1.6, ux: -dz / l, uz: dx / l };
      }
    }
    return worst;
  }

  private nodeRCache = new Map<number, number>();
  private nodeR(id: number) {
    const n = this.nodes.get(id);
    if (!n || this.rdeg(n) <= 2) return 0;
    let r = this.nodeRCache.get(id);
    if (r === undefined) {
      r = nodeRenderRadius(n.control, this.edgesAt(id));
      this.nodeRCache.set(id, r);
    }
    return r;
  }

  update(now: number, night: number, simT: number) {
    if (this.dirty && now - this.lastBuild > 700) { this.rebuild(); this.lastBuild = now; this.dirty = false; }
    (this.lamps.material as THREE.MeshBasicMaterial).color.setRGB(0.35 + 1.4 * night, 0.32 + 1.2 * night, 0.25 + 0.8 * night);
    (this.pools.material as THREE.MeshBasicMaterial).opacity = 0.18 * night;
    for (const [id, g] of this.works) {
      const e = this.edges.get(id);
      if (!e) continue;
      const paver = g.userData.paver as THREE.Object3D;
      const pl = g.userData.pl as PL;
      const len = pl.s[pl.s.length - 1];
      const p = at(pl, len * Math.min(1, e.progress));
      paver.position.set(p[0], p[1], p[2]);
      paver.rotation.y = -Math.atan2(p[4], p[3]);
      paver.position.y += Math.sin(simT * 5) * 0.03;
    }
  }

  setSignals(arr: Int32Array) {
    this.signalPhase.clear();
    for (let i = 0; i < arr.length; i += 2) this.signalPhase.set(arr[i], arr[i + 1]);
    const c = new THREE.Color();
    for (let i = 0; i < this.signalSlots.length; i++) {
      const s = this.signalSlots[i];
      const ph = this.signalPhase.get(s.node);
      if (ph === undefined) { c.setRGB(0.2, 0.2, 0.2); this.signals.setColorAt(i, c); continue; }
      const green = (ph >> (s.idx % 16)) & 1;
      const yellow = (ph >> 16) & 1;
      if (green && !yellow) c.setRGB(0.1, 2.2, 0.4); else if (green && yellow) c.setRGB(2.4, 1.6, 0); else c.setRGB(2.4, 0.15, 0.1);
      this.signals.setColorAt(i, c);
    }
    if (this.signals.instanceColor) this.signals.instanceColor.needsUpdate = true;
  }

  private updateWork(e: EdgeView) {
    const active = e.progress < 1 || e.upgrading;
    let g = this.works.get(e.id);
    if (!active) { if (g) { this.group.remove(g); this.works.delete(e.id); this.dirty = true; } return; }
    if (!g) {
      g = new THREE.Group();
      const pv = new GB();
      pv.box(0, 0, 0, 5, 1.6, 3, new THREE.Color(0xf0b020));
      pv.box(-1.4, 1.6, 0, 1.6, 1.6, 2, new THREE.Color(0xf0b020));
      pv.box(2.6, 0, 0, 0.6, 0.5, 3.6, new THREE.Color(0x333333));
      pv.cylinder(-1.4, 3.2, 0.8, 0.1, 0.1, 1, 4, new THREE.Color(0x222222));
      const paver = new THREE.Mesh(pv.toGeometry(false), new THREE.MeshStandardMaterial({ vertexColors: true }));
      paver.castShadow = true;
      const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 2.6, 10).rotateX(Math.PI / 2).translate(-7, 0.9, 0), new THREE.MeshStandardMaterial({ color: 0x777777 }));
      const rb = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.6, 2).translate(-9, 1.3, 0), new THREE.MeshStandardMaterial({ color: 0xf0b020 }));
      paver.add(roller, rb);
      g.add(paver);
      g.userData.paver = paver;
      g.userData.pl = toPL(e.pts);
      this.works.set(e.id, g);
      this.group.add(g);
      this.dirty = true;
    } else g.userData.pl = toPL(e.pts);
  }

  private rebuild() {
    this.nodeRCache.clear();
    this.edgesByNode.clear();
    this.deckAt.clear();
    for (const e of this.edges.values()) {
      if (e.deck !== undefined && (e.tunnel || e.progress < 1)) { for (const nid of [e.a, e.b]) this.deckAt.set(nid, (this.deckAt.get(nid) ?? 0) + 1); continue; }
      if (e.progress < 1) continue;
      for (const nid of [e.a, e.b]) { let a = this.edgesByNode.get(nid); if (!a) this.edgesByNode.set(nid, (a = [])); a.push(e); }
    }
    const g = new GB();
    const bg = new GB();
    const poles: THREE.Matrix4[] = [];
    const cones: THREE.Matrix4[] = [];
    const pillars: THREE.Matrix4[] = [];
    this.signalSlots = [];
    const sigM: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    this.edgeMeshIndex = [];
    const plCache = new Map<number, PL>();
    const plOf = (e: EdgeView) => {
      let p = plCache.get(e.id);
      if (!p) {
        const raw = toPL(e.pts);
        const hw = edgeHalfWidth(e);
        if (!e.bridge && !e.elevated && !e.tunnel && e.deck === undefined) {
          const skip = this.externalCuts.length ? this.holesFromCuts(raw, this.externalCuts, 0) : undefined;
          p = liftSurfacePL(raw, hw, this.ground, skip?.length ? 2 : 4, false, skip);
        } else if (e.bridge && !e.elevated && e.deck === undefined) {
          // Over water ground < 0 so the water arch is untouched; over riverbank approaches both carriageway and walkways clear meshY
          p = liftSurfacePL(raw, hw + 1.45, this.ground, 4, false);
        } else {
          p = raw;
        }
        plCache.set(e.id, p);
      }
      return p;
    };
    // Single-source-of-truth sidewalk continuity matching trips.ts, terraforming.ts, and rail.ts 100%
    const edgeWalkSet = computeUrbanSidewalkSet(this.edges.values(), this.nodes);
    const edgeHasWalk = (e: EdgeView): boolean => edgeWalkSet.has(e.id);
    const isWaterBridgeJoint = (nid: number): boolean => {
      const nd = this.nodes.get(nid);
      if (!nd) return false;
      const inc = this.edgesAt(nid);
      return inc.length >= 2 && inc.every((q0) => q0.bridge && !q0.elevated && q0.deck === undefined) && this.ground(nd.x, nd.z) < 0.5;
    };
    const armOf = (nid: number, e: EdgeView, r: number): Arm => {
      const pl = plOf(e), len = pl.s[pl.s.length - 1];
      const fromA = e.a === nid;
      const q0 = at(pl, fromA ? Math.min(r, len) : Math.max(0, len - r));
      const walk = edgeHasWalk(e);
      return { x: q0[0], y: q0[1], z: q0[2], dx: fromA ? q0[3] : -q0[3], dz: fromA ? q0[4] : -q0[4], hw: edgeHalfWidth(e), walk };
    };
    const bendR = new Map<number, number>();
    const taperMap = new Map<number, { narrow: EdgeView; wide: EdgeView; narrowHW: number; wideHW: number; len: number; hasWalk: boolean }>();
    for (const n of this.nodes.values()) {
      if (this.rdeg(n) !== 2) continue;
      const inc = this.edgesAt(n.id);
      if (inc.length !== 2) continue;
      // Do not cut bridge mouths with a curved bend (keep crisp abutment seam + walkway taper instead)
      if (inc.some((e) => e.bridge || e.elevated || e.deck !== undefined)) continue;
      const A = armOf(n.id, inc[0], 0), B = armOf(n.id, inc[1], 0);
      const turn = Math.acos(Math.max(-1, Math.min(1, -(A.dx * B.dx + A.dz * B.dz))));
      const lenA = plOf(inc[0]).s.at(-1)!, lenB = plOf(inc[1]).s.at(-1)!;
      if (turn >= 0.1) {
        const hw = Math.max(A.hw, B.hw);
        bendR.set(n.id, Math.min(hw * (1 + turn) + 3, lenA * 0.35, lenB * 0.35));
      } else if (Math.abs(A.hw - B.hw) > 0.25 && A.walk === B.walk) {
        const aNarrow = A.hw < B.hw;
        const narrow = aNarrow ? inc[0] : inc[1];
        const wide = aNarrow ? inc[1] : inc[0];
        const narrowHW = aNarrow ? A.hw : B.hw;
        const wideHW = aNarrow ? B.hw : A.hw;
        const narrowLen = aNarrow ? lenA : lenB;
        const tLen = widthTaperLength(narrowHW, wideHW, narrowLen);
        if (tLen > 0.5) taperMap.set(n.id, { narrow, wide, narrowHW, wideHW, len: tLen, hasWalk: A.walk && B.walk });
      }
    }
    const trimAt = (nid: number, eid?: number) => {
      const base = this.nodeR(nid) * 0.92 || (bendR.get(nid) ?? 0);
      if (base > 0) return base;
      const tap = taperMap.get(nid);
      return tap && eid !== undefined && tap.narrow.id === eid ? tap.len : 0;
    };
    // tunnel cuts first: streets above need to know where the openings are
    this.cuts = [];
    for (const e of this.edges.values()) {
      if (!e.tunnel || e.deck === undefined) continue;
      const pl = plOf(e), len = pl.s[pl.s.length - 1], hwT = edgeHalfWidth(e) + 0.35;
      for (const r of this.cutRuns(e, pl, len)) {
        const pts: number[] = [];
        for (let s = r.s0; s <= r.s1 + 0.01; s += 2) { const q0 = at(pl, Math.min(s, r.s1)); pts.push(q0[0], q0[1], q0[2]); }
        if (pts.length >= 6) this.cuts.push({ pts, hw: hwT });
      }
    }
    for (const e of this.edges.values()) {
      const pl = plOf(e);
      const len = pl.s[pl.s.length - 1];
      if (e.tunnel && e.deck !== undefined) { this.tunnel(g, bg, e, pl, len); continue; }
      const ra = e.deck !== undefined && e.progress < 1 ? 0 : trimAt(e.a, e.id), rb = e.deck !== undefined && e.progress < 1 ? 0 : trimAt(e.b, e.id);
      const s0 = Math.min(ra, len / 2), s1 = Math.max(len - rb, len / 2);
      const hw = edgeHalfWidth(e);
      const startV = g.count;
      const done = e.progress >= 1 || e.upgrading;
      const dirt = e.cls === RoadClass.Dirt;
      const wear = dirt ? 0 : Math.max(0, Math.min(1, e.wear ?? 0));
      const surface = dirt ? COL.dirt : (wear > 0.05 ? COL.asphalt.clone().lerp(COL.asphaltOld, Math.min(1, wear * 1.05)) : COL.asphalt);
      const walkCol = wear >= 0.35 ? COL.walk.clone().lerp(COL.walkOld, Math.min(1, (wear - 0.35) / 0.65) * 0.65) : COL.walk;
      const isAtGrade = !e.bridge && !e.elevated && !e.tunnel && e.deck === undefined;
      const isGroundConforming = !e.elevated && !e.tunnel && e.deck === undefined;
      const surfG = isGroundConforming ? this.ground : undefined;
      if (!done && e.deck !== undefined) {
        ribbon(bg, pl, s0, s0 + (s1 - s0) * e.progress, -hw - 0.8, hw + 0.8, 0, COL.concrete, 6);
      } else if (!done) {
        const sp = s0 + (s1 - s0) * e.progress;
        ribbon(g, pl, s0, sp, -hw, hw, 0.02, surface, 8, surfG, 0.18);
        ribbon(g, pl, sp, s1, -hw - 1, hw + 1, 0, COL.earth, 8, surfG, 0.16);
        for (let s = s0; s < s1; s += 9) {
          const p = at(pl, s);
          for (const side of [-1, 1]) { m.makeTranslation(p[0] - p[4] * (hw + 0.6) * side, p[1], p[2] + p[3] * (hw + 0.6) * side); cones.push(m.clone()); }
        }
      } else {
        const holes = e.hole ? this.holesOn(e, pl) : [];
        const extHoles = isAtGrade && this.externalCuts.length ? this.holesFromCuts(pl, this.externalCuts, 0) : [];
        const allCutHoles = extHoles.length ? [...holes, ...extHoles] : holes;
        if (extHoles.length) {
          // Match RailLayer's 8-strip transverse carriageway at 0.5 m step for exact < 0.015 m C0 mouth continuity across full width
          const rStep = hw * 0.25;
          for (const [a0, a1] of spans(s0, s1, allCutHoles)) {
            for (let j = 0; j < 8; j++) {
              ribbon(g, pl, a0, a1, -hw + j * rStep, -hw + (j + 1) * rStep, 0, surface, 0.5, surfG, 0.18);
            }
          }
        } else {
          for (const [a0, a1] of spans(s0, s1, allCutHoles)) ribbon(g, pl, a0, a1, -hw, hw, 0, surface, 8, surfG, 0.18);
        }
        for (const h of holes) {
          const h0 = Math.max(s0, h.s0), h1 = Math.min(s1, h.s1), inner = h.hw + 0.55;
          if (h1 - h0 < 0.5 || inner >= hw - 1) continue;
          ribbon(g, pl, h0, h1, inner, hw, 0, surface, 8, surfG, 0.18);
          ribbon(g, pl, h0, h1, -hw, -inner, 0, surface, 8, surfG, 0.18);
          dashes(g, pl, h0, h1, inner + 0.25, 0.15, 3, 4, 0.03, COL.white, surfG, 0.215);
          dashes(g, pl, h0, h1, -inner - 0.25, 0.15, 3, 4, 0.03, COL.white, surfG, 0.215);
        }
        if (e.upgrading) for (let s = s0; s < s1; s += 7) { const p = at(pl, s); m.makeTranslation(p[0] - p[4] * (hw - 0.6), p[1], p[2] + p[3] * (hw - 0.6)); cones.push(m.clone()); }
        if (!dirt) {
          if (edgeHasWalk(e)) {
            for (const [w0, w1] of spans(s0, s1, extHoles)) {
              if (extHoles.length) {
                // Match RailLayer's 4-strip transverse walkways (0.65 m wide) at 0.5 m step for < 0.015 m mouth continuity everywhere
                const swStrip = SIDEWALK_WIDTH * 0.25;
                for (let j = 0; j < 4; j++) {
                  const o0 = hw + j * swStrip, o1 = hw + (j + 1) * swStrip;
                  ribbon(g, pl, w0, w1, o0, o1, 0.12, walkCol, 0.5, surfG, 0.30);
                  ribbon(g, pl, w0, w1, -o1, -o0, 0.12, walkCol, 0.5, surfG, 0.30);
                }
                ribbon(g, pl, w0, w1, hw, hw + 0.25, 0.14, COL.curb, 0.5, surfG, 0.32);
                ribbon(g, pl, w0, w1, -hw - 0.25, -hw, 0.14, COL.curb, 0.5, surfG, 0.32);
              } else {
                ribbon(g, pl, w0, w1, hw, hw + SIDEWALK_WIDTH, 0.12, walkCol, 8, surfG, 0.30);
                ribbon(g, pl, w0, w1, -hw - SIDEWALK_WIDTH, -hw, 0.12, walkCol, 8, surfG, 0.30);
                ribbon(g, pl, w0, w1, hw, hw + 0.25, 0.14, COL.curb, 8, surfG, 0.32);
                ribbon(g, pl, w0, w1, -hw - 0.25, -hw, 0.14, COL.curb, 8, surfG, 0.32);
              }
              // vertical curb risers between carriageway and raised sidewalk
              wall(g, pl, w0, w1, hw, 0, 0.13, COL.curb, 6);
              wall(g, pl, w0, w1, -hw, 0, 0.13, COL.curb, 6);
              // downhill retaining walls sealing sidewalk edges cleanly to the ground
              if (isAtGrade) {
                groundSkirt(g, pl, w0, w1, hw + SIDEWALK_WIDTH, 0.12, COL.retain, this.ground, 0.30, 0.12, 4);
                groundSkirt(g, pl, w0, w1, -(hw + SIDEWALK_WIDTH), 0.12, COL.retain, this.ground, 0.30, 0.12, 4);
              }
            }
          } else if (isAtGrade) {
            for (const [w0, w1] of spans(s0, s1, extHoles)) {
              groundSkirt(g, pl, w0, w1, hw, 0, COL.retain, this.ground, 0.18, 0.14, 4);
              groundSkirt(g, pl, w0, w1, -hw, 0, COL.retain, this.ground, 0.18, 0.14, 4);
            }
          }
          // check which ends have painted crosswalks so longitudinal lines never overlap the zebra stripes
          const cwEnds: [number, number, number][] = [];
          let hasCwA = false, hasCwB = false;
          for (const [nid, sc, dir] of [[e.a, s0 + CROSSWALK_INSET, 1], [e.b, s1 - CROSSWALK_INSET, -1]] as [number, number, number][]) {
            const nd = this.nodes.get(nid);
            const deg = nd ? this.rdeg(nd) : 0;
            const inc = this.edgesAt(nid);
            const hasUrban = inc.some((q0) => q0.cls >= RoadClass.Local && q0.cls <= RoadClass.Avenue);
            if (hasEndCrosswalk(e, len, deg, hasUrban, !!nd?.interchange)) {
              cwEnds.push([nid, sc, dir]);
              if (dir > 0) hasCwA = true; else hasCwB = true;
            }
          }
          // markings (trimmed behind painted crosswalks and not over a trench opening)
          const cwMargin = CROSSWALK_INSET + CROSSWALK_HALF_LEN + 0.5;
          const markS0 = hasCwA ? Math.min(s1, s0 + cwMargin) : s0;
          const markS1 = hasCwB ? Math.max(markS0, s1 - cwMargin) : s1;
          const dy = 0.03;
          // Discrete asphalt wear patches & cracks on worn stretches (wear >= 0.35), returning clean after resurfacing
          if (wear >= 0.35 && !e.upgrading && hw > 1.8) {
            const patchStep = wear >= 0.65 ? 11 : 17;
            for (const [m0, m1] of spans(markS0, markS1, allCutHoles)) {
              for (let sP = m0 + 3; sP < m1 - 4; sP += patchStep) {
                const hsh = ((e.id * 73856093) ^ (Math.floor(sP) * 19349663)) >>> 0;
                const uOff = ((hsh % 100) / 100) * 2 - 1;
                const maxLat = Math.max(0.6, hw - 1.3);
                const lat = uOff * maxLat;
                const pLen = 1.6 + ((hsh >> 8) % 18) * 0.1;
                const pW = 0.9 + ((hsh >> 13) % 10) * 0.1;
                const col = (hsh & 3) === 0 ? COL.patchLight : COL.patchDark;
                ribbon(g, pl, sP, Math.min(m1 - 0.5, sP + pLen), Math.max(-hw + 0.3, lat - pW * 0.5), Math.min(hw - 0.3, lat + pW * 0.5), 0.016, col, pLen, surfG, 0.20);
                if (wear >= 0.65 && (hsh & 1) === 1 && sP + 3.5 < m1 - 1) {
                  const lat2 = -lat * 0.65;
                  ribbon(g, pl, sP + 2.1, Math.min(m1 - 0.4, sP + 3.2), Math.max(-hw + 0.4, lat2 - 0.38), Math.min(hw - 0.4, lat2 + 0.38), 0.02, COL.tunnel, 1.2, surfG, 0.205);
                }
              }
            }
          }
          for (const [m0, m1] of spans(markS0, markS1, allCutHoles)) {
            const pad0 = hasCwA && m0 <= markS0 + 0.05 ? 0.35 : 2;
            const pad1 = hasCwB && m1 >= markS1 - 0.05 ? 0.35 : 2;
            const l0 = m0 + pad0, l1 = m1 - pad1;
            if (l1 <= l0 + 0.4) continue;
            if (e.oneway) {
              for (let l = 1; l < e.lanes; l++) dashes(g, pl, l0, l1, -hw + 0.4 + l * LANE_WIDTH, 0.15, 3, 4, dy, COL.white, surfG, 0.215);
            } else {
              if (e.cls >= RoadClass.Avenue) {
                const med0 = hasCwA && m0 <= markS0 + 0.05 ? m0 + 0.5 : m0 + 3;
                const med1 = hasCwB && m1 >= markS1 - 0.05 ? m1 - 0.5 : m1 - 3;
                if (med1 > med0 + 0.5) ribbon(g, pl, med0, med1, -0.8, 0.8, 0.18, COL.median, 8, surfG, 0.36);
              } else {
                ribbon(g, pl, l0, l1, -0.2, -0.06, dy, COL.yellow, 8, surfG, 0.215);
                ribbon(g, pl, l0, l1, 0.06, 0.2, dy, COL.yellow, 8, surfG, 0.215);
              }
              const med = e.cls >= RoadClass.Avenue ? 0.8 : 0;
              for (let l = 1; l < e.lanes; l++) {
                dashes(g, pl, l0, l1, med + l * LANE_WIDTH, 0.15, 3, 4, dy, COL.white, surfG, 0.215);
                dashes(g, pl, l0, l1, -med - l * LANE_WIDTH, 0.15, 3, 4, dy, COL.white, surfG, 0.215);
              }
              if (e.busLane) {
                ribbon(g, pl, m0 + (hasCwA && m0 <= markS0 + 0.05 ? 0.2 : 1), m1 - (hasCwB && m1 >= markS1 - 0.05 ? 0.2 : 1), med + (e.lanes - 1) * LANE_WIDTH, med + e.lanes * LANE_WIDTH, dy * 0.6, COL.bus, 8, surfG, 0.205);
                ribbon(g, pl, m0 + (hasCwA && m0 <= markS0 + 0.05 ? 0.2 : 1), m1 - (hasCwB && m1 >= markS1 - 0.05 ? 0.2 : 1), -med - e.lanes * LANE_WIDTH, -med - (e.lanes - 1) * LANE_WIDTH, dy * 0.6, COL.bus, 8, surfG, 0.205);
              }
            }
          }
          // crosswalks + aligned white stop bars at ends (lifted cleanly above terrain & asphalt on slopes)
          for (const [, sc, dir] of cwEnds) {
            const cwA = Math.min(sc - CROSSWALK_HALF_LEN, sc + CROSSWALK_HALF_LEN);
            const cwB = Math.max(sc - CROSSWALK_HALF_LEN, sc + CROSSWALK_HALF_LEN);
            for (let k = -hw + 0.6; k < hw - 0.4; k += 1.1) {
              ribbon(g, pl, cwA, cwB, k, k + 0.55, 0.035, COL.white, 3, surfG, 0.22);
            }
            // Crisp white stop line right behind the zebra on the approaching half of the carriageway
            if (len > 30) {
              const sBar = sc + (CROSSWALK_HALF_LEN + STOP_LINE_GAP * 0.65) * dir;
              if (sBar > 1 && sBar < len - 1) {
                const loOff = e.oneway ? -hw + 0.35 : (dir > 0 ? -hw + 0.35 : 0.25);
                const hiOff = e.oneway ? hw - 0.35 : (dir > 0 ? -0.25 : hw - 0.35);
                ribbon(g, pl, sBar - 0.18, sBar + 0.18, loOff, hiOff, 0.038, COL.white, 1, surfG, 0.225);
              }
            }
          }
          // streetlights
          if (e.cls !== RoadClass.Highway || e.bridge) {
            const spacing = e.cls >= RoadClass.Avenue ? 28 : 34;
            let side = 1;
            for (let s = s0 + 8; s < s1 - 4; s += spacing) {
              const p = at(pl, s);
              const off = e.cls >= RoadClass.Avenue && !e.oneway ? 0 : (hw + 1.6) * side;
              const ang = Math.atan2(p[4], p[3]);
              const yaw = -(ang + (side > 0 ? -Math.PI / 2 : Math.PI / 2));
              q.setFromAxisAngle(up, e.cls >= RoadClass.Avenue && !e.oneway ? -ang + Math.PI / 2 : yaw);
              const px = p[0] - p[4] * off, pz = p[2] + p[3] * off;
              const py = isAtGrade ? Math.max(p[1] + 0.12, this.ground(px, pz) + 0.24) : p[1];
              m.compose(new THREE.Vector3(px, py, pz), q, new THREE.Vector3(1, 1, 1));
              poles.push(m.clone());
              if (e.cls >= RoadClass.Avenue && !e.oneway) {
                q.setFromAxisAngle(up, -ang - Math.PI / 2);
                m.compose(new THREE.Vector3(p[0], p[1], p[2]), q, new THREE.Vector3(1, 1, 1));
                poles.push(m.clone());
              }
              side = -side;
            }
          }
        } else if (isAtGrade) {
          // Dirt road embankment skirts on slopes
          groundSkirt(g, pl, s0, s1, hw, 0, COL.earth, this.ground, 0.14, 0.14, 4);
          groundSkirt(g, pl, s0, s1, -hw, 0, COL.earth, this.ground, 0.14, 0.14, 4);
        }
      }
      // bridge / elevated structure
      if (e.bridge || e.elevated) {
        const hasWalkway = !!e.bridge && !e.elevated && e.deck === undefined;
        const deckPad = hasWalkway ? 1.9 : 0.8;
        const paraOff = hasWalkway ? hw + 1.65 : hw + 0.6;
        // Trim bridge deck, walkways, and parapets to junction mouths [s0, s1] so parapets never poke into T-junctions
        const bS0 = Math.max(0, s0);
        const bS1 = Math.min(len, s1);
        const pS0 = bS0 > 0.5 ? Math.min(bS1, bS0 + 0.6) : 0;
        const pS1 = bS1 < len - 0.5 ? Math.max(pS0, bS1 - 0.6) : len;
        if (bS1 > bS0 + 0.5) {
          // closed concrete deck underside + top edge slab
          ribbon(bg, pl, bS0, bS1, -hw - deckPad, hw + deckPad, -1.0, COL.concreteDark, 6);
          if (hasWalkway && done) {
            // dedicated raised pedestrian walkways on both sides of the bridge deck inside the parapets
            ribbon(g, pl, bS0, bS1, hw, hw + 1.45, 0.12, COL.walk, 8, this.ground, 0.30);
            ribbon(g, pl, bS0, bS1, -hw - 1.45, -hw, 0.12, COL.walk, 8, this.ground, 0.30);
            ribbon(g, pl, bS0, bS1, hw, hw + 0.22, 0.14, COL.curb, 8, this.ground, 0.32);
            ribbon(g, pl, bS0, bS1, -hw - 0.22, -hw, 0.14, COL.curb, 8, this.ground, 0.32);
            wall(g, pl, bS0, bS1, hw, 0, 0.13, COL.curb, 6);
            wall(g, pl, bS0, bS1, -hw, 0, 0.13, COL.curb, 6);
          }
          // parapets: real walls with a top, plus the deck fascia down to the slab underside
          for (const sd of [-1, 1]) {
            const o = paraOff * sd;
            ribbon(bg, pl, pS0, pS1, o - 0.2, o + 0.2, 1.0, COL.concrete, 6);
            wall(bg, pl, pS0, pS1, o + 0.2 * sd, -1.0, 1.0, COL.concrete, 6);
            wall(bg, pl, pS0, pS1, o - 0.2 * sd, 0, 1.0, COL.concrete, 6);
          }
        }
        // Closed concrete abutments & wing walls at land ends of bridges (skip mid-river bridge-to-bridge joints)
        if (e.bridge && !e.elevated && bS1 > bS0 + 1) {
          for (const [endS, paraEndS, inward, atJunc, endNodeId] of [
            [bS0, pS0, 1, bS0 > 0.5, e.a],
            [bS1, pS1, -1, bS1 < len - 0.5, e.b],
          ] as [number, number, number, boolean, number][]) {
            if (isWaterBridgeJoint(endNodeId)) continue;
            const ep = at(pl, endS);
            const pp = at(pl, paraEndS);
            const ang = Math.atan2(ep[4], ep[3]);
            const gy = this.ground(ep[0], ep[2]);
            const bot = Math.min(gy - 2.2, ep[1] - 4.5);
            const hAbut = Math.max(1.5, ep[1] - 0.05 - bot);
            bg.setTransform(ep[0], bot, ep[2], ang);
            // Solid abutment headwall tucked cleanly beneath the approach slab
            bg.box(inward * 1.4, 0, 0, 3.6, hAbut, (hw + deckPad + 0.25) * 2, COL.concreteDark);
            bg.setTransform(0, 0, 0, 0);
            // Parapet end-posts at the exact parapet termination; add wing walls only when NOT inside a junction mouth
            bg.setTransform(pp[0], pp[1] - 0.05, pp[2], ang);
            for (const sd of [-1, 1]) {
              bg.box(inward * 0.25, 0, sd * paraOff, 0.7, 1.08, 0.52, COL.concrete);
              if (!atJunc) {
                bg.box(-inward * 2.2, -3.0, sd * (hw + deckPad + 0.35), 4.2, 3.15, 0.6, COL.concreteDark);
              }
            }
            bg.setTransform(0, 0, 0, 0);
          }
        }
        // Elevated viaduct lower ramp side walls (where clearance is too low for piers)
        if (e.elevated && e.deck !== undefined) {
          for (let s = 0; s < len; s += 4) {
            const sNext = Math.min(len, s + 4);
            const a0 = at(pl, s), a1 = at(pl, sNext);
            const g0 = this.ground(a0[0], a0[2]), g1 = this.ground(a1[0], a1[2]);
            const h0 = a0[1] - g0, h1 = a1[1] - g1;
            if (Math.min(h0, h1) < 2.8 && Math.max(h0, h1) > 0.25) {
              for (const sd of [-1, 1]) {
                const o = (hw + deckPad) * sd;
                const nx = -a0[4] * sd, nz = a0[3] * sd;
                const ax = a0[0] - a0[4] * o, az = a0[2] + a0[3] * o;
                const bx = a1[0] - a1[4] * o, bz = a1[2] + a1[3] * o;
                bg.quad([
                  [ax, g0 - 0.8, az], [bx, g1 - 0.8, bz], [bx, a1[1], bz], [ax, a0[1], az],
                ], [nx, 0, nz], COL.concreteDark);
              }
            }
          }
        }
        // Bridge & viaduct piers extending to real riverbed / carved terrain — physical cross-section NEVER intrudes on roads below!
        const nPier = Math.floor(len / (e.deck !== undefined ? 26 : 30));
        const clearanceFn = (qx: number, qz: number, qr: number) => this.queryRoadClearance(qx, qz, qr, e.id);
        const shaftW = Math.min(hw * 0.72, 3.0);
        for (let i = 1; i <= nPier; i++) {
          const sNom = (len * i) / (nPier + 1);
          if (!done && i / (nPier + 1) > e.progress + 0.15) continue;
          const placement = resolveViaductPierPlacement(
            sNom,
            Math.max(4, bS0 + 3),
            Math.min(len - 4, bS1 - 3),
            (sp) => at(pl, sp),
            hw + deckPad,
            clearanceFn,
            1.6,
            {
              pierHalfLen: 0.85,
              pierHalfWidth: shaftW * 0.5 + 0.2,
              colRadius: 0.9,
              safetyMargin: 0.6,
              maxPortalSpan: 65,
            },
          );
          if (placement.kind === 'skip') continue;
          const minH = e.deck !== undefined ? 2.2 : 0.8;
          const ang = Math.atan2(placement.tz, placement.tx);
          const topY = placement.y - 1.0;
          if (placement.kind === 'single') {
            const gy = this.pierGroundY(placement.x, placement.z);
            const base = gy < 0.2 ? Math.min(gy - 2.0, -5.0) : gy - 2.0;
            const h = topY - base;
            if (h < minH) continue;
            q.setFromAxisAngle(up, -ang);
            // Pillar base geometry is 1.4 × 1.4 -> scale cleanly to 1.54 m × shaftW
            m.compose(new THREE.Vector3(placement.x, base, placement.z), q, new THREE.Vector3(1.1, h, shaftW / 1.4));
            pillars.push(m.clone());
            // Concrete pier cap beam supporting the full deck width overhead
            bg.setTransform(placement.x, topY - 0.55, placement.z, ang);
            bg.box(0, 0, 0, 2.2, 0.65, (hw + deckPad - 0.2) * 2, COL.concrete);
            bg.setTransform(0, 0, 0, 0);
          } else {
            // Portal frame: twin side columns (1.20 m × 1.20 m) outside ALL lower carriageway(s) + horizontal concrete crossbeam
            const gL = this.pierGroundY(placement.left.x, placement.left.z);
            const gR = this.pierGroundY(placement.right.x, placement.right.z);
            const baseL = gL < 0.2 ? Math.min(gL - 2.0, -5.0) : gL - 2.0;
            const baseR = gR < 0.2 ? Math.min(gR - 2.0, -5.0) : gR - 2.0;
            const hL = topY - baseL, hR = topY - baseR;
            if (Math.max(hL, hR) < minH) continue;
            q.setFromAxisAngle(up, -ang);
            if (hL >= 0.8) {
              m.compose(new THREE.Vector3(placement.left.x, baseL, placement.left.z), q, new THREE.Vector3(0.86, hL, 0.86));
              pillars.push(m.clone());
            }
            if (hR >= 0.8) {
              m.compose(new THREE.Vector3(placement.right.x, baseR, placement.right.z), q, new THREE.Vector3(0.86, hR, 0.86));
              pillars.push(m.clone());
            }
            const midLat = (placement.rightSpan - placement.leftSpan) * 0.5;
            const beamSpan = placement.leftSpan + placement.rightSpan + 1.8;
            bg.setTransform(placement.x, topY - 0.85, placement.z, ang);
            bg.box(0, 0, midLat, 2.1, 0.9, beamSpan, COL.concrete);
            bg.setTransform(0, 0, 0, 0);
          }
        }
        // cable-stayed signature bridge
        if (e.bridge && len > 160 && e.name.includes('Estaiada')) {
          const mid = at(pl, len / 2);
          const ang = Math.atan2(mid[4], mid[3]);
          bg.setTransform(mid[0], mid[1], mid[2], ang);
          bg.box(0, 0, 0, 3, 70, 3, COL.white);
          for (let k = 1; k <= 8; k++) {
            for (const dir of [-1, 1]) {
              const x = dir * k * (len / 2 - 10) / 8;
              const hgt = 68 - k * 4;
              bg.tri([[0, hgt, -0.1], [x, 1.5, -0.1], [x, 1.5, 0.1]], COL.white);
              bg.tri([[0, hgt, 0.1], [0, hgt, -0.1], [x, 1.5, 0.1]], COL.white);
            }
          }
          bg.setTransform(0, 0, 0, 0);
        }
      }
      this.edgeMeshIndex.push({ start: startV, end: g.count, id: e.id });
    }
    // intersections & smooth bends
    for (const n of this.nodes.values()) {
      const deg = this.rdeg(n);
      if (deg < 2) {
        if (deg === 1) {
          const inc1 = this.edgesAt(n.id);
          const y1 = inc1.length ? armOf(n.id, inc1[0], 0).y : Math.max(n.y, this.ground(n.x, n.z) + 0.18);
          const r1 = Math.max(3, n.radius * 0.9);
          const col1 = inc1.every((e) => e.cls === RoadClass.Dirt) ? COL.dirt : COL.asphalt;
          if (inc1.some((e) => e.elevated || e.deck !== undefined)) {
            g.setTransform(n.x, y1, n.z, 0);
            disc(g, 0, 0.005, 0, r1, 12, col1);
            g.setTransform(0, 0, 0, 0);
          } else {
            liftedDisc(g, n.x, y1 + 0.005, n.z, r1, 14, 2, col1, this.ground, 0.18);
          }
        }
        continue;
      }
      if (deg === 2) {
        const inc = this.edgesAt(n.id);
        const br = bendR.get(n.id);
        if (br !== undefined && inc.length === 2) {
          const [e1, e2] = inc;
          const A = armOf(n.id, e1, br), B = armOf(n.id, e2, br);
          const ny = Math.max(n.y, this.ground(n.x, n.z) + 0.18, (A.y + B.y) * 0.5);
          const rawBpl = toPL(bendLine(A, B, n.x, ny, n.z));
          const hw = Math.max(A.hw, B.hw);
          const bpl = liftSurfacePL(rawBpl, hw, this.ground, 3, false);
          const L = bpl.s[bpl.s.length - 1];
          const dirt = e1.cls === RoadClass.Dirt && e2.cls === RoadClass.Dirt;
          ribbon(g, bpl, 0, L, -hw, hw, 0.004, dirt ? COL.dirt : COL.asphalt, 3, this.ground, 0.18);
          if (A.walk && B.walk) {
            ribbon(g, bpl, 0, L, hw, hw + SIDEWALK_WIDTH, 0.12, COL.walk, 3, this.ground, 0.30);
            ribbon(g, bpl, 0, L, -hw - SIDEWALK_WIDTH, -hw, 0.12, COL.walk, 3, this.ground, 0.30);
            ribbon(g, bpl, 0, L, hw, hw + 0.25, 0.14, COL.curb, 3, this.ground, 0.32);
            ribbon(g, bpl, 0, L, -hw - 0.25, -hw, 0.14, COL.curb, 3, this.ground, 0.32);
            wall(g, bpl, 0, L, hw, 0, 0.13, COL.curb, 4);
            wall(g, bpl, 0, L, -hw, 0, 0.13, COL.curb, 4);
            groundSkirt(g, bpl, 0, L, hw + SIDEWALK_WIDTH, 0.12, COL.retain, this.ground, 0.30, 0.12, 4);
            groundSkirt(g, bpl, 0, L, -(hw + SIDEWALK_WIDTH), 0.12, COL.retain, this.ground, 0.30, 0.12, 4);
          } else if (A.walk !== B.walk) {
            // Taper sidewalk smoothly across the bend where urban road meets unpaved/highway
            const segs = 3;
            for (let k = 0; k < segs; k++) {
              const sA = (L * k) / segs, sB = (L * (k + 1)) / segs;
              const wMid = SIDEWALK_WIDTH * (A.walk ? 1 - (k + 0.5) / segs : (k + 0.5) / segs);
              if (wMid > 0.2) {
                ribbon(g, bpl, sA, sB, hw, hw + wMid, 0.12, COL.walk, 3, this.ground, 0.30);
                ribbon(g, bpl, sA, sB, -hw - wMid, -hw, 0.12, COL.walk, 3, this.ground, 0.30);
              }
            }
          } else {
            groundSkirt(g, bpl, 0, L, hw, 0, dirt ? COL.earth : COL.retain, this.ground, 0.18, 0.14, 4);
            groundSkirt(g, bpl, 0, L, -hw, 0, dirt ? COL.earth : COL.retain, this.ground, 0.18, 0.14, 4);
          }
          if (!dirt && !e1.oneway && !e2.oneway) {
            if (e1.cls >= RoadClass.Avenue && e2.cls >= RoadClass.Avenue) ribbon(g, bpl, 0, L, -0.8, 0.8, 0.18, COL.median, 3, this.ground, 0.36);
            else if (e1.cls !== RoadClass.Highway) { ribbon(g, bpl, 0, L, -0.2, -0.06, 0.03, COL.yellow, 3, this.ground, 0.215); ribbon(g, bpl, 0, L, 0.06, 0.2, 0.03, COL.yellow, 3, this.ground, 0.215); }
          }
        } else if (taperMap.has(n.id)) {
          // Straight width-change transition (e.g. local <-> highway): flared asphalt + continuous paved sidewalk trapezoids
          const tap = taperMap.get(n.id)!;
          const nPl = plOf(tap.narrow), nLen = nPl.s[nPl.s.length - 1];
          const fromA = tap.narrow.a === n.id;
          const segs = 2;
          const surfCol = tap.narrow.cls === RoadClass.Dirt && tap.wide.cls === RoadClass.Dirt ? COL.dirt : COL.asphalt;
          const atTap = (f: number) => {
            const sLocal = tap.len * f;
            const q0 = at(nPl, fromA ? Math.min(sLocal, nLen) : Math.max(0, nLen - sLocal));
            const dx = fromA ? q0[3] : -q0[3], dz = fromA ? q0[4] : -q0[4];
            return { x: q0[0], y: q0[1], z: q0[2], dx, dz, hw: tap.wideHW + (tap.narrowHW - tap.wideHW) * f };
          };
          for (let k = 0; k < segs; k++) {
            const p0 = atTap(k / segs), p1 = atTap((k + 1) / segs);
            const ptAt = (p: typeof p0, o: number, dy: number, minC: number): [number, number, number] => {
              const wx = p.x - p.dz * o, wz = p.z + p.dx * o;
              return [wx, Math.max(p.y + dy, this.ground(wx, wz) + minC), wz];
            };
            const aL = ptAt(p0, p0.hw, 0, 0.18), aR = ptAt(p0, -p0.hw, 0, 0.18);
            const bL = ptAt(p1, p1.hw, 0, 0.18), bR = ptAt(p1, -p1.hw, 0, 0.18);
            emitAdaptiveQuad(g, aL[0], aL[1], aL[2], bL[0], bL[1], bL[2], bR[0], bR[1], bR[2], aR[0], aR[1], aR[2], surfCol, this.ground, 0.18, 2);
            if (tap.hasWalk) {
              for (const sd of [-1, 1]) {
                const wi0 = ptAt(p0, sd * p0.hw, 0.12, 0.30), wo0 = ptAt(p0, sd * (p0.hw + SIDEWALK_WIDTH), 0.12, 0.30);
                const wi1 = ptAt(p1, sd * p1.hw, 0.12, 0.30), wo1 = ptAt(p1, sd * (p1.hw + SIDEWALK_WIDTH), 0.12, 0.30);
                const ci0 = ptAt(p0, sd * p0.hw, 0.14, 0.32), co0 = ptAt(p0, sd * (p0.hw + 0.25), 0.14, 0.32);
                const ci1 = ptAt(p1, sd * p1.hw, 0.14, 0.32), co1 = ptAt(p1, sd * (p1.hw + 0.25), 0.14, 0.32);
                if (sd > 0) {
                  emitAdaptiveQuad(g, wi0[0], wi0[1], wi0[2], wi1[0], wi1[1], wi1[2], wo1[0], wo1[1], wo1[2], wo0[0], wo0[1], wo0[2], COL.walk, this.ground, 0.30, 2);
                  emitAdaptiveQuad(g, ci0[0], ci0[1], ci0[2], ci1[0], ci1[1], ci1[2], co1[0], co1[1], co1[2], co0[0], co0[1], co0[2], COL.curb, this.ground, 0.32, 1);
                } else {
                  emitAdaptiveQuad(g, wi0[0], wi0[1], wi0[2], wo0[0], wo0[1], wo0[2], wo1[0], wo1[1], wo1[2], wi1[0], wi1[1], wi1[2], COL.walk, this.ground, 0.30, 2);
                  emitAdaptiveQuad(g, ci0[0], ci0[1], ci0[2], co0[0], co0[1], co0[2], co1[0], co1[1], co1[2], ci1[0], ci1[1], ci1[2], COL.curb, this.ground, 0.32, 1);
                }
                const nxS = -p0.dz * sd, nzS = p0.dx * sd;
                g.quad([[wi0[0], p0.y, wi0[2]], [wi1[0], p1.y, wi1[2]], [wi1[0], wi1[1], wi1[2]], [wi0[0], wi0[1], wi0[2]]], [-nxS, 0, -nzS], COL.curb);
              }
            }
          }
        } else if (inc.length === 2 && inc.some((e) => e.bridge) && inc.some((e) => !e.bridge && edgeHasWalk(e))) {
          // Clean sidewalk-to-bridge-walkway transition where an urban street joins a bridge abutment
          const street = inc.find((e) => !e.bridge)!;
          const stArm = armOf(n.id, street, 0);
          const hw = stArm.hw;
          const y0 = stArm.y;
          const ca = stArm.dx, sa = stArm.dz;
          const liftWorld = (lx: number, lz: number, dy: number): [number, number, number] => {
            const wx = stArm.x + lx * ca - lz * sa;
            const wz = stArm.z + lx * sa + lz * ca;
            return [wx, Math.max(y0 + dy, this.ground(wx, wz) + 0.30), wz];
          };
          for (const sd of [-1, 1]) {
            const a0 = liftWorld(0, sd * hw, 0.125), a1 = liftWorld(4.0, sd * hw, 0.125);
            const b1 = liftWorld(4.0, sd * (hw + SIDEWALK_WIDTH), 0.125), b0 = liftWorld(0, sd * (hw + 1.45), 0.125);
            liftedQuad(g, sd > 0 ? [a0, a1, b1, b0] : [a0, b0, b1, a1], COL.walk, this.ground, 0.30);
          }
          liftedDisc(g, n.x, y0 + 0.004, n.z, Math.max(...inc.map((e) => edgeHalfWidth(e))), 14, 2, COL.asphalt, this.ground, 0.18);
        } else if (inc.length === 2 && inc.every((e) => e.bridge && !e.elevated && e.deck === undefined)) {
          // Continuous mid-river bridge joint between two consecutive bridge spans + dedicated mid-river pier
          const A = armOf(n.id, inc[0], 0), B = armOf(n.id, inc[1], 0);
          const yMax = Math.max(n.y, A.y, B.y);
          const hwJ = Math.max(A.hw, B.hw);
          const deckPad = 1.9;
          g.setTransform(n.x, yMax, n.z, 0);
          disc(g, 0, 0.004, 0, hwJ, 16, COL.asphalt);
          g.setTransform(0, 0, 0, 0);
          bg.setTransform(n.x, yMax, n.z, 0);
          disc(bg, 0, -1.0, 0, hwJ + deckPad, 16, COL.concreteDark);
          bg.setTransform(0, 0, 0, 0);
          const gy = this.pierGroundY(n.x, n.z);
          const base = gy < 0.2 ? Math.min(gy - 2.0, -5.0) : gy - 2.0;
          const topY = yMax - 1.0;
          const h = topY - base;
          if (h > 0.8) {
            const ang = Math.atan2(B.dz - A.dz, B.dx - A.dx);
            q.setFromAxisAngle(up, -ang);
            const jShaftW = Math.min(hwJ * 0.72, 3.0);
            m.compose(new THREE.Vector3(n.x, base, n.z), q, new THREE.Vector3(1.1, h, jShaftW / 1.4));
            pillars.push(m.clone());
            bg.setTransform(n.x, topY - 0.55, n.z, ang);
            bg.box(0, 0, 0, 2.4, 0.65, (hwJ + deckPad - 0.2) * 2, COL.concrete);
            bg.setTransform(0, 0, 0, 0);
          }
        } else if (inc.length === 2 && !inc.some((e) => e.bridge || e.elevated || e.deck !== undefined) && edgeHasWalk(inc[0]) !== edgeHasWalk(inc[1])) {
          // Straight urban-to-rural/highway transition: clean 5 m tapered sidewalk return lifted to ground
          const unwalked = edgeHasWalk(inc[0]) ? inc[1] : inc[0];
          const walked = edgeHasWalk(inc[0]) ? inc[0] : inc[1];
          const uArm = armOf(n.id, unwalked, 0);
          const wArm = armOf(n.id, walked, 0);
          const hw = Math.max(uArm.hw, wArm.hw);
          const y0 = Math.max(uArm.y, wArm.y, this.ground(n.x, n.z) + 0.18);
          const ca = uArm.dx, sa = uArm.dz;
          const liftWorld = (lx: number, lz: number, dy: number): [number, number, number] => {
            const wx = n.x + lx * ca - lz * sa;
            const wz = n.z + lx * sa + lz * ca;
            return [wx, Math.max(y0 + dy, this.ground(wx, wz) + 0.30), wz];
          };
          for (const sd of [-1, 1]) {
            const a0 = liftWorld(0, sd * hw, 0.125), a1 = liftWorld(5.0, sd * hw, 0.125);
            const b1 = liftWorld(5.0, sd * (hw + 0.22), 0.125), b0 = liftWorld(0, sd * (hw + SIDEWALK_WIDTH), 0.125);
            liftedQuad(g, sd > 0 ? [a0, a1, b1, b0] : [a0, b0, b1, a1], COL.walk, this.ground, 0.30);
          }
          liftedDisc(g, n.x, y0 + 0.004, n.z, hw, 14, 2, COL.asphalt, this.ground, 0.18);
        } else if (inc.length) {
          const yMax = Math.max(n.y, ...inc.map((e) => armOf(n.id, e, 0).y));
          const col2 = inc.every((e) => e.cls === RoadClass.Dirt) ? COL.dirt : COL.asphalt;
          const r2 = Math.max(...inc.map((e) => edgeHalfWidth(e)));
          if (inc.some((e) => e.elevated || e.deck !== undefined)) {
            g.setTransform(n.x, yMax, n.z, 0);
            disc(g, 0, 0.004, 0, r2, 14, col2);
            g.setTransform(0, 0, 0, 0);
          } else {
            liftedDisc(g, n.x, yMax + 0.004, n.z, r2, 14, 2, col2, this.ground, 0.18);
          }
        }
        continue;
      }
      if (n.interchange) {
        const inc = this.edgesAt(n.id);
        const major = inc.reduce((a, e) => (e.cls > a.cls ? e : a), inc[0]);
        if (major) {
          const o = this.nodes.get(major.a === n.id ? major.b : major.a)!;
          const ang = Math.atan2(o.z - n.z, o.x - n.x);
          const hwv = edgeHalfWidth(major) + 1;
          const L = this.nodeR(n.id) * 2 + 40;
          const ca = Math.cos(ang), sa = Math.sin(ang);
          bg.setTransform(n.x, n.y, n.z, ang);
          bg.box(0, 6.2, 0, L, 1.0, hwv * 2, COL.concrete, 0, { top: COL.asphalt });
          bg.box(0, 7.2, hwv - 0.2, L, 1.0, 0.4, COL.concrete); bg.box(0, 7.2, -hwv + 0.2, L, 1.0, 0.4, COL.concrete);
          for (let k = -2; k <= 2; k++) bg.box(k * 4, 7.22, 0, 2.5, 0.02, 0.18, COL.white);
          bg.setTransform(0, 0, 0, 0);
          // Place interchange viaduct supports using full physical-footprint road-clearance resolution
          const icSample = (sp: number): [number, number, number, number, number] => [n.x + ca * sp, n.y + 7.2, n.z + sa * sp, ca, sa];
          const icShaftW = Math.min(hwv * 0.68, 3.0);
          for (const px of [-L / 3, L / 3]) {
            const plIc = resolveViaductPierPlacement(
              px, -L * 0.46, L * 0.46, icSample, hwv,
              (qx, qz, qr) => this.queryRoadClearance(qx, qz, qr, major.id),
              1.6,
              { pierHalfLen: 0.85, pierHalfWidth: icShaftW * 0.5 + 0.2, colRadius: 0.9, safetyMargin: 0.6, maxPortalSpan: 65 },
            );
            if (plIc.kind === 'skip') continue;
            if (plIc.kind === 'single') {
              const gy = this.pierGroundY(plIc.x, plIc.z);
              const base = gy - 2.0;
              const h = (n.y + 6.2) - base;
              if (h > 1.2) {
                q.setFromAxisAngle(up, -ang);
                m.compose(new THREE.Vector3(plIc.x, base, plIc.z), q, new THREE.Vector3(1.1, h, icShaftW / 1.4));
                pillars.push(m.clone());
              }
            } else {
              const gL = this.pierGroundY(plIc.left.x, plIc.left.z), gR = this.pierGroundY(plIc.right.x, plIc.right.z);
              const baseL = gL - 2.0, baseR = gR - 2.0;
              const hL = (n.y + 6.2) - baseL, hR = (n.y + 6.2) - baseR;
              q.setFromAxisAngle(up, -ang);
              if (hL > 1.0) { m.compose(new THREE.Vector3(plIc.left.x, baseL, plIc.left.z), q, new THREE.Vector3(0.86, hL, 0.86)); pillars.push(m.clone()); }
              if (hR > 1.0) { m.compose(new THREE.Vector3(plIc.right.x, baseR, plIc.right.z), q, new THREE.Vector3(0.86, hR, 0.86)); pillars.push(m.clone()); }
              const midLat = (plIc.rightSpan - plIc.leftSpan) * 0.5;
              bg.setTransform(plIc.x, n.y + 5.35, plIc.z, ang);
              bg.box(0, 0, midLat, 2.0, 0.9, plIc.leftSpan + plIc.rightSpan + 1.8, COL.concrete);
              bg.setTransform(0, 0, 0, 0);
            }
          }
        }
      }
      const anyDirt = this.edgesAt(n.id).every((e) => e.cls === RoadClass.Dirt);
      const nr = this.nodeR(n.id);
      if (n.control === 3) {
        const yRb = Math.max(n.y, this.ground(n.x, n.z) + 0.18);
        liftedDisc(g, n.x, yRb + 0.01, n.z, nr, 18, 2, anyDirt ? COL.dirt : COL.asphalt, this.ground, 0.18, COL.retain);
        liftedDisc(g, n.x, yRb + 0.21, n.z, nr * 0.5, 16, 1, COL.curb, this.ground, 0.38);
        liftedDisc(g, n.x, yRb + 0.22, n.z, nr * 0.45, 16, 1, COL.median, this.ground, 0.40);
      } else {
        const arms = this.edgesAt(n.id).map((e) => armOf(n.id, e, Math.min(nr * 0.92, plOf(e).s.at(-1)! / 2)));
        junction(g, n.x, n.y, n.z, arms, { surface: anyDirt ? COL.dirt : COL.asphalt, walk: COL.walk, curb: COL.curb }, this.ground);
      }
      if (n.control === 2 || n.control === 4) {
        const inc = this.edgesAt(n.id);
        inc.forEach((e, idx) => {
          const other = this.nodes.get(e.a === n.id ? e.b : e.a);
          if (!other) return;
          const dx = other.x - n.x, dz = other.z - n.z, l = Math.hypot(dx, dz) || 1;
          const ux = dx / l, uz = dz / l;
          const r = this.nodeR(n.id) + 1;
          const px = n.x + ux * r - uz * (edgeHalfWidth(e) + 1.2), pz = n.z + uz * r + ux * (edgeHalfWidth(e) + 1.2);
          const py = Math.max(n.y, this.ground(px, pz) + 0.24);
          m.makeTranslation(px, py + 4.2, pz);
          sigM.push(m.clone());
          this.signalSlots.push({ node: n.id, edge: e.id, idx });
          q.identity();
          m.compose(new THREE.Vector3(px, py, pz), q, new THREE.Vector3(0.6, 0.6, 0.6));
          poles.push(m.clone());
        });
      }
    }
    this.onCuts?.(this.cuts);
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.mesh = new THREE.Mesh(g.toGeometry(false), this.mat);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'roads';
    this.group.add(this.mesh);
    if (this.bridgeMesh) { this.group.remove(this.bridgeMesh); this.bridgeMesh.geometry.dispose(); }
    if (bg.count) {
      this.bridgeMesh = new THREE.Mesh(bg.toGeometry(false), this.bridgeMat);
      this.bridgeMesh.castShadow = true; this.bridgeMesh.receiveShadow = true;
      this.group.add(this.bridgeMesh);
    } else this.bridgeMesh = null;
    const setInst = (im: THREE.InstancedMesh, arr: THREE.Matrix4[]) => {
      const n = Math.min(arr.length, im.instanceMatrix.count);
      for (let i = 0; i < n; i++) im.setMatrixAt(i, arr[i]);
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
    };
    setInst(this.poles, poles);
    const lamps: THREE.Matrix4[] = [], pools: THREE.Matrix4[] = [];
    const pos = new THREE.Vector3(), sc = new THREE.Vector3(), qq = new THREE.Quaternion();
    for (const pm of poles) {
      pm.decompose(pos, qq, sc);
      if (sc.x < 0.9) continue;
      const head = new THREE.Vector3(1.6, 6.9, 0).applyQuaternion(qq).add(pos);
      lamps.push(new THREE.Matrix4().compose(head, qq, sc));
      pools.push(new THREE.Matrix4().makeTranslation(head.x, pos.y + 0.25, head.z));
    }
    setInst(this.lamps, lamps);
    setInst(this.pools, pools);
    setInst(this.cones, cones);
    setInst(this.signals, sigM);
    setInst(this.elevatedPillars, pillars);
    this.setSignals(new Int32Array([...this.signalPhase.entries()].flat()));
  }

  private edgesByNode = new Map<number, EdgeView[]>();
  /** open cuts of all tunnels (centre line with road height, half width); sent to the terrain to be carved */
  cuts: { pts: number[]; hw: number }[] = [];
  onCuts: ((c: { pts: number[]; hw: number }[]) => void) | null = null;
  private static PORTAL_D = 6.5;

  /** depth of a tunnel road below the surface at arc length s */
  private depthAt(pl: PL, s: number) { const p = at(pl, s); return { p, d: Math.max(0.3, this.ground(p[0], p[2])) + 0.12 - p[1] }; }

  /** the stretches of a tunnel that run in an open cut (between the surface and the portal) */
  private cutRuns(e: EdgeView, pl: PL, len: number): { s0: number; s1: number }[] {
    const built = e.progress >= 1 ? len : len * e.progress;
    const runs: { s0: number; s1: number }[] = [];
    let cur: { s0: number; s1: number } | null = null;
    for (let s = 0; s <= built; s += 2) {
      const { d } = this.depthAt(pl, s);
      const open = d > 0.3 && d < RoadsLayer.PORTAL_D;
      if (open) { if (!cur) runs.push(cur = { s0: Math.max(0, s - 2), s1: s }); cur.s1 = Math.min(built, s + 2); } else cur = null;
    }
    return runs;
  }

  /** where a street above has trench openings (in its own arc length), with the trench half width */
  private holesOn(_e: EdgeView, pl: PL): { s0: number; s1: number; hw: number }[] {
    return this.holesFromCuts(pl, this.cuts);
  }

  private holesFromCuts(pl: PL, cuts: TerrainCut[], pad = 1): { s0: number; s1: number; hw: number }[] {
    const out: { s0: number; s1: number; hw: number }[] = [];
    const ax = pl.x[0], az = pl.z[0], bx = pl.x[pl.x.length - 1], bz = pl.z[pl.z.length - 1];
    const L = Math.hypot(bx - ax, bz - az) || 1, ux = (bx - ax) / L, uz = (bz - az) / L;
    for (const c of cuts) {
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < c.pts.length; k += 3) {
        const rx = c.pts[k] - ax, rz = c.pts[k + 2] - az;
        const t = rx * ux + rz * uz, d = Math.abs(rx * uz - rz * ux);
        if (d < 2.5 && t > -2 && t < L + 2) { lo = Math.min(lo, t); hi = Math.max(hi, t); }
      }
      if (hi > lo) out.push({ s0: lo - pad, s1: hi + pad, hw: c.hw });
    }
    return out;
  }

  /**
   * Tunnels: open stretches are ordinary road; in the cut the road runs at its true depth between continuous
   * retaining walls with wide coping & backfill lips sealing cleanly against `TerrainView.setCuts()`, and
   * deeper stretches enter a solid concrete portal headwall.
   */
  private tunnel(g: GB, bg: GB, e: EdgeView, pl: PL, len: number) {
    const hw = edgeHalfWidth(e);
    const built = e.progress >= 1 ? len : len * e.progress;
    const wallC = COL.concrete, dark = COL.tunnel;
    const runs = this.cutRuns(e, pl, len);
    const inRun = (s: number) => runs.some((r) => s >= r.s0 && s <= r.s1);
    const step = 2;
    for (let s = 0; s < built - 0.05; s += step) {
      const s1 = Math.min(built, s + step), mid = (s + s1) / 2;
      const { d } = this.depthAt(pl, mid);
      if (d >= RoadsLayer.PORTAL_D) continue; // underground
      ribbon(g, pl, s, s1, -hw, hw, 0, COL.asphalt, step);
      if (!inRun(mid) || d < 0.25) continue;
      ribbon(g, pl, s, s1, -0.08, 0.08, 0.03, COL.yellow, step);
      const A = at(pl, s), B = at(pl, s1);
      for (const sd of [-1, 1]) {
        const oIn = (hw + 0.25) * sd;
        const oOut = (hw + 0.95) * sd;
        const topY = (q0: [number, number, number, number, number]) => {
          const x = q0[0] - q0[4] * oIn, z = q0[2] + q0[3] * oIn;
          return Math.max(0.3, this.ground(x, z)) + 0.95;
        };
        const tA = topY(A), tB = topY(B);
        const P = (q0: [number, number, number, number, number], o: number, y: number) => [q0[0] - q0[4] * o, y, q0[2] + q0[3] * o];
        // Inner retaining wall down below the road floor
        bg.quad([P(A, oIn, A[1] - 0.35), P(B, oIn, B[1] - 0.35), P(B, oIn, tB), P(A, oIn, tA)], [-A[4] * sd, 0, A[3] * sd], wallC);
        // Wide concrete coping spanning over the cut bank edge (seals TerrainView.setCuts border)
        bg.quad([P(A, oIn, tA), P(B, oIn, tB), P(B, oOut, tB), P(A, oOut, tA)], [0, 1, 0], wallC);
        // Outer backfill lip dropping into the carved earth bank so zero cracks appear
        bg.quad([P(A, oOut, tA - 1.4), P(B, oOut, tB - 1.4), P(B, oOut, tB), P(A, oOut, tA)], [A[4] * sd, 0, -A[3] * sd], COL.concreteDark);
      }
    }
    // portals: where the cut meets the underground part
    for (const r of runs) for (const [sp, inward] of [[r.s0, -1], [r.s1, 1]] as [number, number][]) {
      if (sp <= 0.5 || sp >= built - 0.5) continue;
      const q0 = at(pl, sp), ang = Math.atan2(q0[4], q0[3]);
      if (this.depthAt(pl, sp + inward * 3).d < RoadsLayer.PORTAL_D - 0.5) continue;
      const gy = Math.max(0.3, this.ground(q0[0], q0[2])) + 1.5;
      const H = Math.max(6.5, gy - q0[1]);
      bg.setTransform(q0[0], q0[1], q0[2], ang);
      // Wide solid headwall, wing walls, lintel and dark tunnel mouth
      bg.box(0, -0.4, -hw - 1.1, 1.4, H + 0.4, 2.0, wallC);
      bg.box(0, -0.4, hw + 1.1, 1.4, H + 0.4, 2.0, wallC);
      bg.box(0, 5.4, 0, 1.4, H - 5.2, hw * 2 + 4.4, wallC);
      bg.box(inward * 0.9, -0.1, 0, 0.7, 5.6, hw * 2 + 0.4, dark);
      bg.setTransform(0, 0, 0, 0);
    }
  }

  /** decks/tunnels leave from the middle of a street: they don't make a node a junction visually */
  private deckAt = new Map<number, number>();
  private rdeg(n: NodeView) { return n.deg - (this.deckAt.get(n.id) ?? 0); }
  edgesAt(nid: number): EdgeView[] {
    const out = [...(this.edgesByNode.get(nid) ?? [])];
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  pickEdge(hit: THREE.Intersection): number | null {
    if (hit.object !== this.mesh || !hit.face) return null;
    const v = hit.face.a;
    for (const r of this.edgeMeshIndex) if (v >= r.start && v < r.end) return r.id;
    return null;
  }
  get mainMesh() { return this.mesh; }
}

function disc(g: GB, cx: number, y: number, cz: number, r: number, seg: number, c: THREE.Color) {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    g.tri([[cx, y, cz], [cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r], [cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r]], c);
  }
}

/** Emit a terrain-conforming quad whose both triangles (0,1,2) & (0,2,3) clear `ground + minClear` at centroids and edges. */
function liftedQuad(
  g: GB, pts: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]],
  c: THREE.Color, ground: (x: number, z: number) => number, minClear = 0.30,
) {
  const [p0, p1, p2, p3] = pts;
  const ensureTri = (a: [number, number, number], b: [number, number, number], d: [number, number, number]) => {
    const mx = (a[0] + b[0] + d[0]) / 3, mz = (a[2] + b[2] + d[2]) / 3, my = (a[1] + b[1] + d[1]) / 3;
    const needC = ground(mx, mz) + minClear - my;
    if (needC > 0) { const bump = needC + 0.02; a[1] += bump; b[1] += bump; d[1] += bump; }
    for (const [u, v] of [[a, b], [b, d], [d, a]] as [[number, number, number], [number, number, number]][]) {
      const ex = (u[0] + v[0]) * 0.5, ez = (u[2] + v[2]) * 0.5, ey = (u[1] + v[1]) * 0.5;
      const needE = ground(ex, ez) + minClear - ey;
      if (needE > 0) { const bump = needE + 0.02; u[1] += bump; v[1] += bump; }
    }
  };
  ensureTri(p0, p1, p2);
  ensureTri(p0, p2, p3);
  g.quad([p0, p1, p2, p3], [0, 1, 0], c);
}

/** Adaptive upward-facing triangle emitter for `liftedDisc`: zero subdivision on flat discs, local refinement on ridges. */
function emitAdaptiveTri(
  g: GB,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  col: THREE.Color,
  ground: (x: number, z: number) => number,
  minClear: number,
  depth: number,
) {
  const mcx = (ax + bx + cx) / 3, mcz = (az + bz + cz) / 3, mcy = (ay + by + cy) / 3;
  let maxNeed = ground(mcx, mcz) + minClear - mcy;
  const abx = (ax + bx) * 0.5, abz = (az + bz) * 0.5, aby = (ay + by) * 0.5;
  const bcx = (bx + cx) * 0.5, bcz = (bz + cz) * 0.5, bcy = (by + cy) * 0.5;
  const cax = (cx + ax) * 0.5, caz = (cz + az) * 0.5, cay = (cy + ay) * 0.5;
  const gAB = ground(abx, abz), gBC = ground(bcx, bcz), gCA = ground(cax, caz);
  const nAB = gAB + minClear - aby; if (nAB > maxNeed) maxNeed = nAB;
  const nBC = gBC + minClear - bcy; if (nBC > maxNeed) maxNeed = nBC;
  const nCA = gCA + minClear - cay; if (nCA > maxNeed) maxNeed = nCA;
  const lMax = Math.max(
    (bx - ax) * (bx - ax) + (bz - az) * (bz - az),
    (cx - bx) * (cx - bx) + (cz - bz) * (cz - bz),
    (ax - cx) * (ax - cx) + (az - cz) * (az - cz),
  );
  if (lMax > 16) {
    let nQ = ground(ax * 0.5 + bx * 0.25 + cx * 0.25, az * 0.5 + bz * 0.25 + cz * 0.25) + minClear - (ay * 0.5 + by * 0.25 + cy * 0.25);
    if (nQ > maxNeed) maxNeed = nQ;
    nQ = ground(ax * 0.25 + bx * 0.5 + cx * 0.25, az * 0.25 + bz * 0.5 + cz * 0.25) + minClear - (ay * 0.25 + by * 0.5 + cy * 0.25);
    if (nQ > maxNeed) maxNeed = nQ;
    nQ = ground(ax * 0.25 + bx * 0.25 + cx * 0.5, az * 0.25 + bz * 0.25 + cz * 0.5) + minClear - (ay * 0.25 + by * 0.25 + cy * 0.5);
    if (nQ > maxNeed) maxNeed = nQ;
  }
  if (maxNeed <= 0) {
    g.triUp(ax, ay, az, bx, by, bz, cx, cy, cz, col);
    return;
  }
  if (depth > 0 && maxNeed > 0.015) {
    if (lMax > 5.0) {
      const mABy = Math.max(aby, gAB + minClear);
      const mBCy = Math.max(bcy, gBC + minClear);
      const mCAy = Math.max(cay, gCA + minClear);
      emitAdaptiveTri(g, ax, ay, az, abx, mABy, abz, cax, mCAy, caz, col, ground, minClear, depth - 1);
      emitAdaptiveTri(g, abx, mABy, abz, bx, by, bz, bcx, mBCy, bcz, col, ground, minClear, depth - 1);
      emitAdaptiveTri(g, cax, mCAy, caz, bcx, mBCy, bcz, cx, cy, cz, col, ground, minClear, depth - 1);
      emitAdaptiveTri(g, abx, mABy, abz, bcx, mBCy, bcz, cax, mCAy, caz, col, ground, minClear, depth - 1);
      return;
    }
  }
  const bump = maxNeed + 0.005;
  g.triUp(ax, ay + bump, az, bx, by + bump, bz, cx, cy + bump, cz, col);
}

/** Adaptive terrain-conforming disc (lightweight on flat ground, local ridge refinement on slopes). */
function liftedDisc(
  g: GB, cx: number, yBase: number, cz: number, r: number, seg: number, rings: number, c: THREE.Color,
  ground: (x: number, z: number) => number, minClear = 0.18, skirtCol?: THREE.Color,
) {
  const cy = Math.max(yBase, ground(cx, cz) + minClear);
  const ringPts: [number, number, number][][] = [];
  for (let ri = 1; ri <= rings; ri++) {
    const rr = (r * ri) / rings;
    const pts: [number, number, number][] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
      pts.push([x, Math.max(yBase, ground(x, z) + minClear), z]);
    }
    ringPts.push(pts);
  }
  for (let i = 0; i < seg; i++) {
    const i1 = (i + 1) % seg;
    const p1 = ringPts[0][i1], p0 = ringPts[0][i];
    emitAdaptiveTri(g, cx, cy, cz, p1[0], p1[1], p1[2], p0[0], p0[1], p0[2], c, ground, minClear, 2);
    for (let ri = 0; ri < rings - 1; ri++) {
      const a0 = ringPts[ri][i], a1 = ringPts[ri][i1], b1 = ringPts[ri + 1][i1], b0 = ringPts[ri + 1][i];
      emitAdaptiveQuad(g, a0[0], a0[1], a0[2], a1[0], a1[1], a1[2], b1[0], b1[1], b1[2], b0[0], b0[1], b0[2], c, ground, minClear, 2);
    }
    if (skirtCol) {
      const a = ringPts[rings - 1][i], b = ringPts[rings - 1][i1];
      const ga = ground(a[0], a[2]), gb = ground(b[0], b[2]);
      if (ga > -1e8 && gb > -1e8 && (a[1] - ga > 0.16 || b[1] - gb > 0.16)) {
        const dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1;
        g.quad([[a[0], ga - 0.35, a[2]], [b[0], gb - 0.35, b[2]], [b[0], b[1], b[2]], [a[0], a[1], a[2]]], [dz / l, 0, -dx / l], skirtCol);
      }
    }
  }
}

function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [];
  for (const g0 of geos) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    pos.push(...(g.attributes.position.array as Float32Array));
    nor.push(...(g.attributes.normal.array as Float32Array));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return out;
}
