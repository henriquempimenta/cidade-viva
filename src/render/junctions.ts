import * as THREE from 'three';
import { SIDEWALK_WIDTH } from '../shared/roadGeom';
import type { GB } from './geomBuilder';

/**
 * Smooth road joints: a junction is a C0-continuous polygon whose kerbs are quadratic Bézier
 * fillets between neighbouring road mouths, with miter-clamped non-invading sidewalks on acute
 * corners, clean tapered caps on mixed sidewalks (a.walk !== b.walk), and vertical curb/retaining
 * skirts down to the ground mesh on slopes.
 */
export interface Arm {
  x: number; y: number; z: number; // centre line at the mouth
  dx: number; dz: number; // unit direction pointing AWAY from the node
  hw: number; // half width of the carriageway
  walk: boolean; // has sidewalks
}

export type V3 = [number, number, number];

const RETAIN_COL = new THREE.Color(0x8e8980);

/** upward-facing triangle regardless of the winding we were given */
function up(g: GB, a: V3, b: V3, c: V3, col: THREE.Color) {
  const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - a[0], vz = c[2] - a[2];
  // flat up normal like the road ribbons, so seams between tilted triangles don't show
  if (uz * vx - ux * vz >= 0) g.quad([a, b, c, c], [0, 1, 0], col); else g.quad([a, c, b, b], [0, 1, 0], col);
}
function upQuad(g: GB, a: V3, b: V3, c: V3, d: V3, col: THREE.Color) { up(g, a, b, c, col); up(g, a, c, d, col); }

/** vertical quad along segment a->b dropping from top y down to bottom y (outward normal) */
function skirtQuad(g: GB, aTop: V3, bTop: V3, aBotY: number, bBotY: number, col: THREE.Color) {
  const dx = bTop[0] - aTop[0], dz = bTop[2] - aTop[2];
  const l = Math.hypot(dx, dz) || 1;
  const nx = dz / l, nz = -dx / l;
  g.quad([
    [aTop[0], aBotY, aTop[2]],
    [bTop[0], bBotY, bTop[2]],
    [bTop[0], bTop[1], bTop[2]],
    [aTop[0], aTop[1], aTop[2]],
  ], [nx, 0, nz], col);
}

/**
 * Kerb fillet between the +perp side of arm A (facing B) and the -perp side of arm B (facing A),
 * with C0 smoothstep elevation interpolation from `A.y + dy` (f=0) to `B.y + dy` (f=1).
 */
export function fillet(A: Arm, B: Arm, oa: number, ob: number, dy: number, cxNode?: number, czNode?: number, n = 8): V3[] {
  const ax = A.x - A.dz * oa, az = A.z + A.dx * oa;
  const bx = B.x + B.dz * ob, bz = B.z - B.dx * ob;
  const d1x = -A.dx, d1z = -A.dz, d2x = -B.dx, d2z = -B.dz;
  const det = d1x * d2z - d1z * d2x;
  let cx = (ax + bx) * 0.5, cz = (az + bz) * 0.5;
  if (Math.abs(det) > 1e-4) {
    const ex = bx - ax, ez = bz - az;
    const t = (ex * d2z - ez * d2x) / det;
    const u = (ex * d1z - ez * d1x) / det;
    const rA = cxNode !== undefined && czNode !== undefined ? Math.hypot(A.x - cxNode, A.z - czNode) : 24;
    const rB = cxNode !== undefined && czNode !== undefined ? Math.hypot(B.x - cxNode, B.z - czNode) : 24;
    const limA = Math.min(2.2 * Math.max(oa, ob) + 6, Math.max(2, rA * 0.95));
    const limB = Math.min(2.2 * Math.max(oa, ob) + 6, Math.max(2, rB * 0.95));
    if (t > 0 && u > 0) {
      const tc = Math.min(t, limA);
      const uc = Math.min(u, limB);
      cx = 0.5 * ((ax + d1x * tc) + (bx + d2x * uc));
      cz = 0.5 * ((az + d1z * tc) + (bz + d2z * uc));
    }
  }
  const ya = A.y + dy, yb = B.y + dy;
  const out: V3[] = [];
  for (let k = 0; k <= n; k++) {
    const f = k / n, inv = 1 - f;
    const s = f * f * (3 - 2 * f);
    out.push([
      inv * inv * ax + 2 * inv * f * cx + f * f * bx,
      ya + (yb - ya) * s,
      inv * inv * az + 2 * inv * f * cz + f * f * bz,
    ]);
  }
  return out;
}

export interface CornerSidewalk {
  inner: V3[];
  outer: V3[];
  kerbOut: V3[];
  valid: boolean;
}

