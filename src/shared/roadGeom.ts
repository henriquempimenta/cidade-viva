import { LANE_WIDTH, RoadClass } from './constants';

export const SIDEWALK_WIDTH = 2.6;
export const SIDEWALK_CENTER = SIDEWALK_WIDTH * 0.5; // 1.3 m outside carriageway edge
export const CROSSWALK_INSET = 2.2;
export const CROSSWALK_HALF_LEN = 1.4;
export const STOP_LINE_GAP = 0.25;
export const CURB_WAIT_OFFSET = 1.35;
export const QUEUE_OFFSET = 1.0;
export const SHELTER_OFFSET = 2.1;
export const UNDERPASS_HALF_LEN = 28;
export const UNDERPASS_FLAT_HALF = 7;
export const UNDERPASS_DEPTH = 4.6;

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

export interface SidewalkContext {
  /** Incident completed surface edge counts at endpoints a and b. */
  degA?: number;
  degB?: number;
  interchangeA?: boolean;
  interchangeB?: boolean;
  /** Number of incident urban (Local..Avenue) edges at endpoints a and b. */
  urbanEdgesA?: number;
  urbanEdgesB?: number;
  /** True when both ends connect to adjacent edges that already carry urban sidewalks (prevents mid-corridor gaps). */
  bridgedBetweenUrban?: boolean;
}

/** Whether an edge renders concrete sidewalks + crosswalks (supports urban highway/access continuity). */
export function hasUrbanSidewalk(
  e: { cls: number; bridge?: boolean; elevated?: boolean; tunnel?: boolean; deck?: number },
  ctx?: SidewalkContext,
): boolean {
  if (e.cls === RoadClass.Dirt || e.bridge || e.elevated || e.tunnel || e.deck !== undefined) return false;
  if (e.cls !== RoadClass.Highway) return true;
  if (!ctx) return false;
  if (ctx.bridgedBetweenUrban) return true;
  const endUrban = (deg = 0, inter = false, urbanEdges = 0) => !inter && (urbanEdges >= 1 || deg >= 3);
  return endUrban(ctx.degA, ctx.interchangeA, ctx.urbanEdgesA)
    || endUrban(ctx.degB, ctx.interchangeB, ctx.urbanEdgesB);
}

export interface SidewalkEdgeLike {
  id: number;
  a: number;
  b: number;
  cls: number;
  bridge?: boolean;
  elevated?: boolean;
  tunnel?: boolean;
  deck?: number;
  alive?: boolean;
  progress?: number;
}

export interface SidewalkNodeLike {
  id: number;
  interchange?: boolean;
  alive?: boolean;
}

/**
 * Single source of truth for urban sidewalk classification shared identically by
 * RoadsLayer, Junctions, Terraforming, Rail underpasses, and pedestrian Trips (`walkPath`).
 *
 * Uses a two-pass propagation:
 * 1. Direct classification via `hasUrbanSidewalk(e, endpointCtx)` for all completed at-grade edges.
 * 2. Bridges isolated intermediate highway segments whose BOTH ends connect to sidewalked edges
 *    (so `local -> hw -> hw -> hw -> local` keeps uninterrupted sidewalks in both sim and render).
 */
export function computeUrbanSidewalkSet(
  edges: Iterable<SidewalkEdgeLike>,
  nodes: Map<number, SidewalkNodeLike> | ReadonlyArray<SidewalkNodeLike | undefined>,
): Set<number> {
  const getNode = (id: number): SidewalkNodeLike | undefined => (
    nodes instanceof Map ? nodes.get(id) : nodes[id]
  );
  const surfEdges: SidewalkEdgeLike[] = [];
  const byNode = new Map<number, SidewalkEdgeLike[]>();
  const urbanCount = new Map<number, number>();
  for (const e of edges) {
    if (e.alive === false) continue;
    if (e.progress !== undefined && e.progress < 1) continue;
    if (e.deck !== undefined && e.tunnel) continue;
    surfEdges.push(e);
    for (const nid of [e.a, e.b]) {
      let arr = byNode.get(nid);
      if (!arr) byNode.set(nid, (arr = []));
      arr.push(e);
      if (e.cls >= RoadClass.Local && e.cls <= RoadClass.Avenue && !e.bridge && !e.elevated && !e.tunnel && e.deck === undefined) {
        urbanCount.set(nid, (urbanCount.get(nid) ?? 0) + 1);
      }
    }
  }

  const baseWalk = new Set<number>();
  for (const e of surfEdges) {
    const na = getNode(e.a), nb = getNode(e.b);
    const degA = byNode.get(e.a)?.length ?? 0;
    const degB = byNode.get(e.b)?.length ?? 0;
    if (hasUrbanSidewalk(e, {
      degA,
      degB,
      interchangeA: !!na?.interchange,
      interchangeB: !!nb?.interchange,
      urbanEdgesA: urbanCount.get(e.a) ?? 0,
      urbanEdgesB: urbanCount.get(e.b) ?? 0,
    })) {
      baseWalk.add(e.id);
    }
  }

  const walk = new Set<number>(baseWalk);
  // Propagate across up to 2 intermediate highway hops bounded on BOTH ends by sidewalked edges
  for (let pass = 0; pass < 2; pass++) {
    const add: number[] = [];
    for (const e of surfEdges) {
      if (walk.has(e.id) || e.cls !== RoadClass.Highway || e.bridge || e.elevated || e.tunnel || e.deck !== undefined) continue;
      const aWalk = (byNode.get(e.a) ?? []).some((q) => q.id !== e.id && walk.has(q.id));
      const bWalk = (byNode.get(e.b) ?? []).some((q) => q.id !== e.id && walk.has(q.id));
      if (aWalk && bWalk && hasUrbanSidewalk(e, { bridgedBetweenUrban: true })) {
        add.push(e.id);
      }
    }
    if (!add.length) break;
    for (const id of add) walk.add(id);
  }
  return walk;
}

