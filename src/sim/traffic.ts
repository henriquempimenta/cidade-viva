import { EMERGENCY_CAP, EMERGENCY_EXCESS, MODE_CAP, LANE_WIDTH, MAX_VEHICLES, RoadClass, VEH_FLAG_BRAKE, VEH_FLAG_HAZARD, VEH_FLAG_SIREN, VEH_FLAG_YIELD, VEH_FLAG_FULL, VEH_STRIDE, VType, HOUR_SECONDS } from '../shared/constants';
import { vehiclePhysicalLen } from '../shared/vehiclePresets';
import { vehicleSound, type RNode, type REdge, type RoadNetwork } from './roads';

export interface Payload { kind: number; id: number; aux: number }
export const P_CITIZEN = 1, P_SERVICE = 2, P_BUS = 3, P_CARGO = 4, P_CONSTRUCTION = 5, P_TOURBUS = 6, P_FUNERAL = 7, P_GARBAGE = 8, P_MOVING = 9, P_PATROL = 10, P_TAXI = 11, P_INCIDENT = 12;

export interface RoadBlockage {
  incidentId: number;
  edge: number;
  dir: number;
  lane: number;
  s: number;
  len: number;
  fullClosure: boolean;
}

const IDM_A = 1.6, IDM_B = 2.8, IDM_S0 = 2.2, IDM_T = 1.25;
const IDM_INV2SQRT = 1 / (2 * Math.sqrt(IDM_A * IDM_B));

export function laneOffset(e: REdge, lane: number): number {
  if (e.oneway) return (lane + 0.5) * LANE_WIDTH - (e.lanes * LANE_WIDTH) / 2;
  const med = e.cls >= RoadClass.Avenue ? 0.8 : 0.08;
  return med + (lane + 0.5) * LANE_WIDTH + (e.lat ?? 0);
}

/**
 * Vehicles on the road graph, car-following by the Intelligent Driver Model.
 *
 * Coordinate convention: `s[i]` is the vehicle's longitudinal CENTER along its directed edge,
 * matching the centered 3D meshes (`[-len/2, +len/2]`). Front bumper = `s[i] + len[i] / 2`,
 * rear bumper = `s[i] - len[i] / 2`.
 */
export class Traffic {
  max = 0;
  active = new Uint8Array(0);
  gen = new Uint16Array(0);
  type = new Uint8Array(0);
  edge = new Int32Array(0);
  dir = new Uint8Array(0);
  lane = new Uint8Array(0);
  s = new Float32Array(0);
  /** longitudinal position at the start of the current tick (prevents reverse pullback after splitEdge) */
  sPre = new Float32Array(0);
  v = new Float32Array(0);
  v0f = new Float32Array(0);
  len = new Float32Array(0);
  lat = new Float32Array(0);
  stuck = new Float32Array(0);
  flags = new Uint8Array(0);
  pidx = new Int32Array(0);
  destS = new Float32Array(0);
  jnode = new Int32Array(0);
  jlen = new Float32Array(0);
  jp = new Float32Array(0);
  x = new Float32Array(0); y = new Float32Array(0); z = new Float32Array(0); h = new Float32Array(0);
  pKind = new Uint8Array(0);
  pId = new Int32Array(0);
  pAux = new Int32Array(0);
  origin = new Int32Array(0);
  dest = new Int32Array(0);
  dwell = new Float32Array(0);
  /** 1 while legitimately halted at a red signal, closed level crossing, or bus curb dwell (or queued behind one) */
  legitWait = new Uint8Array(0);
  /** last bus stop index served on the current edge (prevents re-triggering the same stop) */
  lastStopKey = new Int32Array(0);
  /** road incident id if this vehicle is immobilized at a crash/breakdown scene (-1 otherwise) */
  incidentId = new Int32Array(0);
  /** optional car visual variant index from Household (-1 = era/hash default) */
  variant = new Int16Array(0);
  path: (number[] | null)[] = [];
  private free: number[] = [];
  count = 0;
  era = 0;
  virtualTrips = 0;
  /** diagnostic counters for flow health & stability gates */
  arrivals = 0;
  despawnsStuck = 0;
  despawnsRedLight = 0;
  static readonly STUCK_LIMIT = 90;
  onArrive: (slot: number) => void = () => {};
  onStuck: (slot: number) => void = () => {};
  /** bus next stop lookup along current directed edge; returns stop index & center s if demand exists */
  nextStop: (slot: number, edge: number, dir: number, curS: number, lastStopIdx: number) => { stopIdx: number; s: number } | null = () => null;
  /** bus curb stop callback: returns dwell seconds (> 0 only if someone boarded or alighted) */
  onStop: (slot: number, stopIdx: number) => number = () => 0;
  private laneArr: number[][] = [];
  private usedKeys: number[] = [];
  rain = 0;
  /** level crossings closed: edge id -> position t along edge */
  closedCrossings = new Map<number, number[]>();
  /** active lane/edge blockages from road incidents, keyed by directed edge (edge*2+dir) */
  blockages = new Map<number, RoadBlockage[]>();
  /** vehicle-seconds spent stopped at closed level crossings, per edge (read and reset by the railway) */
  crossWait = new Map<number, number>();

  constructor(private R: RoadNetwork) { this.grow(MAX_VEHICLES); }

  /** storage grows on demand: there is no hard cap on simultaneous vehicles */
  private grow(n: number) {
    const old = this.max;
    const self = this as unknown as Record<string, unknown>;
    for (const k of Object.keys(self)) {
      const a = self[k];
      if (!ArrayBuffer.isView(a) || k === 'jp') continue;
      const C = (a as unknown as { constructor: new (n: number) => Float32Array }).constructor;
      const b = new C(n); b.set(a as Float32Array); self[k] = b;
    }
    this.lastStopKey.fill(-1, old);
    this.incidentId.fill(-1, old);
    this.variant.fill(-1, old);
    const jp = new Float32Array(n * 6); jp.set(this.jp); this.jp = jp;
    for (let i = old; i < n; i++) this.path.push(null);
    for (let i = n - 1; i >= old; i--) this.free.push(i);
    this.max = n;
  }

  /** soft budget: physical vehicles are limited by road space, not by a fixed pool */
  get capacityLeft() { return 1e9; }

  trim(e: REdge, nodeId: number): number {
    const n = this.R.nodes[nodeId];
    return n.edges.length >= 3 ? Math.min(n.radius, e.len * 0.3) : 0;
  }
  sStart(e: REdge, dir: number) { return this.trim(e, dir === 0 ? e.a : e.b); }
  sEnd(e: REdge, dir: number) { return e.len - this.trim(e, dir === 0 ? e.b : e.a); }

  /** lanes a vehicle of (type, flags) is legally allowed to occupy on edge `e` (enforces exclusive BRT bus lanes) */
  allowedLanes(e: REdge, type: VType, flags = 0): number[] {
    const L = Math.max(1, e.lanes);
    const isBus = type === VType.Bus || type === VType.TourBus || type === VType.SchoolBus;
    const isSiren = (flags & VEH_FLAG_SIREN) !== 0;
    const maxLane = e.busLane && L > 1 && !isBus && !isSiren ? L - 2 : L - 1;
    const out: number[] = [];
    for (let l = 0; l <= maxLane; l++) out.push(l);
    return out;
  }

  /** true when placing centered footprint [s - len/2, s + len/2] does not encroach on or jump across a closed level crossing */
  crossingClear(e: REdge, dir: number, s: number, len: number, refS?: number): boolean {
    const crossing = this.closedCrossings.get(e.id);
    if (!crossing || !crossing.length) return true;
    const myLo = s - len * 0.5;
    const myHi = s + len * 0.5;
    for (const ct of crossing) {
      const cs = dir === 0 ? ct * e.len : (1 - ct) * e.len;
      // physical barrier zone [cs - 5, cs + 5]
      if (myHi > cs - 5 && myLo < cs + 5) return false;
      // never shift a spawn from before/at the gate onto the far side of a closed barrier
      if (refS !== undefined && refS <= cs + 5 && myHi > cs - 5) return false;
    }
    return true;
  }

