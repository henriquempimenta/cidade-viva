import { HOUR_SECONDS, PED_FLAG_WAITING, VType } from '../shared/constants';
import type { TransitLineView } from '../shared/protocol';
import type { Building } from './buildings';
import { Act, ST_IN, ST_TRANSIT } from './citizens';
import { P_BUS } from './traffic';
import { doorOf } from './trips';
import type { World } from './world';
import { KINDS } from '../shared/catalog';

export interface Stop { x: number; z: number; node: number; s: number; name: string }
export interface Line {
  id: number; kind: 'bus' | 'brt' | 'rail' | 'metro'; color: string; name: string;
  stops: Stop[]; path: number[]; startS: number; destS: number;
  fleet: number; vehicles: Set<number>; ridersToday: number; ridersYday: number;
  waiting: Map<number, number[]>; onboard: Map<number, number[]>; edges: Set<number>;
  headway: number; lastSpawn: number; pts: number[];
}
interface Ride { line: number; from: number; to: number; phase: number; since: number; dest: number }

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e84393', '#fdcb6e', '#00cec9', '#6c5ce7', '#d35400', '#27ae60'];
const ZONE = 300;

/** Self-managing public transport: lines are derived from the observed origin–destination matrix. */
export class Transit {
  lines: Line[] = [];
  private nextId = 1;
  private od = new Map<number, number>();
  rides = new Map<number, Ride>();
  dirty = new Set<number>();
  removed: number[] = [];
  private lastPlan = -5;
  ridersDay = 0;

  constructor(private w: World) {}

  private zone(x: number, z: number) { return Math.floor(x / ZONE) * 1000 + Math.floor(z / ZONE); }
  private zoneCenter(k: number) { return { x: (Math.floor(k / 1000) + 0.5) * ZONE, z: ((k % 1000) + 0.5) * ZONE }; }