/**
 * Compute miter-clamped sidewalk & kerb curves around corner (A -> B) without invading either
 * adjacent carriageway or self-intersecting, even at acute intersection angles (< 70°).
 */
export function computeCornerSidewalk(
  A: Arm, B: Arm, cx: number, cz: number, width = SIDEWALK_WIDTH, n = 8,
): CornerSidewalk {
  const inner = fillet(A, B, A.hw, B.hw, 0.12, cx, cz, n);
  const dotAB = A.dx * B.dx + A.dz * B.dz;
  const crossAB = A.dx * B.dz - A.dz * B.dx;
  const pad = 0.05;

  let wCorner = width;
  if (dotAB > 0.02) {
    // Acute corner (< ~89°): bound sidewalk width so the outer edges of A and B never cross past their
    // miter intersection or invade the opposite arm's carriageway.
    if (crossAB <= 1e-4) {
      return { inner, outer: [], kerbOut: [], valid: false };
    }
    const rA = Math.hypot(A.x - cx, A.z - cz);
    const rB = Math.hypot(B.x - cx, B.z - cz);
    const wMaxA = (rA * crossAB - (B.hw + pad) - A.hw * dotAB) / (1 + dotAB);
    const wMaxB = (rB * crossAB - (A.hw + pad) - B.hw * dotAB) / (1 + dotAB);
    wCorner = Math.max(0, Math.min(width, wMaxA, wMaxB));
  }

  if (wCorner < 0.08) {
    return { inner, outer: [], kerbOut: [], valid: false };
  }

  const outer = fillet(A, B, A.hw + wCorner, B.hw + wCorner, 0.12, cx, cz, n);
  const kW = Math.min(0.25, wCorner);
  const kerbOut = fillet(A, B, A.hw + kW, B.hw + kW, 0.14, cx, cz, n);
  return { inner, outer, kerbOut, valid: true };
}

export interface JunctionStyle { surface: THREE.Color; walk: THREE.Color; curb: THREE.Color }