  spawn(type: VType, path: number[], startS: number, destS: number, payload: Payload, origin = -1, dest = -1, flags = 0, variant = -1): number {
    if (!path.length) return -1;
    if (!this.free.length) this.grow(this.max * 2);
    const de = path[0];
    const e = this.R.edges[de >> 1];
    if (!e || !e.alive) return -1;
    const candidateSlot = this.free[this.free.length - 1];
    const nextGen = (this.gen[candidateSlot] + 1) & 0xffff;
    const vlen = vehiclePhysicalLen(type, candidateSlot, nextGen, this.era, variant);
    const allowed = this.allowedLanes(e, type, flags);
    const pref = allowed[allowed.length - 1] ?? 0;
    const lo = this.sStart(e, de & 1) + vlen * 0.5;
    const hi = this.sEnd(e, de & 1) - vlen * 0.5 - 0.5;
    // refuse admission if the vehicle physically cannot fit on this stretch
    if (lo > hi) { this.spawnRefused++; return -1; }
    const s0 = Math.max(lo, Math.min(startS, hi));
    // reserve real road space: a vehicle never materialises on top of another one or inside a closed level crossing
    const place = this.findRoom(e, de & 1, pref, s0, vlen, allowed);
    if (!place) { this.spawnRefused++; return -1; }
    const slot = this.free.pop()!;
    this.active[slot] = 1;
    this.gen[slot] = nextGen;
    this.type[slot] = type;
    this.edge[slot] = e.id;
    this.dir[slot] = de & 1;
    this.lane[slot] = place[0];
    this.s[slot] = place[1];
    this.sPre[slot] = place[1];
    this.v[slot] = 0;
    // compliance with the posted limit: drivers choose 88–100 % of it (nobody exceeds it except sirens, see step())
    const vf = 0.88 + ((slot * 2654435761 + this.gen[slot] * 97) >>> 0) % 1000 / 1000 * 0.12;
    this.v0f[slot] = vf;
    this.len[slot] = vlen;
    this.lat[slot] = 0;
    this.stuck[slot] = 0;
    this.legitWait[slot] = 0;
    this.flags[slot] = flags;
    this.path[slot] = path.slice(); // own copy: topology patches (splits, reversals) edit it in place
    this.pidx[slot] = 0;
    this.destS[slot] = destS;
    this.jnode[slot] = -1;
    this.jlen[slot] = 0;
    this.pKind[slot] = payload.kind; this.pId[slot] = payload.id; this.pAux[slot] = payload.aux;
    this.origin[slot] = origin; this.dest[slot] = dest;
    this.dwell[slot] = 0;
    this.lastStopKey[slot] = -1;
    this.incidentId[slot] = -1;
    this.variant[slot] = variant;
    this.count++;
    this.occupy(slot);
    e.count[de & 1]++;
    if (origin >= 0 || dest >= 0) this.R.logOD(e, origin, dest);
    return slot;
  }

  /** spawns refused because there was no free road space at the access point */
  spawnRefused = 0;
  /** minimum free space kept around a vehicle when it enters a lane (m) */
  static ENTRY_GAP = 2;

  /** vehicles currently on (edge, dir, lane), including those that entered since the last rebuild */
  private occupants(e: REdge, dir: number, lane: number): number[] {
    const arr = this.laneArr[this.key(e.id, dir, lane)];
    return arr ?? [];
  }

  /** returns true when vehicle `i` has >= `margin` m longitudinal clearance from ALL other active vehicles in its lane (ignoring lat) */
  isClearOfLaneNeighbors(i: number, margin = 0.6): boolean {
    if (!this.active[i]) return false;
    const eid = this.edge[i], dir = this.dir[i], lane = this.lane[i];
    const myLo = this.s[i] - this.len[i] * 0.5;
    const myHi = this.s[i] + this.len[i] * 0.5;
    for (const o of this.occupants(this.R.edges[eid], dir, lane)) {
      if (o === i || !this.active[o] || this.edge[o] !== eid || this.dir[o] !== dir || this.lane[o] !== lane) continue;
      const oLo = this.s[o] - this.len[o] * 0.5;
      const oHi = this.s[o] + this.len[o] * 0.5;
      if (myHi + margin > oLo && myLo - margin < oHi) return false;
    }
    return true;
  }

  /** returns an active blockage overlapping centered footprint [s - len/2, s + len/2] on (e, dir, lane), if any */
  blockageAt(e: REdge, dir: number, lane: number, s: number, len: number, self = -1): RoadBlockage | null {
    const list = this.blockages.get(e.id * 2 + dir);
    if (!list || !list.length) return null;
    const myLo = s - len * 0.5;
    const myHi = s + len * 0.5;
    for (const b of list) {
      if (!b.fullClosure && b.lane !== lane) continue;
      if (self >= 0 && this.pKind[self] === P_INCIDENT && this.pId[self] === b.incidentId) continue;
      if (myHi > b.s - b.len * 0.5 - 3.0 && myLo < b.s + b.len * 0.5 + 1.5) return b;
    }
    return null;
  }

  /** does centered footprint [s - len/2, s + len/2] on this lane overlap another vehicle (with entry gap) or active blockage? */
  laneFree(e: REdge, dir: number, lane: number, s: number, len: number, self = -1): boolean {
    if (!this.crossingClear(e, dir, s, len)) return false;
    if (this.blockageAt(e, dir, lane, s, len, self)) return false;
    const G = Traffic.ENTRY_GAP;
    const ss = this.sStart(e, dir);
    const myLo = s - len * 0.5;
    const myHi = s + len * 0.5;
    for (const o of this.occupants(e, dir, lane)) {
      if (o === self || !this.active[o] || this.edge[o] !== e.id || this.dir[o] !== dir || this.lane[o] !== lane) continue;
      const so = this.s[o];
      const hlo = this.len[o] * 0.5;
      // a vehicle still crossing the junction box has already reserved [sStart, sStart + len] on this exit lane
      const lo = so - hlo < ss ? ss : so - hlo;
      const hi = so - hlo < ss ? Math.max(ss + this.len[o], so + hlo) : so + hlo;
      if (myHi + G > lo && myLo - G < hi) return false;
    }
    return true;
  }

  /** a free centered lane position at or near s0 (moving back towards the entrance, then forward), or null */
  findRoom(e: REdge, dir: number, pref: number, s0: number, len: number, allowed?: number[]): [number, number] | null {
    const lo = this.sStart(e, dir) + len * 0.5;
    const hi = this.sEnd(e, dir) - len * 0.5 - 0.5;
    if (lo > hi) return null;
    const base = allowed && allowed.length ? allowed : Array.from({ length: Math.max(1, e.lanes) }, (_, l) => l);
    const lanes: number[] = [];
    if (base.includes(pref)) lanes.push(pref);
    for (const l of base) if (l !== pref) lanes.push(l);
    const offs = [0, -6, 6, -12, 12, -20, 20];
    for (const d of offs) for (const l of lanes) {
      const s = s0 + d;
      if (s < lo || s > hi) continue;
      if (this.crossingClear(e, dir, s, len, s0) && this.laneFree(e, dir, l, s, len)) return [l, s];
    }
    return null;
  }

  /** register a slot in its lane list right away, so later spawns and entries in the same tick see it */
  private occupy(i: number) {
    const k = this.key(this.edge[i], this.dir[i], this.lane[i]);
    let arr = this.laneArr[k];
    if (!arr) this.laneArr[k] = arr = [];
    if (!arr.length) this.usedKeys.push(k);
    arr.push(i);
  }

  private releaseJunction(slot: number) {
    const j = this.jnode[slot];
    if (j < 0) return;
    const node = this.R.nodes[j];
    if (node) {
      const idx = node.jSlots.indexOf(slot);
      if (idx >= 0) node.jSlots.splice(idx, 1);
      node.inJunction = node.jSlots.length;
    }
    this.jnode[slot] = -1;
  }

  despawn(slot: number) {
    if (!this.active[slot]) return;
    this.releaseJunction(slot);
    this.active[slot] = 0;
    this.incidentId[slot] = -1;
    this.variant[slot] = -1;
    this.path[slot] = null;
    this.free.push(slot);
    this.count--;
  }

  private key(edge: number, dir: number, lane: number) { return (edge * 2 + dir) * 4 + lane; }

  /** remaining distance-time to destination (for virtual conversion) */
  remainingTime(slot: number): number {
    const p = this.path[slot];
    if (!p) return 0;
    let t = 0;
    for (let i = this.pidx[slot]; i < p.length; i++) { const e = this.R.edges[p[i] >> 1]; if (e?.alive) t += this.R.travelTime(e, p[i] & 1); }
    return t;
  }

