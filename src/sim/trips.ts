import { RoadClass } from '../shared/constants';
import {
  CROSSWALK_INSET, edgeHalfWidth, edgePtsCum, hasEndCrosswalk, pedWalkOffset, sampleEdgePts,
  sampleRoadSurfaceY, sampleUnderpassWalkY, widthTaperLength,
} from '../shared/roadGeom';
import type { Building } from './buildings';
import type { REdge, RoadNetwork } from './roads';

export interface Access { edge: REdge; t: number; x: number; z: number }

/** where a building touches the road network (re-resolved when edges are split) */
export function accessOf(R: RoadNetwork, b: Building): Access | null {
  let e = b.edge >= 0 ? R.edges[b.edge] : null;
  if (!e || !e.alive || e.progress < 1 || (e.cls === RoadClass.Highway && b.def.cat !== 'transport')) {
    const p = R.nearestEdgePoint(b.x, b.z, Math.max(b.w, b.d) / 2 + 160, (q) => q.alive && q.progress >= 1 && !q.bridge && !q.elevated && q.cls !== RoadClass.Highway);
    if (!p) return null;
    b.edge = p.edge.id; b.edgeT = p.t;
    e = p.edge;
  }
  const a = R.nodes[e.a], bb = R.nodes[e.b];
  return { edge: e, t: b.edgeT, x: a.x + (bb.x - a.x) * b.edgeT, z: a.z + (bb.z - a.z) * b.edgeT };
}

export interface CarPlan { path: number[]; startS: number; destS: number; time: number }
export interface ActivePlan { path: number[]; startS: number; destS: number; len: number }

export function activeAccessOf(R: RoadNetwork, b: Building): Access | null {
  const e = b.edge >= 0 ? R.edges[b.edge] : null;
  if (e && e.alive && e.progress >= 1 && e.deck === undefined) {
    const a = R.nodes[e.a], bb = R.nodes[e.b];
    return { edge: e, t: b.edgeT, x: a.x + (bb.x - a.x) * b.edgeT, z: a.z + (bb.z - a.z) * b.edgeT };
  }
  const p = R.nearestEdgePoint(b.x, b.z, Math.max(b.w, b.d) / 2 + 160, (q) => q.alive && q.progress >= 1 && !q.bridge && !q.elevated && q.deck === undefined);
  if (!p) return null;
  const a = R.nodes[p.edge.a], bb = R.nodes[p.edge.b];
  return { edge: p.edge, t: p.t, x: a.x + (bb.x - a.x) * p.t, z: a.z + (bb.z - a.z) * p.t };
}

export function activePlanEdges(R: RoadNetwork, eo: REdge, to: number, ed: REdge, td: number, ox: number, oz: number, dx: number, dz: number, maxDist = 5200): ActivePlan | null {
  if (eo.deck !== undefined || ed.deck !== undefined) return null;
  if (eo.id === ed.id) {
    const dir = td >= to ? 0 : 1;
    const startS = dir === 0 ? to * eo.len : (1 - to) * eo.len;
    const destS = dir === 0 ? td * eo.len : (1 - td) * eo.len;
    const len = Math.max(2, destS - startS);
    return { path: [eo.id * 2 + dir], startS, destS, len };
  }
  const oa = R.nodes[eo.a], ob = R.nodes[eo.b];
  const dirO = Math.hypot(ob.x - dx, ob.z - dz) <= Math.hypot(oa.x - dx, oa.z - dz) ? 0 : 1;
  const head = dirO === 0 ? eo.b : eo.a;
  const startS = dirO === 0 ? to * eo.len : (1 - to) * eo.len;
  const da = R.nodes[ed.a], db = R.nodes[ed.b];
  const dirD = Math.hypot(da.x - ox, da.z - oz) <= Math.hypot(db.x - ox, db.z - oz) ? 0 : 1;
  const tail = dirD === 0 ? ed.a : ed.b;
  const destS = dirD === 0 ? td * ed.len : (1 - td) * ed.len;
  const mid = R.walkRoute(head, tail, maxDist);
  if (!mid) return null;
  const path = [eo.id * 2 + dirO, ...mid, ed.id * 2 + dirD];
  if (mid.length && (mid[0] >> 1) === eo.id) path.splice(0, 2, mid[0]);
  let dS = destS;
  if (path.length >= 2 && (path[path.length - 2] >> 1) === ed.id) {
    const lastDir = path[path.length - 2] & 1;
    path.pop();
    dS = lastDir === dirD ? destS : ed.len - destS;
  }
  const s0 = (path[0] >> 1) === eo.id ? ((path[0] & 1) === dirO ? startS : eo.len - startS) : 0;
  let len = 0;
  for (let k = 0; k < path.length; k++) len += R.edges[path[k] >> 1].len;
  len = Math.max(10, len - s0 - (R.edges[path[path.length - 1] >> 1].len - dS));
  return { path, startS: s0, destS: dS, len };
}

