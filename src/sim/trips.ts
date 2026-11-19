import { RoadClass } from '../shared/constants';
import type { Building } from './buildings';
import type { REdge, RoadNetwork } from './roads';
import { laneOffset } from './traffic';

export interface Access { edge: REdge; t: number; x: number; z: number }

/** where a building touches the road network (re-resolved when edges are split) */
export function accessOf(R: RoadNetwork, b: Building): Access | null {
  let e = b.edge >= 0 ? R.edges[b.edge] : null;
  if (!e || !e.alive || e.progress < 1 || e.cls === RoadClass.Highway && b.def.cat !== 'transport') {
    const p = R.nearestEdgePoint(b.x, b.z, Math.max(b.w, b.d) / 2 + 160, (q) => q.alive && q.progress >= 1 && !q.bridge && !q.elevated && q.cls !== RoadClass.Highway);
    if (!p) return null;
    b.edge = p.edge.id; b.edgeT = p.t;
    e = p.edge;
  }
  const a = R.nodes[e.a], bb = R.nodes[e.b];
  return { edge: e, t: b.edgeT, x: a.x + (bb.x - a.x) * b.edgeT, z: a.z + (bb.z - a.z) * b.edgeT };
}

export interface CarPlan { path: number[]; startS: number; destS: number; time: number }

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

/** sidewalk waypoints [x,z,...] following the car path, offset to the right side */
export function walkPoints(R: RoadNetwork, plan: CarPlan, from: { x: number; z: number }, to: { x: number; z: number }): number[] {
  const out: number[] = [from.x, from.z];
  const pts: number[] = [];
  for (let k = 0; k < plan.path.length; k++) {
    const de = plan.path[k];
    const e = R.edges[de >> 1];
    const dir = de & 1;
    const a = R.nodes[dir === 0 ? e.a : e.b], b = R.nodes[dir === 0 ? e.b : e.a];
    const ux = (b.x - a.x) / e.len, uz = (b.z - a.z) / e.len;
    const off = laneOffset(e, e.lanes - 1) + 3.4;
    const nx = -uz * off, nz = ux * off;
    const s0 = k === 0 ? plan.startS : 0;
    const s1 = k === plan.path.length - 1 ? plan.destS : e.len;
    pts.push(a.x + ux * s0 + nx, a.z + uz * s0 + nz, a.x + ux * s1 + nx, a.z + uz * s1 + nz);
  }
  for (let i = 0; i < pts.length; i += 2) {
    const lx = out[out.length - 2], lz = out[out.length - 1];
    if (Math.hypot(pts[i] - lx, pts[i + 1] - lz) > 0.5) out.push(pts[i], pts[i + 1]);
  }
  out.push(to.x, to.z);
  return out;
}

export function pathLength(R: RoadNetwork, plan: CarPlan): number {
  let d = 0;
  for (let k = 0; k < plan.path.length; k++) d += R.edges[plan.path[k] >> 1].len;
  return Math.max(10, d - plan.startS - (R.edges[plan.path[plan.path.length - 1] >> 1].len - plan.destS));
}

/** door point: on the lot edge facing the street */
export function doorOf(R: RoadNetwork, b: Building): { x: number; z: number } {
  const a = accessOf(R, b);
  if (!a) return { x: b.x, z: b.z };
  const dx = a.x - b.x, dz = a.z - b.z, l = Math.hypot(dx, dz) || 1;
  const r = Math.min(Math.max(b.w, b.d) / 2 + 1, l * 0.8);
  return { x: b.x + (dx / l) * r, z: b.z + (dz / l) * r };
}