  /** check whether entering `node` from (inEdge, inDir) toward (outEdge, outDir, outLane) conflicts with any vehicle currently inside `node` */
  private junctionConflict(node: RNode, inEdge: REdge, inDir: number, outEdge: REdge, outDir: number, outLane: number, self: number): boolean {
    if (!node.jSlots.length) return false;
    const R = this.R;
    let majorCls = -1;
    if (node.interchange) {
      for (const id of node.edges) majorCls = Math.max(majorCls, R.edges[id]?.cls ?? 0);
    }
    const [u1x, u1z] = this.dirVec(inEdge, inDir);
    const [v1x, v1z] = this.dirVec(outEdge, outDir);
    const cross1 = u1x * v1z - u1z * v1x; // > 0 right turn, < 0 left turn
    for (let k = node.jSlots.length - 1; k >= 0; k--) {
      const o = node.jSlots[k];
      if (o === self) continue;
      if (!this.active[o] || this.jnode[o] !== node.id) {
        node.jSlots.splice(k, 1);
        node.inJunction = node.jSlots.length;
        continue;
      }
      const op = this.path[o];
      const opi = this.pidx[o];
      const oInDe = op && opi > 0 ? op[opi - 1] : -1;
      const oInEdge = oInDe >= 0 ? R.edges[oInDe >> 1] : null;
      const oOutEdge = R.edges[this.edge[o]];
      if (!oInEdge || !oOutEdge) return true;
      // grade-separated interchange: viaduct major road does not conflict with surface minor road
      if (node.interchange && (inEdge.cls === majorCls) !== (oInEdge.cls === majorCls)) continue;
      // same incoming edge heading onto the same exit edge (parallel lanes AND same-lane convoy:
      // physical spacing is enforced by exitLaneRoom + IDM)
      if (oInEdge.id === inEdge.id && oOutEdge.id === outEdge.id) continue;
      void outLane;
      // opposing straight or right-turn movements do not cross each other
      const [u2x, u2z] = this.dirVec(oInEdge, oInDe & 1);
      const [v2x, v2z] = this.dirVec(oOutEdge, this.dir[o]);
      const dotIn = u1x * u2x + u1z * u2z;
      if (dotIn < -0.7 && oOutEdge.id !== outEdge.id) {
        const cross2 = u2x * v2z - u2z * v2x;
        if (cross1 > -0.35 && cross2 > -0.35) continue;
      }
      return true;
    }
    return false;
  }

  /** exact junction arc length for a transition from (e, dir, lane, fromS) into (ne, ndir, nl) */
  private estimateJlen(e: REdge, dir: number, lane: number, ne: REdge, ndir: number, nl: number, fromS: number): number {
    const p0 = this.point(e, dir, lane, fromS);
    const p2 = this.point(ne, ndir, nl, this.sStart(ne, ndir));
    const [hx, hz] = this.dirVec(e, dir), [nx, nz] = this.dirVec(ne, ndir);
    const den = hx * nz - hz * nx;
    let cx = (p0[0] + p2[0]) / 2, cz = (p0[2] + p2[2]) / 2;
    if (Math.abs(den) > 0.15) {
      const t = ((p2[0] - p0[0]) * nz - (p2[2] - p0[2]) * nx) / den;
      if (t > 0 && t < 40) { cx = p0[0] + hx * t; cz = p0[2] + hz * t; }
    }
    const l1 = Math.hypot(cx - p0[0], cz - p0[2]), l2 = Math.hypot(p2[0] - cx, p2[2] - cz), l3 = Math.hypot(p2[0] - p0[0], p2[2] - p0[2]);
    return Math.max(0.5, (l1 + l2 + l3) / 2);
  }

  /**
   * Check whether exit lane (ne, ndir, nl) has room to accept a vehicle of length `vlen` from `inEdgeId`
   * without blocking the junction box or overlapping a leader. Accounts for `overshoot` past `sEntry`
   * and returns `maxEntryS` so transition placement can never violate physical bumper clearance.
   */
  private exitLaneRoom(
    ne: REdge, ndir: number, nl: number, vlen: number, inEdgeId: number, self: number, jlenEst: number, overshoot = 0,
  ): { ok: boolean; leaderDist: number; leaderV: number; maxEntryS: number } {
    const ns = this.sStart(ne, ndir);
    const neEnd = this.sEnd(ne, ndir);
    if (!this.crossingClear(ne, ndir, ns + vlen * 0.5, vlen)) return { ok: false, leaderDist: 0, leaderV: 0, maxEntryS: -Infinity };
    // Refuse entry into a lane whose entrance is immediately blocked by an active road incident
    const blks = this.blockages.get(ne.id * 2 + ndir);
    if (blks && blks.length) {
      for (const b of blks) {
        if (!b.fullClosure && b.lane !== nl) continue;
        if (this.pKind[self] === P_INCIDENT && this.pId[self] === b.incidentId) continue;
        if (b.fullClosure && ne.lanes <= 1 && b.s - b.len * 0.5 - 3.5 < ns + vlen + Traffic.ENTRY_GAP) {
          return { ok: false, leaderDist: 0, leaderV: 0, maxEntryS: -Infinity };
        }
        if (b.s - b.len * 0.5 - 3.5 < ns + vlen + Traffic.ENTRY_GAP) {
          return { ok: false, leaderDist: 0, leaderV: 0, maxEntryS: -Infinity };
        }
      }
    }
    const narr = this.occupants(ne, ndir, nl);
    if (!narr.length) return { ok: true, leaderDist: Infinity, leaderV: 0, maxEntryS: Infinity };
    const G = Traffic.ENTRY_GAP;
    let hasPast = false;
    let minPastRear = neEnd;
    let minPastV = 0;
    let inBoxLen = 0;
    let minBoxRear = Infinity;
    let minBoxV = Infinity;
    for (const o of narr) {
      if (o === self || !this.active[o] || this.edge[o] !== ne.id || this.dir[o] !== ndir || this.lane[o] !== nl) continue;
      const rearO = this.s[o] - this.len[o] * 0.5;
      if (rearO < ns) {
        const op = this.path[o], opi = this.pidx[o];
        const oInDe = op && opi > 0 ? op[opi - 1] : -1;
        const oInEdgeId = oInDe >= 0 ? (oInDe >> 1) : -1;
        // convoy only behind a moving leader from the exact same incoming arm
        if (oInEdgeId !== inEdgeId || this.v[o] < 0.8) return { ok: false, leaderDist: 0, leaderV: 0, maxEntryS: -Infinity };
        inBoxLen += this.len[o] + G;
        if (rearO < minBoxRear) { minBoxRear = rearO; minBoxV = this.v[o]; }
      } else {
        hasPast = true;
        if (rearO < minPastRear) { minPastRear = rearO; minPastV = this.v[o]; }
      }
    }
    const needed = inBoxLen + vlen + G;
    if (hasPast) {
      if (minPastRear - ns < needed) return { ok: false, leaderDist: 0, leaderV: 0, maxEntryS: -Infinity };
    } else if (inBoxLen > 0) {
      if (neEnd - ns < needed) return { ok: false, leaderDist: 0, leaderV: 0, maxEntryS: -Infinity };
    }
    const minAnyRear = Math.min(minBoxRear, hasPast ? minPastRear : Infinity);
    const maxEntryS = minAnyRear < Infinity ? minAnyRear - G - vlen * 0.5 : Infinity;
    const entryCenter = ns - jlenEst + overshoot;
    const myFrontAtEntry = entryCenter + vlen * 0.5;
    if (minBoxRear < Infinity) {
      // Check clearance both at the stop-line entry (without overshoot) and with overshoot
      const baseGap = minBoxRear - ((ns - jlenEst) + vlen * 0.5);
      if (baseGap < G) return { ok: false, leaderDist: 0, leaderV: 0, maxEntryS: -Infinity };
      const boxGap = minBoxRear - myFrontAtEntry;
      if (boxGap < G && maxEntryS < ns - jlenEst) return { ok: false, leaderDist: 0, leaderV: 0, maxEntryS: -Infinity };
      return { ok: true, leaderDist: Math.max(G, boxGap), leaderV: minBoxV, maxEntryS };
    }
    if (hasPast) {
      if (minPastRear - myFrontAtEntry < G && maxEntryS < ns - jlenEst) return { ok: false, leaderDist: 0, leaderV: 0, maxEntryS: -Infinity };
      return { ok: true, leaderDist: (minPastRear - ns) + 4, leaderV: minPastV, maxEntryS };
    }
    return { ok: true, leaderDist: Infinity, leaderV: 0, maxEntryS: Infinity };
  }

