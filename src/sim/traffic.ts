import { EMERGENCY_CAP, EMERGENCY_EXCESS, MODE_CAP, LANE_WIDTH, MAX_VEHICLES, RoadClass, VEH_FLAG_BRAKE, VEH_FLAG_SIREN, VEH_FLAG_YIELD, VEH_FLAG_FULL, VEH_STRIDE, VType, VTYPE_LEN, HOUR_SECONDS } from '../shared/constants';
import { vehicleSound, type RNode, type REdge, type RoadNetwork } from './roads';

export interface Payload { kind: number; id: number; aux: number }
export const P_CITIZEN = 1, P_SERVICE = 2, P_BUS = 3, P_CARGO = 4, P_CONSTRUCTION = 5, P_TOURBUS = 6, P_FUNERAL = 7, P_GARBAGE = 8, P_MOVING = 9, P_PATROL = 10, P_TAXI = 11;

const IDM_A = 1.6, IDM_B = 2.8, IDM_S0 = 2.2, IDM_T = 1.25;
const IDM_INV2SQRT = 1 / (2 * Math.sqrt(IDM_A * IDM_B));

export function laneOffset(e: REdge, lane: number): number {
  if (e.oneway) return (lane + 0.5) * LANE_WIDTH - (e.lanes * LANE_WIDTH) / 2;
  const med = e.cls >= RoadClass.Avenue ? 0.8 : 0.08;
  return med + (lane + 0.5) * LANE_WIDTH + (e.lat ?? 0);
}

/** Vehicles on the road graph, car-following by the Intelligent Driver Model. */
export class Traffic {
  max = 0;
  active = new Uint8Array(0);
  gen = new Uint16Array(0);
  type = new Uint8Array(0);
  edge = new Int32Array(0);
  dir = new Uint8Array(0);
  lane = new Uint8Array(0);
  s = new Float32Array(0);
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
  path: (number[] | null)[] = [];
  private free: number[] = [];
  count = 0;
  virtualTrips = 0;
  onArrive: (slot: number) => void = () => {};
  onStuck: (slot: number) => void = () => {};
  onStop: (slot: number, node: number) => boolean = () => false; // buses: return true to dwell
  private laneArr: number[][] = [];
  private usedKeys: number[] = [];
  rain = 0;
  /** level crossings closed: edge id -> position t along edge */
  closedCrossings = new Map<number, number[]>();
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

