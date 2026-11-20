import { HOUR_SECONDS, LOT_SETBACK, ROAD_HALF_WIDTH, ROAD_LANES, ROAD_SPEED, RoadClass } from '../shared/constants';
import type { EdgeView, NodeView } from '../shared/protocol';
import { MinHeap } from './heap';
import { dijkstraTree, InlineBackend, type RouteBackend, type RouteGraph } from './routeKernel';
import type { Terrain } from './terrain';
import { OCC_ROAD, type Occupancy } from './occupancy';
import type { RNG } from '../shared/rng';
import { STREET_NAMES, STREET_PREFIX } from '../shared/names';

export const CAP_PER_LANE_HOUR = 26;

export interface RNode {
  id: number; x: number; z: number; y: number;
  edges: number[];
  control: number; // 0 none, 1 priority, 2 signal, 3 roundabout, 4 smart signal
  phase: number; phaseT: number; phases: number[][]; // groups of incoming edge ids
  interchange: boolean;
  /** a joint of an elevated/tunnel structure: not part of the street network, nothing attaches to it */
  deck?: boolean;
  inJunction: number; // vehicles currently crossing
  delay: number; // EMA of waiting seconds at node
  waitAcc: number;
  alive: boolean;
  radius: number;
}

export const DECK_CLEAR = 7.5, DECK_DEPTH = 8;

export interface REdge {
  id: number; a: number; b: number;
  cls: RoadClass;
  lanes: number;
  oneway: number;
  bridge: boolean; tunnel: boolean; elevated: boolean;
  /**
   * grade-separated bypass (elevado / túnel): ramp length in metres for a structure that leaves the street,
   * passes over/under junctions or tracks and comes back; -1 = straight bore through a hill. Undefined = ordinary road.
   */
  deck?: number;
  /** position of this piece along a multi-edge structure and the structure's total length (ramps span pieces) */
  deckS0?: number; deckTot?: number;
  busLane: boolean;
  len: number;
  progress: number; // 1 = usable
  upgrading: boolean; upgradeTo?: Partial<REdge>; workP: number;
  name: string;
  pts: number[];
  // traffic stats (per direction)
  count: [number, number];
  volume: [number, number];
  peakVC: number; // today
  vcHistory: number[]; // daily peaks
  congestedDays: number;
  stopped: [number, number];
  alive: boolean;
  builtDay: number;
  // OD log for "Por que congestionado?"
  odLog: number[]; // pairs originBuilding, destBuilding (ring)
  odPtr: number;
  /** acoustic accounting: running sums [light, moto, heavy, speed, samples] and their hourly mean */
  snd?: Float32Array; sndMean?: Float32Array;
}

/** simplified traffic acoustics: rolling noise grows with speed, engines with load and acceleration */
export function vehicleSound(cls: number, speed: number, accel: number, dirt: boolean): number {
  const w = cls === 2 ? 2.7 : cls === 1 ? 1.75 : 1;
  const rolling = Math.pow(speed / 13, 1.35) * (dirt ? 1.28 : 1);
  const engine = 0.22 + Math.max(0, accel) * 0.23 + Math.max(0, -accel - 0.45) * 0.055;
  return w * (engine + rolling);
}

export interface SegmentPlan {
  ok: boolean;
  reason?: string;
  from: number; // node id or -1 (new node at ax,az)
  ax: number; az: number;
  bx: number; bz: number;
  toNode: number; // existing node to connect to, or -1
  split?: { edge: number; t: number }; // split an edge at end
  cls: RoadClass;
  len: number;
  waterLen: number;
  maxGrade: number;
  cost: number;
}

interface Tree { dist: Float32Array; next: Int32Array; ver: number; built: number; lastUse: number }

export class RoadNetwork {
  nodes: RNode[] = [];
  edges: REdge[] = [];
  private nodeHash = new Map<number, number[]>();
  private edgeHash = new Map<number, number[]>();
  private readonly HC = 100;
  topoVer = 0;
  dirtyNodes = new Set<number>();
  dirtyEdges = new Set<number>();
  removedEdges: number[] = [];
  private trees = new Map<number, Tree>();
  time = 0;
  /** external hook: the railway vetoes segments that would cross it badly (returns the reason) */
  railCheck?: (ax: number, az: number, bx: number, bz: number, cls: RoadClass) => string | null;