  /** Audit whether vehicle `i` (or the head of its lane queue) is currently held by a red signal on `(e, dir)`. */
  isHeldByRedSignal(i: number, e: REdge, dir: number, nodesSignal: (n: RNode, inEdge: REdge, dir: number, distToStop: number, waited: number) => boolean): boolean {
    if ((this.flags[i] & VEH_FLAG_SIREN) !== 0) return false;
    const node = this.R.nodes[dir === 0 ? e.b : e.a];
    if (!node || (node.control !== 2 && node.control !== 4)) return false;
    const sStart = this.sStart(e, dir), sEnd = this.sEnd(e, dir);
    const sEntry = Math.max(sStart + 0.5, sEnd - this.len[i] * 0.5);
    const distSelf = Math.max(0, sEntry - this.s[i]);
    if (distSelf < 24 && !nodesSignal(node, e, dir, distSelf, this.stuck[i])) return true;
    const arr = this.laneArr[this.key(e.id, dir, this.lane[i])];
    if (arr && arr.length) {
      const head = arr[arr.length - 1];
      if (this.active[head] && head !== i) {
        const headEntry = Math.max(sStart + 0.5, sEnd - this.len[head] * 0.5);
        const distHead = Math.max(0, headEntry - this.s[head]);
        if (distHead < 24 && !nodesSignal(node, e, dir, distHead, this.stuck[head])) return true;
      }
    }
    return false;
  }

  /** Centralized stuck-despawn path with honest red-light audit telemetry. */
  private despawnForStuck(i: number, e: REdge | undefined, dir: number, nodesSignal: (n: RNode, inEdge: REdge, dir: number, distToStop: number, waited: number) => boolean) {
    if (e?.alive && this.isHeldByRedSignal(i, e, dir, nodesSignal)) this.despawnsRedLight++;
    this.despawnsStuck++;
    this.onStuck(i);
    this.despawn(i);
  }

  /** Helper: does an approaching siren at `node` require a non-emergency vehicle from `inEdge` to hold? */
  private sirenPreemptsCross(node: RNode, inEdge: REdge, sirenNodes: Map<number, number>): boolean {
    if (node.edges.length < 3) return false;
    const sEdgeId = sirenNodes.get(node.id);
    if (sEdgeId === undefined || sEdgeId === inEdge.id) return false;
    if (node.interchange) {
      let major = 0;
      for (const id of node.edges) major = Math.max(major, this.R.edges[id]?.cls ?? 0);
      const sEdge = this.R.edges[sEdgeId];
      if (sEdge && (inEdge.cls === major) !== (sEdge.cls === major)) return false;
    }
    return true;
  }

  /** Helper: forward bumper gap to next vehicle in sorted lane list `arr` ahead of position `myS` */
  private laneForwardGap(arr: number[] | undefined, myS: number, myLen: number, self: number, emergency: boolean): { gap: number; v: number } {
    if (!arr || !arr.length) return { gap: 1e9, v: 0 };
    const hli = myLen * 0.5;
    for (let k = 0; k < arr.length; k++) {
      const o = arr[k];
      if (o === self || !this.active[o]) continue;
      if (this.s[o] <= myS) continue;
      if (emergency && (this.flags[o] & VEH_FLAG_YIELD) && this.lat[o] > 1.0) continue;
      return { gap: this.s[o] - myS - hli - this.len[o] * 0.5, v: this.v[o] };
    }
    return { gap: 1e9, v: 0 };
  }

  /** Helper: does `(e, dir, lane)` have a blockage ahead of `myS` within `lookahead` meters for vehicle `self`? */
  private laneHasBlockAhead(e: REdge, dir: number, lane: number, myS: number, lookahead: number, self: number): RoadBlockage | null {
    const blks = this.blockages.get(e.id * 2 + dir);
    if (!blks || !blks.length) return null;
    for (const b of blks) {
      if (!b.fullClosure && b.lane !== lane) continue;
      if (this.pKind[self] === P_INCIDENT && this.pId[self] === b.incidentId) continue;
      const ds = b.s - myS;
      if (ds > -b.len * 0.5 - 2 && ds < lookahead) return b;
    }
    return null;
  }