/** Length of the flared carriageway & sidewalk transition where two sidewalked roads of different widths meet straight. */
export function widthTaperLength(hwNarrow: number, hwWide: number, narrowLen: number): number {
  const diff = Math.abs(hwWide - hwNarrow);
  if (diff <= 0.25) return 0;
  return Math.min(Math.max(5, diff * 1.8), Math.max(0, narrowLen * 0.35));
}

/**
 * Shared cross-section road surface elevation across `[-roadHW, +roadHW]` using the exact same
 * lateral sweep in `roads.ts`, `roadsLayer.ts`, and `railLayer.ts` so vehicles, pedestrians,
 * and rendered pavement agree to < 0.02 m on steep slopes and underpass mouths.
 */
export function sampleRoadSurfaceY(
  x: number,
  z: number,
  nx: number,
  nz: number,
  roadHW: number,
  ground: (gx: number, gz: number) => number,
  fallbackY = 0.48,
): number {
  const latSteps = Math.max(2, Math.ceil((2 * roadHW) / 2.5));
  let maxG = -1e9;
  for (let j = 0; j <= latSteps; j++) {
    const o = -roadHW + (2 * roadHW * j) / latSteps;
    const g = ground(x + nx * o, z + nz * o);
    if (g > maxG) maxG = g;
  }
  return maxG > -1e8 ? Math.max(0.3, maxG) + 0.18 : fallbackY;
}

/** Smoothstep weight (0 outside ramp, 1 inside flat center under tracks) for a rail underpass trench. */
export function underpassBlend(
  u: number,
  halfLenNeg = UNDERPASS_HALF_LEN,
  halfLenPos = UNDERPASS_HALF_LEN,
  flatHalf = UNDERPASS_FLAT_HALF,
): number {
  const absU = Math.abs(u);
  if (absU <= flatHalf) return 1;
  const halfLen = u < 0 ? halfLenNeg : halfLenPos;
  if (absU >= halfLen) return 0;
  const f0 = 1 - (absU - flatHalf) / Math.max(1e-6, halfLen - flatHalf);
  return f0 * f0 * (3 - 2 * f0);
}

/**
 * Shared C0-continuous rail underpass floor elevation at longitudinal offset `u` from crossing center.
 * - Matches `surfY` with 0.00 m step at both mouths (`u = -halfLenNeg` and `u = +halfLenPos`), even on 25%+ slopes.
 * - Reaches `<= railY - depth` under the railway (`|u| <= flatHalf`) without ever rising above `surfY`.
 */
export function sampleUnderpassY(
  u: number,
  surfY: number,
  railY: number,
  halfLenNeg = UNDERPASS_HALF_LEN,
  halfLenPos = UNDERPASS_HALF_LEN,
  flatHalf = UNDERPASS_FLAT_HALF,
  depth = UNDERPASS_DEPTH,
): number {
  const f = underpassBlend(u, halfLenNeg, halfLenPos, flatHalf);
  if (f <= 0) return surfY;
  const targetFloor = Math.min(surfY, railY - depth);
  return surfY + (targetFloor - surfY) * f;
}

/**
 * Shared transverse-aware sidewalk elevation inside a rail underpass (`c.under`).
 * - At the mouths (`f = 0`): matches `RoadsLayer` lateral sidewalk height `max(surfRoadY + 0.12, localGroundY + 0.30)`
 *   so there is < 0.03 m step at 1 cm across the seam even on steep cross-slopes.
 * - Under the railway (`f = 1`): blends smoothly into the level sunken walkway `targetFloor + 0.12`.
 * Used identically by `railLayer.ts`, `trips.ts`, and `peds.ts`.
 */