/** sidewalk/bike route between two buildings: ignores one-way car restrictions and avoids highways */
export function activePlan(R: RoadNetwork, from: Building, to: Building, maxDist = 5200): ActivePlan | null {
  const ao = activeAccessOf(R, from), ad = activeAccessOf(R, to);
  if (!ao || !ad) return null;
  return activePlanEdges(R, ao.edge, ao.t, ad.edge, ad.t, from.x, from.z, to.x, to.z, maxDist);
}

/** sidewalk route between a building and an arbitrary point (e.g. a rail station) */
export function activePlanToPoint(R: RoadNetwork, from: Building, tx: number, tz: number, maxDist = 1400): ActivePlan | null {
  const ao = activeAccessOf(R, from);
  if (!ao) return null;
  const pe = R.nearestEdgePoint(tx, tz, 140, (q) => q.alive && q.progress >= 1 && q.deck === undefined);
  if (!pe) return null;
  return activePlanEdges(R, ao.edge, ao.t, pe.edge, pe.t, from.x, from.z, tx, tz, maxDist);
}

/** sidewalk route between a building and an exact point (edge, t) such as a bus stop */
export function activePlanToEdge(R: RoadNetwork, from: Building, edge: REdge, t: number, tx: number, tz: number, maxDist = 1400): ActivePlan | null {
  const ao = activeAccessOf(R, from);
  if (!ao) return null;
  return activePlanEdges(R, ao.edge, ao.t, edge, Math.max(0, Math.min(1, t)), from.x, from.z, tx, tz, maxDist);
}

export function activePlanFromPoint(R: RoadNetwork, fx: number, fz: number, to: Building, maxDist = 1400): ActivePlan | null {
  const ad = activeAccessOf(R, to);
  if (!ad) return null;
  const pe = R.nearestEdgePoint(fx, fz, 140, (q) => q.alive && q.progress >= 1 && q.deck === undefined);
  if (!pe) return null;
  return activePlanEdges(R, pe.edge, pe.t, ad.edge, ad.t, fx, fz, to.x, to.z, maxDist);
}

export function activePlanFromEdge(R: RoadNetwork, edge: REdge, t: number, fx: number, fz: number, to: Building, maxDist = 1400): ActivePlan | null {
  const ad = activeAccessOf(R, to);
  if (!ad) return null;
  return activePlanEdges(R, edge, Math.max(0, Math.min(1, t)), ad.edge, ad.t, fx, fz, to.x, to.z, maxDist);
}

export function carPlanEdges(R: RoadNetwork, eo: REdge, to: number, ed: REdge, td: number, ox: number, oz: number, dx: number, dz: number): CarPlan | null {
  if (eo.id === ed.id) {
    const dir = td >= to ? 0 : 1;
    if (!(dir === 1 && eo.oneway)) {
      const startS = dir === 0 ? to * eo.len : (1 - to) * eo.len;
      const destS = dir === 0 ? td * eo.len : (1 - td) * eo.len;
      if (destS - startS > 2) return { path: [eo.id * 2 + dir], startS, destS, time: (destS - startS) / R.freeSpeed(eo) };
    }
  }
  // origin: head toward the endpoint closer to the destination
  const oa = R.nodes[eo.a], ob = R.nodes[eo.b];
  let dirO = Math.hypot(ob.x - dx, ob.z - dz) <= Math.hypot(oa.x - dx, oa.z - dz) ? 0 : 1;
  if (eo.oneway) dirO = 0;
  const head = dirO === 0 ? eo.b : eo.a;
  const startS = dirO === 0 ? to * eo.len : (1 - to) * eo.len;
  const da = R.nodes[ed.a], db = R.nodes[ed.b];
  let dirD = Math.hypot(da.x - ox, da.z - oz) <= Math.hypot(db.x - ox, db.z - oz) ? 0 : 1;
  if (ed.oneway) dirD = 0;
  const tail = dirD === 0 ? ed.a : ed.b;
  const destS = dirD === 0 ? td * ed.len : (1 - td) * ed.len;
  const mid = R.route(head, tail);
  if (!mid) return null;
  const path = [eo.id * 2 + dirO, ...mid, ed.id * 2 + dirD];
  // avoid U-turn artefacts: if mid starts by going back on the origin edge, start from the other side
  if (mid.length && (mid[0] >> 1) === eo.id) path.splice(0, 2, mid[0]);
  let dS = destS;
  if (path.length >= 2 && (path[path.length - 2] >> 1) === ed.id) {
    const lastDir = path[path.length - 2] & 1;
    path.pop();
    dS = lastDir === dirD ? destS : ed.len - destS;
  }
  const time = R.pathTime(path);
  return { path, startS: (path[0] >> 1) === eo.id ? ((path[0] & 1) === dirO ? startS : eo.len - startS) : 0, destS: dS, time };
}

export function carPlan(R: RoadNetwork, from: Building, to: Building): CarPlan | null {
  const ao = accessOf(R, from), ad = accessOf(R, to);
  if (!ao || !ad) return null;
  return carPlanEdges(R, ao.edge, ao.t, ad.edge, ad.t, from.x, from.z, to.x, to.z);
}

