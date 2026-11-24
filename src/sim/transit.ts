import { HOUR_SECONDS, PED_FLAG_WAITING, RoadClass, VType } from '../shared/constants';
import { CURB_WAIT_OFFSET, edgeHalfWidth, QUEUE_OFFSET, sampleEdgePts, SHELTER_OFFSET } from '../shared/roadGeom';
import type { TransitLineView } from '../shared/protocol';
import type { Building } from './buildings';
import { Act, ST_IN, ST_TRANSIT } from './citizens';
import { projSeg, type REdge } from './roads';
import { P_BUS } from './traffic';
import { activePlanEdges, activePlanFromEdge, activePlanFromPoint, activePlanToEdge, activePlanToPoint, doorOf, walkPath } from './trips';
import type { World } from './world';
import { KINDS } from '../shared/catalog';

export const FARE_BUS = 3.5;
export const FARE_BRT = 4.0;
export const FARE_RAIL = 4.5;
export const FARE_METRO = 5.0;
export const CAP_BUS = 55;
export const CAP_BRT = 90;

export function lineFare(kind: 'bus' | 'brt' | 'rail' | 'metro'): number {
  return kind === 'bus' ? FARE_BUS : kind === 'brt' ? FARE_BRT : kind === 'rail' ? FARE_RAIL : FARE_METRO;
}

export interface Stop {
  id: number;
  x: number;
  z: number;
  node: number;
  edge: number; // road edge id for bus/BRT, -1 for rail/metro
  dir: number; // direction on road edge (0: a->b, 1: b->a)
  s: number; // distance along directed edge (bus/BRT) or rail arc length (rail/metro)
  curbX: number;
  curbZ: number;
  ux: number;
  uz: number;
  name: string;
}

export interface Line {
  id: number; kind: 'bus' | 'brt' | 'rail' | 'metro'; color: string; name: string;
  stops: Stop[]; path: number[]; startS: number; destS: number;
  fleet: number; vehicles: Set<number>; ridersToday: number; ridersYday: number;
  /** waiting riders keyed by stable Stop.id (never array index) */
  waiting: Map<number, number[]>; onboard: Map<number, number[]>; edges: Set<number>;
  headway: number; lastSpawn: number; pts: number[];
  pendingBRT?: boolean;
  /** average fleet age (days) & mechanical wear (0..1) for bus/BRT fleet maintenance & renewal */
  fleetAge?: number;
  fleetWear?: number;
  /** pending single-bus replacements scheduled to retire old units on their next garage return */
  pendingRenewals?: number;
}
export interface Ride { line: number; fromId: number; toId: number; gen: number; phase: number; since: number; dest: number }

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e84393', '#fdcb6e', '#00cec9', '#6c5ce7', '#d35400', '#27ae60'];
const ZONE = 300;

/** Self-managing public transport: lines are derived from the observed origin–destination matrix. */
export class Transit {
  lines: Line[] = [];
  private nextId = 1;
  private nextStopId = 1;
  private od = new Map<number, number>();
  rides = new Map<number, Ride>();
  dirty = new Set<number>();
  removed: number[] = [];
  private lastPlan = -5;
  ridersDay = 0;
  faresCollected = 0;
  busMaintCostToday = 0;
  /** intraday accumulator for single-bus renewals carried into daily() for CityHall.daily() accounting */
  private busRenewalCostAcc = 0;
  busRenewals = 0;

  constructor(private w: World) {}

  allocStopId(): number { return this.nextStopId++; }
  private findStopIdx(l: Line, stopId: number): number { return l.stops.findIndex((s) => s.id === stopId); }
  private findStop(l: Line, stopId: number): Stop | undefined { return l.stops.find((s) => s.id === stopId); }

  private zone(x: number, z: number) { return Math.floor(x / ZONE) * 1000 + Math.floor(z / ZONE); }
  private zoneCenter(k: number) { return { x: (Math.floor(k / 1000) + 0.5) * ZONE, z: ((k % 1000) + 0.5) * ZONE }; }

  recordTrip(from: Building, to: Building, len: number) {
    if (len < 700) return;
    const a = this.zone(from.x, from.z), b = this.zone(to.x, to.z);
    if (a === b) return;
    const k = a < b ? a * 1e6 + b : b * 1e6 + a;
    this.od.set(k, (this.od.get(k) ?? 0) + 1);
  }

  // ------------------------------------------------------------ curb stop placement helper
  /** Build a sidewalk curb stop along an eligible urban edge (never on highways, bridges, decks, tunnels, water, or inside junctions). */
  buildEdgeStop(e: REdge, dir: number, preferredS?: number): Stop | null {
    const w = this.w, R = w.roads, T = w.terrain;
    if (!e || !e.alive || e.progress < 1) return null;
    if (e.cls === RoadClass.Highway || e.bridge || e.elevated || e.tunnel || e.deck !== undefined) return null;
    const nStart = dir === 0 ? e.a : e.b;
    const nEnd = dir === 0 ? e.b : e.a;
    const rStart = R.nodeRenderR(nStart);
    const rEnd = R.nodeRenderR(nEnd);
    const idealMin = rStart + 18;
    const idealMax = e.len - (rEnd + 18);
    let s: number;
    if (idealMax >= idealMin) {
      s = preferredS !== undefined ? Math.max(idealMin, Math.min(idealMax, preferredS)) : (idealMin + idealMax) * 0.5;
    } else {
      // shorter urban block: stay strictly outside both junction radii + crosswalk aprons
      const minSafe = rStart + 7;
      const maxSafe = e.len - (rEnd + 7);
      if (maxSafe < minSafe + 2) return null;
      s = preferredS !== undefined ? Math.max(minSafe, Math.min(maxSafe, preferredS)) : (minSafe + maxSafe) * 0.5;
    }
    const p = sampleEdgePts(e.pts, s, dir);
    const cx = p[0], cz = p[2], ux = p[3], uz = p[4];
    const rx = -uz, rz = ux; // right-hand sidewalk of travel direction dir
    const hw = edgeHalfWidth(e);
    const curbX = cx + rx * (hw + CURB_WAIT_OFFSET);
    const curbZ = cz + rz * (hw + CURB_WAIT_OFFSET);
    const shX = cx + rx * (hw + SHELTER_OFFSET);
    const shZ = cz + rz * (hw + SHELTER_OFFSET);
    // never place a stop/shelter in water
    if (T.isWater(curbX, curbZ) || T.isWater(shX, shZ) || T.heightAt(shX, shZ) <= T.seaLevel + 0.5) return null;
    // never let shelter overlap another road's asphalt carriageway
    for (const o of R.edgesNear(shX, shZ, 26)) {
      if (o.id === e.id || !o.alive || o.deck !== undefined) continue;
      const oa = R.nodes[o.a], ob = R.nodes[o.b];
      const pr = projSeg(shX, shZ, oa.x, oa.z, ob.x, ob.z);
      if (pr.d < edgeHalfWidth(o) + 1.0) return null;
    }
    const refNode = s < e.len * 0.5 ? nStart : nEnd;
    return {
      id: this.allocStopId(),
      x: curbX,
      z: curbZ,
      node: refNode,
      edge: e.id,
      dir,
      s,
      curbX,
      curbZ,
      ux,
      uz,
      name: w.districtName(curbX, curbZ),
    };
  }