  step(dt: number, nodesSignal: (n: RNode, inEdge: REdge, dir: number, distToStop: number, waited: number) => boolean) {
    const R = this.R;
    // 1. lane lists + snapshot start-of-tick sPre (prevents reverse pullback after splitEdge)
    const LA = this.laneArr, used = this.usedKeys;
    for (const k of used) LA[k].length = 0;
    used.length = 0;
    for (let i = 0; i < this.max; i++) {
      if (!this.active[i]) continue;
      this.sPre[i] = this.s[i];
      const le = R.edges[this.edge[i]];
      if (le && this.lane[i] >= le.lanes) this.lane[i] = Math.max(0, le.lanes - 1);
      const k = this.key(this.edge[i], this.dir[i], this.lane[i]);
      let arr = LA[k];
      if (!arr) LA[k] = arr = [];
      if (!arr.length) used.push(k);
      arr.push(i);
    }
    const S = this.s;
    for (const k of used) { const arr = LA[k]; if (arr.length > 1) arr.sort((a, b) => S[a] - S[b]); }
    for (const e of R.edges) if (e.alive) { e.stopped[0] = 0; e.stopped[1] = 0; }
    const rainF = 1 - 0.25 * this.rain;

    // 1.5 active lane changes (multi-lane incident bypass + siren overtaking slow/stopped queues)
    // Runs BEFORE IDM and maintains sorted LA with strict laneFree clearance => mathematically zero overlap.
    for (let i = 0; i < this.max; i++) {
      if (!this.active[i] || this.jnode[i] >= 0 || this.dwell[i] > 0 || this.incidentId[i] >= 0) continue;
      const eid = this.edge[i], dir = this.dir[i];
      const e = R.edges[eid];
      if (!e || !e.alive || e.lanes < 2) continue;
      const curLane = this.lane[i];
      const emergency = (this.flags[i] & VEH_FLAG_SIREN) !== 0;
      const blk = this.laneHasBlockAhead(e, dir, curLane, this.s[i], 58, i);
      const wantBypass = !!blk && !blk.fullClosure;
      let wantOvertake = false;
      let curFwdGap = 1e9;
      if (emergency && !wantBypass) {
        const curKey = this.key(eid, dir, curLane);
        const fwd = this.laneForwardGap(LA[curKey], this.s[i], this.len[i], i, true);
        curFwdGap = fwd.gap;
        const vDes = Math.min(EMERGENCY_CAP, R.speedLimit(e) * rainF + EMERGENCY_EXCESS);
        if (fwd.gap < 48 && fwd.v < vDes * 0.65) wantOvertake = true;
      }
      if (!wantBypass && !wantOvertake) continue;
      // Candidate target lanes: prefer allowedLanes; for partial blockage bypass allow temporary use of any unblocked lane
      const allowed = this.allowedLanes(e, this.type[i], this.flags[i]);
      const cands: number[] = [];
      for (const l of allowed) if (l !== curLane) cands.push(l);
      if (wantBypass) {
        for (let l = 0; l < e.lanes; l++) if (l !== curLane && !cands.includes(l)) cands.push(l);
      }
      let bestLane = -1;
      let bestGap = wantOvertake ? curFwdGap + 10 : -1;
      for (const alt of cands) {
        if (this.laneHasBlockAhead(e, dir, alt, this.s[i], 58, i)) continue;
        if (!this.laneFree(e, dir, alt, this.s[i], this.len[i], i)) continue;
        const altFwd = this.laneForwardGap(LA[this.key(eid, dir, alt)], this.s[i], this.len[i], i, emergency);
        if (altFwd.gap > bestGap) { bestGap = altFwd.gap; bestLane = alt; }
      }
      if (bestLane >= 0) {
        const oldKey = this.key(eid, dir, curLane);
        const oldArr = LA[oldKey];
        if (oldArr) {
          const idx = oldArr.indexOf(i);
          if (idx >= 0) oldArr.splice(idx, 1);
        }
        this.lane[i] = bestLane;
        const newKey = this.key(eid, dir, bestLane);
        let newArr = LA[newKey];
        if (!newArr) LA[newKey] = newArr = [];
        if (!newArr.length) used.push(newKey);
        newArr.push(i);
        if (newArr.length > 1) newArr.sort((a, b) => S[a] - S[b]);
      }
    }

    // emergency presence per edge-dir (yielding) & approaching signal/junction preemption (cross-traffic hold)
    const sirens = new Map<number, number[]>();
    const sirenNodes = new Map<number, number>();
    for (let i = 0; i < this.max; i++) if (this.active[i] && (this.flags[i] & VEH_FLAG_SIREN) && this.incidentId[i] < 0) {
      const eid = this.edge[i], dir = this.dir[i];
      const k = eid * 2 + dir;
      let list = sirens.get(k);
      if (!list) { list = []; sirens.set(k, list); }
      list.push(i);
      const e = R.edges[eid];
      const p = this.path[i];
      if (e?.alive && p && this.pidx[i] < p.length - 1) {
        const distToNode = this.sEnd(e, dir) - this.s[i];
        if (distToNode > -4 && distToNode < 58) {
          const nid = dir === 0 ? e.b : e.a;
          if (!sirenNodes.has(nid)) sirenNodes.set(nid, eid);
        }
      }
    }
    // 2. IDM
    for (const k of used) {
      const arr = LA[k];
      if (!arr.length) continue;
      const eid = (k >> 2) >> 1, dir = (k >> 2) & 1;
      const e = R.edges[eid];
      if (!e || !e.alive) { for (const i of arr) this.despawn(i); continue; }
      const sStart = this.sStart(e, dir);
      const sEnd = this.sEnd(e, dir);
      const vmax = R.speedLimit(e) * rainF;
      const sirenList = sirens.get(eid * 2 + dir);
      const crossing = this.closedCrossings.get(eid);
      const edgeBlks = this.blockages.get(eid * 2 + dir);
      for (let idx = 0; idx < arr.length; idx++) {
        const i = arr[idx];
        if (!this.active[i]) continue;
        // Immobilized incident vehicle or responder parked on scene
        if (this.incidentId[i] >= 0) {
          this.v[i] = 0;
          this.stuck[i] = 0;
          this.legitWait[i] = 1;
          if ((this.flags[i] & VEH_FLAG_SIREN) === 0) this.flags[i] |= VEH_FLAG_HAZARD;
          const targetLat = this.pAux[i] === 99 ? 0.65 : 0;
          this.lat[i] += (targetLat - this.lat[i]) * Math.min(1, dt * 2.5);
          continue;
        }
        const emergency = (this.flags[i] & VEH_FLAG_SIREN) !== 0;
        const hli = this.len[i] * 0.5;
        // yield to sirens approaching from behind AND remain pulled over until the siren fully clears our body
        let yieldNow = false;
        if (!emergency && sirenList) {
          for (let si = 0; si < sirenList.length; si++) {
            const sv = sirenList[si];
            const d = this.s[i] - this.s[sv];
            if ((d > 0 && d < 65) || (d <= 0 && -d < hli + this.len[sv] * 0.5 + 3.0)) {
              yieldNow = true;
              break;
            }
          }
        }
        if (yieldNow) this.flags[i] |= VEH_FLAG_YIELD; else this.flags[i] &= ~VEH_FLAG_YIELD;
        // dwell (bus stops on the curb, deliveries)
        if (this.dwell[i] > 0) {
          this.dwell[i] -= dt;
          this.v[i] = 0;
          this.legitWait[i] = this.pKind[i] === P_BUS ? 1 : 0;
          // If already pulled over for a passing siren, stay pulled over until cleared; never slide sideways while parked
          if (yieldNow && this.lat[i] > 1.0) this.lat[i] += (1.4 - this.lat[i]) * Math.min(1, dt * 3);
          else if (this.pKind[i] === P_BUS && !yieldNow) this.lat[i] += (0.6 - this.lat[i]) * Math.min(1, dt * 3);
          continue;
        }
        this.legitWait[i] = 0;
        const ty0 = this.type[i];
        const cap = MODE_CAP[ty0] ?? Infinity;
        // desired speed = posted limit × compliance, capped per mode; sirens get a declared, bounded exception
        let v0 = emergency ? Math.min(EMERGENCY_CAP, vmax + EMERGENCY_EXCESS) : Math.min(vmax * this.v0f[i], cap * rainF) * (yieldNow ? 0.3 : 1);
        let gap = 1e9, vl = 0;
        let vehGap = 1e9;
        // leader in lane: exact bumper-to-bumper clearance using both vehicles' half-lengths
        for (let j = idx + 1; j < arr.length; j++) {
          const o = arr[j];
          // overtake only a vehicle that has actually pulled over to the curb (never an immobilized incident vehicle)
          if (emergency && this.incidentId[o] < 0 && (this.flags[o] & VEH_FLAG_YIELD) && this.lat[o] > 1.0) continue;
          gap = this.s[o] - this.s[i] - hli - this.len[o] * 0.5;
          vehGap = gap;
          vl = this.v[o];
          break;
        }
        // bus stop along the current edge (strictly outside intersections)
        let busStopLat = 0;
        let stopTarget: { stopIdx: number; s: number } | null = null;
        let stopLimiting = false;
        let dsStopLim = Infinity;
        if (this.pKind[i] === P_BUS && this.jnode[i] < 0) {
          const ns = this.nextStop(i, eid, dir, this.s[i], this.lastStopKey[i]);
          if (ns && ns.s > sStart + 1 && ns.s < sEnd - 2) {
            const dsStop = ns.s - this.s[i];
            if (dsStop > -1.5 && dsStop < 48) {
              stopTarget = ns;
              if (dsStop < 24) busStopLat = 0.6;
              // Compensate IDM_S0 so equilibrium (v=0, a=0) lands at dsStop = 0 instead of stalling at 2.2 m
              const stopGapIdm = Math.max(0.1, dsStop + IDM_S0);
              if (dsStop > -0.5 && stopGapIdm < gap) {
                gap = stopGapIdm;
                vl = 0;
                stopLimiting = true;
                dsStopLim = Math.max(0, dsStop);
              }
            }
          }
        }
        const path = this.path[i]!;
        const pi = this.pidx[i];
        const last = pi >= path.length - 1;
        // unified stop-line / transition reference: front bumper reaches sEnd when center reaches sEntry = sEnd - hli
        const sEntry = Math.max(sStart + 0.5, sEnd - hli);
        const distEnd = sEntry - this.s[i];
        let blockedAtNode = false;
        let redSignalHold = false;
        let crossingHold = false;
        let incidentHold = false;
        let sirenHold = false;
        // Road incident blockage on this lane (cones/barricade perimeter)
        if (edgeBlks && edgeBlks.length) {
          for (const blk of edgeBlks) {
            if (!blk.fullClosure && blk.lane !== this.lane[i]) continue;
            if (this.pKind[i] === P_INCIDENT && this.pId[i] === blk.incidentId) continue;
            const gBlk = (blk.s - blk.len * 0.5 - 3.5) - (this.s[i] + hli);
            if (gBlk > -1.5 && gBlk < gap) {
              gap = Math.max(0.05, gBlk);
              vl = 0;
              stopLimiting = false;
              incidentHold = true;
            }
          }
        }
        if (gap > distEnd) {
          if (last) {
            const dg = this.destS[i] - this.s[i] + 3;
            if (dg < gap) { gap = dg; vl = 0; stopLimiting = false; }
          } else {
            const nde = path[pi + 1];
            const ne = R.edges[nde >> 1];
            const node = R.nodes[dir === 0 ? e.b : e.a];
            let ok = !!ne && ne.alive && ne.progress >= 1;
            const nl = ok ? this.chooseLane(e, dir, ne, nde & 1, i) : 0;
            // Hold non-emergency cross traffic while a siren vehicle is approaching the same junction
            if (ok && !emergency && this.sirenPreemptsCross(node, e, sirenNodes)) {
              ok = false;
              sirenHold = true;
            }
            if (ok && !emergency) {
              ok = nodesSignal(node, e, dir, distEnd, this.stuck[i]);
              if (!ok && (node.control === 2 || node.control === 4)) redSignalHold = true;
            }
            // Emergency vehicle crossing a red signal slows to controlled caution speed (~6-8 m/s)
            if (ok && emergency && (node.control === 2 || node.control === 4) && distEnd < 28 && !nodesSignal(node, e, dir, distEnd, this.stuck[i])) {
              v0 = Math.min(v0, 7.5);
            }
            if (ok && node.edges.length >= 3) {
              if (this.junctionConflict(node, e, dir, ne, nde & 1, nl, i)) ok = false;
            }
            if (ok) {
              const jEst = this.estimateJlen(e, dir, this.lane[i], ne, nde & 1, nl, sEntry);
              const rm = this.exitLaneRoom(ne, nde & 1, nl, this.len[i], e.id, i, jEst);
              if (!rm.ok) ok = false;
              else if (rm.leaderDist < Infinity) {
                const g2 = Math.max(0, distEnd) + rm.leaderDist;
                if (g2 < gap) { gap = g2; vl = rm.leaderV; stopLimiting = false; }
              }
            }
            if (!ok) {
              blockedAtNode = true;
              const g2 = Math.max(0.05, distEnd);
              if (g2 < gap) { gap = g2; vl = 0; stopLimiting = false; }
              node.waitAcc += dt;
            }
          }
        }
        // Keep emergency vehicle at safe caution speed while actively traversing a signalized junction box
        if (emergency && this.jnode[i] >= 0) {
          const jn = R.nodes[this.jnode[i]];
          if (jn && (jn.control === 2 || jn.control === 4)) v0 = Math.min(v0, 8.0);
        }
        // closed level crossing: a physical barrier, sirens included (front bumper stops well before the track)
        if (crossing) {
          for (const ct of crossing) {
            const cs = dir === 0 ? ct * e.len : (1 - ct) * e.len;
            const g2 = (cs - 5) - (this.s[i] + hli);
            if (g2 > -2 && g2 < gap) { gap = Math.max(0.05, g2); vl = 0; stopLimiting = false; crossingHold = true; }
            if (g2 > -2 && g2 < 140 && this.v[i] < 1.5) this.crossWait.set(eid, (this.crossWait.get(eid) ?? 0) + dt);
          }
        }
        if ((redSignalHold && distEnd < 18) || crossingHold || incidentHold || sirenHold) this.legitWait[i] = 1;
        const v = this.v[i];
        const dv = v - vl;
        const sStar = IDM_S0 + Math.max(0, v * IDM_T + (v * dv) * IDM_INV2SQRT);
        const g = Math.max(0.1, gap);
        const rv = v / Math.max(0.1, v0), rv2 = rv * rv;
        let a = IDM_A * (1 - rv2 * rv2 - (sStar / g) * (sStar / g));
        if (a < -9) a = -9;
        let nv = v + a * dt;
        if (nv < 0) nv = 0;
        let ds = (v + nv) * 0.5 * dt;
        // strict anti-overlap guard: keeps bumper-to-bumper spacing >= 0.85 m to any vehicle ahead
        if (vehGap < 1e8 && ds > vehGap - 0.85) ds = Math.max(0, vehGap - 0.85);
        if (stopLimiting) {
          // brake cleanly right up to stopTarget.s without stalling 2.2 m short
          if (ds > dsStopLim) ds = dsStopLim;
        } else if (blockedAtNode) {
          // keep front bumper strictly behind the stop line (never overhanging the crosswalk)
          if (ds > Math.max(0, distEnd - 0.2)) ds = Math.max(0, distEnd - 0.2);
        } else if (gap < 1e8 && ds > gap - 0.85) {
          ds = Math.max(0, gap - 0.85);
        }
        this.v[i] = nv;
        this.s[i] += ds;
        // did a bus arrive at its curb stop on this edge?
        if (stopTarget) {
          const rem = stopTarget.s - this.s[i];
          if (rem <= 1.2 && (this.v[i] < 2.8 || rem <= 0.35)) {
            this.v[i] = 0;
            if (!yieldNow) this.lat[i] = 0.6;
            this.lastStopKey[i] = stopTarget.stopIdx;
            const dwellSecs = this.onStop(i, stopTarget.stopIdx);
            if (dwellSecs > 0) { this.dwell[i] = dwellSecs; this.legitWait[i] = 1; }
          }
        }
        if (a < -1.2) this.flags[i] |= VEH_FLAG_BRAKE; else this.flags[i] &= ~VEH_FLAG_BRAKE;
        // acoustics: what this vehicle adds to the street's noise right now
        const snd = e.snd ?? (e.snd = new Float32Array(5));
        const ty = this.type[i];
        const sc = ty === VType.Moto ? 1 : ty === VType.Car || ty === VType.Taxi || ty === VType.Ambulance || ty === VType.Police || ty === VType.Van || ty === VType.Hearse ? 0 : 2;
        snd[sc] += vehicleSound(sc, nv, a, e.cls === RoadClass.Dirt);
        snd[3] += nv; snd[4]++;
        // lateral offset (yield to curb or pull into bus stop)
        const latT = yieldNow ? 1.4 : busStopLat;
        this.lat[i] += (latT - this.lat[i]) * Math.min(1, dt * (yieldNow ? 2.8 : 1.8));
      }
      // Propagate legitimate wait (red light / closed crossing / bus dwell / road incident) backward through queued vehicles,
      // then update stuck timers so cars waiting legitimately in a signal/crossing/incident queue are never despawned
      for (let idx = arr.length - 1; idx >= 0; idx--) {
        const i = arr[idx];
        if (!this.active[i]) continue;
        if (idx < arr.length - 1 && !this.legitWait[i] && this.v[i] < 0.5) {
          const o = arr[idx + 1];
          if (this.active[o] && this.legitWait[o]) {
            const bgap = this.s[o] - this.s[i] - (this.len[o] + this.len[i]) * 0.5;
            if (bgap < 8) this.legitWait[i] = 1;
          }
        }
        if (this.v[i] < 0.5 && this.dwell[i] <= 0 && this.incidentId[i] < 0) {
          e.stopped[dir]++;
          if (!this.legitWait[i]) this.stuck[i] += dt;
        } else {
          this.stuck[i] = Math.max(0, this.stuck[i] - dt * 2);
        }
      }
    }
    // 3. transitions
    for (let i = 0; i < this.max; i++) {
      if (!this.active[i] || this.incidentId[i] >= 0) continue;
      const e = R.edges[this.edge[i]];
      const dir = this.dir[i];
      if (!e?.alive) { this.despawnForStuck(i, e, dir, nodesSignal); continue; }
      // left the junction once the body clears sStart?
      if (this.jnode[i] >= 0) {
        const releaseS = Math.min(this.sStart(e, dir) + this.len[i] * 0.4, this.sEnd(e, dir) - 0.5);
        if (this.s[i] >= releaseS) this.releaseJunction(i);
      }
      const path = this.path[i]!;
      const pi = this.pidx[i];
      if (pi >= path.length - 1) {
        const isService = this.pKind[i] === P_SERVICE || this.pKind[i] === P_GARBAGE;
        const isIncScene = this.pKind[i] === P_INCIDENT && this.pAux[i] <= 3;
        const isIncTransport = this.pKind[i] === P_INCIDENT && this.pAux[i] >= 4;
        const arrived = isIncScene
          ? (this.s[i] >= this.destS[i] - 3.0 && this.isClearOfLaneNeighbors(i, 0.5))
            || (this.s[i] >= this.destS[i] - 34 && (this.v[i] < 0.8 || this.stuck[i] > 2.5) && this.isClearOfLaneNeighbors(i, 0.5))
            || (this.s[i] >= this.destS[i] - 1.5 && this.stuck[i] > 6)
          : isIncTransport || isService
            ? this.s[i] >= this.destS[i] - 2.0
            : this.s[i] >= this.destS[i] - 0.5 || (this.stuck[i] > 8 && this.destS[i] - this.s[i] < 30);
        if (arrived) {
          this.arrivals++;
          this.onArrive(i);
          // Responders arriving at an incident scene may stay visibly parked via incidentId[i] >= 0
          if (this.active[i] && this.incidentId[i] < 0) this.despawn(i);
        } else if (this.stuck[i] > Traffic.STUCK_LIMIT && !this.legitWait[i]) {
          this.despawnForStuck(i, e, dir, nodesSignal);
        }
        continue;
      }
      const sEnd = this.sEnd(e, dir);
      const vlen = this.len[i];
      const sEntry = Math.max(this.sStart(e, dir) + 0.5, sEnd - vlen * 0.5);
      // Never pull s[i] backwards below start-of-tick sPre[i] (fixes splitEdge reverse-teleport overlap)
      const holdS = Math.max(this.sPre[i], sEntry - 0.06);
      if (this.s[i] >= sEntry - 0.05) {
        const nde = path[pi + 1];
        const ne = R.edges[nde >> 1];
        if (!ne || !ne.alive) { this.despawnForStuck(i, e, dir, nodesSignal); continue; }
        const node = R.nodes[dir === 0 ? e.b : e.a];
        const emergency = (this.flags[i] & VEH_FLAG_SIREN) !== 0;
        // Dynamic detour if the next edge has an active full closure (and we are not a responder for it)
        const nextBlks = this.blockages.get(nde);
        if (nextBlks && nextBlks.length) {
          const closed = nextBlks.find((b) => b.fullClosure && !(this.pKind[i] === P_INCIDENT && this.pId[i] === b.incidentId));
          if (closed) {
            if (pi + 1 < path.length - 1) {
              const lastDe = path[path.length - 1];
              const lastE = R.edges[lastDe >> 1];
              if (lastE?.alive) {
                const lastTail = (lastDe & 1) === 0 ? lastE.a : lastE.b;
                const detour = R.route(node.id, lastTail);
                if (detour && detour.length && detour[0] !== nde) {
                  this.path[i] = [...path.slice(0, pi + 1), ...detour, lastDe];
                  this.s[i] = Math.min(this.s[i], holdS);
                  continue;
                }
              }
            }
            this.s[i] = Math.min(this.s[i], holdS);
            this.v[i] = 0;
            this.legitWait[i] = 1;
            continue;
          }
        }
        // Hold non-emergency cross traffic while a siren vehicle is approaching this junction
        if (!emergency && this.sirenPreemptsCross(node, e, sirenNodes)) {
          this.s[i] = Math.min(this.s[i], holdS);
          this.v[i] = 0;
          this.legitWait[i] = 1;
          continue;
        }
        let nl = this.chooseLane(e, dir, ne, nde & 1, i);
        // keep signal & conflict checks unified at the stop line sEntry (front bumper never overhangs crosswalk)
        if (!emergency && !nodesSignal(node, e, dir, Math.max(0, sEntry - this.s[i]), this.stuck[i])) {
          this.s[i] = Math.min(this.s[i], holdS);
          this.v[i] = 0;
          const isRedSig = node.control === 2 || node.control === 4;
          if (!isRedSig && !this.legitWait[i] && this.stuck[i] > Traffic.STUCK_LIMIT) {
            this.despawnForStuck(i, e, dir, nodesSignal);
          }
          continue;
        }
        // block transition if a conflicting vehicle is actively inside the junction box
        if (node.edges.length >= 3 && this.junctionConflict(node, e, dir, ne, nde & 1, nl, i)) {
          this.s[i] = Math.min(this.s[i], holdS);
          this.v[i] = 0;
          if (!this.legitWait[i] && this.stuck[i] > Traffic.STUCK_LIMIT) { this.despawnForStuck(i, e, dir, nodesSignal); }
          continue;
        }
        // the exit lane must have physical room (or safe moving same-stream convoy room) before committing
        const overshoot = Math.max(0, this.s[i] - sEntry);
        const allowed = this.allowedLanes(ne, this.type[i], this.flags[i]);
        let jEst = this.estimateJlen(e, dir, this.lane[i], ne, nde & 1, nl, sEntry);
        let rm = this.exitLaneRoom(ne, nde & 1, nl, vlen, e.id, i, jEst, overshoot);
        if (!rm.ok) {
          let alt = -1;
          for (const l of allowed) {
            if (l === nl) continue;
            const altJ = this.estimateJlen(e, dir, this.lane[i], ne, nde & 1, l, sEntry);
            const altRm = this.exitLaneRoom(ne, nde & 1, l, vlen, e.id, i, altJ, overshoot);
            if (altRm.ok) { alt = l; jEst = altJ; rm = altRm; break; }
          }
          if (alt < 0) {
            this.s[i] = Math.min(this.s[i], holdS);
            this.v[i] = 0;
            if (!this.legitWait[i] && this.stuck[i] > Traffic.STUCK_LIMIT) { this.despawnForStuck(i, e, dir, nodesSignal); }
            continue;
          }
          nl = alt;
        }
        this.setJunction(i, e, dir, this.lane[i], ne, nde & 1, nl, node, sEntry);
        this.edge[i] = ne.id; this.dir[i] = nde & 1; this.lane[i] = nl;
        // Clamp initial s on exit lane so fast-moving overshoot never eats into leader bumper clearance
        this.s[i] = Math.min(this.sStart(ne, nde & 1) - this.jlen[i] + overshoot, rm.maxEntryS);
        this.pidx[i] = pi + 1;
        this.lastStopKey[i] = -1;
        this.jnode[i] = node.id;
        node.jSlots.push(i);
        node.inJunction = node.jSlots.length;
        ne.count[nde & 1]++;
        this.occupy(i);
        if (this.origin[i] >= 0) R.logOD(ne, this.origin[i], this.dest[i]);
      } else if (!this.legitWait[i] && this.stuck[i] > Traffic.STUCK_LIMIT) {
        if (this.isHeldByRedSignal(i, e, dir, nodesSignal)) continue;
        this.despawnForStuck(i, e, dir, nodesSignal);
      }
    }
  }