/** plan from a node (e.g. highway entry) to a building */
export function carPlanFromNode(R: RoadNetwork, node: number, to: Building): CarPlan | null {
  const ad = accessOf(R, to);
  if (!ad) return null;
  const n = R.nodes[node];
  const first = n.edges.map((id) => R.edges[id]).find((e) => e.alive && e.progress >= 1 && (!e.oneway || e.a === node));
  if (!first) return null;
  const t0 = first.a === node ? 0.001 : 0.999;
  return carPlanEdges(R, first, t0, ad.edge, ad.t, n.x, n.z, to.x, to.z);
}
export function carPlanToNode(R: RoadNetwork, from: Building, node: number): CarPlan | null {
  const ao = accessOf(R, from);
  if (!ao) return null;
  const n = R.nodes[node];
  const last = n.edges.map((id) => R.edges[id]).find((e) => e.alive && e.progress >= 1 && (!e.oneway || e.b === node));
  if (!last) return null;
  const t1 = last.a === node ? 0.001 : 0.999;
  return carPlanEdges(R, ao.edge, ao.t, last, t1, from.x, from.z, n.x, n.z);
}

interface WalkHop {
  e: REdge;
  dir: number;
  cum: Float64Array;
  totalLen: number;
  nStart: number;
  nEnd: number;
  rStart: number;
  rEnd: number;
  swStart: number;
  swEnd: number;
  cwStart: number;
  cwEnd: number;
  off: number;
  urban: boolean;
  /** Tapered sidewalk zone at start/end of this hop when joining a wider straight road (`local <-> highway`). */
  taperStart: number;
  offStart: number;
  taperEnd: number;
  offEnd: number;
}

/** Exact sidewalk lateral offset at longitudinal coordinate `s` along `h`, matching RoadsLayer's width taper. */
function hopOffsetAt(h: WalkHop, s: number): number {
  if (h.taperStart > 0 && s < h.taperStart) {
    const f = Math.max(0, Math.min(1, s / h.taperStart));
    return h.offStart + (h.off - h.offStart) * f;
  }
  if (h.taperEnd > 0 && s > h.totalLen - h.taperEnd) {
    const f = Math.max(0, Math.min(1, (s - (h.totalLen - h.taperEnd)) / h.taperEnd));
    return h.off + (h.offEnd - h.off) * f;
  }
  return h.off;
}

function pushPt(out: number[], outY: number[], x: number, y: number, z: number) {
  if (out.length >= 2) {
    const lx = out[out.length - 2], lz = out[out.length - 1];
    if (Math.hypot(x - lx, z - lz) <= 0.25) return;
  }
  out.push(x, z);
  outY.push(y);
}

function groundWalkY(R: RoadNetwork, x: number, z: number, lift = 0.15): number {
  return Math.max(0.2, R.terrain.meshY(x, z), R.terrain.heightAt(x, z)) + lift;
}

function swPt3DAtOff(R: RoadNetwork, h: WalkHop, s: number, side: number, off: number): [number, number, number] {
  const p = sampleEdgePts(h.e.pts, s, h.dir, h.cum);
  const wx = p[0] - p[4] * off * side;
  const wz = p[2] + p[3] * off * side;
  const e = h.e;
  // Level-accurate elevation: structures (bridges, elevated decks, tunnels) strictly follow their own e.pts level;
  // surface streets clear meshY without ever snapping up to overhead viaducts or dropping into tunnels below.
  let wy: number;
  if (e.tunnel) {
    wy = p[1] + 0.12;
  } else if (e.elevated) {
    wy = p[1] + 0.12;
  } else if (e.bridge) {
    const nearEnd = s < 10 || s > h.totalLen - 10;
    wy = nearEnd ? Math.max(p[1], R.terrain.meshY(wx, wz) + 0.18) + 0.12 : p[1] + 0.12;
  } else {
    // Inside a carved rail underpass (`c.under`), use the exact shared transverse-aware walkway profile
    let underY: number | null = null;
    if (e.underpasses && e.underpasses.length) {
      const sFwd = h.dir === 0 ? s : h.totalLen - s;
      const hw = edgeHalfWidth(e);
      const meshGround = (gx: number, gz: number) => R.terrain.meshY(gx, gz);
      for (const up of e.underpasses) {
        const u = sFwd - up.t * e.len;
        if (u >= -up.halfLenNeg - 0.05 && u <= up.halfLenPos + 0.05) {
          const surfRoadY = sampleRoadSurfaceY(p[0], p[2], -p[4], p[3], hw, meshGround);
          const candidate = sampleUnderpassWalkY(
            u, surfRoadY, meshGround(wx, wz), up.ry,
            up.halfLenNeg, up.halfLenPos, up.flatHalf, up.depth, h.urban,
          );
          if (underY === null || candidate < underY) underY = candidate;
        }
      }
    }
    if (underY !== null) {
      wy = underY;
    } else {
      const gY = Math.max(0.2, R.terrain.meshY(wx, wz));
      wy = h.urban
        ? Math.max(p[1] + 0.12, gY + 0.30)
        : Math.max(p[1] + 0.04, gY + 0.18);
    }
  }
  return [wx, wy, wz];
}

function swPt3D(R: RoadNetwork, h: WalkHop, s: number, side: number): [number, number, number] {
  return swPt3DAtOff(R, h, s, side, hopOffsetAt(h, s));
}