  /** Place well-spaced curb stops along a bus/BRT path (strictly on eligible urban edges, outside junctions). */
  private placeStopsAlongPath(path: number[], spacing = 310): Stop[] {
    const R = this.w.roads;
    const stops: Stop[] = [];
    const usedEdges = new Set<number>();
    let acc = spacing;
    for (const de of path) {
      const e = R.edges[de >> 1];
      if (!e || !e.alive) continue;
      acc += e.len;
      if (acc < spacing * 0.75 || usedEdges.has(de)) continue;
      const st = this.buildEdgeStop(e, de & 1);
      if (!st) continue;
      if (stops.some((prev) => Math.hypot(prev.x - st.x, prev.z - st.z) < 180)) continue;
      stops.push(st);
      usedEdges.add(de);
      acc = 0;
    }
    // fallback if spacing was too tight for a short loop: relax spacing to collect at least 2 safe curb stops
    if (stops.length < 2) {
      for (const de of path) {
        if (usedEdges.has(de)) continue;
        const e = R.edges[de >> 1];
        if (!e || !e.alive) continue;
        const st = this.buildEdgeStop(e, de & 1);
        if (!st) continue;
        if (stops.some((prev) => Math.hypot(prev.x - st.x, prev.z - st.z) < 90)) continue;
        stops.push(st);
        usedEdges.add(de);
        if (stops.length >= 2) break;
      }
    }
    return stops;
  }

  /** Keep bus stops synchronized when a road edge is split into two halves (e1, e2), never leaving orphan stops. */
  onEdgeSplit(old: REdge, e1: REdge, e2: REdge, t: number) {
    const R = this.w.roads;
    const cut0 = t * old.len, cut1 = (1 - t) * old.len;
    for (const l of this.lines) {
      if (!l.edges.has(old.id)) continue;
      l.path = l.path.flatMap((de) => (de >> 1) !== old.id ? [de] : (de & 1) === 0 ? [e1.id * 2, e2.id * 2] : [e2.id * 2 + 1, e1.id * 2 + 1]);
      l.edges = new Set(l.path.map((d) => d >> 1));
      let changed = false;
      const deadIndices = new Set<number>();
      for (let k = 0; k < l.stops.length; k++) {
        const st = l.stops[k];
        if (st.edge !== old.id) continue;
        const cut = st.dir === 0 ? cut0 : cut1;
        const first = st.dir === 0 ? e1 : e2;
        const second = st.dir === 0 ? e2 : e1;
        const targetEdge = st.s < cut ? first : second;
        const targetS = st.s < cut ? st.s : st.s - cut;
        let rebuilt = this.buildEdgeStop(targetEdge, st.dir, targetS) ?? this.buildEdgeStop(st.s < cut ? second : first, st.dir);
        // If both split halves are too short, relocate onto the nearest eligible urban edge along the line
        if (!rebuilt) {
          const used = new Set(l.stops.filter((_, idx) => idx !== k).map((s) => s.edge * 2 + s.dir));
          let bestDist = Infinity;
          for (const de of l.path) {
            if (used.has(de)) continue;
            const ce = R.edges[de >> 1];
            if (!ce || !ce.alive) continue;
            const cand = this.buildEdgeStop(ce, de & 1);
            if (!cand) continue;
            const d = Math.hypot(cand.x - st.x, cand.z - st.z);
            if (d < bestDist) { bestDist = d; rebuilt = cand; }
          }
        }
        if (rebuilt) {
          // preserve stable Stop.id so queues and rides stay bound to this exact stop
          rebuilt.id = st.id;
          const movedDist = Math.hypot(rebuilt.x - st.x, rebuilt.z - st.z);
          l.stops[k] = rebuilt;
          this.layoutStopQueue(l, k);
          if (movedDist > 2) this.repathWalkingRiders(l, rebuilt);
          changed = true;
        } else {
          deadIndices.add(k);
          changed = true;
        }
      }
      if (deadIndices.size) {
        const survivors = l.stops.filter((_, idx) => !deadIndices.has(idx));
        if (survivors.length >= 2) {
          this.replaceStops(l, survivors);
        } else {
          // Fewer than 2 viable stops remain: evacuate waiting, walking (phase 0/3) and onboard (phase 2) riders cleanly
          this.evacuateLine(l);
          l.stops = survivors;
        }
      }
      if (changed) this.dirty.add(l.id);
    }
  }

  // ------------------------------------------------------------ mode choice API (used by citizens)
  private nearestStop(line: Line, x: number, z: number, maxD: number): number {
    let bi = -1, bd = maxD;
    line.stops.forEach((s, i) => { const d = Math.hypot(s.x - x, s.z - z); if (d < bd) { bd = d; bi = i; } });
    return bi;
  }
  transitOption(from: Building, to: Building, len: number): { mode: number; time: number; fare: number; line: number; a: number; b: number } | null {
    let best: { mode: number; time: number; fare: number; line: number; a: number; b: number } | null = null;
    for (const l of this.lines) {
      if (!l.vehicles.size && (l.kind === 'bus' || l.kind === 'brt')) continue;
      const reach = l.kind === 'bus' || l.kind === 'brt' ? 450 : 750;
      const a = this.nearestStop(l, from.x, from.z, reach), b = this.nearestStop(l, to.x, to.z, reach);
      if (a < 0 || b < 0 || a === b) continue;
      const walk = (Math.hypot(l.stops[a].x - from.x, l.stops[a].z - from.z) + Math.hypot(l.stops[b].x - to.x, l.stops[b].z - to.z)) / 1.3;
      const ride = Math.hypot(l.stops[b].x - l.stops[a].x, l.stops[b].z - l.stops[a].z) * 1.25 / (l.kind === 'bus' ? 7 : l.kind === 'brt' ? 10 : 17);
      const time = walk + l.headway / 2 + ride;
      const fare = lineFare(l.kind);
      const t = { mode: l.kind === 'bus' || l.kind === 'brt' ? 3 : 4, time, fare, line: l.id, a: l.stops[a].id, b: l.stops[b].id };
      if (!best || time < best.time) best = t;
    }
    void len;
    return best;
  }

  private planWalkToStop(from: Building, st: Stop) {
    const R = this.w.roads;
    if (st.edge >= 0) {
      const e = R.edges[st.edge];
      if (e && e.alive && e.progress >= 1) {
        const t = st.dir === 0 ? st.s / Math.max(1, e.len) : 1 - st.s / Math.max(1, e.len);
        const wp = activePlanToEdge(R, from, e, t, st.x, st.z, 2600);
        if (wp) return wp;
      }
    }
    return activePlanToPoint(R, from, st.x, st.z, 2600);
  }