  spawn(type: VType, path: number[], startS: number, destS: number, payload: Payload, origin = -1, dest = -1, flags = 0): number {
    if (!path.length) return -1;
    if (!this.free.length) this.grow(this.max * 2);
    const de = path[0];
    const e = this.R.edges[de >> 1];
    if (!e || !e.alive) return -1;
    const lanes = e.lanes;
    const vlen = VTYPE_LEN[type] ?? 4.5;
    const pref = type === VType.Bus || type === VType.TourBus || type === VType.SchoolBus ? lanes - 1 : Math.max(0, lanes - 1 - (e.busLane && lanes > 1 ? 1 : 0));
    const s0 = Math.max(this.sStart(e, de & 1), Math.min(startS, this.sEnd(e, de & 1) - 1));
    // reserve real road space: a vehicle never materialises on top of another one
    const place = this.findRoom(e, de & 1, pref, s0, vlen);
    if (!place) { this.spawnRefused++; return -1; }
    const slot = this.free.pop()!;
    this.active[slot] = 1;
    this.gen[slot] = (this.gen[slot] + 1) & 0xffff;
    this.type[slot] = type;
    this.edge[slot] = e.id;
    this.dir[slot] = de & 1;
    this.lane[slot] = place[0];
    this.s[slot] = place[1];
    this.v[slot] = 0;
    // compliance with the posted limit: drivers choose 88–100 % of it (nobody exceeds it except sirens, see step())
    const vf = 0.88 + ((slot * 2654435761 + this.gen[slot] * 97) >>> 0) % 1000 / 1000 * 0.12;
    this.v0f[slot] = vf;
    this.len[slot] = VTYPE_LEN[type] ?? 4.5;
    this.lat[slot] = 0;
    this.stuck[slot] = 0;
    this.flags[slot] = flags;
    this.path[slot] = path.slice(); // own copy: topology patches (splits, reversals) edit it in place
    this.pidx[slot] = 0;
    this.destS[slot] = destS;
    this.jnode[slot] = -1;
    this.jlen[slot] = 0;
    this.pKind[slot] = payload.kind; this.pId[slot] = payload.id; this.pAux[slot] = payload.aux;
    this.origin[slot] = origin; this.dest[slot] = dest;
    this.dwell[slot] = 0;
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

  /** does [s-len, s] on this lane overlap another vehicle (with the entry gap)? */
  laneFree(e: REdge, dir: number, lane: number, s: number, len: number, self = -1): boolean {
    const G = Traffic.ENTRY_GAP;
    for (const o of this.occupants(e, dir, lane)) {
      if (o === self || !this.active[o] || this.edge[o] !== e.id || this.dir[o] !== dir || this.lane[o] !== lane) continue;
      const so = this.s[o];
      if (s + G > so - this.len[o] && s - len - G < so) return false;
    }
    return true;
  }

  /** a free lane position at or near s0 (moving back towards the entrance, then forward), or null */
  findRoom(e: REdge, dir: number, pref: number, s0: number, len: number): [number, number] | null {
    const lanes: number[] = [pref];
    for (let l = 0; l < e.lanes; l++) if (l !== pref) lanes.push(l);
    const lo = this.sStart(e, dir) + len, hi = this.sEnd(e, dir) - 1;
    const offs = [0, -6, 6, -12, 12, -20, 20];
    for (const d of offs) for (const l of lanes) {
      const s = s0 + d;
      if (d !== 0 && (s < lo || s > hi)) continue;
      if (this.laneFree(e, dir, l, s, len)) return [l, s];
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

  despawn(slot: number) {
    if (!this.active[slot]) return;
    const j = this.jnode[slot];
    if (j >= 0) this.R.nodes[j].inJunction = Math.max(0, this.R.nodes[j].inJunction - 1);
    this.active[slot] = 0;
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

  step(dt: number, nodesSignal: (n: RNode, inEdge: REdge, dir: number, distToStop: number, waited: number) => boolean) {
    const R = this.R;
    // 1. lane lists
    const LA = this.laneArr, used = this.usedKeys;
    for (const k of used) LA[k].length = 0;
    used.length = 0;
    for (let i = 0; i < this.max; i++) {
      if (!this.active[i]) continue;
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
    // emergency presence per edge-dir for yielding
    const sirens = new Map<number, number>();
    for (let i = 0; i < this.max; i++) if (this.active[i] && this.flags[i] & VEH_FLAG_SIREN) {
      const k = this.edge[i] * 2 + this.dir[i];
      sirens.set(k, Math.max(sirens.get(k) ?? -1e9, this.s[i]));
    }
    // 2. IDM
    const rainF = 1 - 0.25 * this.rain;
    for (const k of used) {
      const arr = LA[k];
      if (!arr.length) continue;
      const eid = (k >> 2) >> 1, dir = (k >> 2) & 1;
      const e = R.edges[eid];
      if (!e || !e.alive) { for (const i of arr) this.despawn(i); continue; }
      const sEnd = this.sEnd(e, dir);
      const vmax = R.speedLimit(e) * rainF;
      const sirenS = sirens.get(eid * 2 + dir);
      const crossing = this.closedCrossings.get(eid);
      for (let idx = 0; idx < arr.length; idx++) {
        const i = arr[idx];
        if (!this.active[i]) continue;
        const emergency = (this.flags[i] & VEH_FLAG_SIREN) !== 0;
        // yield to sirens approaching from behind
        let yieldNow = false;
        if (!emergency && sirenS !== undefined && sirenS < this.s[i] && this.s[i] - sirenS < 60) yieldNow = true;
        if (yieldNow) this.flags[i] |= VEH_FLAG_YIELD; else this.flags[i] &= ~VEH_FLAG_YIELD;
        // dwell (bus stops, deliveries)
        if (this.dwell[i] > 0) { this.dwell[i] -= dt; this.v[i] = 0; continue; }
        const ty0 = this.type[i];
        const cap = MODE_CAP[ty0] ?? Infinity;
        // desired speed = posted limit × compliance, capped per mode; sirens get a declared, bounded exception
        const v0 = emergency ? Math.min(EMERGENCY_CAP, vmax + EMERGENCY_EXCESS) : Math.min(vmax * this.v0f[i], cap * rainF) * (yieldNow ? 0.3 : 1);
        let gap = 1e9, vl = 0;
        // leader in lane
        for (let j = idx + 1; j < arr.length; j++) {
          const o = arr[j];
          // overtake only a vehicle that has actually pulled over to the curb
          if (emergency && this.flags[o] & VEH_FLAG_YIELD && this.lat[o] > 1.0) continue;
          gap = this.s[o] - this.s[i] - this.len[o];
          vl = this.v[o];
          break;
        }
        const path = this.path[i]!;
        const pi = this.pidx[i];
        const last = pi >= path.length - 1;
        const distEnd = sEnd - this.s[i];
        if (gap > distEnd) {
          if (last) {
            const dg = this.destS[i] - this.s[i] + 3;
            if (dg < gap) { gap = dg; vl = 0; }
          } else {
            const nde = path[pi + 1];
            const ne = R.edges[nde >> 1];
            const node = R.nodes[dir === 0 ? e.b : e.a];
            let ok = !!ne && ne.alive && ne.progress >= 1;
            if (ok && !emergency) ok = nodesSignal(node, e, dir, distEnd, this.stuck[i]);
            if (ok) {
              // room on next lane? (don't block the box)
              const nl = this.chooseLane(e, dir, ne, nde & 1, i);
              const narr = this.laneArr[this.key(ne.id, nde & 1, nl)];
              if (narr && narr.length) {
                const o = narr[0];
                const room = this.s[o] - this.sStart(ne, nde & 1) - this.len[o];
                // gridlock relief may squeeze in, but never into space that is physically occupied
                if (room < 3 && (this.stuck[i] < 25 || room < this.len[i] * 0.25 + 0.5)) ok = false;
                else { const g2 = distEnd + room + 6; if (g2 < gap) { gap = g2; vl = this.v[o]; } }
              }
            }
            if (!ok) { const g2 = distEnd - 1; if (g2 < gap) { gap = g2; vl = 0; } node.waitAcc += dt; }
          }
        }
        // closed level crossing: a physical barrier, sirens included (they get no preemption from a train)
        if (crossing) {
          for (const ct of crossing) {
            const cs = dir === 0 ? ct * e.len : (1 - ct) * e.len;
            const g2 = cs - 7 - this.s[i];
            if (g2 > -2 && g2 < gap) { gap = Math.max(0.1, g2); vl = 0; }
            if (g2 > -2 && g2 < 140 && this.v[i] < 1.5) this.crossWait.set(eid, (this.crossWait.get(eid) ?? 0) + dt);
          }
        }
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
        if (ds > gap - 0.5 && gap < 1e8) ds = Math.max(0, gap - 0.5);
        this.v[i] = nv;
        this.s[i] += ds;
        if (a < -1.2) this.flags[i] |= VEH_FLAG_BRAKE; else this.flags[i] &= ~VEH_FLAG_BRAKE;
        if (nv < 0.5) { e.stopped[dir]++; this.stuck[i] += dt; } else this.stuck[i] = Math.max(0, this.stuck[i] - dt * 2);
        // acoustics: what this vehicle adds to the street's noise right now
        const snd = e.snd ?? (e.snd = new Float32Array(5));
        const ty = this.type[i];
        const sc = ty === VType.Moto ? 1 : ty === VType.Car || ty === VType.Taxi || ty === VType.Ambulance || ty === VType.Police || ty === VType.Van || ty === VType.Hearse ? 0 : 2;
        snd[sc] += vehicleSound(sc, nv, a, e.cls === RoadClass.Dirt);
        snd[3] += nv; snd[4]++;
        // lateral offset (yield to the curb)
        const latT = yieldNow ? 1.4 : 0;
        this.lat[i] += (latT - this.lat[i]) * Math.min(1, dt * 1.5);
      }
    }
    // 3. transitions
    for (let i = 0; i < this.max; i++) {
      if (!this.active[i]) continue;
      const e = R.edges[this.edge[i]];
      const dir = this.dir[i];
      if (!e?.alive) { this.onStuck(i); this.despawn(i); continue; }
      // left the junction?
      if (this.jnode[i] >= 0 && this.s[i] >= this.sStart(e, dir)) {
        R.nodes[this.jnode[i]].inJunction = Math.max(0, R.nodes[this.jnode[i]].inJunction - 1);
        this.jnode[i] = -1;
      }
      const path = this.path[i]!;
      const pi = this.pidx[i];
      if (pi >= path.length - 1) {
        if (this.s[i] >= this.destS[i] - 0.5 || (this.stuck[i] > 8 && this.destS[i] - this.s[i] < 30)) { this.onArrive(i); this.despawn(i); }
        else if (this.stuck[i] > 50) { this.onStuck(i); this.despawn(i); }
        continue;
      }
      const sEnd = this.sEnd(e, dir);
      if (this.s[i] >= sEnd - 0.05) {
        const nde = path[pi + 1];
        const ne = R.edges[nde >> 1];
        if (!ne || !ne.alive) { this.onStuck(i); this.despawn(i); continue; }
        const node = R.nodes[dir === 0 ? e.b : e.a];
        if (this.pKind[i] === P_BUS && this.onStop(i, node.id)) { this.dwell[i] = 14; }
        let nl = this.chooseLane(e, dir, ne, nde & 1, i);
        // the exit lane must have physical room for the whole vehicle before it commits to the junction
        const entryS = this.sStart(ne, nde & 1) + 0.5;
        if (!this.laneFree(ne, nde & 1, nl, entryS, 0)) {
          let alt = -1;
          for (let l = 0; l < ne.lanes; l++) if (l !== nl && this.laneFree(ne, nde & 1, l, entryS, 0)) { alt = l; break; }
          if (alt < 0) { this.s[i] = sEnd - 0.06; this.v[i] = 0; if (this.stuck[i] > 50) { this.onStuck(i); this.despawn(i); } continue; }
          nl = alt;
        }
        this.setJunction(i, e, dir, this.lane[i], ne, nde & 1, nl, node);
        this.edge[i] = ne.id; this.dir[i] = nde & 1; this.lane[i] = nl;
        this.s[i] = this.sStart(ne, nde & 1) - this.jlen[i] + Math.max(0, this.s[i] - sEnd);
        this.pidx[i] = pi + 1;
        this.jnode[i] = node.id;
        node.inJunction++;
        ne.count[nde & 1]++;
        this.occupy(i);
        if (this.origin[i] >= 0) R.logOD(ne, this.origin[i], this.dest[i]);
      } else if (this.stuck[i] > 50) { this.onStuck(i); this.despawn(i); }
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
        }
        if (k === p.length - 2 && this.pidx[i] <= k + 1) {
          // destination offset was measured on the old edge
          const cut = d === 0 ? cut0 : cut1;
          if (this.destS[i] >= cut) this.destS[i] -= cut;
          else p.pop(); // the door is on the first half: the trip ends there
        }
      }
      if (this.edge[i] === old.id) { this.edge[i] = (this.dir[i] === 0 ? e1 : e2).id; }
    }
  }

  /** an edge had its ends swapped: re-express everything on it in the new orientation */
  reverseEdge(eid: number) {
    for (let i = 0; i < this.max; i++) {
      if (!this.active[i]) continue;
      if (this.edge[i] === eid) this.dir[i] ^= 1;
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
    const L = ne.lanes;
    if (L <= 1) return 0;
    const bus = t === VType.Bus || t === VType.TourBus || t === VType.SchoolBus;
    if (bus && ne.busLane) return L - 1;
    // turn direction at the next-next junction
    const path = this.path[slot]!;
    const pi = this.pidx[slot] + 1;
    const after = path[pi + 1];
    const maxLane = ne.busLane && !bus ? L - 2 : L - 1;
    if (after === undefined) return maxLane;
    const ae = this.R.edges[after >> 1];
    const [hx, hz] = this.dirVec(ne, ndir), [nx, nz] = this.dirVec(ae, after & 1);
    const cross = hx * nz - hz * nx;
    void dir;
    if (cross > 0.35) return maxLane; // right turn
    if (cross < -0.35) return 0; // left turn
    // straight: least occupied lane
    let best = 0, bc = Infinity;
    for (let l = 0; l <= maxLane; l++) { const c = this.laneArr[this.key(ne.id, ndir, l)]?.length ?? 0; if (c < bc) { bc = c; best = l; } }
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

  private setJunction(i: number, e: REdge, dir: number, lane: number, ne: REdge, ndir: number, nl: number, node: RNode) {
    const p0 = this.point(e, dir, lane, this.sEnd(e, dir));
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

  /** compute world positions for snapshot / follow */
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
      out[o + 6] = f; out[o + 7] = this.pKind[i] === P_BUS || this.pKind[i] === P_TOURBUS ? this.pId[i] : -1;
      out[o + 8] = this.pKind[i] === P_CITIZEN ? this.pId[i] : -1;
      n++;
    }
    return n;
  }

  inspect(slot: number) {
    if (!this.active[slot]) return null;
    const e = this.R.edges[this.edge[slot]];
    const limit = e ? this.R.speedLimit(e) : 0;
    return { type: this.type[slot], speed: this.v[slot], limit, cap: MODE_CAP[this.type[slot]] ?? null, edge: e?.name, kind: this.pKind[slot], id: this.pId[slot], siren: (this.flags[slot] & VEH_FLAG_SIREN) !== 0 };
  }

  static hourSeconds = HOUR_SECONDS;
}
