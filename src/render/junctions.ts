import * as THREE from 'three';
import type { GB } from './geomBuilder';

/**
 * Smooth road joints (idea adapted from the alternative v14 build): instead of a disc at
 * every node, a junction is a polygon whose kerbs are quadratic curves between neighbouring
 * road mouths, and the sidewalks/kerbs follow those same fillets around the corner.
 * Bends (nodes joining two roads) get a continuous curved piece of road.
 */
export interface Arm {
  x: number; y: number; z: number; // centre line at the mouth
  dx: number; dz: number; // unit direction pointing AWAY from the node
  hw: number; // half width of the carriageway
  walk: boolean; // has sidewalks
}

type V3 = [number, number, number];

/** upward-facing triangle regardless of the winding we were given */
function up(g: GB, a: V3, b: V3, c: V3, col: THREE.Color) {
  const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - a[0], vz = c[2] - a[2];
  // flat up normal like the road ribbons, so seams between tilted triangles don't show
  if (uz * vx - ux * vz >= 0) g.quad([a, b, c, c], [0, 1, 0], col); else g.quad([a, c, b, b], [0, 1, 0], col);
}
function upQuad(g: GB, a: V3, b: V3, c: V3, d: V3, col: THREE.Color) { up(g, a, b, c, col); up(g, a, c, d, col); }

/** kerb fillet between the side of arm A facing B and the side of B facing A, at lateral offset o */
function fillet(A: Arm, B: Arm, oa: number, ob: number, y: number, n = 8): V3[] {
  // side of A toward B is +perp(A); side of B toward A is −perp(B)   (arms sorted by angle)
  const ax = A.x - A.dz * oa, az = A.z + A.dx * oa;
  const bx = B.x + B.dz * ob, bz = B.z - B.dx * ob;
  // the two kerb lines run back toward the node: a − dA·t and b − dB·u
  const d1x = -A.dx, d1z = -A.dz, d2x = -B.dx, d2z = -B.dz;
  const det = d1x * d2z - d1z * d2x;
  let cx = (ax + bx) / 2, cz = (az + bz) / 2;
  if (Math.abs(det) > 1e-4) {
    const ex = bx - ax, ez = bz - az;
    const t = (ex * d2z - ez * d2x) / det, u = (ex * d1z - ez * d1x) / det;
    const lim = 2.5 * Math.max(oa, ob) + 8;
    if (t > 0 && u > 0 && t < lim && u < lim) { cx = ax + d1x * t; cz = az + d1z * t; }
  }
  const out: V3[] = [];
  for (let k = 0; k <= n; k++) {
    const f = k / n, i = 1 - f;
    out.push([i * i * ax + 2 * i * f * cx + f * f * bx, y, i * i * az + 2 * i * f * cz + f * f * bz]);
  }
  return out;
}

export interface JunctionStyle { surface: THREE.Color; walk: THREE.Color; curb: THREE.Color }

/** junction of 3+ arms: filleted pavement polygon plus wrapped kerbs and sidewalks */
export function junction(g: GB, cx: number, cy: number, cz: number, arms: Arm[], st: JunctionStyle, ground: (x: number, z: number) => number = () => -1e9) {
  const lift = (p: V3, m = 0.22): V3 => [p[0], Math.max(p[1], ground(p[0], p[2]) + m), p[2]];
  if (arms.length < 2) return;
  const A = [...arms].sort((p, q) => Math.atan2(p.dz, p.dx) - Math.atan2(q.dz, q.dx));
  const outline: V3[] = [];
  for (let i = 0; i < A.length; i++) {
    const a = A[i], b = A[(i + 1) % A.length];
    const y = (a.y + b.y) / 2 + 0.012;
    outline.push([a.x + a.dz * a.hw, y, a.z - a.dx * a.hw]); // −perp side (toward previous arm)
    outline.push(...fillet(a, b, a.hw, b.hw, y));
  }
  const c: V3 = [cx, A.reduce((m, a) => m + a.y, 0) / A.length + 0.012, cz];
  // two rings so the surface can follow the ground between the centre and the kerbs
  const O = outline.map((p) => lift(p));
  const M = O.map((p) => lift([(p[0] + c[0]) / 2, (p[1] + c[1]) / 2, (p[2] + c[2]) / 2]));
  const C = lift(c);
  for (let k = 0; k < O.length; k++) {
    const k1 = (k + 1) % O.length;
    up(g, C, M[k], M[k1], st.surface);
    upQuad(g, M[k], O[k], O[k1], M[k1], st.surface);
  }
  // sidewalks and kerbs follow the corner curves
  for (let i = 0; i < A.length; i++) {
    const a = A[i], b = A[(i + 1) % A.length];
    if (!a.walk || !b.walk) continue;
    const y = (a.y + b.y) / 2;
    const inner = fillet(a, b, a.hw, b.hw, y + 0.12), outer = fillet(a, b, a.hw + 2.6, b.hw + 2.6, y + 0.12);
    const kerbIn = fillet(a, b, a.hw, b.hw, y + 0.14), kerbOut = fillet(a, b, a.hw + 0.25, b.hw + 0.25, y + 0.14);
    for (let k = 0; k < inner.length - 1; k++) {
      upQuad(g, lift(inner[k], 0.34), lift(inner[k + 1], 0.34), lift(outer[k + 1], 0.34), lift(outer[k], 0.34), st.walk);
      upQuad(g, lift(kerbIn[k], 0.36), lift(kerbIn[k + 1], 0.36), lift(kerbOut[k + 1], 0.36), lift(kerbOut[k], 0.36), st.curb);
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