  private planWalkFromStop(st: Stop, to: Building) {
    const R = this.w.roads;
    if (st.edge >= 0) {
      const e = R.edges[st.edge];
      if (e && e.alive && e.progress >= 1) {
        const t = st.dir === 0 ? st.s / Math.max(1, e.len) : 1 - st.s / Math.max(1, e.len);
        const wp = activePlanFromEdge(R, e, t, st.x, st.z, to, 2600);
        if (wp) return wp;
      }
    }
    return activePlanFromPoint(R, st.x, st.z, to, 2600);
  }

  board(i: number, from: Building, to: Building, opt: { line: number; a: number; b: number }): boolean {
    const w = this.w;
    const l = this.lines.find((x) => x.id === opt.line);
    if (!l) return false;
    const st = this.findStop(l, opt.a);
    const stTo = this.findStop(l, opt.b);
    if (!st || !stTo || st.id === stTo.id) return false;
    this.rides.set(i, { line: l.id, fromId: st.id, toId: stTo.id, gen: w.citizens.gen[i], phase: 0, since: w.t, dest: to.id });
    const door = doorOf(w.roads, from);
    if (w.peds.capacityLeft > 40) {
      // Always route via real sidewalks & crosswalks — never spawn a 2-point straight-line cut through buildings
      const wp = this.planWalkToStop(from, st);
      if (wp) {
        const wp3 = walkPath(w.roads, wp, door, st);
        const slot = w.peds.spawn(wp3.pts, i, 1.35, w.citizens.pedIdentityFlags(i), w.citizens.colorOf(i), 0, wp3.ys);
        if (slot >= 0) { w.citizens.slot[i] = slot; w.citizens.state[i] = ST_TRANSIT; return true; }
      }
    }
    // virtual walk to the stop (no crow-flies ghost pedestrian through walls)
    w.citizens.state[i] = ST_TRANSIT;
    w.citizens.slot[i] = -1;
    this.atStop(i);
    return true;
  }

  /** Remove a citizen completely from transit rides, waiting queues, onboard lists, and any waiting/walking ped. */
  cancelCitizen(i: number) {
    const w = this.w;
    this.rides.delete(i);
    const s = w.citizens.slot[i];
    if (s >= 0 && w.peds.active[s] && w.peds.citizen[s] === i) {
      w.peds.despawn(s);
      w.citizens.slot[i] = -1;
    }
    for (const l of this.lines) {
      for (const [stopId, q] of l.waiting) {
        const idx = q.indexOf(i);
        if (idx >= 0) {
          q.splice(idx, 1);
          const k = this.findStopIdx(l, stopId);
          if (k >= 0) this.layoutStopQueue(l, k);
        }
      }
      for (const list of l.onboard.values()) {
        const idx = list.indexOf(i);
        if (idx >= 0) list.splice(idx, 1);
      }
    }
  }

  /** ped arrival callback for transit riders: reached the stop (phase 0) or the destination (phase 3) */
  pedArrived(i: number): boolean {
    const r = this.rides.get(i);
    if (!r) return false;
    if (!this.w.citizens.alive[i] || this.w.citizens.gen[i] !== r.gen || this.w.citizens.state[i] !== ST_TRANSIT) {
      this.rides.delete(i);
      return false;
    }
    if (r.phase === 0) { this.atStop(i); return true; }
    if (r.phase === 3) { this.rides.delete(i); this.w.citizens.arrive(i); return true; }
    return false;
  }

  /** Compute FIFO queue pose [x, z, heading] for index `idx` waiting at stop `st`. */
  private queuePose(st: Stop, idx: number): [number, number, number] {
    const ux = st.ux || 1, uz = st.uz || 0;
    const rx = -uz, rz = ux; // outward toward back of sidewalk
    if (st.edge >= 0) {
      // line up neatly along the front sidewalk (hw + 1.0 m) behind the boarding point, facing the road
      const row = Math.floor(idx / 12);
      const pos = idx % 12;
      const latShift = (QUEUE_OFFSET - CURB_WAIT_OFFSET) + row * 0.5;
      const back = pos * 0.75;
      const px = st.curbX + rx * latShift - ux * back;
      const pz = st.curbZ + rz * latShift - uz * back;
      const heading = Math.atan2(-rz, -rx); // facing the carriageway
      return [px, pz, heading];
    }
    const px = st.x - ux * (idx * 0.75);
    const pz = st.z - uz * (idx * 0.75);
    return [px, pz, Math.atan2(-rz, -rx)];
  }

  /** Re-align all waiting pedestrians in FIFO order at stop index `k` of line `l`. */
  private layoutStopQueue(l: Line, k: number) {
    const w = this.w;
    const st = l.stops[k];
    if (!st) return;
    const q = l.waiting.get(st.id);
    if (!q) return;
    for (let idx = 0; idx < q.length; idx++) {
      const cid = q[idx];
      const slot = w.citizens.slot[cid];
      if (slot >= 0 && w.peds.active[slot] && w.peds.citizen[slot] === cid) {
        const [px, pz, h] = this.queuePose(st, idx);
        w.peds.setHeldPose(slot, px, pz, h);
      }
    }
  }

  /** Plan a sidewalk route from an arbitrary live world point `(fx, fz)` to stop `st` (no backtracking to origin building). */
  private planWalkFromPointToStop(fx: number, fz: number, st: Stop) {
    const R = this.w.roads;
    const pe = R.nearestEdgePoint(fx, fz, 140, (q) => q.alive && q.progress >= 1 && q.deck === undefined);
    if (!pe) return null;
    if (st.edge >= 0) {
      const de = R.edges[st.edge];
      if (de && de.alive && de.progress >= 1 && de.deck === undefined) {
        const dt = st.dir === 0 ? st.s / Math.max(1, de.len) : 1 - st.s / Math.max(1, de.len);
        const wp = activePlanEdges(R, pe.edge, pe.t, de, Math.max(0, Math.min(1, dt)), fx, fz, st.x, st.z, 2600);
        if (wp) return wp;
      }
    }
    const pd = R.nearestEdgePoint(st.x, st.z, 140, (q) => q.alive && q.progress >= 1 && q.deck === undefined);
    if (!pd) return null;
    return activePlanEdges(R, pe.edge, pe.t, pd.edge, pd.t, fx, fz, st.x, st.z, 2600);
  }

