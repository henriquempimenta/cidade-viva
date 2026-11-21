import { LANE_WIDTH, RoadClass } from './constants';

export const SIDEWALK_WIDTH = 2.6;
export const SIDEWALK_CENTER = SIDEWALK_WIDTH * 0.5; // 1.3 m outside carriageway edge
export const CROSSWALK_INSET = 2.2;
export const CROSSWALK_HALF_LEN = 1.4;
export const STOP_LINE_GAP = 0.25;
export const CURB_WAIT_OFFSET = 1.35;
export const QUEUE_OFFSET = 1.0;
export const SHELTER_OFFSET = 2.1;

export interface RoadWidthLike {
  cls: number;
  lanes: number;
  oneway: number;
  viewLanes?: number;
}

/** Half-width of the paved carriageway (asphalt/dirt), shared identically by sim and renderer. */
export function edgeHalfWidth(e: RoadWidthLike): number {
  const lanes = e.viewLanes ?? e.lanes;
  const median = e.cls >= RoadClass.Avenue ? 1.6 : 0.15;
  const dirs = e.oneway ? 1 : 2;
  return (lanes * LANE_WIDTH * dirs) / 2 + median / (e.oneway ? 2 : 1) + 0.4;
}

/** Lateral distance from road centerline to the center of the urban sidewalk ([hw, hw + 2.6]). */
export function sidewalkCenterOffset(e: RoadWidthLike): number {
  return edgeHalfWidth(e) + SIDEWALK_CENTER;
}

/** Lateral walking offset for pedestrians along an edge (handles urban sidewalks, bridge walkways, dirt shoulders). */
export function pedWalkOffset(e: RoadWidthLike & { bridge?: boolean; elevated?: boolean }): number {
  if (e.bridge && !e.elevated) return edgeHalfWidth(e) + 0.75;
  if (e.elevated) return edgeHalfWidth(e) + 0.1;
  if (e.cls === RoadClass.Dirt) return edgeHalfWidth(e) + 0.9;
  return sidewalkCenterOffset(e);
}

/** Whether an edge renders concrete sidewalks + crosswalks. */
export function hasUrbanSidewalk(e: { cls: number; bridge?: boolean; elevated?: boolean }): boolean {
  return e.cls !== RoadClass.Dirt && e.cls !== RoadClass.Highway && !e.bridge && !e.elevated;
}

/**
 * Shared predicate for whether an edge end at a node paints a zebra crosswalk.
 * Used identically by RoadsLayer and walkPoints so pedestrians cross strictly on painted crosswalks.
 */
export function hasEndCrosswalk(
  e: { cls: number; bridge?: boolean; elevated?: boolean; tunnel?: boolean; deck?: number },
  len: number,
  nodeDeg: number,
  nodeHasUrban: boolean,
  nodeInterchange: boolean,
): boolean {
  if (len <= 20 || e.bridge || e.elevated || e.tunnel || e.deck !== undefined) return false;
  if (e.cls >= RoadClass.Local && e.cls <= RoadClass.Avenue) return true;
  if (e.cls === RoadClass.Highway && nodeDeg >= 3 && !nodeInterchange && nodeHasUrban) return true;
  return false;
}

/**
 * Exact distance from a junction node center to the outer (approaching-traffic) edge of the painted
 * zebra crosswalk plus stop-line buffer. Shared identically by Traffic.stopTrim() and RoadsLayer stop bars.
 */
export function crosswalkStopBack(
  e: { cls: number; bridge?: boolean; elevated?: boolean; tunnel?: boolean; deck?: number },
  len: number,
  renderR: number,
  nodeDeg: number,
  nodeHasUrban: boolean,
  nodeInterchange: boolean,
): number {
  if (renderR <= 0 || !hasEndCrosswalk(e, len, nodeDeg, nodeHasUrban, nodeInterchange)) return 0;
  return renderR * 0.92 + CROSSWALK_INSET + CROSSWALK_HALF_LEN + STOP_LINE_GAP;
}

/**
 * Junction fillet radius matching RoadsLayer.nodeR().
 * Returns 0 for degree <= 2 nodes.
 */
export function nodeRenderRadius(control: number, incidentEdges: RoadWidthLike[]): number {
  if (incidentEdges.length <= 2) return 0;
  let r = 3;
  for (const e of incidentEdges) r = Math.max(r, edgeHalfWidth(e) + (control === 3 ? 1.2 : 5.5));
  if (control === 3) r += 9;
  return r;
}

/** Cumulative 2D (XZ) arc lengths for a flat [x, y, z, ...] polyline. */
export function edgePtsCum(pts: number[]): Float64Array {
  const n = Math.floor(pts.length / 3);
  const cum = new Float64Array(n);
  let acc = 0;
  for (let i = 1; i < n; i++) {
    acc += Math.hypot(pts[i * 3] - pts[(i - 1) * 3], pts[i * 3 + 2] - pts[(i - 1) * 3 + 2]);
    cum[i] = acc;
  }
  return cum;
}

/**
 * Sample [x, y, z, ux, uz] along a flat [x, y, z, ...] edge polyline at distance s from the start of direction dir.
 * dir === 0: forward (pts[0] -> pts[end]); dir === 1: reversed (pts[end] -> pts[0]).
 */
export function sampleEdgePts(
  pts: number[],
  s: number,
  dir: number,
  cum?: Float64Array,
): [number, number, number, number, number] {
  const n = Math.floor(pts.length / 3);
  if (n < 2) return [pts[0] ?? 0, pts[1] ?? 0, pts[2] ?? 0, 1, 0];
  const c = cum ?? edgePtsCum(pts);
  const total = c[n - 1] || 1;
  const sf = dir === 0 ? Math.max(0, Math.min(total, s)) : Math.max(0, Math.min(total, total - s));
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c[mid] <= sf) lo = mid;
    else hi = mid;
  }
  const segL = Math.max(1e-6, c[hi] - c[lo]);
  const t = Math.max(0, Math.min(1, (sf - c[lo]) / segL));
  const x0 = pts[lo * 3], y0 = pts[lo * 3 + 1], z0 = pts[lo * 3 + 2];
  const x1 = pts[hi * 3], y1 = pts[hi * 3 + 1], z1 = pts[hi * 3 + 2];
  const dx = x1 - x0, dz = z1 - z0;
  const l = Math.hypot(dx, dz) || 1;
  let ux = dx / l, uz = dz / l;
  if (dir === 1) {
    ux = -ux;
    uz = -uz;
  }
  return [x0 + dx * t, y0 + (y1 - y0) * t, z0 + dz * t, ux, uz];
}