export function sampleUnderpassWalkY(
  u: number,
  surfRoadY: number,
  localGroundY: number,
  railY: number,
  halfLenNeg = UNDERPASS_HALF_LEN,
  halfLenPos = UNDERPASS_HALF_LEN,
  flatHalf = UNDERPASS_FLAT_HALF,
  depth = UNDERPASS_DEPTH,
  urban = true,
): number {
  const lift = urban ? 0.12 : 0.04;
  const gClear = urban ? 0.30 : 0.18;
  const mouthY = localGroundY > -1e8
    ? Math.max(surfRoadY + lift, Math.max(0.3, localGroundY) + gClear)
    : surfRoadY + lift;
  const f = underpassBlend(u, halfLenNeg, halfLenPos, flatHalf);
  if (f <= 0) return mouthY;
  const trenchY = Math.min(surfRoadY, railY - depth) + lift;
  return mouthY + (trenchY - mouthY) * f;
}

export interface RoadClearanceHit {
  blocked: boolean;
  /** Half-width to clear the lower carriageway + safety margin. */
  clearHalfW?: number;
  /** Unit direction vector of the obstructing lower road. */
  ux?: number;
  uz?: number;
}

export type RoadClearanceFn = (x: number, z: number, r: number) => RoadClearanceHit;

export interface PierFootprintOpts {
  /** Physical half-length of central single pier along viaduct tangent (default 0.85 m). */
  pierHalfLen?: number;
  /** Physical half-width of central single pier transverse to viaduct (default 1.5 m). */
  pierHalfWidth?: number;
  /** Physical circumscribed radius of a portal side column (default 0.90 m). */
  colRadius?: number;
  /** Extra lateral/longitudinal clearance margin outside carriageway edge (default 0.55 m). */
  safetyMargin?: number;
  /** Maximum lateral half-span search for portal columns (default 65 m, spans 3+ parallel avenues). */
  maxPortalSpan?: number;
}

export type ViaductPierPlacement =
  | { kind: 'single'; s: number; x: number; y: number; z: number; tx: number; tz: number; shifted: boolean }
  | {
      kind: 'portal';
      s: number;
      x: number;
      y: number;
      z: number;
      tx: number;
      tz: number;
      left: { x: number; z: number };
      right: { x: number; z: number };
      leftSpan: number;
      rightSpan: number;
      halfSpan: number;
    }
  | { kind: 'skip'; s: number };

/**
 * Resolve a viaduct pier location at arc length `s` so the ENTIRE physical cross-section of piers and
 * portal columns NEVER intrudes onto ANY at-grade road below (including oblique 30° crossings and
 * corridors with 3+ parallel avenues).
 */
