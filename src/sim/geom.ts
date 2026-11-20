/** distance from a segment to an oriented rectangle centred at the origin (0 when they intersect) */
export function segRectDist(ax: number, az: number, bx: number, bz: number, ca: number, sa: number, hw: number, hd: number): number {
  // into the rectangle frame
  const u0 = ax * ca + az * sa, v0 = -ax * sa + az * ca, u1 = bx * ca + bz * sa, v1 = -bx * sa + bz * ca;
  // segment vs box (exact): clip against the slab, otherwise distance to the nearest feature
  if (segBoxHit(u0, v0, u1, v1, hw, hd)) return 0;
  let best = Math.min(ptBox(u0, v0, hw, hd), ptBox(u1, v1, hw, hd));
  for (const [cu, cv] of [[hw, hd], [-hw, hd], [hw, -hd], [-hw, -hd]]) best = Math.min(best, ptSeg(cu, cv, u0, v0, u1, v1));
  return best;
}
function ptBox(u: number, v: number, hw: number, hd: number) { return Math.hypot(Math.max(0, Math.abs(u) - hw), Math.max(0, Math.abs(v) - hd)); }
function ptSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}
function segBoxHit(u0: number, v0: number, u1: number, v1: number, hw: number, hd: number) {
  let t0 = 0, t1 = 1;
  const du = u1 - u0, dv = v1 - v0;
  for (const [p, q] of [[-du, u0 + hw], [du, hw - u0], [-dv, v0 + hd], [dv, hd - v0]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}