  /** Rebuild walk from the pedestrian's current live position `(fx, fz)` or cancel cleanly for phase-0 riders heading to a moved stop. */
  private repathWalkingRiders(l: Line, st: Stop) {
    const w = this.w;
    for (const [cid, r] of [...this.rides.entries()]) {
      if (r.line !== l.id || r.phase !== 0 || r.fromId !== st.id) continue;
      if (!w.citizens.alive[cid] || w.citizens.gen[cid] !== r.gen || w.citizens.state[cid] !== ST_TRANSIT) {
        this.rides.delete(cid);
        continue;
      }
      const oldSlot = w.citizens.slot[cid];
      let hasPos = false;
      let fx = st.x, fz = st.z;
      if (oldSlot >= 0 && w.peds.active[oldSlot] && w.peds.citizen[oldSlot] === cid) {
        w.peds.pose(oldSlot);
        fx = w.peds.x[oldSlot];
        fz = w.peds.z[oldSlot];
        hasPos = true;
        w.peds.despawn(oldSlot);
        w.citizens.slot[cid] = -1;
      }
      let wp = hasPos ? this.planWalkFromPointToStop(fx, fz, st) : null;
      if (!wp && !hasPos) {
        const fromB = w.buildings.byId.get(w.citizens.loc[cid]);
        if (fromB) {
          const d = doorOf(w.roads, fromB);
          fx = d.x; fz = d.z;
          wp = this.planWalkToStop(fromB, st);
        }
      }
      if (wp && w.peds.capacityLeft > 40) {
        const wp3 = walkPath(w.roads, wp, { x: fx, z: fz }, st);
        const ns = w.peds.spawn(wp3.pts, cid, 1.35, w.citizens.pedIdentityFlags(cid), w.citizens.colorOf(cid), 0, wp3.ys);
        if (ns >= 0) { w.citizens.slot[cid] = ns; continue; }
      }
      this.giveUp(cid);
    }
  }

  private atStop(i: number) {
    const w = this.w;
    const r = this.rides.get(i);
    if (!r || !w.citizens.alive[i] || w.citizens.gen[i] !== r.gen || w.citizens.state[i] !== ST_TRANSIT) {
      this.rides.delete(i);
      return;
    }
    const l = this.lines.find((x) => x.id === r.line);
    const st = l ? this.findStop(l, r.fromId) : undefined;
    if (!l || !st) { this.giveUp(i); return; }
    r.phase = 1; r.since = w.t;
    let q = l.waiting.get(st.id);
    if (!q) l.waiting.set(st.id, (q = []));
    const idx = q.length;
    q.push(i);
    // stand in an orderly FIFO queue on the sidewalk beside the shelter, facing the road
    if (w.peds.capacityLeft > 60) {
      const [px, pz, h] = this.queuePose(st, idx);
      const stopY = Math.max(0.2, w.terrain.meshY(px, pz), w.terrain.heightAt(px, pz)) + 0.27;
      const slot = w.peds.spawn([px, pz, px + Math.cos(h) * 0.05, pz + Math.sin(h) * 0.05], i, 0.01, PED_FLAG_WAITING | w.citizens.pedIdentityFlags(i), w.citizens.colorOf(i), 4, [stopY, stopY]);
      if (slot >= 0) { w.peds.hold(slot); w.citizens.slot[i] = slot; }
    } else w.citizens.slot[i] = -1;
  }

  private giveUp(i: number, fromX?: number, fromZ?: number) {
    const w = this.w;
    const r = this.rides.get(i);
    this.rides.delete(i);
    if (!w.citizens.alive[i] || (r && w.citizens.gen[i] !== r.gen)) return;
    const s = w.citizens.slot[i];
    if (s >= 0 && w.peds.citizen[s] === i) w.peds.despawn(s);
    w.citizens.slot[i] = -1;
    if (fromX !== undefined && fromZ !== undefined) {
      if (w.citizens.switchToWalk(i, fromX, fromZ)) return;
      const dest = r ? w.buildings.byId.get(r.dest) : w.buildings.byId.get(w.citizens.tripDest[i]);
      const dist = dest ? Math.hypot(dest.x - fromX, dest.z - fromZ) : 390;
      w.citizens.virtualArrive(i, Math.max(10, dist / 1.3), fromX, fromZ);
      return;
    }
    w.citizens.virtualArrive(i, 300);
  }

  /**
   * A vehicle of line `l` is at stop index `k`: alight & board (FIFO), debiting real fares.
   * `heading(toIdx)`: does this vehicle travel towards stop index `toIdx` from here? Linear lines (rail, metro) only take riders
   * going their way; loop lines reach every stop, so they leave it undefined.
   */
  serveStop(l: Line, k: number, vkey: number, capacity: number, heading?: (to: number) => boolean): number {
    const w = this.w;
    const st = l.stops[k];
    if (!st) return 0;
    const stopId = st.id;
    let onboard = l.onboard.get(vkey);
    if (!onboard) l.onboard.set(vkey, (onboard = []));
    let moved = 0;
    // alight (strictly phase === 2: actually onboard)
    const stay: number[] = [];
    for (const i of onboard) {
      const r = this.rides.get(i);
      if (!r || !w.citizens.alive[i] || w.citizens.gen[i] !== r.gen || w.citizens.state[i] !== ST_TRANSIT || r.line !== l.id || r.phase !== 2) continue;
      if (r.toId === stopId) {
        moved++;
        r.phase = 3;
        const dest = w.buildings.byId.get(r.dest);
        if (dest && w.peds.capacityLeft > 40) {
          const door = doorOf(w.roads, dest);
          const wp = this.planWalkFromStop(st, dest);
          if (wp) {
            const wp3 = walkPath(w.roads, wp, st, door);
            const slot = w.peds.spawn(wp3.pts, i, 1.35, w.citizens.pedIdentityFlags(i), w.citizens.colorOf(i), 0, wp3.ys);
            if (slot >= 0) { w.citizens.slot[i] = slot; continue; }
          }
        }
        this.rides.delete(i);
        w.citizens.virtualArrive(i, Math.hypot((dest?.x ?? st.x) - st.x, (dest?.z ?? st.z) - st.z) / 1.3);
      } else stay.push(i);
    }
    onboard = stay;
    // board in strict FIFO order, validating generation/state/line/stopId before boarding or charging fare
    const fare = lineFare(l.kind);
    const q = l.waiting.get(stopId);
    if (q && q.length) {
      const rest: number[] = [];
      for (const i of q) {
        const r = this.rides.get(i);
        if (!r || !w.citizens.alive[i] || w.citizens.gen[i] !== r.gen || w.citizens.state[i] !== ST_TRANSIT || r.line !== l.id || r.fromId !== stopId || r.phase !== 1) continue;
        const toIdx = this.findStopIdx(l, r.toId);
        if (toIdx < 0) { this.giveUp(i); continue; }
        if (onboard.length >= capacity || (heading && !heading(toIdx))) { rest.push(i); continue; }
        const h = w.citizens.households.get(w.citizens.hh[i]);
        if (h) {
          if (h.money < fare) {
            // household cannot afford the fare: leave queue and walk to destination instead of riding free
            const ps = w.citizens.slot[i];
            if (ps >= 0 && w.peds.citizen[ps] === i) w.peds.despawn(ps);
            w.citizens.slot[i] = -1;
            this.rides.delete(i);
            if (!w.citizens.switchToWalk(i, st.x, st.z)) w.citizens.virtualArrive(i, 300, st.x, st.z);
            continue;
          }
          h.money -= fare;
        }
        this.faresCollected += fare;
        const s = w.citizens.slot[i];
        if (s >= 0 && w.peds.citizen[s] === i) w.peds.despawn(s);
        w.citizens.slot[i] = -1;
        r.phase = 2;
        onboard.push(i);
        l.ridersToday++;
        this.ridersDay++;
        moved++;
      }
      l.waiting.set(stopId, rest);
      if (rest.length) this.layoutStopQueue(l, k);
    }
    l.onboard.set(vkey, onboard);
    return moved;
  }