  /** an edge was split in two (a→n = e1, n→b = e2): vehicles and paths move onto the halves, nobody vanishes */
  splitEdge(old: REdge, e1: REdge, e2: REdge, t: number) {
    const cut0 = t * old.len, cut1 = (1 - t) * old.len;
    for (let i = 0; i < this.max; i++) {
      if (!this.active[i]) continue;
      const p = this.path[i];
      if (!p) continue;
      for (let k = p.length - 1; k >= 0; k--) {
        if (p[k] >> 1 !== old.id) continue;
        const d = p[k] & 1;
        const pair = d === 0 ? [e1.id * 2, e2.id * 2] : [e2.id * 2 + 1, e1.id * 2 + 1];
        p.splice(k, 1, pair[0], pair[1]);
        if (k < this.pidx[i]) this.pidx[i]++;
        else if (k === this.pidx[i] && this.edge[i] === old.id) {
          const cut = d === 0 ? cut0 : cut1;
          if (this.s[i] < cut) this.edge[i] = pair[0] >> 1;
          else { this.edge[i] = pair[1] >> 1; this.s[i] -= cut; this.pidx[i]++; }
          this.lastStopKey[i] = -1;
          this.occupy(i);
        }
        if (k === p.length - 2 && this.pidx[i] <= k + 1) {
          // destination offset was measured on the old edge
          const cut = d === 0 ? cut0 : cut1;
          if (this.destS[i] >= cut) this.destS[i] -= cut;
          else p.pop(); // the door is on the first half: the trip ends there
        }
      }
      if (this.edge[i] === old.id) { this.edge[i] = (this.dir[i] === 0 ? e1 : e2).id; this.lastStopKey[i] = -1; this.occupy(i); }
    }
  }