function pushAlongEdge(R: RoadNetwork, out: number[], outY: number[], h: WalkHop, sA: number, sB: number, side: number) {
  const [ax, ay, az] = swPt3D(R, h, sA, side);
  pushPt(out, outY, ax, ay, az);
  if (Math.abs(sB - sA) <= 0.3) return;
  const n = h.cum.length;
  const total = h.totalLen;
  const forward = sB >= sA;
  const lo = Math.min(sA, sB), hi = Math.max(sA, sB);
  const sList: number[] = [];
  // Include intermediate vertices of e.pts so curved roads, bridges, and underpasses follow exact height
  if (h.dir === 0) {
    for (let i = 1; i < n - 1; i++) {
      const si = h.cum[i];
      if (si > lo + 0.4 && si < hi - 0.4) sList.push(si);
    }
  } else {
    for (let i = 1; i < n - 1; i++) {
      const si = total - h.cum[i];
      if (si > lo + 0.4 && si < hi - 0.4) sList.push(si);
    }
  }
  // Include exact width-taper breakpoints and fine samples inside any taper zone overlapped by [lo, hi]
  if (h.taperStart > 0 && lo < h.taperStart) {
    const tHi = Math.min(hi, h.taperStart);
    for (let st = 1; st <= 4; st++) {
      const sp = lo + ((tHi - lo) * st) / 4;
      if (sp > lo + 0.25 && sp < hi - 0.25) sList.push(sp);
    }
  }
  if (h.taperEnd > 0 && hi > total - h.taperEnd) {
    const tLo = Math.max(lo, total - h.taperEnd);
    for (let st = 0; st < 4; st++) {
      const sp = tLo + ((hi - tLo) * st) / 4;
      if (sp > lo + 0.25 && sp < hi - 0.25) sList.push(sp);
    }
  }
  sList.sort((u, v) => (forward ? u - v : v - u));
  let lastS = sA;
  for (const si of sList) {
    if (Math.abs(si - lastS) <= 0.3) continue;
    lastS = si;
    const [px, py, pz] = swPt3D(R, h, si, side);
    pushPt(out, outY, px, py, pz);
  }
  const [bx, by, bz] = swPt3D(R, h, sB, side);
  pushPt(out, outY, bx, by, bz);
}

/** Quadratic Bezier corner fillet matching junctions.ts sidewalks around a corner, with C0 elevation interpolation */
function pushCornerFillet(
  out: number[], outY: number[],
  pA: [number, number, number], uA: [number, number],
  pB: [number, number, number], uB: [number, number],
  R: RoadNetwork, surface = true,
) {
  const det = uA[0] * (-uB[1]) - uA[1] * (-uB[0]);
  let cx = (pA[0] + pB[0]) * 0.5;
  let cz = (pA[2] + pB[2]) * 0.5;
  if (Math.abs(det) > 0.08) {
    const ex = pB[0] - pA[0], ez = pB[2] - pA[2];
    const t = (ex * (-uB[1]) - ez * (-uB[0])) / det;
    const u = (uA[0] * ez - uA[1] * ex) / det;
    if (t > 0 && u > 0 && t < 28 && u < 28) {
      cx = pA[0] + uA[0] * t;
      cz = pA[2] + uA[1] * t;
    }
  }
  for (let step = 1; step <= 4; step++) {
    const f = step / 4, inv = 1 - f;
    const x = inv * inv * pA[0] + 2 * inv * f * cx + f * f * pB[0];
    const z = inv * inv * pA[2] + 2 * inv * f * cz + f * f * pB[2];
    const yLin = pA[1] + (pB[1] - pA[1]) * f;
    const y = surface ? Math.max(yLin, groundWalkY(R, x, z, 0.27)) : yLin;
    pushPt(out, outY, x, y, z);
  }
}

export interface WalkPath3D {
  pts: number[];
  ys: number[];
}

/**
 * Sidewalk & crosswalk waypoints [x,z,...] plus level-accurate per-waypoint elevations `ys`,
 * following real road geometry (`e.pts`), keeping pedestrians on rendered sidewalks & bridge walkways,
 * rounding corners along fillets, and never confusing multi-level viaducts/tunnels with surface streets.
 */