  /** Find the next stop on `(edge, dir)` ahead of `curS` that has waiting or alighting passengers. */
  nextBusStop = (slot: number, edge: number, dir: number, curS: number, lastStopIdx: number): { stopIdx: number; s: number } | null => {
    const T = this.w.traffic;
    const l = this.lines.find((x) => x.id === T.pId[slot]);
    if (!l) return null;
    const onboard = l.onboard.get(slot);
    let bestIdx = -1;
    let bestS = Infinity;
    for (let k = 0; k < l.stops.length; k++) {
      if (k === lastStopIdx) continue;
      const st = l.stops[k];
      if (st.edge !== edge || st.dir !== dir) continue;
      if (st.s < curS - 1.5 || st.s >= bestS) continue;
      const waiting = (l.waiting.get(st.id)?.length ?? 0) > 0;
      const alighting = !!onboard && onboard.some((cid) => this.rides.get(cid)?.toId === st.id);
      if (!waiting && !alighting) continue;
      bestS = st.s;
      bestIdx = k;
    }
    return bestIdx >= 0 ? { stopIdx: bestIdx, s: bestS } : null;
  };

  /** Bus stop callback from traffic when stopped at the curb on the edge (never in a junction). */
  onBusStop = (slot: number, stopIdx: number): number => {
    const T = this.w.traffic;
    const l = this.lines.find((x) => x.id === T.pId[slot]);
    if (!l || stopIdx < 0 || stopIdx >= l.stops.length) return 0;
    const cap = l.kind === 'brt' ? CAP_BRT : CAP_BUS;
    const n = this.serveStop(l, stopIdx, slot, cap);
    T.pAux[slot] = l.onboard.get(slot)?.length ?? 0;
    // dwell strictly when passengers actually boarded or alighted (never random empty dwells)
    return n > 0 ? Math.min(18, 6 + n * 0.6) : 0;
  };

  /** a bus completed its loop: respawn and keep passengers, or retire/replace if a fleet renewal is pending */
  busArrived(slot: number) {
    const w = this.w, T = w.traffic;
    const l = this.lines.find((x) => x.id === T.pId[slot]);
    let bx = l?.stops[0]?.x, bz = l?.stops[0]?.z;
    if (T.active[slot]) { T.computePose(slot); bx = T.x[slot]; bz = T.z[slot]; }
    l?.vehicles.delete(slot);
    if (!l) return;
    const pass = l.onboard.get(slot) ?? [];
    l.onboard.delete(slot);
    const activePass = pass.filter((cid) => {
      const r = this.rides.get(cid);
      return !!r && w.citizens.alive[cid] && w.citizens.gen[cid] === r.gen && w.citizens.state[cid] === ST_TRANSIT && r.line === l.id && r.phase === 2;
    });
    if ((l.pendingRenewals ?? 0) > 0 && w.budget.money > 55) {
      // Never drop paid onboard passengers during a fleet renewal: either transfer them seamlessly onto the
      // replacement bus immediately, or retire cleanly at the depot when empty.
      if (activePass.length > 0) {
        const ns = this.spawnBus(l);
        if (ns < 0) {
          for (const i of activePass) this.giveUp(i, bx, bz);
          return;
        }
        l.onboard.set(ns, activePass);
        T.pAux[ns] = activePass.length;
      } else {
        // Empty bus retires cleanly at depot; next dispatch puts the fresh bus (new slot/gen) into service
        l.lastSpawn = -1e9;
      }
      l.pendingRenewals = Math.max(0, (l.pendingRenewals ?? 0) - 1);
      // Apply gradual 1-bus renewal ONLY when an aging bus genuinely finishes its loop and returns to the depot
      const frac = 1 / Math.max(1, l.fleet);
      l.fleetAge = (l.fleetAge ?? 0) * (1 - frac);
      l.fleetWear = Math.max(0.05, (l.fleetWear ?? 0.05) * (1 - frac) + 0.05 * frac);
      this.busRenewalCostAcc += 40;
      this.busMaintCostToday += 40;
      this.busRenewals++;
      const st = l.stops[0];
      if (st) w.events.emit('bus_line', st.x, st.z, 0.45, `Ônibus renovado na frota da ${l.name}`, { visual: 0.5 });
      return;
    }
    if (l.vehicles.size < l.fleet) {
      const ns = this.spawnBus(l);
      if (ns >= 0) {
        l.onboard.set(ns, activePass);
        T.pAux[ns] = activePass.length;
        return;
      }
    }
    for (const i of activePass) this.giveUp(i, bx, bz);
  }

  /** a bus was interrupted/dropped mid-route (gridlock or road topology removal): evacuate riders without consuming a depot renewal */
  busInterrupted(slot: number) {
    const w = this.w, T = w.traffic;
    const l = this.lines.find((x) => x.id === T.pId[slot]);
    let bx = l?.stops[0]?.x, bz = l?.stops[0]?.z;
    if (T.active[slot]) { T.computePose(slot); bx = T.x[slot]; bz = T.z[slot]; }
    l?.vehicles.delete(slot);
    if (!l) return;
    const pass = l.onboard.get(slot) ?? [];
    l.onboard.delete(slot);
    for (const i of pass) this.giveUp(i, bx, bz);
  }

  /** Evacuate every waiting, walking and onboard rider on line `l` and suspend its fleet. */
  private evacuateLine(l: Line) {
    for (const q of l.waiting.values()) for (const cid of q) this.giveUp(cid);
    l.waiting.clear();
    for (const pass of l.onboard.values()) for (const cid of pass) this.giveUp(cid);
    l.onboard.clear();
    for (const [cid, r] of [...this.rides.entries()]) {
      if (r.line === l.id) this.giveUp(cid);
    }
    l.fleet = 0;
  }

  /** Evacuate onboard riders from a broken-down bus without stranding them or corrupting rides. */
  evacuateBus(slot: number): number {
    const T = this.w.traffic;
    const l = this.lines.find((x) => x.id === T.pId[slot]);
    if (!l) return 0;
    l.vehicles.delete(slot);
    const pass = l.onboard.get(slot) ?? [];
    l.onboard.delete(slot);
    for (const cid of pass) this.giveUp(cid);
    T.pAux[slot] = 0;
    return pass.length;
  }