  /** an edge had its ends swapped: re-express everything on it in the new orientation */
  reverseEdge(eid: number) {
    for (let i = 0; i < this.max; i++) {
      if (!this.active[i]) continue;
      if (this.edge[i] === eid) { this.dir[i] ^= 1; this.occupy(i); }
      const p = this.path[i];
      if (p) for (let k = 0; k < p.length; k++) if (p[k] >> 1 === eid) p[k] ^= 1;
    }
  }

  /** re-plan the remaining route of every vehicle whose path became illegal; returns [replanned, dropped] */
  revalidate(): [number, number] {
    const R = this.R;
    let rp = 0, dropped = 0;
    for (let i = 0; i < this.max; i++) {
      if (!this.active[i]) continue;
      const p = this.path[i]!;
      const pi = this.pidx[i];
      if (R.validPath(p, pi + 1) && (pi + 1 >= p.length || this.joins(p[pi], p[pi + 1]))) continue;
      // keep the current edge (the vehicle is physically on it) and the final edge (where the door is)
      const cur = p[pi], last = p[p.length - 1];
      const head = this.headOf(cur);
      let np: number[] | null = null;
      if (pi === p.length - 1) np = [cur];
      else if (R.legal(last)) {
        const lastTail = (last & 1) === 0 ? R.edges[last >> 1].a : R.edges[last >> 1].b;
        const mid = head === lastTail ? [] : R.route(head, lastTail);
        if (mid) np = [cur, ...mid, last];
      }
      if (np && R.validPath(np, 1)) { this.path[i] = np; this.pidx[i] = 0; rp++; }
      else { this.onStuck(i); this.despawn(i); dropped++; }
    }
    return [rp, dropped];
  }
  private headOf(de: number) { const e = this.R.edges[de >> 1]; return (de & 1) === 0 ? e.b : e.a; }
  private joins(a: number, b: number) { const e = this.R.edges[b >> 1]; return this.headOf(a) === ((b & 1) === 0 ? e.a : e.b); }