export function walkPath(
  R: RoadNetwork,
  plan: { path: number[]; startS: number; destS: number },
  from: { x: number; z: number },
  to: { x: number; z: number },
): WalkPath3D {
  const m = plan.path.length;
  if (!m) {
    return {
      pts: [from.x, from.z, to.x, to.z],
      ys: [groundWalkY(R, from.x, from.z), groundWalkY(R, to.x, to.z)],
    };
  }

  const hops: WalkHop[] = [];
  for (let k = 0; k < m; k++) {
    const de = plan.path[k];
    const e = R.edges[de >> 1];
    if (!e || !e.alive) continue;
    const dir = de & 1;
    const cum = edgePtsCum(e.pts);
    const totalLen = cum[cum.length - 1] || e.len || 1;
    const nStart = dir === 0 ? e.a : e.b;
    const nEnd = dir === 0 ? e.b : e.a;
    const rStart = R.nodeRenderR(nStart) * 0.92;
    const rEnd = R.nodeRenderR(nEnd) * 0.92;
    const swStart = Math.min(rStart, totalLen * 0.45);
    const swEnd = Math.max(totalLen - rEnd, totalLen * 0.55);
    const incStart = R.surfaceEdgesAt(nStart);
    const incEnd = R.surfaceEdgesAt(nEnd);
    const hasCwStart = hasEndCrosswalk(e, totalLen, incStart.length, incStart.some((q) => q.cls >= RoadClass.Local && q.cls <= RoadClass.Avenue), !!R.nodes[nStart]?.interchange);
    const hasCwEnd = hasEndCrosswalk(e, totalLen, incEnd.length, incEnd.some((q) => q.cls >= RoadClass.Local && q.cls <= RoadClass.Avenue), !!R.nodes[nEnd]?.interchange);
    const urban = R.hasSidewalk(e.id);
    const cwStart = rStart > 0 && (urban || hasCwStart) && totalLen > 20 ? Math.min(swStart + CROSSWALK_INSET, totalLen * 0.5) : swStart;
    const cwEnd = rEnd > 0 && (urban || hasCwEnd) && totalLen > 20 ? Math.max(swEnd - CROSSWALK_INSET, totalLen * 0.5) : swEnd;
    const myOff = pedWalkOffset(e);
    const myHW = edgeHalfWidth(e);
    // Compute exact straight width-taper zones at start/end matching RoadsLayer.taperMap
    const endTaper = (nid: number, inc: REdge[]): { len: number; off: number } => {
      if (!urban || e.bridge || e.elevated || e.tunnel || e.deck !== undefined || inc.length !== 2) return { len: 0, off: myOff };
      const other = inc[0].id === e.id ? inc[1] : inc[0];
      if (!other || other.bridge || other.elevated || other.tunnel || other.deck !== undefined) return { len: 0, off: myOff };
      if (!R.hasSidewalk(other.id)) return { len: 0, off: myOff };
      const oHW = edgeHalfWidth(other);
      if (oHW <= myHW + 0.25) return { len: 0, off: myOff };
      // Confirm straight joint (turn < 0.1 rad, matching RoadsLayer.taperMap)
      const pMe = sampleEdgePts(e.pts, e.a === nid ? 0 : totalLen, e.a === nid ? 0 : 1, cum);
      const oCum = edgePtsCum(other.pts), oLen = oCum[oCum.length - 1] || other.len || 1;
      const pOt = sampleEdgePts(other.pts, other.a === nid ? 0 : oLen, other.a === nid ? 0 : 1, oCum);
      const turn = Math.acos(Math.max(-1, Math.min(1, -(pMe[3] * pOt[3] + pMe[4] * pOt[4]))));
      if (turn >= 0.1) return { len: 0, off: myOff };
      const tLen = widthTaperLength(myHW, oHW, totalLen);
      return tLen > 0.5 ? { len: tLen, off: pedWalkOffset(other) } : { len: 0, off: myOff };
    };
    const tS = endTaper(nStart, incStart);
    const tE = endTaper(nEnd, incEnd);
    hops.push({
      e, dir, cum, totalLen, nStart, nEnd, rStart, rEnd, swStart, swEnd, cwStart, cwEnd,
      off: myOff, urban,
      taperStart: tS.len, offStart: tS.off,
      taperEnd: tE.len, offEnd: tE.off,
    });
  }
  if (!hops.length) {
    return {
      pts: [from.x, from.z, to.x, to.z],
      ys: [groundWalkY(R, from.x, from.z), groundWalkY(R, to.x, to.z)],
    };
  }

  // Determine which side (+1 right of dir, -1 left of dir) origin and destination lie on
  const sideOfPoint = (h: WalkHop, s: number, pt: { x: number; z: number }): number => {
    const p = sampleEdgePts(h.e.pts, s, h.dir, h.cum);
    const dot = (pt.x - p[0]) * (-p[4]) + (pt.z - p[2]) * p[3];
    return dot >= 0 ? 1 : -1;
  };
  const s0Raw = Math.max(0, Math.min(hops[0].totalLen, plan.startS));
  const sEndRaw = Math.max(0, Math.min(hops[hops.length - 1].totalLen, plan.destS));
  const sideFrom = sideOfPoint(hops[0], s0Raw, from);
  const sideTo = sideOfPoint(hops[hops.length - 1], sEndRaw, to);

  const firstEdge = hops[0].e;
  const lastEdge = hops[hops.length - 1].e;
  const fromY = firstEdge.bridge || firstEdge.elevated || firstEdge.tunnel
    ? swPt3D(R, hops[0], s0Raw, sideFrom)[1]
    : groundWalkY(R, from.x, from.z, 0.16);
  const toY = lastEdge.bridge || lastEdge.elevated || lastEdge.tunnel
    ? swPt3D(R, hops[hops.length - 1], sEndRaw, sideTo)[1]
    : groundWalkY(R, to.x, to.z, 0.16);

  const out: number[] = [from.x, from.z];
  const outY: number[] = [fromY];

  // Single-edge trip
  if (hops.length === 1) {
    const h = hops[0];
    const sA = Math.max(0, Math.min(h.totalLen, plan.startS));
    const sB = Math.max(0, Math.min(h.totalLen, plan.destS));
    if (sideFrom === sideTo) {
      pushAlongEdge(R, out, outY, h, sA, sB, sideFrom);
    } else {
      // Cross on the nearest painted crosswalk (or perpendicular midpoint on very long blocks)
      const cands: number[] = [];
      if (h.rStart > 0 || h.urban) cands.push(h.cwStart);
      if (h.rEnd > 0 || h.urban) cands.push(h.cwEnd);
      let sCross = (sA + sB) * 0.5;
      let bestCost = Infinity;
      for (const cw of cands) {
        const extra = Math.abs(sA - cw) + Math.abs(sB - cw) - Math.abs(sB - sA);
        if (extra < bestCost) { bestCost = extra; sCross = cw; }
      }
      if (bestCost > 160) sCross = Math.max(h.swStart, Math.min(h.swEnd, (sA + sB) * 0.5));
      pushAlongEdge(R, out, outY, h, sA, sCross, sideFrom);
      const [cx2, cy2, cz2] = swPt3D(R, h, sCross, sideTo);
      pushPt(out, outY, cx2, cy2, cz2);
      pushAlongEdge(R, out, outY, h, sCross, sB, sideTo);
    }
    pushPt(out, outY, to.x, toY, to.z);
    return { pts: out, ys: outY };
  }

  // Multi-edge trip: 2-state DP to pick the sidewalk side (+1/-1) on each edge minimizing street crossings
  const H = hops.length;
  const dp0 = new Float64Array(H).fill(Infinity); // state 0 -> side -1
  const dp1 = new Float64Array(H).fill(Infinity); // state 1 -> side +1
  const prev0 = new Int8Array(H);
  const prev1 = new Int8Array(H);
  if (sideFrom < 0) dp0[0] = 0; else dp1[0] = 0;

  const transCost = (k: number, sa: number, sb: number): number => {
    const h1 = hops[k], h2 = hops[k + 1];
    const p1 = sampleEdgePts(h1.e.pts, h1.swEnd, h1.dir, h1.cum);
    const p2 = sampleEdgePts(h2.e.pts, h2.swStart, h2.dir, h2.cum);
    const cross = p1[3] * p2[4] - p1[4] * p2[3];
    const dot = p1[3] * p2[3] + p1[4] * p2[4];
    if (h1.rEnd === 0) return sa === sb ? 0 : 1.5;
    if ((cross > 0.25 && sa === 1 && sb === 1) || (cross < -0.25 && sa === -1 && sb === -1)) return 0; // inner corner fillet
    if (Math.abs(cross) <= 0.25 && dot > 0 && sa === sb) return 0.8; // straight across side arm
    if (sa !== sb && ((cross > 0.25 && sb === 1) || (cross < -0.25 && sb === -1) || (cross > 0.25 && sa === 1) || (cross < -0.25 && sa === -1))) return 1.2;
    if (Math.abs(cross) <= 0.25 && dot > 0 && sa !== sb) return 2.0;
    return 2.5; // outer corner (2 crosswalks)
  };

  for (let k = 0; k < H - 1; k++) {
    for (let nextSt = 0; nextSt < 2; nextSt++) {
      const sb = nextSt === 0 ? -1 : 1;
      const c0 = dp0[k] + transCost(k, -1, sb);
      const c1 = dp1[k] + transCost(k, 1, sb);
      if (nextSt === 0) {
        if (c0 <= c1) { dp0[k + 1] = c0; prev0[k + 1] = 0; } else { dp0[k + 1] = c1; prev0[k + 1] = 1; }
      } else {
        if (c0 <= c1) { dp1[k + 1] = c0; prev1[k + 1] = 0; } else { dp1[k + 1] = c1; prev1[k + 1] = 1; }
      }
    }
  }
  const sides = new Int8Array(H);
  let st = sideTo < 0 ? 0 : 1;
  sides[H - 1] = sideTo;
  for (let k = H - 1; k >= 1; k--) {
    st = st === 0 ? prev0[k] : prev1[k];
    sides[k - 1] = st === 0 ? -1 : 1;
  }
  sides[0] = sideFrom;

  // Walk through hops and emit explicit corner fillets & crosswalk crossings at every junction
  let curS = Math.min(hops[0].swEnd, s0Raw);
  let curSide = sides[0];

  /** Round or cross straight from mouth of h1 (side `sd`) to mouth of h2 (same side `sd`) at junction nid */
  const emitSameSideJunction = (h1: WalkHop, h2: WalkHop, sd: number) => {
    const p1 = sampleEdgePts(h1.e.pts, h1.swEnd, h1.dir, h1.cum);
    const p2 = sampleEdgePts(h2.e.pts, h2.swStart, h2.dir, h2.cum);
    const u1: [number, number] = [p1[3], p1[4]];
    const u2: [number, number] = [p2[3], p2[4]];
    const mouth1 = swPt3D(R, h1, h1.swEnd, sd);
    const mouth2 = swPt3D(R, h2, h2.swStart, sd);
    const surf = !h1.e.tunnel && !h2.e.tunnel && !h1.e.elevated && !h2.e.elevated;
    const cross = u1[0] * u2[1] - u1[1] * u2[0];
    const dot = u1[0] * u2[0] + u1[1] * u2[1];

    // Inner corner turn: pure sidewalk fillet (no asphalt crossed)
    if ((cross > 0.25 && sd === 1) || (cross < -0.25 && sd === -1)) {
      pushCornerFillet(out, outY, mouth1, u1, mouth2, u2, R, surf);
      return;
    }

    // Going straight on side `sd`: check if a side arm leaves the junction on that side
    if (Math.abs(cross) <= 0.25 && dot > 0) {
      const nid = h1.nEnd;
      const rx = -u1[1] * sd, rz = u1[0] * sd; // outward normal on side `sd`
      let sideArm: REdge | null = null;
      let bestAlign = 0.45;
      for (const cand of R.surfaceEdgesAt(nid)) {
        if (cand.id === h1.e.id || cand.id === h2.e.id) continue;
        const cDir = cand.a === nid ? 0 : 1;
        const cp = sampleEdgePts(cand.pts, Math.min(5, cand.len * 0.5), cDir);
        const align = cp[3] * rx + cp[4] * rz;
        if (align > bestAlign) { bestAlign = align; sideArm = cand; }
      }
      if (sideArm && sideArm.len > 16) {
        const sDir = sideArm.a === nid ? 0 : 1;
        const sCum = edgePtsCum(sideArm.pts);
        const sLen = sCum[sCum.length - 1] || sideArm.len;
        const nd = R.nodes[nid];
        const inc = R.surfaceEdgesAt(nid);
        const hasUrban = inc.some((q) => q.cls >= RoadClass.Local && q.cls <= RoadClass.Avenue);
        const hasCw = hasEndCrosswalk(sideArm, sLen, inc.length, hasUrban, !!nd?.interchange);
        const rN = R.nodeRenderR(nid) * 0.92;
        const sMouth = Math.min(rN, sLen * 0.45);
        const sCw = hasCw ? Math.min(sMouth + CROSSWALK_INSET, sLen * 0.5) : sMouth;
        const sOff = pedWalkOffset(sideArm);
        const sp = sampleEdgePts(sideArm.pts, sCw, sDir, sCum);
        const sUx = sp[3], sUz = sp[4];
        // side of sideArm facing h1 (behind u1) vs facing h2 (ahead along u2)
        const sideBehind = ((-sUz) * (-u1[0]) + sUx * (-u1[1])) >= 0 ? 1 : -1;
        const sideAhead = -sideBehind;
        const bx = sp[0] - sUz * sOff * sideBehind, bz = sp[2] + sUx * sOff * sideBehind;
        const ax = sp[0] - sUz * sOff * sideAhead, az = sp[2] + sUx * sOff * sideAhead;
        const by = Math.max(sp[1], groundWalkY(R, bx, bz, 0.14)) + 0.13;
        const ay = Math.max(sp[1], groundWalkY(R, ax, az, 0.14)) + 0.13;
        const pBehind: [number, number, number] = [bx, by, bz];
        const pAhead: [number, number, number] = [ax, ay, az];
        // Curve onto the side arm's sidewalk to its painted crosswalk, cross on zebra stripes, curve onto h2
        pushCornerFillet(out, outY, mouth1, u1, pBehind, [sUx, sUz], R, surf);
        pushPt(out, outY, pAhead[0], pAhead[1], pAhead[2]);
        pushCornerFillet(out, outY, pAhead, [-sUx, -sUz], mouth2, u2, R, surf);
        return;
      }
      // No side arm (T-junction straight side): follow smooth sidewalk transition when road width changes
      if (Math.abs(h1.off - h2.off) > 0.25) {
        const midX = (mouth1[0] + mouth2[0]) * 0.5, midZ = (mouth1[2] + mouth2[2]) * 0.5;
        const maxOff = Math.max(h1.off, h2.off);
        const nd = R.nodes[h1.nEnd];
        // Push midpoint outward to the wider sidewalk alignment so the path stays 100% on rendered corner sidewalk
        const cX = nd ? nd.x - u1[1] * maxOff * sd : midX;
        const cZ = nd ? nd.z + u1[0] * maxOff * sd : midZ;
        for (let st = 1; st <= 4; st++) {
          const f = st / 4, inv = 1 - f;
          const x = inv * inv * mouth1[0] + 2 * inv * f * cX + f * f * mouth2[0];
          const z = inv * inv * mouth1[2] + 2 * inv * f * cZ + f * f * mouth2[2];
          const yLin = mouth1[1] + (mouth2[1] - mouth1[1]) * f;
          const y = surf ? Math.max(yLin, groundWalkY(R, x, z, 0.30)) : yLin;
          pushPt(out, outY, x, y, z);
        }
        return;
      }
      // Equal widths: continuous sidewalk straight through
      pushPt(out, outY, mouth2[0], mouth2[1], mouth2[2]);
      return;
    }

    // Fallback smooth corner
    pushCornerFillet(out, outY, mouth1, u1, mouth2, u2, R, surf);
  };

  for (let k = 0; k < H - 1; k++) {
    const h1 = hops[k], h2 = hops[k + 1];
    const s1 = curSide;
    const s2 = sides[k + 1];

    // Deg <= 2 bend (no intersection box, including bridge abutments and straight width tapers handled by hopOffsetAt)
    if (h1.rEnd === 0) {
      if (s1 === s2) {
        pushAlongEdge(R, out, outY, h1, curS, h1.totalLen, s1);
        const [bx, by, bz] = swPt3D(R, h2, 0, s2);
        pushPt(out, outY, bx, by, bz);
        curS = 0;
      } else {
        const sCross = Math.max(curS, h1.totalLen - 3);
        pushAlongEdge(R, out, outY, h1, curS, sCross, s1);
        const [cx, cy, cz] = swPt3D(R, h1, sCross, s2);
        pushPt(out, outY, cx, cy, cz);
        pushAlongEdge(R, out, outY, h1, sCross, h1.totalLen, s2);
        curS = 0;
      }
      curSide = s2;
      continue;
    }

    // Deg >= 3 junction: never cross diagonally through the center
    const p1 = sampleEdgePts(h1.e.pts, h1.swEnd, h1.dir, h1.cum);
    const p2 = sampleEdgePts(h2.e.pts, h2.swStart, h2.dir, h2.cum);
    const cross = p1[3] * p2[4] - p1[4] * p2[3];
    const dot = p1[3] * p2[3] + p1[4] * p2[4];
    const isRightTurn = cross > 0.25;
    const isLeftTurn = cross < -0.25;

    // Choose which side to round the corner on: inner corner when turning, else s2 when going straight
    const cornerSide = isRightTurn ? 1 : isLeftTurn ? -1 : (dot > 0 ? s2 : s1);

    if (s1 !== cornerSide) {
      // Cross h1 on its painted crosswalk before reaching the junction mouth
      const sCross1 = Math.min(h1.cwEnd, Math.max(curS, h1.cwEnd));
      pushAlongEdge(R, out, outY, h1, curS, sCross1, s1);
      const [cx1, cy1, cz1] = swPt3D(R, h1, sCross1, cornerSide);
      pushPt(out, outY, cx1, cy1, cz1);
      pushAlongEdge(R, out, outY, h1, sCross1, h1.swEnd, cornerSide);
    } else {
      pushAlongEdge(R, out, outY, h1, curS, h1.swEnd, cornerSide);
    }

    // Move around the corner fillet (or across the side arm's crosswalk when going straight)
    emitSameSideJunction(h1, h2, cornerSide);

    if (cornerSide !== s2) {
      // Cross h2 on its painted crosswalk immediately after entering h2
      pushAlongEdge(R, out, outY, h2, h2.swStart, h2.cwStart, cornerSide);
      const [cx2, cy2, cz2] = swPt3D(R, h2, h2.cwStart, s2);
      pushPt(out, outY, cx2, cy2, cz2);
      curS = h2.cwStart;
      curSide = s2;
    } else {
      curS = h2.swStart;
      curSide = s2;
    }
  }

  // Final hop to destination sidewalk projection, then perpendicular into destination door
  const lastH = hops[H - 1];
  const finalS = Math.max(lastH.swStart, Math.min(lastH.totalLen, sEndRaw));
  pushAlongEdge(R, out, outY, lastH, curS, finalS, curSide);
  pushPt(out, outY, to.x, toY, to.z);
  return { pts: out, ys: outY };
}