  /** after a topology change (one-way conversion, street replaced by a structure): re-route lines through their stops */
  revalidateLines(): number {
    const R = this.w.roads;
    let fixed = 0;
    for (const l of this.lines) {
      if ((l.kind !== 'bus' && l.kind !== 'brt') || !l.path.length) continue;
      const pathValid = R.validPath(l.path);
      const stopsValid = l.stops.every((s) => s.edge >= 0 && R.edges[s.edge]?.alive && l.edges.has(s.edge));
      if (pathValid && stopsValid) continue;
      const e0 = R.edges[l.path[0] >> 1];
      const start = e0 ? ((l.path[0] & 1) === 0 ? e0.a : e0.b) : l.stops[0]?.node;
      if (start === undefined || start < 0 || !R.nodes[start]?.alive) { this.evacuateLine(l); continue; }
      const seq = [start, ...l.stops.map((s) => s.node).filter((n) => n >= 0 && n !== start && R.nodes[n]?.alive), start];
      const path: number[] = [];
      let ok = true;
      R.buildBudget = Math.max(R.buildBudget, seq.length + 2);
      for (let k = 0; k + 1 < seq.length && ok; k++) {
        const seg = seq[k] === seq[k + 1] ? [] : R.route(seq[k], seq[k + 1], 800);
        if (!seg) ok = false; else path.push(...seg);
      }
      if (!ok || path.length < 2) { this.evacuateLine(l); continue; } // suspended until the network allows it again
      const newStops = this.placeStopsAlongPath(path);
      if (newStops.length < 2) { this.evacuateLine(l); continue; }
      l.path = path;
      l.destS = R.edges[path[path.length - 1] >> 1].len - 1;
      l.edges = new Set(path.map((d) => d >> 1));
      l.pts = [];
      for (const de of path) { const e = R.edges[de >> 1]; const a = R.nodes[(de & 1) === 0 ? e.a : e.b]; l.pts.push(a.x, a.y + 0.5, a.z); }
      this.replaceStops(l, newStops);
      l.headway = this.headway(l);
      this.dirty.add(l.id);
      fixed++;
    }
    return fixed;
  }

  private spawnBus(l: Line): number {
    const w = this.w;
    if (w.traffic.capacityLeft < 30 || !w.roads.validPath(l.path)) return -1;
    const slot = w.traffic.spawn(VType.Bus, l.path, l.startS, l.destS, { kind: P_BUS, id: l.id, aux: 0 });
    if (slot >= 0) { l.vehicles.add(slot); l.lastSpawn = w.t; }
    return slot;
  }

  hourly() {
    const w = this.w;
    this.checkPendingBRT();
    for (const l of this.lines) {
      if (l.kind !== 'bus' && l.kind !== 'brt') continue;
      for (const v of [...l.vehicles]) if (!w.traffic.active[v] || w.traffic.pKind[v] !== P_BUS || w.traffic.pId[v] !== l.id) l.vehicles.delete(v);
      const night = w.hour < 5;
      const target = night ? Math.ceil(l.fleet / 3) : l.fleet;
      if (l.vehicles.size < target && w.t - l.lastSpawn > l.headway * 0.5) this.spawnBus(l);
    }
    // impatient riders give up
    for (const [i, r] of [...this.rides.entries()]) if (r.phase === 1 && w.t - r.since > HOUR_SECONDS * 1.5) {
      const l = this.lines.find((x) => x.id === r.line);
      const q = l?.waiting.get(r.fromId);
      if (l && q) {
        l.waiting.set(r.fromId, q.filter((x) => x !== i));
        const k = this.findStopIdx(l, r.fromId);
        if (k >= 0) this.layoutStopQueue(l, k);
      }
      this.giveUp(i);
    }
  }

  daily() {
    const w = this.w;
    // Carry intraday single-bus renewal costs into today's municipal closeout (read right after by CityHall.daily())
    this.busMaintCostToday = this.busRenewalCostAcc;
    this.busRenewalCostAcc = 0;
    for (const [k, v] of this.od) { const nv = v * 0.6; if (nv < 1) this.od.delete(k); else this.od.set(k, nv); }
    for (const l of this.lines) {
      l.ridersYday = l.ridersToday;
      l.ridersToday = 0;
      if (l.kind === 'bus' || l.kind === 'brt') {
        const perBus = l.ridersYday / Math.max(1, l.fleet);
        if (perBus > 90 && l.fleet < 14) { l.fleet++; l.headway = this.headway(l); }
        else if (perBus < 20 && l.fleet > 2) { l.fleet--; l.headway = this.headway(l); }
        if (l.kind === 'bus' && l.ridersYday > 650 && w.era >= 2) this.toBRT(l);
        // Fleet aging, preventive maintenance & gradual renewal
        if (l.fleet > 0) {
          l.fleetAge = (l.fleetAge ?? 0) + 1;
          l.fleetWear = Math.min(1, (l.fleetWear ?? 0) + 0.022 + Math.min(0.035, l.ridersYday / Math.max(1, l.fleet * 1800)));
          if (l.fleetWear >= 0.36 && w.budget.money > -400) {
            l.fleetWear = Math.max(0.08, l.fleetWear - 0.24);
            this.busMaintCostToday += l.fleet * 4;
          }
          if ((l.fleetAge >= 28 || l.fleetWear >= 0.78) && w.budget.money > 55) {
            // Schedule 1 unit for gradual renewal; age/wear/cost/counter apply ONLY on genuine depot return in busArrived()
            const curPending = l.pendingRenewals ?? 0;
            if (curPending < Math.max(1, l.fleet)) {
              l.pendingRenewals = curPending + 1;
            }
          }
        }
      }
      this.dirty.add(l.id);
    }
    if (w.day - this.lastPlan >= 2) { this.lastPlan = w.day; this.planBusLine(); }
  }

  private headway(l: Line) {
    let len = 0;
    for (const de of l.path) len += this.w.roads.edges[de >> 1]?.len ?? 0;
    return len / 7 / Math.max(1, l.fleet);
  }