  chooseLane(_e: REdge, dir: number, ne: REdge, ndir: number, slot: number): number {
    const t = this.type[slot];
    const allowed = this.allowedLanes(ne, t, this.flags[slot]);
    if (allowed.length <= 1) return allowed[0] ?? 0;
    // Filter out lanes blocked by an active partial incident on (ne, ndir)
    const blks = this.blockages.get(ne.id * 2 + ndir);
    let pool = allowed;
    if (blks && blks.length) {
      const open = allowed.filter((l) => !blks.some((b) => !b.fullClosure && b.lane === l && !(this.pKind[slot] === P_INCIDENT && this.pId[slot] === b.incidentId)));
      if (open.length) pool = open;
    }
    const bus = t === VType.Bus || t === VType.TourBus || t === VType.SchoolBus;
    const maxLane = pool[pool.length - 1];
    // turn direction at the next-next junction
    const path = this.path[slot]!;
    const pi = this.pidx[slot] + 1;
    const after = path[pi + 1];
    if (after !== undefined) {
      const ae = this.R.edges[after >> 1];
      if (ae) {
        const [hx, hz] = this.dirVec(ne, ndir), [nx, nz] = this.dirVec(ae, after & 1);
        const cross = hx * nz - hz * nx;
        void dir;
        if (cross < -0.35) return pool[0]; // left turn (buses included on >= 2 lanes)
        if (cross > 0.35) return maxLane; // right turn
      }
    }
    if (bus) return maxLane; // buses stay in the rightmost curb/bus lane for stops
    if (after === undefined) return maxLane;
    // straight: least occupied open allowed lane
    let best = pool[0], bc = Infinity;
    for (const l of pool) { const c = this.laneArr[this.key(ne.id, ndir, l)]?.length ?? 0; if (c < bc) { bc = c; best = l; } }
    return best;
  }

  dirVec(e: REdge, dir: number): [number, number] {
    const a = this.R.nodes[e.a], b = this.R.nodes[e.b];
    const dx = (b.x - a.x) / e.len, dz = (b.z - a.z) / e.len;
    return dir === 0 ? [dx, dz] : [-dx, -dz];
  }

  /** world point on a directed edge lane at distance s */
  point(e: REdge, dir: number, lane: number, s: number, lat = 0): [number, number, number, number] {
    const p = e.pts;
    const n = p.length / 3;
    let t = s / e.len;
    if (dir === 1) t = 1 - t;
    t = Math.min(1, Math.max(0, t));
    const f = t * (n - 1);
    const k = Math.min(n - 2, Math.floor(f));
    const u = f - k;
    const x0 = p[k * 3], y0 = p[k * 3 + 1], z0 = p[k * 3 + 2], x1 = p[k * 3 + 3], y1 = p[k * 3 + 4], z1 = p[k * 3 + 5];
    let tx = x1 - x0, tz = z1 - z0;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    if (dir === 1) { tx = -tx; tz = -tz; }
    const off = laneOffset(e, lane) + lat;
    return [x0 + (x1 - x0) * u - tz * off, y0 + (y1 - y0) * u, z0 + (z1 - z0) * u + tx * off, Math.atan2(tz, tx)];
  }

  private setJunction(i: number, e: REdge, dir: number, lane: number, ne: REdge, ndir: number, nl: number, node: RNode, fromS = this.sEnd(e, dir)) {
    const p0 = this.point(e, dir, lane, fromS);
    const p2 = this.point(ne, ndir, nl, this.sStart(ne, ndir));
    const [hx, hz] = this.dirVec(e, dir), [nx, nz] = this.dirVec(ne, ndir);
    // intersection of the incoming and outgoing tangents
    const den = hx * nz - hz * nx;
    let cx = (p0[0] + p2[0]) / 2, cz = (p0[2] + p2[2]) / 2;
    if (Math.abs(den) > 0.15) {
      const t = ((p2[0] - p0[0]) * nz - (p2[2] - p0[2]) * nx) / den;
      if (t > 0 && t < 40) { cx = p0[0] + hx * t; cz = p0[2] + hz * t; }
    }
    const b = this.jp;
    b[i * 6] = p0[0]; b[i * 6 + 1] = p0[2]; b[i * 6 + 2] = cx; b[i * 6 + 3] = cz; b[i * 6 + 4] = p2[0]; b[i * 6 + 5] = p2[2];
    const l1 = Math.hypot(cx - p0[0], cz - p0[2]), l2 = Math.hypot(p2[0] - cx, p2[2] - cz), l3 = Math.hypot(p2[0] - p0[0], p2[2] - p0[2]);
    this.jlen[i] = Math.max(0.5, (l1 + l2 + l3) / 2);
    void node;
  }

  /** compute world positions for snapshot / follow (s[i] is vehicle center) */
  computePose(i: number) {
    const e = this.R.edges[this.edge[i]];
    if (!e) return;
    const dir = this.dir[i];
    const ss = this.sStart(e, dir);
    if (this.s[i] < ss && this.jlen[i] > 0) {
      const u = Math.min(1, Math.max(0, 1 - (ss - this.s[i]) / this.jlen[i]));
      const b = this.jp, o = i * 6;
      const a1 = 1 - u;
      const x = a1 * a1 * b[o] + 2 * a1 * u * b[o + 2] + u * u * b[o + 4];
      const z = a1 * a1 * b[o + 1] + 2 * a1 * u * b[o + 3] + u * u * b[o + 5];
      const dx = 2 * a1 * (b[o + 2] - b[o]) + 2 * u * (b[o + 4] - b[o + 2]);
      const dz = 2 * a1 * (b[o + 3] - b[o + 1]) + 2 * u * (b[o + 5] - b[o + 3]);
      const node = this.R.nodes[this.jnode[i] >= 0 ? this.jnode[i] : dir === 0 ? e.a : e.b];
      this.x[i] = x; this.z[i] = z; this.y[i] = node.y + 0.05;
      this.h[i] = Math.atan2(dz, dx);
      return;
    }
    const p = this.point(e, dir, this.lane[i], this.s[i], this.lat[i]);
    this.x[i] = p[0]; this.y[i] = p[1]; this.z[i] = p[2]; this.h[i] = p[3];
  }

  fillSnapshot(out: Float32Array): number {
    let n = 0;
    for (let i = 0; i < this.max; i++) {
      const o = i * VEH_STRIDE;
      if (!this.active[i]) { out[o + 4] = 0; continue; }
      this.computePose(i);
      out[o] = this.x[i]; out[o + 1] = this.y[i]; out[o + 2] = this.z[i]; out[o + 3] = this.h[i];
      out[o + 4] = this.type[i]; out[o + 5] = this.gen[i];
      let f = this.flags[i];
      if (this.pKind[i] === P_BUS && this.pAux[i] > 30) f |= VEH_FLAG_FULL;
      out[o + 6] = f;
      out[o + 7] = this.pKind[i] === P_BUS || this.pKind[i] === P_TOURBUS
        ? this.pId[i]
        : this.type[i] === VType.Car && this.variant[i] >= 0
          ? this.variant[i]
          : -1;
      out[o + 8] = this.pKind[i] === P_CITIZEN ? this.pId[i] : -1;
      n++;
    }
    return n;
  }

  inspect(slot: number) {
    if (!this.active[slot]) return null;
    const e = this.R.edges[this.edge[slot]];
    const limit = e ? this.R.speedLimit(e) : 0;
    return {
      slot,
      type: this.type[slot],
      speed: this.v[slot],
      limit,
      cap: MODE_CAP[this.type[slot]] ?? null,
      edge: e?.name ?? '—',
      edgeId: e?.id ?? -1,
      kind: this.pKind[slot],
      id: this.pId[slot],
      aux: this.pAux[slot],
      siren: (this.flags[slot] & VEH_FLAG_SIREN) !== 0,
      hazard: (this.flags[slot] & VEH_FLAG_HAZARD) !== 0,
      incidentId: this.incidentId[slot],
    };
  }

  static hourSeconds = HOUR_SECONDS;
}