  recordTrip(from: Building, to: Building, len: number) {
    if (len < 700) return;
    const a = this.zone(from.x, from.z), b = this.zone(to.x, to.z);
    if (a === b) return;
    const k = a < b ? a * 1e6 + b : b * 1e6 + a;
    this.od.set(k, (this.od.get(k) ?? 0) + 1);
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
      if (!l.vehicles.size && l.kind === 'bus') continue;
      const reach = l.kind === 'bus' || l.kind === 'brt' ? 450 : 750;
      const a = this.nearestStop(l, from.x, from.z, reach), b = this.nearestStop(l, to.x, to.z, reach);
      if (a < 0 || b < 0 || a === b) continue;
      const walk = (Math.hypot(l.stops[a].x - from.x, l.stops[a].z - from.z) + Math.hypot(l.stops[b].x - to.x, l.stops[b].z - to.z)) / 1.3;
      const ride = Math.hypot(l.stops[b].x - l.stops[a].x, l.stops[b].z - l.stops[a].z) * 1.25 / (l.kind === 'bus' ? 7 : l.kind === 'brt' ? 10 : 17);
      const time = walk + l.headway / 2 + ride;
      const t = { mode: l.kind === 'bus' || l.kind === 'brt' ? 3 : 4, time, fare: 4, line: l.id, a, b };
      if (!best || time < best.time) best = t;
    }
    void len;
    return best;
  }

  board(i: number, from: Building, to: Building, opt: { line: number; a: number; b: number }): boolean {
    const w = this.w;
    const l = this.lines.find((x) => x.id === opt.line);
    if (!l) return false;
    const st = l.stops[opt.a];
    this.rides.set(i, { line: l.id, from: opt.a, to: opt.b, phase: 0, since: w.t, dest: to.id });
    const door = doorOf(w.roads, from);
    if (w.peds.capacityLeft > 40) {
      const slot = w.peds.spawn([door.x, door.z, st.x, st.z], i, 1.35, 0, 0);
      if (slot >= 0) { w.citizens.slot[i] = slot; w.citizens.state[i] = ST_TRANSIT; return true; }
    }
    // virtual walk to the stop
    w.citizens.state[i] = ST_TRANSIT;
    w.citizens.slot[i] = -1;
    this.atStop(i);
    return true;
  }

  /** ped arrival callback for transit riders: reached the stop (phase 0) or the destination (phase 3) */
  pedArrived(i: number): boolean {
    const r = this.rides.get(i);
    if (!r) return false;
    if (r.phase === 0) { this.atStop(i); return true; }
    if (r.phase === 3) { this.rides.delete(i); this.w.citizens.arrive(i); return true; }
    return false;
  }

  private atStop(i: number) {
    const w = this.w;
    const r = this.rides.get(i)!;
    const l = this.lines.find((x) => x.id === r.line);
    if (!l) { this.giveUp(i); return; }
    r.phase = 1; r.since = w.t;
    const st = l.stops[r.from];
    let q = l.waiting.get(r.from);
    if (!q) l.waiting.set(r.from, (q = []));
    q.push(i);
    // a person standing at the stop
    if (w.peds.capacityLeft > 60) {
      const a = (q.length * 1.7) % 6.28;
      const slot = w.peds.spawn([st.x + Math.cos(a) * 1.5, st.z + Math.sin(a) * 1.5, st.x + Math.cos(a) * 1.5 + 0.05, st.z + Math.sin(a) * 1.5], i, 0.01, PED_FLAG_WAITING, 0);
      if (slot >= 0) { w.peds.hold(slot); w.citizens.slot[i] = slot; }
    } else w.citizens.slot[i] = -1;
  }

  private giveUp(i: number) {
    const w = this.w;
    const s = w.citizens.slot[i];
    if (s >= 0 && w.peds.citizen[s] === i) w.peds.despawn(s);
    this.rides.delete(i);
    w.citizens.virtualArrive(i, 300);
  }

  /** a vehicle of line l is at stop index k: alight & board */
  /**
   * `heading(to)`: does this vehicle travel towards stop `to` from here? Linear lines (rail, metro) only take riders
   * going their way; loop lines reach every stop, so they leave it undefined.
   */
  serveStop(l: Line, k: number, vkey: number, capacity: number, heading?: (to: number) => boolean): number {
    const w = this.w;
    let onboard = l.onboard.get(vkey);
    if (!onboard) l.onboard.set(vkey, (onboard = []));
    let moved = 0;
    // alight
    const stay: number[] = [];
    for (const i of onboard) {
      const r = this.rides.get(i);
      if (!r || !w.citizens.alive[i]) continue;
      if (r.to === k) {
        moved++;
        r.phase = 3;
        const dest = w.buildings.byId.get(r.dest);
        const st = l.stops[k];
        if (dest && w.peds.capacityLeft > 40) {
          const door = doorOf(w.roads, dest);
          const slot = w.peds.spawn([st.x, st.z, door.x, door.z], i, 1.35, 0, 0);
          if (slot >= 0) { w.citizens.slot[i] = slot; continue; }
        }
        this.rides.delete(i);
        w.citizens.virtualArrive(i, Math.hypot((dest?.x ?? st.x) - st.x, (dest?.z ?? st.z) - st.z) / 1.3);
      } else stay.push(i);
    }
    onboard = stay;
    // board
    const q = l.waiting.get(k);
    if (q && q.length) {
      const rest: number[] = [];
      for (const i of q) {
        const r = this.rides.get(i);
        if (!r || !w.citizens.alive[i]) continue;
        if (onboard.length >= capacity || (heading && !heading(r.to))) { rest.push(i); continue; }
        const s = w.citizens.slot[i];
        if (s >= 0 && w.peds.citizen[s] === i) w.peds.despawn(s);
        w.citizens.slot[i] = -1;
        r.phase = 2;
        onboard.push(i);
        l.ridersToday++;
        this.ridersDay++;
        moved++;
      }
      l.waiting.set(k, rest);
    }
    l.onboard.set(vkey, onboard);
    return moved;
  }

  /** bus stop callback from traffic */
  onBusNode = (slot: number, node: number): boolean => {
    const T = this.w.traffic;
    const l = this.lines.find((x) => x.id === T.pId[slot]);
    if (!l) return false;
    const k = l.stops.findIndex((s) => s.node === node);
    if (k < 0) return false;
    const n = this.serveStop(l, k, slot, 70);
    T.pAux[slot] = l.onboard.get(slot)?.length ?? 0;
    return n > 0 || (slot + node) % 2 === 0;
  };

  /** a bus completed its loop: respawn and keep passengers */
  busArrived(slot: number) {
    const w = this.w, T = w.traffic;
    const l = this.lines.find((x) => x.id === T.pId[slot]);
    l?.vehicles.delete(slot);
    if (!l) return;
    const pass = l.onboard.get(slot) ?? [];
    l.onboard.delete(slot);
    if (l.vehicles.size < l.fleet) {
      const ns = this.spawnBus(l);
      if (ns >= 0) { l.onboard.set(ns, pass); return; }
    }
    for (const i of pass) this.giveUp(i);
  }

  /** after a topology change (one-way conversion, street replaced by a structure): re-route lines through their stops */
  revalidateLines(): number {
    const R = this.w.roads;
    let fixed = 0;
    for (const l of this.lines) {
      if ((l.kind !== 'bus' && l.kind !== 'brt') || !l.path.length || R.validPath(l.path)) continue;
      const e0 = R.edges[l.path[0] >> 1];
      const start = (l.path[0] & 1) === 0 ? e0.a : e0.b;
      const seq = [start, ...l.stops.map((s) => s.node).filter((n) => n !== start), start];
      const path: number[] = [];
      let ok = true;
      R.buildBudget = Math.max(R.buildBudget, seq.length + 2);
      for (let k = 0; k + 1 < seq.length && ok; k++) {
        const seg = seq[k] === seq[k + 1] ? [] : R.route(seq[k], seq[k + 1], 800);
        if (!seg) ok = false; else path.push(...seg);
      }
      if (!ok || path.length < 2) { l.fleet = 0; continue; } // suspended until the network allows it again
      l.path = path;
      l.destS = R.edges[path[path.length - 1] >> 1].len - 1;
      l.edges = new Set(path.map((d) => d >> 1));
      l.pts = [];
      for (const de of path) { const e = R.edges[de >> 1]; const a = R.nodes[(de & 1) === 0 ? e.a : e.b]; l.pts.push(a.x, a.y + 0.5, a.z); }
      l.headway = this.headway(l);
      this.dirty.add(l.id);
      fixed++;
    }
    return fixed;
  }

  private spawnBus(l: Line): number {
    const w = this.w;
    if (w.traffic.capacityLeft < 30 || !w.roads.validPath(l.path)) return -1;
    const slot = w.traffic.spawn(l.kind === 'brt' ? VType.Bus : VType.Bus, l.path, l.startS, l.destS, { kind: P_BUS, id: l.id, aux: 0 });
    if (slot >= 0) { l.vehicles.add(slot); l.lastSpawn = w.t; }
    return slot;
  }

  hourly() {
    const w = this.w;
    for (const l of this.lines) {
      if (l.kind !== 'bus' && l.kind !== 'brt') continue;
      for (const v of [...l.vehicles]) if (!w.traffic.active[v] || w.traffic.pKind[v] !== P_BUS || w.traffic.pId[v] !== l.id) l.vehicles.delete(v);
      const night = w.hour < 5;
      const target = night ? Math.ceil(l.fleet / 3) : l.fleet;
      if (l.vehicles.size < target && w.t - l.lastSpawn > l.headway * 0.5) this.spawnBus(l);
    }
    // impatient riders give up
    for (const [i, r] of this.rides) if (r.phase === 1 && w.t - r.since > HOUR_SECONDS * 1.5) {
      const l = this.lines.find((x) => x.id === r.line);
      const q = l?.waiting.get(r.from);
      if (q) l!.waiting.set(r.from, q.filter((x) => x !== i));
      this.giveUp(i);
    }
  }

  daily() {
    const w = this.w;
    for (const [k, v] of this.od) { const nv = v * 0.6; if (nv < 1) this.od.delete(k); else this.od.set(k, nv); }
    for (const l of this.lines) {
      l.ridersYday = l.ridersToday;
      l.ridersToday = 0;
      if (l.kind === 'bus' || l.kind === 'brt') {
        const perBus = l.ridersYday / Math.max(1, l.fleet);
        if (perBus > 90 && l.fleet < 14) { l.fleet++; l.headway = this.headway(l); }
        else if (perBus < 20 && l.fleet > 2) { l.fleet--; l.headway = this.headway(l); }
        if (l.kind === 'bus' && l.ridersYday > 650 && w.era >= 2) this.toBRT(l);
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
    for (const [k, cnt] of pairs.slice(0, 15)) {
      if (cnt < threshold) break;
      const za = this.zoneCenter(Math.floor(k / 1e6)), zb = this.zoneCenter(k % 1e6);
      if (this.lines.some((l) => this.nearestStop(l, za.x, za.z, 450) >= 0 && this.nearestStop(l, zb.x, zb.z, 450) >= 0)) continue;
      const na = R.nearestNode(za.x, za.z, 250, (n) => n.edges.some((id) => R.edges[id].progress >= 1 && R.edges[id].cls !== 4)), nb = R.nearestNode(zb.x, zb.z, 250, (n) => n.edges.some((id) => R.edges[id].progress >= 1 && R.edges[id].cls !== 4));
      if (!na || !nb || na.id === nb.id) continue;
      R.buildBudget = 4;
      const out = R.route(na.id, nb.id), back = R.route(nb.id, na.id);
      if (!out || !back || out.length < 2) continue;
      const path = [...out, ...back];
      // stops every ~330 m at nodes along the loop
      const stops: Stop[] = [];
      let acc = 330;
      for (const de of path) {
        const e = R.edges[de >> 1];
        acc += e.len;
        const node = (de & 1) === 0 ? e.b : e.a;
        if (acc >= 330 && !stops.some((s) => s.node === node)) {
          const n = R.nodes[node];
          stops.push({ x: n.x, z: n.z, node, s: 0, name: w.districtName(n.x, n.z) });
          acc = 0;
        }
      }
      if (stops.length < 2) continue;
      const id = this.nextId++;
      const pts: number[] = [];
      for (const de of path) { const e = R.edges[de >> 1]; const a = R.nodes[(de & 1) === 0 ? e.a : e.b]; pts.push(a.x, a.y + 0.5, a.z); }
      const fleet = Math.max(2, Math.round((path.reduce((s, de) => s + R.edges[de >> 1].len, 0) / 7 / 300) * (0.6 + p.transitPriority)));
      const l: Line = {
        id, kind: 'bus', color: COLORS[(id - 1) % COLORS.length], name: `Linha ${id} · ${w.districtName(za.x, za.z)} ↔ ${w.districtName(zb.x, zb.z)}`,
        stops, path, startS: 0, destS: R.edges[path[path.length - 1] >> 1].len - 1, fleet, vehicles: new Set(), ridersToday: 0, ridersYday: 0,
        waiting: new Map(), onboard: new Map(), edges: new Set(path.map((d) => d >> 1)), headway: 300, lastSpawn: -1e9, pts,
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
    const w = this.w;
    l.kind = 'brt';
    l.name = l.name.replace('Linha', 'BRT');
    let n = 0;
    for (const id of l.edges) { const e = w.roads.edges[id]; if (e.alive && e.lanes >= 2 && !e.busLane && !e.upgrading) { e.upgrading = true; e.upgradeTo = { busLane: true }; e.workP = 0; w.roadWorks.set(e.id, { motive: 'BRT', speed: 0.4, kind: 'upgrade' }); n++; } }
    const s = l.stops[0];
    w.events.emit('line_opened', s.x, s.z, 0.9, `${l.name} ganha faixa exclusiva em ${n} trechos`, { headline: `Linha mais lotada vira BRT com faixa exclusiva`, visual: 0.8 });
  }

  /** new stop list for a line (a station opened in between): riders and queues follow their stop, matched by position */
  replaceStops(l: Line, stops: Stop[]) {
    const map = l.stops.map((o) => { let bi = -1, bd = Infinity; stops.forEach((n, k) => { const d = Math.hypot(n.x - o.x, n.z - o.z); if (d < bd) { bd = d; bi = k; } }); return bi; });
    for (const r of this.rides.values()) if (r.line === l.id) { r.from = map[r.from] ?? r.from; r.to = map[r.to] ?? r.to; }
    const wq = new Map<number, number[]>();
    for (const [k, q] of l.waiting) { const nk = map[k] ?? k; wq.set(nk, [...(wq.get(nk) ?? []), ...q]); }
    l.waiting = wq;
    l.stops = stops;
    this.dirty.add(l.id);
  }

  /** register a rail/metro line so citizens can ride it */
  addRailLine(kind: 'rail' | 'metro', name: string, stops: Stop[], pts: number[], headway: number): Line {
    const id = this.nextId++;
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
    const st = l.stops[r.phase <= 1 ? r.from : r.to];
    return r.phase === 0 ? `caminhando até o ponto (${l.name})` : r.phase === 1 ? `esperando no ponto ${st.name} (${l.name})` : r.phase === 2 ? `a bordo: ${l.name}, desce em ${st.name}` : `desceu do ${l.kind === 'bus' ? 'ônibus' : 'trem'}`;
  }

  position(i: number) {
    const w = this.w;
    const r = this.rides.get(i);
    if (!r) return null;
    const s = w.citizens.slot[i];
    if (s >= 0 && w.peds.active[s] && w.peds.citizen[s] === i) { w.peds.pose(s); return { x: w.peds.x[s], y: Math.max(0.2, w.terrain.heightAt(w.peds.x[s], w.peds.z[s])) + 0.1, z: w.peds.z[s], h: w.peds.h[s], inside: false, building: -1 }; }
    const l = this.lines.find((x) => x.id === r.line);
    if (!l) return null;
    if (r.phase === 2) {
      for (const [vk, list] of l.onboard) if (list.includes(i)) {
        if (l.kind === 'bus' || l.kind === 'brt') { if (w.traffic.active[vk]) { w.traffic.computePose(vk); return { x: w.traffic.x[vk], y: w.traffic.y[vk] + 1, z: w.traffic.z[vk], h: w.traffic.h[vk], inside: false, building: -1 }; } }
        else { const p = w.trainsSys?.trainPose(vk); if (p) return { ...p, inside: false, building: -1 }; }
      }
    }
    const st = l.stops[r.from];
    return { x: st.x, y: Math.max(0, w.terrain.heightAt(st.x, st.z)) + 1, z: st.z, h: 0, inside: false, building: -1 };
  }

  views(): TransitLineView[] {
    const out: TransitLineView[] = [];
    for (const id of this.dirty) {
      const l = this.lines.find((x) => x.id === id);
      if (!l) continue;
      out.push({ id: l.id, kind: l.kind, color: l.color, name: l.name, pts: l.pts, stops: l.stops.flatMap((s) => [s.x, s.z]), riders: l.ridersYday, vehicles: l.kind === 'bus' || l.kind === 'brt' ? l.vehicles.size : l.fleet });
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
    let c = 0;
    for (const l of this.lines) c += l.kind === 'bus' ? l.fleet * 12 : l.kind === 'brt' ? l.fleet * 16 : l.kind === 'metro' ? 300 : 120;
    return c;
  }
  fares(): number { const f = this.ridersDay * 2.5; this.ridersDay = 0; return f; }

  static readonly ACT = Act;
  static readonly ST_IN = ST_IN;
}