  private planBusLine() {
    const w = this.w, R = w.roads, p = w.params;
    if (w.era < 1 || w.population < 700) return;
    if (this.lines.filter((l) => l.kind === 'bus' || l.kind === 'brt').length >= 3 + w.era * 3 + Math.round(p.transitPriority * 4)) return;
    const depot = w.buildings.list.find((b) => b.kind === 'busDepot');
    if (!depot) {
      if (!w.buildings.list.some((b) => b.kind === 'busDepot')) w.cityHall.build({ kind: 'busDepot', label: KINDS.busDepot.label, motive: 'Base para as primeiras linhas de ônibus', benefit: 10, cost: KINDS.busDepot.cost });
      return;
    }
    const pairs = [...this.od.entries()].sort((a, b) => b[1] - a[1]);
    const threshold = 25 * (1.4 - p.transitPriority);
    const urbanNodeOk = (n: { edges: number[] }) => n.edges.some((id) => {
      const e = R.edges[id];
      return e.alive && e.progress >= 1 && e.cls !== RoadClass.Highway && !e.bridge && !e.elevated && !e.tunnel && e.deck === undefined;
    });
    for (const [k, cnt] of pairs.slice(0, 15)) {
      if (cnt < threshold) break;
      const za = this.zoneCenter(Math.floor(k / 1e6)), zb = this.zoneCenter(k % 1e6);
      if (this.lines.some((l) => this.nearestStop(l, za.x, za.z, 450) >= 0 && this.nearestStop(l, zb.x, zb.z, 450) >= 0)) continue;
      const na = R.nearestNode(za.x, za.z, 250, urbanNodeOk), nb = R.nearestNode(zb.x, zb.z, 250, urbanNodeOk);
      if (!na || !nb || na.id === nb.id) continue;
      R.buildBudget = 4;
      const out = R.route(na.id, nb.id), back = R.route(nb.id, na.id);
      if (!out || !back || out.length < 2) continue;
      const path = [...out, ...back];
      // stops along urban edges, away from junctions, bridges, highways, elevated decks and tunnels
      const stops = this.placeStopsAlongPath(path);
      if (stops.length < 2) continue;
      const id = this.nextId++;
      const pts: number[] = [];
      for (const de of path) { const e = R.edges[de >> 1]; const a = R.nodes[(de & 1) === 0 ? e.a : e.b]; pts.push(a.x, a.y + 0.5, a.z); }
      const fleet = Math.max(2, Math.round((path.reduce((s, de) => s + R.edges[de >> 1].len, 0) / 7 / 300) * (0.6 + p.transitPriority)));
      const l: Line = {
        id, kind: 'bus', color: COLORS[(id - 1) % COLORS.length], name: `Linha ${id} · ${w.districtName(za.x, za.z)} ↔ ${w.districtName(zb.x, zb.z)}`,
        stops, path, startS: 0, destS: R.edges[path[path.length - 1] >> 1].len - 1, fleet, vehicles: new Set(), ridersToday: 0, ridersYday: 0,
        waiting: new Map(), onboard: new Map(), edges: new Set(path.map((d) => d >> 1)), headway: 300, lastSpawn: -1e9, pts,
        fleetAge: 0, fleetWear: 0.05,
      };
      l.headway = this.headway(l);
      this.lines.push(l);
      this.dirty.add(id);
      const slot = this.spawnBus(l);
      w.events.emit('bus_line', na.x, na.z, 0.8, `Nova linha de ônibus: ${l.name} (${Math.round(cnt)} viagens/dia no corredor)`, {
        headline: `Prefeitura cria a ${l.name.split(' · ')[0]} ligando ${w.districtName(za.x, za.z)} a ${w.districtName(zb.x, zb.z)}`,
        entity: slot >= 0 ? { kind: 'vehicle', id: slot, gen: w.traffic.gen[slot] } : undefined, visual: 0.8,
      });
      return;
    }
  }

  private toBRT(l: Line) {
    if (l.kind === 'brt' || l.pendingBRT) return;
    const w = this.w;
    let ready = 0;
    const todo = [];
    for (const id of l.edges) {
      const e = w.roads.edges[id];
      if (!e?.alive) continue;
      if (e.busLane) ready++;
      else if (e.lanes >= 2 && !e.upgrading) todo.push(e);
    }
    // never announce BRT when no dedicated bus lanes exist or can be built
    if (!ready && !todo.length) return;
    if (!todo.length) { this.promoteBRT(l, ready); return; }
    for (const e of todo) {
      e.upgrading = true;
      e.upgradeTo = { busLane: true };
      e.workP = 0;
      w.roadWorks.set(e.id, { motive: 'BRT', speed: 0.4, kind: 'upgrade' });
      w.roads.dirtyEdges.add(e.id);
    }
    l.pendingBRT = true;
    const s = l.stops[0];
    w.events.emit('road_upgrade', s.x, s.z, 0.7, `Obras de faixa exclusiva para a ${l.name} em ${todo.length} trecho(s)`, { visual: 0.6 });
  }

  /** promote pending BRT lines only once their exclusive bus-lane works have finished */
  checkPendingBRT() {
    const w = this.w;
    for (const l of this.lines) {
      if (!l.pendingBRT || l.kind === 'brt') continue;
      let stillWorking = false, ready = 0;
      for (const id of l.edges) {
        const e = w.roads.edges[id];
        if (!e?.alive) continue;
        if (e.upgrading && e.upgradeTo?.busLane) stillWorking = true;
        if (e.busLane) ready++;
      }
      if (stillWorking) continue;
      l.pendingBRT = false;
      if (ready > 0) this.promoteBRT(l, ready);
    }
  }

  private promoteBRT(l: Line, lanes: number) {
    l.kind = 'brt';
    l.name = l.name.replace('Linha', 'BRT');
    l.pendingBRT = false;
    this.dirty.add(l.id);
    const s = l.stops[0];
    this.w.events.emit('line_opened', s.x, s.z, 0.9, `${l.name} entra em operação com faixa exclusiva em ${lanes} trecho(s)`, { headline: `Linha mais lotada vira BRT com faixa exclusiva`, visual: 0.8 });
  }