  constructor(public terrain: Terrain, public occ: Occupancy, private rng: RNG) {}

  // ---------- spatial hashing ----------
  private hkey(i: number, j: number) { return i * 4096 + j; }
  private hashInsert(map: Map<number, number[]>, id: number, x0: number, z0: number, x1: number, z1: number) {
    const i0 = Math.floor(Math.min(x0, x1) / this.HC), i1 = Math.floor(Math.max(x0, x1) / this.HC);
    const j0 = Math.floor(Math.min(z0, z1) / this.HC), j1 = Math.floor(Math.max(z0, z1) / this.HC);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = this.hkey(i, j);
      let a = map.get(k);
      if (!a) map.set(k, (a = []));
      a.push(id);
    }
  }
  private hashRemove(map: Map<number, number[]>, id: number, x0: number, z0: number, x1: number, z1: number) {
    const i0 = Math.floor(Math.min(x0, x1) / this.HC), i1 = Math.floor(Math.max(x0, x1) / this.HC);
    const j0 = Math.floor(Math.min(z0, z1) / this.HC), j1 = Math.floor(Math.max(z0, z1) / this.HC);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const a = map.get(this.hkey(i, j));
      if (!a) continue;
      const p = a.indexOf(id);
      if (p >= 0) a.splice(p, 1);
    }
  }
  private query(map: Map<number, number[]>, x: number, z: number, r: number, out: Set<number>) {
    const i0 = Math.floor((x - r) / this.HC), i1 = Math.floor((x + r) / this.HC);
    const j0 = Math.floor((z - r) / this.HC), j1 = Math.floor((z + r) / this.HC);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const a = map.get(this.hkey(i, j));
      if (a) for (const id of a) out.add(id);
    }
    return out;
  }
  nodesNear(x: number, z: number, r: number): RNode[] {
    const s = this.query(this.nodeHash, x, z, r, new Set());
    const res: RNode[] = [];
    for (const id of s) { const n = this.nodes[id]; if (n.alive && !n.deck && Math.hypot(n.x - x, n.z - z) <= r) res.push(n); }
    return res;
  }
  edgesNear(x: number, z: number, r: number): REdge[] {
    const s = this.query(this.edgeHash, x, z, r, new Set());
    const res: REdge[] = [];
    for (const id of s) { const e = this.edges[id]; if (e.alive) res.push(e); }
    return res;
  }
  nearestNode(x: number, z: number, r: number, filter?: (n: RNode) => boolean): RNode | null {
    let best: RNode | null = null, bd = r;
    for (const n of this.nodesNear(x, z, r)) {
      if (filter && !filter(n)) continue;
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }
  /** nearest point on usable edges */
  nearestEdgePoint(x: number, z: number, r: number, filter?: (e: REdge) => boolean): { edge: REdge; t: number; d: number; px: number; pz: number } | null {
    let best: { edge: REdge; t: number; d: number; px: number; pz: number } | null = null;
    for (const e of this.edgesNear(x, z, r)) {
      if (e.deck !== undefined) continue; // nothing attaches to a viaduct deck or a tunnel
      if (filter && !filter(e)) continue;
      const a = this.nodes[e.a], b = this.nodes[e.b];
      const p = projSeg(x, z, a.x, a.z, b.x, b.z);
      if (p.d <= r && (!best || p.d < best.d)) best = { edge: e, t: p.t, d: p.d, px: p.x, pz: p.z };
    }
    return best;
  }

  // ---------- construction ----------
  addNode(x: number, z: number): RNode {
    const n: RNode = {
      id: this.nodes.length, x, z, y: Math.max(this.terrain.heightAt(x, z), 0.3) + 0.1,
      edges: [], control: 0, phase: 0, phaseT: 0, phases: [], interchange: false, inJunction: 0, delay: 0, waitAcc: 0, alive: true, radius: 4,
    };
    this.nodes.push(n);
    this.hashInsert(this.nodeHash, n.id, x, z, x, z);
    this.dirtyNodes.add(n.id);
    this.topoVer++;
    return n;
  }

  addEdge(a: number, b: number, cls: RoadClass, opts: { progress?: number; bridge?: boolean; name?: string; day?: number; oneway?: number; lanes?: number; elevated?: boolean; tunnel?: boolean; deck?: number; deckS0?: number; deckTot?: number } = {}): REdge {
    const na = this.nodes[a], nb = this.nodes[b];
    const len = Math.hypot(nb.x - na.x, nb.z - na.z);
    const e: REdge = {
      id: this.edges.length, a, b, cls, lanes: opts.lanes ?? ROAD_LANES[cls], oneway: opts.oneway ?? 0,
      bridge: !!opts.bridge, tunnel: !!opts.tunnel, elevated: !!opts.elevated, deck: opts.deck, deckS0: opts.deckS0, deckTot: opts.deckTot, busLane: false, len,
      progress: opts.progress ?? 0, upgrading: false, workP: 1, name: opts.name ?? this.streetName(cls), pts: [],
      count: [0, 0], volume: [0, 0], peakVC: 0, vcHistory: [], congestedDays: 0, stopped: [0, 0], alive: true,
      builtDay: opts.day ?? 0, odLog: [], odPtr: 0,
    };
    this.edges.push(e);
    na.edges.push(e.id); nb.edges.push(e.id);
    this.computePts(e);
    this.hashInsert(this.edgeHash, e.id, na.x, na.z, nb.x, nb.z);
    this.rasterize(e);
    this.updateNodeGeom(na); this.updateNodeGeom(nb);
    this.dirtyEdges.add(e.id);
    this.topoVer++;
    return e;
  }

  streetName(cls: RoadClass): string {
    const base = this.rng.pick(STREET_NAMES);
    if (cls === RoadClass.Highway) return 'Rodovia Regional';
    if (cls === RoadClass.Avenue) return 'Avenida ' + base;
    if (cls === RoadClass.Dirt) return 'Estrada ' + base;
    return this.rng.pick(STREET_PREFIX) + ' ' + base;
  }

  rasterize(e: REdge) {
    const a = this.nodes[e.a], b = this.nodes[e.b];
    const hw = e.cls === RoadClass.Highway ? 14 : LOT_SETBACK - 1;
    if (e.deck !== undefined) {
      // a bypass rides over/under an existing street; a hill bore only claims its open approaches
      if (e.deck >= 0) return;
      const n = Math.max(1, Math.ceil(e.len / 10));
      for (let i = 0; i < n; i++) {
        const p0 = i * 3, p1 = (i + 1) * 3;
        if (e.pts[p0 + 1] < this.terrain.heightAt(e.pts[p0], e.pts[p0 + 2]) - 1) continue;
        const r = this.occ.segRect(e.pts[p0], e.pts[p0 + 2], e.pts[p1], e.pts[p1 + 2], hw);
        this.occ.markRect(r.cx, r.cz, r.angle, r.w + 2, r.d, OCC_ROAD);
      }
      return;
    }
    if (e.bridge) {
      // only mark the land parts
      const r = this.occ.segRect(a.x, a.z, b.x, b.z, hw);
      this.occ.forRect(r.cx, r.cz, r.angle, r.w + 4, r.d, (k) => { if (k >= 0 && this.occ.grid[k] !== 3) this.occ.grid[k] = OCC_ROAD; });
      return;
    }
    const r = this.occ.segRect(a.x, a.z, b.x, b.z, hw);
    this.occ.markRect(r.cx, r.cz, r.angle, r.w + 4, r.d, OCC_ROAD);
  }

  computePts(e: REdge) {
    const a = this.nodes[e.a], b = this.nodes[e.b];
    const n = Math.max(1, Math.ceil(e.len / 10));
    const pts: number[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      let y: number;
      if (e.deck !== undefined) {
        y = this.deckY(e, a, b, t, x, z);
      } else if (e.bridge || e.elevated) {
        const base = a.y + (b.y - a.y) * t;
        const clearance = e.elevated ? 7 : 6.5;
        const ramp = Math.min(1, Math.min(t, 1 - t) * e.len / 40);
        y = Math.max(base, base * (1 - ramp) + clearance * ramp + Math.sin(Math.PI * t) * (e.elevated ? 0 : 2));
        if (e.elevated) y = base + ramp * clearance;
      } else {
        y = Math.max(this.terrain.heightAt(x, z), 0.3) + 0.12;
      }
      pts.push(x, y, z);
    }
    e.pts = pts;
  }

  /** height profile of a grade-separated structure */
  deckY(e: REdge, a: RNode, b: RNode, t: number, x: number, z: number): number {
    const ground = Math.max(this.terrain.heightAt(x, z), 0.3) + 0.12;
    if (e.deck! < 0) return Math.max(a.y + (b.y - a.y) * t, 0.3); // straight bore: constant gentle grade
    const tot = e.deckTot ?? e.len, s = (e.deckS0 ?? 0) + t * e.len, f0 = Math.min(1, Math.max(0, Math.min(s, tot - s)) / e.deck!);
    const f = f0 * f0 * (3 - 2 * f0);
    return e.tunnel ? ground - DECK_DEPTH * f + 0.02 * (1 - f) : ground + 0.06 + DECK_CLEAR * f;
  }
  /** height of the structure above (+) or below (−) the street at a point of the edge */
  deckClearance(e: REdge, t: number): number {
    const a = this.nodes[e.a], b = this.nodes[e.b];
    const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    return this.deckY(e, a, b, t, x, z) - (Math.max(this.terrain.heightAt(x, z), 0.3) + 0.12);
  }

  updateNodeGeom(n: RNode) {
    let r = 3;
    for (const id of n.edges) { const e = this.edges[id]; if (e.alive) r = Math.max(r, ROAD_HALF_WIDTH[e.cls] + (e.lanes > ROAD_LANES[e.cls] ? 3 : 0)); }
    n.radius = n.control === 3 ? r + 9 : r + (n.edges.length > 2 ? 1.5 : 0);
    this.dirtyNodes.add(n.id);
  }

  /** split edge at parameter t, returns new node */
  splitEdge(eid: number, t: number): RNode {
    const e = this.edges[eid];
    const a = this.nodes[e.a], b = this.nodes[e.b];
    const n = this.addNode(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    const props = { progress: e.progress, bridge: e.bridge, name: e.name, day: e.builtDay, oneway: e.oneway, lanes: e.lanes, elevated: e.elevated };
    const busLane = e.busLane;
    this.removeEdge(eid);
    const e1 = this.addEdge(e.a, n.id, e.cls, props);
    const e2 = this.addEdge(n.id, e.b, e.cls, props);
    e1.busLane = e2.busLane = busLane;
    e1.volume = [...e.volume] as [number, number]; e2.volume = [...e.volume] as [number, number];
    e1.vcHistory = [...e.vcHistory]; e2.vcHistory = [...e.vcHistory];
    return n;
  }

  removeEdge(eid: number) {
    const e = this.edges[eid];
    if (!e.alive) return;
    e.alive = false;
    const a = this.nodes[e.a], b = this.nodes[e.b];
    a.edges = a.edges.filter((x) => x !== eid);
    b.edges = b.edges.filter((x) => x !== eid);
    this.hashRemove(this.edgeHash, eid, a.x, a.z, b.x, b.z);
    this.removedEdges.push(eid);
    this.dirtyEdges.delete(eid);
    this.updateNodeGeom(a); this.updateNodeGeom(b);
    this.topoVer++;
  }

  edgeBetween(a: number, b: number): REdge | null {
    for (const id of this.nodes[a].edges) { const e = this.edges[id]; if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return e; }
    return null;
  }

  angleOf(e: REdge, from: number): number {
    const a = this.nodes[from], b = this.nodes[e.a === from ? e.b : e.a];
    return Math.atan2(b.z - a.z, b.x - a.x);
  }

  minAngleAt(nodeId: number, ang: number, ignore = -1): number {
    let m = Math.PI;
    for (const id of this.nodes[nodeId].edges) {
      if (id === ignore) continue;
      const e = this.edges[id];
      m = Math.min(m, angDiff(this.angleOf(e, nodeId), ang));
    }
    return m;
  }

  // ---------- planning a segment ----------
  planSegment(fromNode: number, bx: number, bz: number, cls: RoadClass, opts: { allowBridge?: boolean; maxBridge?: number; maxGrade?: number; ax?: number; az?: number } = {}): SegmentPlan {
    const T = this.terrain;
    const from = fromNode >= 0 ? this.nodes[fromNode] : null;
    const ax = from ? from.x : opts.ax!, az = from ? from.z : opts.az!;
    const plan: SegmentPlan = { ok: false, from: fromNode, ax, az, bx, bz, toNode: -1, cls, len: 0, waterLen: 0, maxGrade: 0, cost: 0 };
    if (!T.inside(bx, bz, 40)) return fail(plan, 'fora do mapa');
    if (from && from.edges.length >= 4) return fail(plan, 'grau máximo');

    // 1. intersections with existing edges -> cut at nearest
    let best: { t: number; edge: REdge; x: number; z: number } | null = null;
    const midx = (ax + bx) / 2, midz = (az + bz) / 2;
    const segLen = Math.hypot(bx - ax, bz - az);
    for (const e of this.edgesNear(midx, midz, segLen / 2 + 20)) {
      if (from && (e.a === fromNode || e.b === fromNode)) continue;
      const na = this.nodes[e.a], nb = this.nodes[e.b];
      const hit = segInt(ax, az, bx, bz, na.x, na.z, nb.x, nb.z);
      if (hit && e.deck !== undefined) {
        // a new street may pass under a deck or over a tunnel, never meet it on a ramp
        const c = this.deckClearance(e, hit.u);
        if (c > 4.5 || c < -5) continue;
        return fail(plan, e.tunnel ? 'rampa de túnel' : 'rampa de viaduto');
      }
      if (hit && hit.t > 0.02 && (!best || hit.t < best.t)) best = { t: hit.t, edge: e, x: hit.x, z: hit.z };
    }
    if (best) {
      const e = best.edge;
      const na = this.nodes[e.a], nb = this.nodes[e.b];
      const da = Math.hypot(na.x - best.x, na.z - best.z), db = Math.hypot(nb.x - best.x, nb.z - best.z);
      if (da < 18 || db < 18) {
        const n = da < db ? na : nb;
        plan.toNode = n.id; bx = n.x; bz = n.z;
      } else {
        if (e.bridge) return fail(plan, 'ponte');
        const tt = projSeg(best.x, best.z, na.x, na.z, nb.x, nb.z).t;
        plan.split = { edge: e.id, t: tt };
        bx = best.x; bz = best.z;
        const crossAng = angDiff(Math.atan2(bz - az, bx - ax), Math.atan2(nb.z - na.z, nb.x - na.x));
        if (Math.min(crossAng, Math.PI - crossAng) < 0.9) return fail(plan, 'ângulo de cruzamento');
      }
    } else {
      // 2. snap to nearby node
      const snap = this.nearestNode(bx, bz, 24, (n) => n.id !== fromNode);
      if (snap) { plan.toNode = snap.id; bx = snap.x; bz = snap.z; }
      else {
        const pe = this.nearestEdgePoint(bx, bz, 16, (e) => !(from && (e.a === fromNode || e.b === fromNode)));
        if (pe) {
          const na = this.nodes[pe.edge.a], nb = this.nodes[pe.edge.b];
          const da = Math.hypot(na.x - pe.px, na.z - pe.pz), db = Math.hypot(nb.x - pe.px, nb.z - pe.pz);
          if (da < 20 || db < 20) { const n = da < db ? na : nb; plan.toNode = n.id; bx = n.x; bz = n.z; }
          else { plan.split = { edge: pe.edge.id, t: pe.t }; bx = pe.px; bz = pe.pz; if (pe.edge.bridge) return fail(plan, 'ponte'); }
        }
      }
    }
    plan.bx = bx; plan.bz = bz;
    const len = Math.hypot(bx - ax, bz - az);
    plan.len = len;
    if (len < 22) return fail(plan, 'curto demais');
    const ang = Math.atan2(bz - az, bx - ax);
    if (from && this.minAngleAt(fromNode, ang) < 0.62) return fail(plan, 'ângulo na origem');
    if (plan.toNode >= 0) {
      if (fromNode >= 0 && this.edgeBetween(fromNode, plan.toNode)) return fail(plan, 'duplicada');
      const tn = this.nodes[plan.toNode];
      if (tn.edges.length >= 4) return fail(plan, 'grau destino');
      if (this.minAngleAt(plan.toNode, ang + Math.PI) < 0.62) return fail(plan, 'ângulo no destino');
    }
    if (plan.split) {
      const e = this.edges[plan.split.edge];
      const na = this.nodes[e.a], nb = this.nodes[e.b];
      const ea = Math.atan2(nb.z - na.z, nb.x - na.x);
      const d = angDiff(ang, ea);
      if (Math.min(d, Math.PI - d) < 0.9) return fail(plan, 'ângulo do T');
    }
    // 3. terrain: grade and water
    const steps = Math.max(2, Math.ceil(len / 8));
    let prevH = Math.max(0, T.heightAt(ax, az));
    let water = 0, grade = 0, wStart = -1;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const h = T.heightAt(x, z);
      if (h < T.seaLevel + 0.5) { water += len / steps; if (wStart < 0) wStart = i; }
      else {
        const hh = Math.max(0, h);
        grade = Math.max(grade, Math.abs(hh - prevH) / (len / steps));
        prevH = hh;
      }
    }
    const endsOnLand = T.heightAt(ax, az) > 0.5 && T.heightAt(bx, bz) > 0.5;
    plan.waterLen = water; plan.maxGrade = grade;
    const maxGrade = opts.maxGrade ?? (cls >= RoadClass.Avenue ? 0.1 : 0.16);
    if (grade > maxGrade) return fail(plan, 'declive forte');
    if (water > 0) {
      if (!opts.allowBridge) return fail(plan, 'água');
      if (water > (opts.maxBridge ?? 260) || !endsOnLand) return fail(plan, 'ponte longa');
    }
    // 4. parallel proximity: don't run too close to unrelated roads
    for (const t of [0.5, 0.25, 0.75]) {
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      for (const e of this.edgesNear(x, z, 30)) {
        if (from && (e.a === fromNode || e.b === fromNode)) continue;
        if (e.deck !== undefined) continue;
        if (plan.toNode >= 0 && (e.a === plan.toNode || e.b === plan.toNode)) continue;
        if (plan.split && e.id === plan.split.edge) continue;
        const na = this.nodes[e.a], nb = this.nodes[e.b];
        const p = projSeg(x, z, na.x, na.z, nb.x, nb.z);
        if (p.d < 26) return fail(plan, 'muito próxima de outra via');
      }
    }
    // 5. the railway is a barrier: few, square, well-spaced crossings
    if (this.railCheck) { const why = this.railCheck(ax, az, bx, bz, cls); if (why) return fail(plan, why); }
    // 6. corridor free of buildings
    const fr = this.occ.segFree(ax, az, bx, bz, ROAD_HALF_WIDTH[cls] + 1.5, 10);
    if (!fr.ok) return fail(plan, 'edificações no caminho');
    plan.ok = true;
    plan.cost = len * (cls + 1) * 0.12 + water * 8 + grade * len * 2;
    return plan;
  }

  applyPlan(plan: SegmentPlan, opts: { progress?: number; day?: number; name?: string } = {}): REdge {
    const fromId = plan.from >= 0 ? plan.from : this.addNode(plan.ax, plan.az).id;
    let toId = plan.toNode;
    if (toId < 0 && plan.split) toId = this.splitEdge(plan.split.edge, plan.split.t).id;
    if (toId < 0) toId = this.addNode(plan.bx, plan.bz).id;
    const e = this.addEdge(fromId, toId, plan.cls, { progress: opts.progress ?? 0, bridge: plan.waterLen > 0, day: opts.day, name: opts.name });
    return e;
  }

  // ---------- traffic accounting ----------
  capacity(e: REdge): number {
    const cls = e.cls;
    const f = cls === RoadClass.Highway ? 1.6 : cls === RoadClass.Avenue ? 1.25 : cls === RoadClass.Dirt ? 0.6 : 1;
    return e.lanes * CAP_PER_LANE_HOUR * f * (e.busLane ? 0.8 : 1) * (e.oneway ? 1.3 : 1);
  }
  freeSpeed(e: REdge): number {
    return ROAD_SPEED[e.cls] * (e.upgrading ? 0.6 : 1) * (e.deck !== undefined ? 1.15 : 1);
  }
  travelTime(e: REdge, dir: number): number {
    const t0 = e.len / this.freeSpeed(e);
    const vc = e.volume[dir] / this.capacity(e);
    return t0 * (1 + 0.15 * Math.pow(vc, 4)) + e.stopped[dir] * 1.5 + (this.nodes[dir === 0 ? e.b : e.a].delay || 0) * 0.5;
  }
  usable(e: REdge) { return e.alive && e.progress >= 1; }

  /** hourly rollover of counters */
  hourTick() {
    for (const e of this.edges) {
      if (!e.alive) continue;
      if (e.snd) {
        const m = e.sndMean ?? (e.sndMean = new Float32Array(5));
        const steps = HOUR_SECONDS / 0.5;
        for (let k = 0; k < 5; k++) { m[k] = m[k] * 0.36 + (e.snd[k] / steps) * 0.64; e.snd[k] = 0; }
      }
      for (let d = 0; d < 2; d++) {
        e.volume[d] = e.volume[d] * 0.4 + e.count[d] * 0.6;
        e.count[d] = 0;
        const vc = e.volume[d] / this.capacity(e);
        if (vc > e.peakVC) e.peakVC = vc;
      }
    }
    for (const n of this.nodes) { if (!n.alive) continue; n.delay = n.delay * 0.5 + n.waitAcc * 0.5 / Math.max(1, n.edges.length); n.waitAcc = 0; }
  }
  dayTick() {
    for (const e of this.edges) {
      if (!e.alive) continue;
      e.vcHistory.push(e.peakVC);
      if (e.vcHistory.length > 7) e.vcHistory.shift();
      e.congestedDays = e.peakVC > 0.85 ? e.congestedDays + 1 : 0;
      e.peakVC = 0;
    }
  }
  logOD(e: REdge, o: number, d: number) {
    if (e.odLog.length < 160) e.odLog.push(o, d);
    else { e.odLog[e.odPtr] = o; e.odLog[e.odPtr + 1] = d; e.odPtr = (e.odPtr + 2) % 160; }
  }

  // ---------- routing (reverse Dijkstra trees, cached, rolling refresh) ----------
  /** max trees rebuilt per sim step (on-demand); the rest is served stale */
  buildBudget = 6;
  /** where background tree refreshes run (inline or a pool of worker threads) */
  backend: RouteBackend = new InlineBackend();
  private rollIdx = 0;
  private stepNo = 0;
  private graph: RouteGraph | null = null;
  private pending: { ticket: number; dests: number[]; due: number; ver: number; t: number } | null = null;
  static readonly EPOCH = 8; // steps between batched refreshes
  static readonly BATCH = 64;

  /** compact snapshot of topology + current travel costs (rebuilt on topology change or every 20 s) */
  routeGraph(): RouteGraph {
    const g = this.graph;
    if (g && g.ver === this.topoVer && g.N === this.nodes.length && this.time - g.t < 20) return g;
    const N = this.nodes.length;
    const off = new Int32Array(N + 1);
    let M = 0;
    for (let u = 0; u < N; u++) { off[u] = M; M += this.nodes[u].edges.length; }
    off[N] = M;
    const nbr = new Int32Array(M), de = new Int32Array(M), cost = new Float32Array(M);
    let m = 0;
    for (let u = 0; u < N; u++) {
      const start = m;
      for (const eid of this.nodes[u].edges) {
        const e = this.edges[eid];
        if (!e.alive || e.progress < 1) continue;
        const w = e.a === u ? e.b : e.a;
        const dir = e.a === w ? 0 : 1; // travelling w -> u
        if (dir === 1 && e.oneway) continue;
        nbr[m] = w; de[m] = eid * 2 + dir; cost[m] = this.travelTime(e, dir) + 1.5; m++;
      }
      off[u] = start;
    }
    off[N] = m;
    this.graph = { N, off, nbr: nbr.subarray(0, m), de: de.subarray(0, m), cost: cost.subarray(0, m), ver: this.topoVer, t: this.time };
    return this.graph;
  }

  /** true when the next step can run (its scheduled routing results have arrived) */
  routingReady(): boolean {
    const p = this.pending;
    return !p || this.stepNo + 1 < p.due || this.backend.ready(p.ticket);
  }

  stepRouting() {
    this.buildBudget = 6;
    this.stepNo++;
    const p = this.pending;
    if (p && this.stepNo >= p.due) {
      // install at a fixed step → identical results whatever thread computed them
      const nexts = this.backend.take(p.ticket);
      p.dests.forEach((d, k) => {
        const old = this.trees.get(d);
        this.trees.set(d, { dist: new Float32Array(0), next: nexts[k], ver: p.ver, built: p.t, lastUse: old ? old.lastUse : p.t });
      });
      this.pending = null;
    }
    if (this.pending || this.stepNo % RoadNetwork.EPOCH !== 0 || !this.trees.size) return;
    // rolling refresh: rebuild the oldest trees so congestion feeds back into routes
    const keys = [...this.trees.keys()];
    const dests: number[] = [];
    for (let i = 0; i < keys.length && dests.length < RoadNetwork.BATCH; i++) {
      this.rollIdx = (this.rollIdx + 1) % keys.length;
      const k = keys[this.rollIdx];
      const t = this.trees.get(k)!;
      if (this.time - t.built > HOUR_SECONDS * 3 || (t.ver !== this.topoVer && this.time - t.built > HOUR_SECONDS * 0.5)) dests.push(k);
    }
    if (!dests.length) return;
    const g = this.routeGraph();
    this.pending = { ticket: this.backend.submit(g, dests), dests, due: this.stepNo + RoadNetwork.EPOCH, ver: g.ver, t: this.time };
  }
  tree(dest: number, force = false): Tree | null {
    let t = this.trees.get(dest);
    // an old tree stays usable after the graph grows: route() validates every hop and
    // forces a rebuild only when the cached path is actually broken
    if (!t || force) {
      if (this.buildBudget <= 0 && t) return t;
      if (this.buildBudget <= 0 && !t) return null;
      this.buildBudget--;
      t = this.buildTree(dest, t);
      this.trees.set(dest, t);
      if (this.trees.size > 4000) {
        let oldK = -1, oldT = Infinity;
        for (const [k, v] of this.trees) if (v.lastUse < oldT) { oldT = v.lastUse; oldK = k; }
        this.trees.delete(oldK);
      }
    }
    t!.lastUse = this.time;
    return t!;
  }
  private heap = new MinHeap();
  private distBuf = new Float64Array(0);
  private buildTree(dest: number, reuse?: Tree): Tree {
    const g = this.routeGraph();
    const N = g.N;
    if (this.distBuf.length < N) this.distBuf = new Float64Array(N + 512);
    const next = reuse && reuse.next.length === N ? reuse.next : new Int32Array(N);
    dijkstraTree(g, dest, next, this.distBuf, this.heap);
    return { dist: new Float32Array(0), next, ver: g.ver, built: this.time, lastUse: this.time };
  }
  /** directed edges from node `from` to `dest`; null if unreachable or routing budget exhausted */
  route(from: number, dest: number, maxLen = 500): number[] | null {
    if (from === dest) return [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = this.tree(dest, attempt === 1);
      if (!t) return null;
      if (from >= t.next.length) continue;
      const out: number[] = [];
      let u = from, ok = true;
      while (u !== dest) {
        const de = t.next[u];
        if (!(de >= 0) || out.length >= maxLen) { ok = false; break; }
        const e = this.edges[de >> 1];
        if (!e.alive || e.progress < 1) { ok = false; break; }
        const tail = (de & 1) === 0 ? e.a : e.b;
        if (tail !== u) { ok = false; break; }
        out.push(de);
        u = (de & 1) === 0 ? e.b : e.a;
      }
      if (ok) return out;
    }
    return null;
  }
  pathTime(path: number[]): number {
    let t = 0;
    for (const de of path) t += this.travelTime(this.edges[de >> 1], de & 1);
    return t;
  }

  // ---------- views ----------
  nodeView(n: RNode): NodeView {
    return { id: n.id, x: n.x, z: n.z, y: n.y, control: n.control, deg: n.edges.length, radius: n.radius, interchange: n.interchange };
  }
  edgeView(e: REdge): EdgeView {
    return {
      id: e.id, a: e.a, b: e.b, cls: e.cls, lanes: e.lanes, oneway: e.oneway, bridge: e.bridge, tunnel: e.tunnel,
      elevated: e.elevated, deck: e.deck, busLane: e.busLane, progress: e.upgrading ? e.workP : e.progress, upgrading: e.upgrading, pts: e.pts, name: e.name,
    };
  }
}

function fail(p: SegmentPlan, reason: string): SegmentPlan { p.ok = false; p.reason = reason; return p; }

export function angDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

export function projSeg(x: number, z: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz || 1;
  let t = ((x - ax) * dx + (z - az) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + dx * t, pz = az + dz * t;
  return { t, x: px, z: pz, d: Math.hypot(px - x, pz - z) };
}

export function segInt(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number) {
  const r1x = bx - ax, r1z = bz - az, r2x = dx - cx, r2z = dz - cz;
  const den = r1x * r2z - r1z * r2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * r2z - (cz - az) * r2x) / den;
  const u = ((cx - ax) * r1z - (cz - az) * r1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, x: ax + r1x * t, z: az + r1z * t };
}