export function resolveViaductPierPlacement(
  s: number,
  minS: number,
  maxS: number,
  sampleAt: (sPos: number) => [number, number, number, number, number],
  deckHalfW: number,
  clearance?: RoadClearanceFn,
  pierRadius = 1.6,
  opts: PierFootprintOpts = {},
): ViaductPierPlacement {
  const p0 = sampleAt(s);
  if (!clearance) {
    return { kind: 'single', s, x: p0[0], y: p0[1], z: p0[2], tx: p0[3], tz: p0[4], shifted: false };
  }

  const safetyMargin = opts.safetyMargin ?? 0.55;
  const pierHalfLen = opts.pierHalfLen ?? Math.max(0.85, pierRadius * 0.55);
  const pierHalfWidth = opts.pierHalfWidth ?? Math.min(Math.max(1.2, deckHalfW * 0.32), 1.9);
  const colRadius = opts.colRadius ?? 0.9;
  const maxPortalSpan = opts.maxPortalSpan ?? 65;

  // Test the FULL physical oriented rectangle of a single central pier against ALL lower roads
  const isSingleClear = (p: [number, number, number, number, number]): boolean => {
    const cx = p[0], cz = p[2], tx = p[3], tz = p[4];
    const nx = -tz, nz = tx;
    const centerR = Math.max(pierRadius, pierHalfLen + safetyMargin);
    if (clearance(cx, cz, centerR).blocked) return false;
    // Check both transverse tips and all 4 physical corners of the pier shaft
    const cornerR = safetyMargin + 0.15;
    const samples: [number, number, number][] = [
      [cx + nx * pierHalfWidth, cz + nz * pierHalfWidth, pierHalfLen + safetyMargin],
      [cx - nx * pierHalfWidth, cz - nz * pierHalfWidth, pierHalfLen + safetyMargin],
      [cx + tx * pierHalfLen + nx * pierHalfWidth, cz + tz * pierHalfLen + nz * pierHalfWidth, cornerR],
      [cx + tx * pierHalfLen - nx * pierHalfWidth, cz + tz * pierHalfLen - nz * pierHalfWidth, cornerR],
      [cx - tx * pierHalfLen + nx * pierHalfWidth, cz - tz * pierHalfLen + nz * pierHalfWidth, cornerR],
      [cx - tx * pierHalfLen - nx * pierHalfWidth, cz - tz * pierHalfLen - nz * pierHalfWidth, cornerR],
    ];
    for (const [qx, qz, qr] of samples) {
      if (clearance(qx, qz, qr).blocked) return false;
    }
    return true;
  };

  if (isSingleClear(p0)) {
    return { kind: 'single', s, x: p0[0], y: p0[1], z: p0[2], tx: p0[3], tz: p0[4], shifted: false };
  }

  // Try longitudinal shifts along the span first (avoids portal frames on simple crossings)
  for (const ds of [6, -6, 9, -9, 12, -12, 14, -14, 18, -18]) {
    const sTry = s + ds;
    if (sTry < minS || sTry > maxS) continue;
    const p = sampleAt(sTry);
    if (isSingleClear(p)) {
      return { kind: 'single', s: sTry, x: p[0], y: p[1], z: p[2], tx: p[3], tz: p[4], shifted: true };
    }
  }

  // Find a portal frame whose twin side columns BOTH clear ALL roads below (scanning outward up to maxPortalSpan)
  const colCheckR = colRadius + safetyMargin;
  const tryPortalAt = (sPos: number): ViaductPierPlacement | null => {
    const p = sampleAt(sPos);
    const nx = -p[4], nz = p[3];
    const startSpan = deckHalfW + colRadius + 0.45;
    let leftSpan = -1;
    let rightSpan = -1;
    for (let sp = startSpan; sp <= maxPortalSpan; sp += 0.8) {
      if (leftSpan < 0 && !clearance(p[0] - nx * sp, p[2] - nz * sp, colCheckR).blocked) {
        leftSpan = sp;
      }
      if (rightSpan < 0 && !clearance(p[0] + nx * sp, p[2] + nz * sp, colCheckR).blocked) {
        rightSpan = sp;
      }
      if (leftSpan >= 0 && rightSpan >= 0) break;
    }
    if (leftSpan < 0 || rightSpan < 0) return null;
    return {
      kind: 'portal',
      s: sPos,
      x: p[0],
      y: p[1],
      z: p[2],
      tx: p[3],
      tz: p[4],
      left: { x: p[0] - nx * leftSpan, z: p[2] - nz * leftSpan },
      right: { x: p[0] + nx * rightSpan, z: p[2] + nz * rightSpan },
      leftSpan,
      rightSpan,
      halfSpan: Math.max(leftSpan, rightSpan),
    };
  };

  const portal0 = tryPortalAt(s);
  if (portal0) return portal0;

  for (const ds of [6, -6, 10, -10, 14, -14, 18, -18]) {
    const sTry = s + ds;
    if (sTry < minS || sTry > maxS) continue;
    const alt = tryPortalAt(sTry);
    if (alt) return alt;
  }

  return { kind: 'skip', s };
}

export interface TerrainCut {
  pts: number[];
  hw: number;
}

/** Combine active road-tunnel and rail-underpass terrain cuts into one list without overwriting either source. */
export function combineTerrainCuts(roadCuts: TerrainCut[], railCuts: TerrainCut[]): TerrainCut[] {
  if (!roadCuts.length) return railCuts.slice();
  if (!railCuts.length) return roadCuts.slice();
  return [...roadCuts, ...railCuts];
}

/**
 * Evaluate the minimum carved terrain elevation at `(x, z)` accounting for any active `setCuts` trenches.
 * Used by TerrainView.cutY and viaduct pier foundations so columns NEVER float above terrain cuts.
 */
export function sampleCutsMinY(
  x: number,
  z: number,
  baseH: number,
  cuts: ReadonlyArray<TerrainCut>,
  bankMargin = 2.4,
): number {
  if (!cuts.length) return baseH;
  let y = baseH;
  for (const c of cuts) {
    const reach = c.hw + bankMargin;
    for (let k = 0; k + 3 < c.pts.length; k += 3) {
      const ax = c.pts[k], ay = c.pts[k + 1], az = c.pts[k + 2];
      const bx = c.pts[k + 3], by = c.pts[k + 4], bz = c.pts[k + 5];
      if (x < Math.min(ax, bx) - reach || x > Math.max(ax, bx) + reach || z < Math.min(az, bz) - reach || z > Math.max(az, bz) + reach) continue;
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
      if (d > reach) continue;
      const floor = ay + (by - ay) * t - 0.45;
      if (floor >= baseH) continue;
      const f = d <= c.hw ? 1 : Math.max(0, 1 - (d - c.hw) / bankMargin);
      const yy = baseH + (floor - baseH) * f;
      if (yy < y) y = yy;
    }
  }
  return y;
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