  /**
   * Replace stops on a line preserving stable Stop.id via 1-to-1 matching (never merging stops by array index).
   * Riders walking to a moved stop are repathed; riders whose stop was removed cancel cleanly.
   */
  replaceStops(l: Line, stops: Stop[]) {
    const oldById = new Map(l.stops.map((s) => [s.id, s]));
    const claimedOld = new Set<number>();
    const usedNewIds = new Set<number>();
    const movedStops: Stop[] = [];

    // 1. Preserve explicit matching IDs first
    for (const ns of stops) {
      if (ns.id > 0 && oldById.has(ns.id) && !claimedOld.has(ns.id)) {
        claimedOld.add(ns.id);
        usedNewIds.add(ns.id);
        const old = oldById.get(ns.id)!;
        if (Math.hypot(ns.x - old.x, ns.z - old.z) > 2) movedStops.push(ns);
      }
    }
    // 2. 1-to-1 nearest match for remaining stops within 120 m (never merges two old stops into one)
    for (const ns of stops) {
      if (usedNewIds.has(ns.id)) continue;
      let bestOld: Stop | null = null, bd = 120;
      for (const old of l.stops) {
        if (claimedOld.has(old.id)) continue;
        const d = Math.hypot(ns.x - old.x, ns.z - old.z);
        if (d < bd) { bd = d; bestOld = old; }
      }
      if (bestOld) {
        ns.id = bestOld.id;
        claimedOld.add(bestOld.id);
        usedNewIds.add(ns.id);
        if (bd > 2) movedStops.push(ns);
      } else {
        if (!(ns.id > 0) || usedNewIds.has(ns.id)) ns.id = this.allocStopId();
        usedNewIds.add(ns.id);
      }
    }

    l.stops = stops;
    const validIds = new Set(stops.map((s) => s.id));

    // Drop queues for removed stops and notify waiting riders
    for (const [sid, q] of [...l.waiting.entries()]) {
      if (!validIds.has(sid)) {
        l.waiting.delete(sid);
        for (const cid of q) this.giveUp(cid);
      }
    }
    // Handle riders whose origin or destination stop was removed or moved
    for (const [cid, r] of [...this.rides.entries()]) {
      if (r.line !== l.id) continue;
      const hasFrom = validIds.has(r.fromId);
      const hasTo = validIds.has(r.toId);
      if (r.phase === 0) {
        if (!hasFrom || !hasTo) this.giveUp(cid);
      } else if (r.phase === 1) {
        if (!hasFrom || !hasTo) {
          const q = l.waiting.get(r.fromId);
          if (q) l.waiting.set(r.fromId, q.filter((x) => x !== cid));
          this.giveUp(cid);
        }
      } else if (r.phase === 2 && !hasTo) {
        if (stops.length) {
          const oldTo = oldById.get(r.toId);
          let best = stops[0], bd = Infinity;
          if (oldTo) {
            for (const s of stops) { const d = Math.hypot(s.x - oldTo.x, s.z - oldTo.z); if (d < bd) { bd = d; best = s; } }
          }
          r.toId = best.id;
        } else {
          this.giveUp(cid);
        }
      }
    }
    for (const ms of movedStops) this.repathWalkingRiders(l, ms);
    for (let k = 0; k < l.stops.length; k++) this.layoutStopQueue(l, k);
    this.dirty.add(l.id);
  }

  /** register a rail/metro line so citizens can ride it */
  addRailLine(kind: 'rail' | 'metro', name: string, stops: Stop[], pts: number[], headway: number): Line {
    const id = this.nextId++;
    for (const st of stops) if (!(st.id > 0)) st.id = this.allocStopId();
    const l: Line = { id, kind, color: kind === 'metro' ? '#c0392b' : '#2d3436', name, stops, path: [], startS: 0, destS: 0, fleet: 0, vehicles: new Set(), ridersToday: 0, ridersYday: 0, waiting: new Map(), onboard: new Map(), edges: new Set(), headway, lastSpawn: 0, pts };
    this.lines.push(l);
    this.dirty.add(id);
    return l;
  }

  ridersOn(edge: number): number {
    let s = 0;
    for (const l of this.lines) if (l.edges.has(edge)) s += l.ridersYday;
    return s;
  }

  splatCoverage(F: World['fields'], arr: Float32Array) {
    for (const l of this.lines) for (const s of l.stops) {
      const strength = l.kind === 'bus' ? 0.35 : l.kind === 'brt' ? 0.6 : 1.0;
      F.splat(arr, s.x, s.z, strength * (l.kind === 'bus' ? 3 : 8), l.kind === 'bus' ? 300 : 650);
    }
  }

  describe(i: number): string {
    const r = this.rides.get(i);
    if (!r) return 'no transporte público';
    const l = this.lines.find((x) => x.id === r.line);
    if (!l) return 'no transporte público';
    const st = this.findStop(l, r.phase <= 1 ? r.fromId : r.toId);
    return r.phase === 0 ? `caminhando até o ponto (${l.name})` : r.phase === 1 ? `esperando no ponto ${st?.name ?? ''} (${l.name})` : r.phase === 2 ? `a bordo: ${l.name}, desce em ${st?.name ?? ''}` : `desceu do ${l.kind === 'bus' || l.kind === 'brt' ? 'ônibus' : 'trem'}`;
  }

  position(i: number) {
    const w = this.w;
    const r = this.rides.get(i);
    if (!r) return null;
    const s = w.citizens.slot[i];
    if (s >= 0 && w.peds.active[s] && w.peds.citizen[s] === i) { w.peds.pose(s); return { x: w.peds.x[s], y: w.peds.y[s], z: w.peds.z[s], h: w.peds.h[s], inside: false, building: -1 }; }
    const l = this.lines.find((x) => x.id === r.line);
    if (!l) return null;
    if (r.phase === 2) {
      for (const [vk, list] of l.onboard) if (list.includes(i)) {
        if (l.kind === 'bus' || l.kind === 'brt') { if (w.traffic.active[vk]) { w.traffic.computePose(vk); return { x: w.traffic.x[vk], y: w.traffic.y[vk] + 1, z: w.traffic.z[vk], h: w.traffic.h[vk], inside: false, building: -1 }; } }
        else { const p = w.trainsSys?.trainPose(vk); if (p) return { ...p, inside: false, building: -1 }; }
      }
    }
    const st = this.findStop(l, r.fromId);
    if (!st) return null;
    return { x: st.x, y: Math.max(0, w.terrain.heightAt(st.x, st.z)) + 1, z: st.z, h: 0, inside: false, building: -1 };
  }

  /** Compute shelter world pose [x, z, angle] for a road bus/BRT stop on the back of the sidewalk. */
  shelterPose(s: Stop): [number, number, number] {
    const rx = -s.uz, rz = s.ux;
    const extra = SHELTER_OFFSET - CURB_WAIT_OFFSET;
    return [s.curbX + rx * extra, s.curbZ + rz * extra, Math.atan2(s.uz, s.ux)];
  }

  views(): TransitLineView[] {
    const out: TransitLineView[] = [];
    for (const id of this.dirty) {
      const l = this.lines.find((x) => x.id === id);
      if (!l) continue;
      const stopPoses = l.kind === 'bus' || l.kind === 'brt'
        ? l.stops.flatMap((s) => this.shelterPose(s))
        : undefined;
      out.push({
        id: l.id,
        kind: l.kind,
        color: l.color,
        name: l.name,
        pts: l.pts,
        stops: l.stops.flatMap((s) => [s.x, s.z]),
        stopPoses,
        riders: l.ridersYday,
        vehicles: l.kind === 'bus' || l.kind === 'brt' ? l.vehicles.size : l.fleet,
      });
    }
    this.dirty.clear();
    return out;
  }

  odPairs(): number[] {
    const out: number[] = [];
    const pairs = [...this.od.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
    for (const [k, v] of pairs) { const a = this.zoneCenter(Math.floor(k / 1e6)), b = this.zoneCenter(k % 1e6); out.push(a.x, a.z, b.x, b.z, v); }
    return out;
  }
  cost(): number {
    let c = this.busMaintCostToday;
    for (const l of this.lines) c += l.kind === 'bus' ? l.fleet * 12 : l.kind === 'brt' ? l.fleet * 16 : l.kind === 'metro' ? 300 : 120;
    return c;
  }
  fares(): number {
    const f = this.faresCollected;
    this.faresCollected = 0;
    this.ridersDay = 0;
    return f;
  }

  static readonly ACT = Act;
  static readonly ST_IN = ST_IN;
}