/** Backwards-compatible 2D [x,z,...] wrapper around `walkPath()`. */
export function walkPoints(
  R: RoadNetwork,
  plan: { path: number[]; startS: number; destS: number },
  from: { x: number; z: number },
  to: { x: number; z: number },
): number[] {
  return walkPath(R, plan, from, to).pts;
}

export function pathLength(R: RoadNetwork, plan: CarPlan): number {
  let d = 0;
  for (let k = 0; k < plan.path.length; k++) d += R.edges[plan.path[k] >> 1].len;
  return Math.max(10, d - plan.startS - (R.edges[plan.path[plan.path.length - 1] >> 1].len - plan.destS));
}

/** door point: on the front facade of the building facing its street, strictly outside the footprint */
export function doorOf(R: RoadNetwork, b: Building): { x: number; z: number } {
  const a = activeAccessOf(R, b) ?? accessOf(R, b);
  if (!a) return { x: b.x, z: b.z };
  const dx = a.x - b.x, dz = a.z - b.z;
  const dist = Math.hypot(dx, dz) || 1;
  const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
  const lu = dx * ca + dz * sa;
  const lv = -dx * sa + dz * ca;
  const hw = Math.max(0.5, b.w * 0.5);
  const hd = Math.max(0.5, b.d * 0.5);
  const scale = Math.max(Math.abs(lu) / hw, Math.abs(lv) / hd, 1e-6);
  const rFacade = dist / scale;
  const swOff = pedWalkOffset(a.edge);
  const maxR = Math.max(rFacade + 0.25, dist - swOff);
  const r = Math.min(rFacade + 0.6, maxR);
  return { x: b.x + (dx / dist) * r, z: b.z + (dz / dist) * r };
}