/** junction of 3+ arms: C0-continuous filleted pavement polygon plus wrapped kerbs, sidewalks & retaining skirts */
export function junction(g: GB, cx: number, cy: number, cz: number, arms: Arm[], st: JunctionStyle, ground: (x: number, z: number) => number = () => -1e9) {
  const lift = (p: V3, m = 0.14): V3 => [p[0], Math.max(p[1], ground(p[0], p[2]) + m), p[2]];
  if (arms.length < 2) return;
  const A = [...arms].sort((p, q) => Math.atan2(p.dz, p.dx) - Math.atan2(q.dz, q.dx));
  const outline: V3[] = [];
  for (let i = 0; i < A.length; i++) {
    const a = A[i], b = A[(i + 1) % A.length];
    // Explicit -perp corner of arm a uses EXACTLY a.y (C0 match with road ribbon mouth)
    outline.push([a.x + a.dz * a.hw, a.y + 0.01, a.z - a.dx * a.hw]);
    outline.push(...fillet(a, b, a.hw, b.hw, 0.01, cx, cz));
  }
  const c: V3 = [cx, A.reduce((m, a) => m + a.y, 0) / A.length + 0.01, cz];
  // three concentric rings so even wide 14 m avenue junctions conform cleanly to interior terrain vertices on steep slopes
  const O = outline.map((p) => lift(p, 0.14));
  const M2 = O.map((p) => lift([c[0] + (p[0] - c[0]) * (2 / 3), c[1] + (p[1] - c[1]) * (2 / 3), c[2] + (p[2] - c[2]) * (2 / 3)], 0.14));
  const M1 = O.map((p) => lift([c[0] + (p[0] - c[0]) * (1 / 3), c[1] + (p[1] - c[1]) * (1 / 3), c[2] + (p[2] - c[2]) * (1 / 3)], 0.14));
  const C = lift(c, 0.14);
  for (let k = 0; k < O.length; k++) {
    const k1 = (k + 1) % O.length;
    up(g, C, M1[k], M1[k1], st.surface);
    upQuad(g, M1[k], M2[k], M2[k1], M1[k1], st.surface);
    upQuad(g, M2[k], O[k], O[k1], M2[k1], st.surface);
  }
  // sidewalks, kerbs, mixed-sidewalk end caps, and downhill retaining skirts
  for (let i = 0; i < A.length; i++) {
    const a = A[i], b = A[(i + 1) % A.length];
    if (a.walk && b.walk) {
      const sw = computeCornerSidewalk(a, b, cx, cz, SIDEWALK_WIDTH);
      if (!sw.valid) continue;
      for (let k = 0; k < sw.inner.length - 1; k++) {
        const i0 = lift(sw.inner[k], 0.26), i1 = lift(sw.inner[k + 1], 0.26);
        const o0 = lift(sw.outer[k], 0.26), o1 = lift(sw.outer[k + 1], 0.26);
        const k0 = lift([sw.inner[k][0], sw.inner[k][1] + 0.02, sw.inner[k][2]], 0.28);
        const k1 = lift([sw.inner[k + 1][0], sw.inner[k + 1][1] + 0.02, sw.inner[k + 1][2]], 0.28);
        const ko0 = lift(sw.kerbOut[k], 0.28), ko1 = lift(sw.kerbOut[k + 1], 0.28);
        upQuad(g, i0, i1, o1, o0, st.walk);
        upQuad(g, k0, k1, ko1, ko0, st.curb);
        // vertical curb riser facing carriageway
        const roadY0 = Math.max(sw.inner[k][1] - 0.12, ground(i0[0], i0[2]) + 0.12);
        const roadY1 = Math.max(sw.inner[k + 1][1] - 0.12, ground(i1[0], i1[2]) + 0.12);
        skirtQuad(g, i1, i0, roadY1, roadY0, st.curb);
        // downhill retaining skirt on outer sidewalk edge when above terrain
        const g0 = ground(o0[0], o0[2]), g1 = ground(o1[0], o1[2]);
        if (g0 > -1e8 && g1 > -1e8 && (o0[1] - g0 > 0.12 || o1[1] - g1 > 0.12)) {
          skirtQuad(g, o0, o1, g0 - 0.35, g1 - 0.35, RETAIN_COL);
        }
      }
    } else if (a.walk !== b.walk) {
      // Mixed sidewalk corner: taper the urban arm's sidewalk cleanly to a rounded kerb return
      const sw = computeCornerSidewalk(a, b, cx, cz, SIDEWALK_WIDTH, 8);
      if (!sw.valid) continue;
      const fromStart = a.walk;
      const segs = 3;
      for (let step = 0; step < segs; step++) {
        const k = fromStart ? step : sw.inner.length - 1 - step;
        const kn = fromStart ? step + 1 : sw.inner.length - 2 - step;
        const t0 = 1 - step / segs;
        const t1 = 1 - (step + 1) / segs;
        const pIn0 = sw.inner[k], pIn1 = sw.inner[kn];
        const pOut0: V3 = [pIn0[0] + (sw.outer[k][0] - pIn0[0]) * t0, pIn0[1], pIn0[2] + (sw.outer[k][2] - pIn0[2]) * t0];
        const pOut1: V3 = [pIn1[0] + (sw.outer[kn][0] - pIn1[0]) * t1, pIn1[1], pIn1[2] + (sw.outer[kn][2] - pIn1[2]) * t1];
        const i0 = lift(pIn0, 0.26), i1 = lift(pIn1, 0.26);
        const o0 = lift(pOut0, 0.26), o1 = lift(pOut1, 0.26);
        upQuad(g, i0, i1, o1, o0, st.walk);
        // kerb edge along the tapered outer boundary
        const g0 = ground(o0[0], o0[2]), g1 = ground(o1[0], o1[2]);
        if (g0 > -1e8 && g1 > -1e8 && (o0[1] - g0 > 0.12 || o1[1] - g1 > 0.12)) {
          skirtQuad(g, o0, o1, g0 - 0.35, g1 - 0.35, st.curb);
        }
      }
    } else {
      // Unpaved / highway corner: add a subtle embankment skirt if the edge is above sloped ground
      const kerb = fillet(a, b, a.hw, b.hw, 0.01, cx, cz, 6);
      for (let k = 0; k < kerb.length - 1; k++) {
        const p0 = lift(kerb[k], 0.14), p1 = lift(kerb[k + 1], 0.14);
        const g0 = ground(p0[0], p0[2]), g1 = ground(p1[0], p1[2]);
        if (g0 > -1e8 && g1 > -1e8 && (p0[1] - g0 > 0.18 || p1[1] - g1 > 0.18)) {
          skirtQuad(g, p0, p1, g0 - 0.35, g1 - 0.35, RETAIN_COL);
        }
      }
    }
  }
}

/** centre line of a bend: quadratic Bézier from mouth A through the node to mouth B, as [x,y,z,…] */
export function bendLine(A: Arm, B: Arm, nx: number, ny: number, nz: number, n = 10): number[] {
  const pts: number[] = [];
  for (let k = 0; k <= n; k++) {
    const f = k / n, i = 1 - f;
    pts.push(i * i * A.x + 2 * i * f * nx + f * f * B.x, i * i * A.y + 2 * i * f * ny + f * f * B.y, i * i * A.z + 2 * i * f * nz + f * f * B.z);
  }
  return pts;
}
