import { HOUR_SECONDS, MAX_TRAIN_CARS, ROAD_HALF_WIDTH, RoadClass, TRAIN_STRIDE, VType } from '../shared/constants';
import type { CrossingView, RailEdgeView, RailStationView } from '../shared/protocol';
import type { Building, Candidate } from './buildings';
import { OCC_RAIL } from './occupancy';
import type { P2 } from './regional';
import { segInt } from './roads';
import type { Line, Stop } from './transit';
import { carPlan } from './trips';
import { P_CARGO } from './traffic';
import type { World } from './world';
import { KINDS } from '../shared/catalog';

interface RLine { /** construction progress 0..1 (lines built during the game grow along their length) */ built?: number; id: number; kind: 'main' | 'metro' | 'spur'; x: number[]; y: number[]; z: number[]; cum: number[]; tracks: number; elevated: boolean; len: number; transit?: Line; stations: { s: number; b: number; name: string; stop: number }[] }
interface Train { id: number; line: number; kind: 'pass' | 'freight' | 'metro'; s: number; dir: number; v: number; vmax: number; cars: number[]; dwell: number; served: Set<number>; gen: number }
interface Crossing { edge: number; t: number; line: number; s: number; x: number; z: number; y: number; angle: number; separated: boolean; under?: boolean; /** a road deck flies over this crossing: the track may not be lifted here */ bypassed?: boolean; closed: boolean; /** vehicle-seconds queued at the gates today */ wait: number; /** consecutive saturated days */ hot: number }

const CAR_LEN = [17, 20, 17, 15, 16, 19];
/** length of each ramp when the track is lifted over a road (gentle ~3% grade) */
export const RAIL_RAMP = 220;
const LIFT = 7.5;
/** minimum spacing between two level crossings on the same line */
const CROSS_GAP = 150;

/** Railways: regional line (freight + passengers), stations, freight terminal, level crossings, duplication, metro. */
export class Rail {
  lines: RLine[] = [];
  trains: Train[] = [];
  crossings: Crossing[] = [];
  /** road underpasses dug where the track can't be lifted (next to stations and the freight yard) */
  private underpasses: { line: number; s: number }[] = [];
  private nextTrain = 1;
  private crossVer = -1;
  dirtyViews = true;
  dirtyStations: RailStationView[] = [];
  crossingsDirty = true;
  terminal: Building | null = null;
  terminalS = -1;
  waitingSingle = 0;
  duplicated = false;
  private lastFreight = -1e9;
  private lastPass = -1e9;
  private lastMetro = -1e9;
  freightToday = 0;
  /** trains run per kind, today and yesterday (noise, chronicle) */
  private runs = { freight: 0, pass: 0, metro: 0 };
  private runsYday = { freight: 0, pass: 0, metro: 0 };

  constructor(private w: World) {
    const T = w.terrain;
    const path = w.railPath;
    const ys = path.map((p) => Math.max(T.heightAt(p.x, p.z), 0));
    for (let it = 0; it < 6; it++) for (let i = 1; i < ys.length - 1; i++) ys[i] = (ys[i - 1] + ys[i] * 2 + ys[i + 1]) / 4;
    const wet = path.map((p) => T.heightAt(p.x, p.z) < T.seaLevel + 0.5);
    // never buried: smoothing would sink the track into hillsides where nothing is drawn (no cuts in the terrain mesh)
    const gr = path.map((p) => Math.max(T.heightAt(p.x, p.z), 0) + 0.05);
    for (let it = 0; it < 3; it++) { for (let i = 0; i < ys.length; i++) ys[i] = Math.max(ys[i], gr[i]); for (let i = 1; i < ys.length - 1; i++) ys[i] = Math.max(gr[i], (ys[i - 1] + ys[i] * 2 + ys[i + 1]) / 4); }
    const y = ys.map((v, i) => (wet[Math.max(0, i - 1)] || wet[i] || wet[Math.min(ys.length - 1, i + 1)] ? Math.max(v, 6) : v) + 0.4);
    this.addLine('main', path, y, 1, false);
    w.roads.railCheck = (ax, az, bx, bz, cls) => this.roadCheck(ax, az, bx, bz, cls);
  }

  // ------------------------------------------------------------------ the railway as an urban barrier
  /** height of the track above the ground at arc length s */
  private clearance(l: RLine, i: number, u: number, x: number, z: number) {
    return l.y[i] + (l.y[i + 1] - l.y[i]) * u - Math.max(0, this.w.terrain.heightAt(x, z));
  }
  private segBoxHit(l: RLine, i: number, minx: number, maxx: number, minz: number, maxz: number) {
    return !(Math.max(l.x[i], l.x[i + 1]) < minx || Math.min(l.x[i], l.x[i + 1]) > maxx || Math.max(l.z[i], l.z[i + 1]) < minz || Math.min(l.z[i], l.z[i + 1]) > maxz);
  }
  /** is there another level crossing on line l within CROSS_GAP of arc length s (built or under construction)? */
  private levelNear(l: RLine, s: number, x: number, z: number): boolean {
    for (const c of this.crossings) if (c.line === l.id && !c.separated && Math.abs(c.s - s) < CROSS_GAP) return true;
    const R = this.w.roads;
    for (const e of R.edgesNear(x, z, CROSS_GAP + 40)) {
      if (!e.alive || e.progress >= 1 || e.bridge || e.deck !== undefined) continue; // finished ones are in this.crossings
      const a = R.nodes[e.a], b = R.nodes[e.b];
      for (let i = 0; i < l.x.length - 1; i++) {
        if (Math.abs(l.cum[i] - s) > CROSS_GAP + 25) continue;
        const h = segInt(a.x, a.z, b.x, b.z, l.x[i], l.z[i], l.x[i + 1], l.z[i + 1]);
        if (h && Math.abs(l.cum[i] + (l.cum[i + 1] - l.cum[i]) * h.u - s) < CROSS_GAP && this.clearance(l, i, h.u, h.x, h.z) < 4.5) return true;
      }
    }
    return false;
  }
  /**
   * Veto for a proposed road segment (idea from the v14 build: the rail is planned against the city and
   * the city respects the rail). Crossings must be nearly square, away from corners, stations and the
   * freight yard, and level crossings must be spaced — so the tracks split the town into "sides" linked
   * by a few gated streets, which later congest and earn viaducts. Arterials cross grade-separated.
   */
  roadCheck(ax: number, az: number, bx: number, bz: number, cls: RoadClass): string | null {
    const hw = ROAD_HALF_WIDTH[cls];
    const L = Math.hypot(bx - ax, bz - az) || 1, dx = bx - ax, dz = bz - az;
    const pad = hw + 12;
    const minx = Math.min(ax, bx) - pad, maxx = Math.max(ax, bx) + pad, minz = Math.min(az, bz) - pad, maxz = Math.max(az, bz) + pad;
    const hits: { x: number; z: number }[] = [];
    for (const l of this.lines) {
      if (l.elevated) continue;
      for (let i = 0; i < l.x.length - 1; i++) {
        if (!this.segBoxHit(l, i, minx, maxx, minz, maxz)) continue;
        const h = segInt(ax, az, bx, bz, l.x[i], l.z[i], l.x[i + 1], l.z[i + 1]);
        if (!h) continue;
        hits.push(h);
        const clr = this.clearance(l, i, h.u, h.x, h.z);
        if (clr > 4.5) continue; // passes under a raised track or a rail bridge
        if (clr > 1.2) return 'trilhos em aterro/rampa: sem altura para passar';
        if (l.kind === 'spur') return 'pátio ferroviário no caminho';
        const rx = l.x[i + 1] - l.x[i], rz = l.z[i + 1] - l.z[i], rl = Math.hypot(rx, rz) || 1;
        if (Math.abs(dx * rz - dz * rx) / (L * rl) < 0.72) return 'cruzamento oblíquo com a ferrovia';
        if (h.t * L < 22 || (1 - h.t) * L < 22) return 'esquina colada aos trilhos';
        const s = l.cum[i] + rl * h.u;
        if (l.stations.some((st) => Math.abs(st.s - s) < 45)) return 'atravessaria a estação';
        if (this.terminal && l.kind === 'main' && Math.abs(this.terminalS - s) < 75) return 'atravessaria o pátio de cargas';
        if (cls >= RoadClass.Avenue) {
          // arterials never get gates: the track is lifted over them, which a station cannot sit on
          if (l.stations.some((st) => Math.abs(st.s - s) < RAIL_RAMP + 30)) return 'viaduto ferroviário cairia sobre a estação';
          continue;
        }
        if (this.levelNear(l, s, h.x, h.z)) return 'passagem de nível próxima demais de outra';
      }
    }
    // don't run hugging the tracks
    for (const t of [0.25, 0.5, 0.75]) {
      const x = ax + dx * t, z = az + dz * t;
      if (hits.some((h) => Math.hypot(h.x - x, h.z - z) < 30)) continue;
      for (const l of this.lines) {
        if (l.elevated) continue;
        for (let i = 0; i < l.x.length - 1; i++) {
          if (!this.segBoxHit(l, i, x - pad, x + pad, z - pad, z + pad)) continue;
          const sx = l.x[i + 1] - l.x[i], sz = l.z[i + 1] - l.z[i], L2 = sx * sx + sz * sz || 1;
          const u = Math.max(0, Math.min(1, ((x - l.x[i]) * sx + (z - l.z[i]) * sz) / L2));
          const px = l.x[i] + sx * u, pz = l.z[i] + sz * u;
          if (Math.hypot(px - x, pz - z) < hw + 7 && this.clearance(l, i, u, px, pz) < 4.5) return 'colada aos trilhos';
        }
      }
    }
    return null;
  }

  private addLine(kind: RLine['kind'], path: P2[], y: number[], tracks: number, elevated: boolean): RLine {
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
    const l: RLine = { id: this.lines.length, kind, x: path.map((p) => p.x), y, z: path.map((p) => p.z), cum, tracks, elevated, len: cum[cum.length - 1], stations: [] };
    this.lines.push(l);
    this.dirtyViews = true;
    return l;
  }

  at(l: RLine, s: number): [number, number, number, number] {
    s = Math.max(0, Math.min(l.len, s));
    let lo = 0, hi = l.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (l.cum[m] <= s) lo = m; else hi = m; }
    const t = (s - l.cum[lo]) / Math.max(1e-6, l.cum[hi] - l.cum[lo]);
    const x = l.x[lo] + (l.x[hi] - l.x[lo]) * t, z = l.z[lo] + (l.z[hi] - l.z[lo]) * t, y = l.y[lo] + (l.y[hi] - l.y[lo]) * t;
    return [x, y, z, Math.atan2(l.z[hi] - l.z[lo], l.x[hi] - l.x[lo])];
  }
  projectS(l: RLine, x: number, z: number): { s: number; d: number } {
    let best = { s: 0, d: Infinity };
    for (let i = 0; i < l.x.length - 1; i++) {
      const ax = l.x[i], az = l.z[i], bx = l.x[i + 1], bz = l.z[i + 1];
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
      if (d < best.d) best = { s: l.cum[i] + Math.sqrt(L2) * t, d };
    }
    return best;
  }

  // ------------------------------------------------------------------ simulation
  step(dt: number) {
    const w = this.w;
    const main = this.lines[0];
    // schedules
    const freightGap = HOUR_SECONDS * (this.terminal ? 2 : 3.5);
    if (w.t - this.lastFreight > freightGap) { if (this.dispatch(main, 'freight')) this.lastFreight = w.t; }
    if (main.stations.length && w.t - this.lastPass > HOUR_SECONDS * (w.era >= 2 ? 1.2 : 2)) { if (this.dispatch(main, 'pass')) this.lastPass = w.t; }
    // metro trains shuttle end to end and are never retired: dispatch only up to the line's fleet (one per ~700 m)
    for (const l of this.lines) if (l.kind === 'metro' && (l.built ?? 1) >= 1 && w.t - this.lastMetro > HOUR_SECONDS * 0.5 && this.trains.filter((t) => t.line === l.id).length < Math.max(2, Math.round(l.len / 700))) { this.dispatch(l, 'metro'); this.lastMetro = w.t; }
    // move
    for (const tr of this.trains) {
      const l = this.lines[tr.line];
      if (tr.dwell > 0) { tr.dwell -= dt; continue; }
      // next stop ahead
      let stopS = Infinity;
      const stops = tr.kind === 'freight' ? (this.terminal && l.kind === 'main' ? [{ s: this.terminalS, b: -1 }] : []) : l.stations;
      for (const st of stops) {
        if (tr.served.has(st.s)) continue;
        const d = (st.s - tr.s) * tr.dir;
        if (d > -1 && d < stopS) stopS = d;
      }
      const brake = 0.6;
      const vTarget = stopS < Infinity ? Math.min(tr.vmax, Math.sqrt(2 * brake * Math.max(0, stopS - 2)) + 0.5) : tr.vmax;
      tr.v += Math.max(-brake * 1.5, Math.min(0.5, vTarget - tr.v)) * dt;
      tr.v = Math.max(0, tr.v);
      tr.s += tr.v * dt * tr.dir;
      if (stopS < 3 && tr.v < 1.2) {
        const st = stops.find((x) => Math.abs(x.s - tr.s) < 4)!;
        if (st) {
          tr.served.add(st.s);
          tr.dwell = tr.kind === 'freight' ? 45 : 22;
          tr.v = 0;
          if (tr.kind === 'freight') { this.freightToday++; w.economy.railBonus = Math.min(2, (w.economy.railBonus ?? 0) + 0.2); }
          else if (l.transit) {
            const k = l.stations.indexOf(st as never);
            if (k >= 0) w.transitSys.serveStop(l.transit, k, tr.id + 100000, 400);
          }
        }
      }
    }
    // end of line
    this.trains = this.trains.filter((tr) => {
      const l = this.lines[tr.line];
      const tail = tr.cars.reduce((s, c) => s + CAR_LEN[c], 0);
      if ((tr.dir > 0 && tr.s > l.len + tail) || (tr.dir < 0 && tr.s < -tail)) {
        if (tr.kind === 'metro') { tr.dir = -tr.dir; tr.served.clear(); tr.s = tr.dir > 0 ? -tail + 1 : l.len + tail - 1; return true; }
        if (l.transit) { const pass = l.transit.onboard.get(tr.id + 100000) ?? []; for (const i of pass) w.citizens.virtualArrive(i, 60); l.transit.onboard.delete(tr.id + 100000); }
        return false;
      }
      return true;
    });
    // level crossings
    if (this.crossVer !== w.roads.topoVer && w.hourIdx % 1 === 0) this.computeCrossings();
    w.traffic.closedCrossings.clear();
    for (const c of this.crossings) {
      const was = c.closed;
      c.closed = false;
      if (c.separated) continue;
      for (const tr of this.trains) {
        if (tr.line !== c.line) continue;
        const tail = tr.cars.reduce((s, k) => s + CAR_LEN[k], 0);
        const d = (c.s - tr.s) * tr.dir;
        if (d > -tail - 10 && d < 160) { c.closed = true; break; }
      }
      if (c.closed) { let a = w.traffic.closedCrossings.get(c.edge); if (!a) w.traffic.closedCrossings.set(c.edge, (a = [])); a.push(c.t); }
      void was;
    }
  }

  private dispatch(l: RLine, kind: Train['kind']): boolean {
    const w = this.w;
    // single track: only one train at a time on the main line
    if (l.kind === 'main' && l.tracks === 1 && this.trains.some((t) => t.line === l.id)) { this.waitingSingle++; return false; }
    const dir = kind === 'metro' ? 1 : w.rng.chance(0.5) ? 1 : -1;
    let cars: number[];
    if (kind === 'freight') {
      const n = 8 + Math.floor(w.rng.next() * 10) + Math.min(10, this.freightToday);
      cars = [0, 0];
      for (let i = 0; i < n; i++) cars.push(2 + Math.floor(w.rng.next() * 3));
    } else if (kind === 'pass') cars = [0, 1, 1, 1, 1];
    else cars = [5, 5, 5, 5];
    const tail = cars.reduce((s, c) => s + CAR_LEN[c], 0);
    const tr: Train = { id: this.nextTrain++, line: l.id, kind, s: dir > 0 ? -5 : l.len + 5, dir, v: kind === 'freight' ? 12 : 18, vmax: kind === 'freight' ? 15 : kind === 'metro' ? 19 : 24, cars, dwell: 0, served: new Set(), gen: 0 };
    void tail;
    this.trains.push(tr);
    this.runs[kind]++;
    if (kind !== 'metro' && w.rng.chance(0.35)) {
      const p = this.at(l, l.len / 2);
      w.events.emit('train', p[0], p[2], kind === 'freight' ? 0.5 : 0.6, kind === 'freight' ? `Trem de carga com ${cars.length - 2} vagões cruza a cidade` : `Trem de passageiros chega à cidade`, { entity: { kind: 'train', id: tr.id }, visual: 0.8 });
    }
    return true;
  }

  trainPose(key: number): { x: number; y: number; z: number; h: number } | null {
    const tr = this.trains.find((t) => t.id === key - 100000);
    if (!tr) return null;
    const p = this.at(this.lines[tr.line], tr.s);
    return { x: p[0], y: p[1] + 2, z: p[2], h: tr.dir > 0 ? p[3] : p[3] + Math.PI };
  }

  fillSnapshot(out: Float32Array): number {
    let n = 0;
    for (const tr of this.trains) {
      const l = this.lines[tr.line];
      let off = 0;
      const side = l.tracks >= 2 ? 2.1 : 0;
      for (const c of tr.cars) {
        if (n >= MAX_TRAIN_CARS) break;
        const s = tr.s - tr.dir * (off + CAR_LEN[c] / 2);
        off += CAR_LEN[c] + 0.8;
        if (s < 0 || s > l.len) continue;
        const p = this.at(l, s);
        const h = tr.dir > 0 ? p[3] : p[3] + Math.PI;
        const o = n * TRAIN_STRIDE;
        out[o] = p[0] - Math.sin(h) * side; out[o + 1] = p[1] + 0.3; out[o + 2] = p[2] + Math.cos(h) * side; out[o + 3] = h;
        out[o + 4] = c; out[o + 5] = tr.id;
        n++;
      }
    }
    return n;
  }
  get count() { return this.trains.length; }

  /** trains index for the director: return index of the first car of a train in the snapshot */
  snapshotIndexOf(trainId: number): number {
    let n = 0;
    for (const tr of this.trains) { if (tr.id === trainId) return n; n += tr.cars.length; }
    return -1;
  }

  // ------------------------------------------------------------------ crossings
  /** daily: fold the queues measured at the gates into a persistent "pressure" per crossing */
  daily() {
    this.runsYday = this.runs; this.runs = { freight: 0, pass: 0, metro: 0 };
    for (const l of this.lines) {
      if ((l.built ?? 1) >= 1) continue;
      // track laid along the corridor a stretch per day (stalled while the works are stalled by corruption)
      const stall = this.w.integrity && this.w.rng.chance(this.w.integrity.index * 0.5);
      if (!stall) l.built = Math.min(1, (l.built ?? 0) + 1 / 14);
      this.dirtyViews = true;
      if (l.built! >= 1) this.openLine(l);
    }
    const W = this.w.traffic.crossWait;
    for (const c of this.crossings) {
      if (c.separated) { c.hot = 0; continue; }
      const e = this.w.roads.edges[c.edge];
      const vol = e ? e.volume[0] + e.volume[1] : 0;
      c.wait = W.get(c.edge) ?? 0;
      // ~8 minutes of stopped vehicles a day, or a busy street, counts as a saturated day
      if (c.wait > 480 || vol > 60) c.hot++; else c.hot = Math.max(0, c.hot - 1);
    }
    W.clear();
  }
  /** for "Por que congestionado?": queue at the gates of this edge, if any */
  gateInfo(edge: number): { wait: number; hot: number; separated: boolean } | null {
    const c = this.crossings.find((k) => k.edge === edge);
    return c ? { wait: c.wait, hot: c.hot, separated: c.separated } : null;
  }

  computeCrossings() {
    const w = this.w, R = w.roads;
    this.crossVer = w.roads.topoVer;
    const old = new Map(this.crossings.map((c) => [`${c.edge}`, c.separated]));
    const prevByS = this.crossings.map((c) => ({ line: c.line, s: c.s, wait: c.wait, hot: c.hot, bypassed: c.bypassed }));
    const out: Crossing[] = [];
    for (const l of this.lines) {
      if (l.elevated) continue;
      for (const e of R.edges) {
        if (!e.alive || e.progress < 1 || e.bridge || e.elevated || e.deck !== undefined) continue;
        const a = R.nodes[e.a], b = R.nodes[e.b];
        const minx = Math.min(a.x, b.x) - 5, maxx = Math.max(a.x, b.x) + 5, minz = Math.min(a.z, b.z) - 5, maxz = Math.max(a.z, b.z) + 5;
        for (let i = 0; i < l.x.length - 1; i++) {
          if (Math.max(l.x[i], l.x[i + 1]) < minx || Math.min(l.x[i], l.x[i + 1]) > maxx || Math.max(l.z[i], l.z[i + 1]) < minz || Math.min(l.z[i], l.z[i + 1]) > maxz) continue;
          const hit = segInt(a.x, a.z, b.x, b.z, l.x[i], l.z[i], l.x[i + 1], l.z[i + 1]);
          if (!hit) continue;
          const s = l.cum[i] + Math.hypot(l.x[i + 1] - l.x[i], l.z[i + 1] - l.z[i]) * hit.u;
          // a track already lifted here (earlier viaduct, rail bridge) needs no gates, whatever the edge id now is
          const raised = this.clearance(l, i, hit.u, hit.x, hit.z) > 4.5;
          out.push({ edge: e.id, t: hit.t, line: l.id, s, x: hit.x, z: hit.z, y: Math.max(0, w.terrain.heightAt(hit.x, hit.z)) + 0.2, angle: Math.atan2(b.z - a.z, b.x - a.x), separated: raised || (old.get(`${e.id}`) ?? false), closed: false, wait: 0, hot: 0 });
        }
      }
    }
    for (const c of out) if (this.underpasses.some((u) => u.line === c.line && Math.abs(u.s - c.s) < 15)) { c.separated = true; c.under = true; }
    for (const c of out) { const p = prevByS.find((q) => q.line === c.line && Math.abs(q.s - c.s) < 12); if (p) { c.wait = p.wait; c.hot = p.hot; c.bypassed = p.bypassed; } }
    this.crossings = out;
    // arterials never get gates: their crossing is built grade-separated
    for (const c of out) {
      const e = R.edges[c.edge];
      if (!c.separated && e.cls < RoadClass.Avenue) this.seat(c);
      if (!c.separated && e.cls >= RoadClass.Avenue && this.canLift(c)) this.separate(c, true);
    }
    this.crossingsDirty = true;
  }
  /** a level crossing needs the rails flush with the street: ease the track down to road level around it */
  private seat(c: Crossing) {
    const l = this.lines[c.line], T = this.w.terrain, R0 = 60;
    let moved = false;
    for (let i = 0; i < l.x.length; i++) {
      const d = Math.abs(l.cum[i] - c.s);
      if (d >= R0) continue;
      const f = 1 - d / R0, wgt = f * f * (3 - 2 * f);
      const target = Math.max(Math.max(0, T.heightAt(l.x[i], l.z[i])) + 0.05, c.y + 0.12);
      const ny = l.y[i] + (target - l.y[i]) * wgt;
      if (Math.abs(ny - l.y[i]) > 0.02) { l.y[i] = ny; moved = true; }
    }
    if (moved) this.dirtyViews = true;
  }
  /** track off the ground around s (a ramp, a viaduct or a bridge) */
  private raisedAt(l: RLine, s: number) {
    for (const ds of [-60, -20, 20, 60]) { const p = this.at(l, s + ds); if (p[1] - Math.max(0, this.w.terrain.heightAt(p[0], p[2])) > 1.6) return true; }
    return false;
  }
  crossingViews(): CrossingView[] {
    return this.crossings.map((c) => {
      const l = this.lines[c.line], e = this.w.roads.edges[c.edge];
      return { x: c.x, z: c.z, y: c.y, angle: c.angle, closed: c.closed, separated: c.separated, under: c.under, hw: e ? ROAD_HALF_WIDTH[e.cls] : 4, rail: this.at(l, c.s)[3], ry: this.at(l, c.s)[1] };
    });
  }
  crossingsSnapshot = (): Uint8Array => { const a = new Uint8Array(this.crossings.length); this.crossings.forEach((c, i) => (a[i] = c.closed ? 1 : 0)); return a; };

  // ------------------------------------------------------------------ views
  railViews(): RailEdgeView[] {
    const out: RailEdgeView[] = [];
    let id = 0;
    for (const l of this.lines) {
      const seg = 8;
      for (let i = 0; i < l.x.length - 1; i += seg) {
        const pts: number[] = [];
        let bridge = false;
        for (let k = i; k <= Math.min(l.x.length - 1, i + seg); k++) {
          pts.push(l.x[k], l.y[k], l.z[k]);
          if (this.w.terrain.heightAt(l.x[k], l.z[k]) < 0.5 || l.y[k] > Math.max(0, this.w.terrain.heightAt(l.x[k], l.z[k])) + 3) bridge = true;
        }
        const s0 = l.cum[i], s1 = l.cum[Math.min(l.x.length - 1, i + seg)], bl = (l.built ?? 1) * l.len;
        const progress = Math.max(0, Math.min(1, (bl - s0) / Math.max(1, s1 - s0)));
        out.push({ id: id++, pts, tracks: l.tracks, progress, bridge: bridge && l.kind !== 'metro', elevated: l.elevated || (bridge && l.kind === 'main' && pts[1] > 3), metro: l.kind === 'metro', spur: l.kind === 'spur' });
      }
    }
    return out;
  }

  /** train noise along the tracks: freight is loud, metro on its viaduct much less; rises with traffic */
  splatNoise(F: World['fields'], noise: Float32Array) {
    const r = this.runsYday;
    for (const l of this.lines) {
      const per = l.kind === 'metro' ? 0.05 + r.metro * 0.012 : l.kind === 'spur' ? 0.1 + r.freight * 0.03 : 0.12 + r.freight * 0.07 + r.pass * 0.035;
      if ((l.built ?? 1) < 1) continue;
      for (let i = 0; i < l.x.length; i++) noise[F.idx(l.x[i], l.z[i])] += per * (l.cum[Math.min(i + 1, l.cum.length - 1)] - l.cum[i] || 20) / 15;
    }
  }

  splatAccess(F: World['fields'], rail: Float32Array, _transit: Float32Array) {
    const main = this.lines[0];
    for (let i = 0; i < main.x.length; i += 3) F.splat(rail, main.x[i], main.z[i], 0.12, 0);
    if (this.terminal) F.splat(rail, this.terminal.x, this.terminal.z, 6, 200);
  }

  // ------------------------------------------------------------------ city hall projects
  projects(): unknown[] {
    const w = this.w;
    const out: unknown[] = [];
    const main = this.lines[0];
    const F = w.fields;
    // passenger station where people live near the line
    if (w.population > 900 && main.stations.length < 1 + Math.floor(w.population / 3500) && !w.buildings.list.some((b) => b.kind === 'railStation' && b.state !== 'done')) {
      let best = -1, bs = 0;
      for (let s = 200; s < main.len - 200; s += 60) {
        if (main.stations.some((st) => Math.abs(st.s - s) < 900)) continue;
        const p = this.at(main, s);
        if (this.raisedAt(main, s)) continue; // platforms can't sit on a viaduct ramp
        const pop = F.sum('resDensity', p[0], p[2], 700) + F.sum('jobDensity', p[0], p[2], 700) * 0.5;
        if (pop > bs) { bs = pop; best = s; }
      }
      if (best >= 0 && bs > 40) out.push({ kind: 'railStation', label: 'Estação ferroviária', motive: `${Math.round(bs)} moradores/empregos a até 700 m da ferrovia`, benefit: 20 + bs / 15, cost: KINDS.railStation.cost, run: () => this.buildStation(best) });
    }
    // freight terminal near industry
    if (!this.terminal && !w.buildings.list.some((b) => b.kind === 'freightTerminal')) {
      const ind = w.buildings.list.filter((b) => b.def.cat === 'ind' && b.state === 'done' && b.kind !== 'farm');
      const jobs = ind.reduce((a, b) => a + b.workers.length, 0);
      if (jobs > 120) {
        let best = -1, bs = 0;
        for (let s = 150; s < main.len - 150; s += 50) {
          const p = this.at(main, s);
          if (this.raisedAt(main, s)) continue;
          let sc = 0;
          for (const b of ind) { const d = Math.hypot(b.x - p[0], b.z - p[2]); if (d < 900) sc += b.workers.length * (1 - d / 900); }
          if (sc > bs) { bs = sc; best = s; }
        }
        if (best >= 0 && bs > 30) out.push({ kind: 'freightTerminal', label: 'Terminal de cargas', motive: `Indústrias com ${jobs} empregos a até 900 m da ferrovia`, benefit: 25 + bs / 10, cost: KINDS.freightTerminal.cost, run: () => this.buildTerminal(best) });
      }
    }
    // duplication of the single track
    if (!this.duplicated && this.waitingSingle > 40 && w.era >= 1) {
      out.push({ kind: 'rail_dup', label: 'Duplicação da ferrovia', motive: `Trens esperando em via singela (${this.waitingSingle} esperas)`, benefit: 30, cost: 2500, run: () => { main.tracks = 2; this.duplicated = true; this.dirtyViews = true; const p = this.at(main, main.len / 2); w.events.emit('rail_build', p[0], p[2], 0.85, 'Ferrovia é duplicada: trens passam a cruzar sem esperar', { headline: 'Linha férrea ganha segunda via', visual: 0.8 }); return true; } });
    }
    // grade separation of level crossings that stay jammed day after day (not a one-off peak)
    let worst: Crossing | null = null;
    for (const c of this.crossings) if (!c.separated && !c.bypassed && c.hot >= 3 && (!worst || c.wait > worst.wait)) worst = c;
    if (worst && w.era >= 1) {
      const c = worst, e = w.roads.edges[c.edge], l = this.lines[c.line];
      if (e?.alive) {
        const min = Math.round(c.wait / 60);
        const motive = `Cancelas da ${e.name} retêm ~${min} min de veículos por dia há ${c.hot} dias`;
        const benefit = 20 + min * 1.2 + c.hot * 2;
        // lifting the track needs long ramps clear of platforms and yards; otherwise the street dips under it
        // a wide street goes over the tracks itself (the at-grade crossing stays for local traffic)
        const plan = e.cls >= RoadClass.Collector && !c.bypassed ? w.structures?.planOverRail(e, c.t) : null;
        if (plan) {
          const cost = w.structures.cost(plan, 'fly');
          out.push({ kind: 'road_viaduct', label: 'Viaduto rodoviário sobre a ferrovia', motive, benefit: benefit * 1.3, cost, run: () => { const k = w.structures.build(plan, 'fly', motive); if (k) c.bypassed = true; return !!k; } });
        } else if (!this.canLift(c))
          out.push({ kind: 'rail_underpass', label: 'Passagem inferior (trincheira)', motive: motive + ' · a estação/pátio impede elevar os trilhos', benefit, cost: 2100, run: () => this.underpass(c) });
        else out.push({ kind: 'rail_viaduct', label: 'Viaduto ferroviário', motive, benefit, cost: 1400, run: () => this.separate(c) });
      }
    }
    // metro in the metropolis
    if (w.era >= 3 && !this.lines.some((l) => l.kind === 'metro') && w.budget.money > 9000) out.push({ kind: 'metro', label: 'Metrô', motive: 'Corredor de maior demanda da metrópole', benefit: 60, cost: 8000, run: () => this.buildMetro() });
    return out;
  }

  private pendingStops = new Map<number, Stop[]>();
  /** a line under construction is finished: trains start and citizens can ride it */
  private openLine(l: RLine) {
    const w = this.w;
    const stops = this.pendingStops.get(l.id);
    if (stops && l.kind === 'metro') {
      l.transit = w.transitSys.addRailLine('metro', 'Metrô Linha 1', stops, l.x.flatMap((x, i) => [x, l.y[i], l.z[i]]), HOUR_SECONDS * 0.5);
      this.pendingStops.delete(l.id);
    }
    const p = this.at(l, l.len / 2);
    w.events.emit('line_opened', p[0], p[2], 1, `${l.kind === 'metro' ? 'Metrô Linha 1' : 'Nova linha férrea'} começa a operar`, { headline: l.kind === 'metro' ? 'Metrô inaugurado: primeira composição parte lotada' : undefined, visual: 1 });
  }

  /** level crossings that would sit on the ramps join the same elevated stretch (one "elevado", not a roller coaster) */
  private stretch(c: Crossing) {
    const group = [c];
    for (let grew = true; grew;) {
      grew = false;
      const lo = Math.min(...group.map((g) => g.s)), hi = Math.max(...group.map((g) => g.s));
      for (const k of this.crossings) {
        if (group.includes(k) || k.line !== c.line || k.under) continue;
        if (k.s > lo - RAIL_RAMP - 10 && k.s < hi + RAIL_RAMP + 10 && hi - lo < 900) { group.push(k); grew = true; }
      }
    }
    return { group, lo: Math.min(...group.map((g) => g.s)), hi: Math.max(...group.map((g) => g.s)) };
  }
  /** can the track be lifted over c? (the whole stretch plus ramps must stay clear of platforms, the yard and line ends) */
  private canLift(c: Crossing) {
    const l = this.lines[c.line], { lo, hi } = this.stretch(c);
    const near = (s: number) => s > lo - RAIL_RAMP - 20 && s < hi + RAIL_RAMP + 20;
    if (l.stations.some((st) => near(st.s))) return false;
    if (l.kind === 'main' && this.terminal && near(this.terminalS)) return false;
    if (this.crossings.some((k) => k.bypassed && k.line === c.line && near(k.s))) return false;
    // a road viaduct above the line here: lifting the track would hit it
    const R = this.w.roads;
    for (const e of R.edges) {
      if (!e.alive || !e.elevated || e.deck === undefined) continue;
      const a = R.nodes[e.a], b = R.nodes[e.b];
      for (let i = 0; i < l.x.length - 1; i++) if (near(l.cum[i]) && segInt(a.x, a.z, b.x, b.z, l.x[i], l.z[i], l.x[i + 1], l.z[i + 1])) return false;
    }
    return lo >= RAIL_RAMP && hi <= l.len - RAIL_RAMP;
  }

  private underpass(c: Crossing): boolean {
    c.separated = true; c.under = true;
    this.underpasses.push({ line: c.line, s: c.s });
    this.crossingsDirty = true;
    const e = this.w.roads.edges[c.edge];
    this.w.events.emit('road_upgrade', c.x, c.z, 0.75, `${e?.name ?? 'A rua'} ganha passagem inferior sob a ferrovia`, { headline: 'Trincheira acaba com a espera nas cancelas', visual: 0.85 });
    return true;
  }

  private separate(c: Crossing, quiet = false): boolean {
    const w = this.w;
    const l = this.lines[c.line];
    const { group, lo, hi } = this.stretch(c);
    const base = Math.max(...group.map((g) => g.y));
    for (const g of group) g.separated = true;
    // lift the rail with long smoothstep ramps (freight trains can't climb steep grades)
    for (let i = 0; i < l.x.length; i++) {
      const s = l.cum[i], d = s < lo ? lo - s : s > hi ? s - hi : 0;
      if (d >= RAIL_RAMP) continue;
      const f = 1 - d / RAIL_RAMP;
      l.y[i] = Math.max(l.y[i], base + LIFT * f * f * (3 - 2 * f));
    }
    this.dirtyViews = true;
    this.crossingsDirty = true;
    const e = w.roads.edges[c.edge];
    if (quiet) w.events.emit('road_upgrade', c.x, c.z, 0.35, `${e?.name ?? 'A via'} passa sob a ferrovia, sem cancelas`, { visual: 0.4 });
    else w.events.emit('road_upgrade', c.x, c.z, 0.8, `Passagem de nível da ${e?.name ?? 'via'} vira viaduto ferroviário`, { headline: 'Fim das cancelas: ferrovia passa por cima da avenida', visual: 0.9 });
    return true;
  }

  private placeAlong(l: RLine, s: number, kind: string, offset: number): Building | null {
    const w = this.w;
    const def = KINDS[kind];
    const bw = def.w[1], bd = def.d[1];
    for (const ds of [0, 60, -60, 120, -120, 200, -200, 300, -300]) for (const extra of [0, 12]) for (const side of [1, -1]) {
      const p = this.at(l, s + ds);
      const nx = -Math.sin(p[3]) * side, nz = Math.cos(p[3]) * side;
      const cx = p[0] + nx * (offset + extra + bd / 2), cz = p[2] + nz * (offset + extra + bd / 2);
      if (!w.occ.rectFree(cx, cz, p[3], bw, bd, true)) continue;
      if (w.terrain.heightAt(cx, cz) < 1) continue;
      const pe = w.roads.nearestEdgePoint(cx, cz, 250, (e) => e.alive && e.progress >= 1 && e.cls !== RoadClass.Highway);
      const c: Candidate = { x: cx, z: cz, angle: p[3], edge: pe ? pe.edge.id : -1, t: pe ? pe.t : 0, side, access: pe ? pe.edge.a : w.roads.nearestNode(cx, cz, 800)?.id ?? 0, offDist: pe ? pe.d : 0, total: 0, terms: {} };
      if (!pe && !w.buildAccessRoad(c, bw, bd)) continue;
      const b = w.buildings.create(kind, c, { era: w.era, day: w.day, w: bw, d: bd, maxDensity: 5, decision: { actor: 'Prefeitura', kind, day: w.day, motive: kind === 'railStation' ? 'Ponto da ferrovia com mais moradores e empregos num raio de 700 m' : 'Ponto da ferrovia mais próximo das indústrias', chosen: c, alternatives: [], sampled: 1 } });
      w.onBuildingStarted(b);
      return b;
    }
    return null;
  }

  private buildStation(s: number): boolean {
    const w = this.w;
    const main = this.lines[0];
    const b = this.placeAlong(main, s, 'railStation', 10);
    if (!b) return false;
    const name = 'Estação ' + w.districtName(b.x, b.z);
    b.name = name;
    main.stations.push({ s: this.projectS(main, b.x, b.z).s, b: b.id, name, stop: main.stations.length });
    main.stations.sort((a, c) => a.s - c.s);
    // register as a transit line (citizens can ride between stations)
    const stops: Stop[] = main.stations.map((st) => { const p = this.at(main, st.s); return { x: p[0], z: p[2], node: -1, s: st.s, name: st.name }; });
    if (!main.transit) main.transit = w.transitSys.addRailLine('rail', 'Trem Regional', stops, [], HOUR_SECONDS * 1.5);
    else { main.transit.stops = stops; w.transitSys.dirty.add(main.transit.id); }
    main.transit.pts = main.x.flatMap((x, i) => [x, main.y[i], main.z[i]]);
    this.dirtyStations.push({ id: b.id, x: b.x, z: b.z, y: b.y, angle: b.angle, len: b.w, kind: 'pass', name });
    w.events.emit('station', b.x, b.z, 0.9, `${name} começa a ser construída`, { headline: `${name}: trem de passageiros vai parar na cidade`, entity: { kind: 'building', id: b.id }, ref: b.id, visual: 0.8 });
    return true;
  }

  private buildTerminal(s: number): boolean {
    const w = this.w;
    const main = this.lines[0];
    const b = this.placeAlong(main, s, 'freightTerminal', 16);
    if (!b) return false;
    this.terminal = b;
    this.terminalS = this.projectS(main, b.x, b.z).s;
    // marshalling yard: a siding parallel to the main line
    const pts: P2[] = [], ys: number[] = [];
    for (let k = -50; k <= 50; k += 10) {
      const p = this.at(main, this.terminalS + k);
      const side = Math.sign((b.x - p[0]) * -Math.sin(p[3]) + (b.z - p[2]) * Math.cos(p[3])) || 1;
      pts.push({ x: p[0] - Math.sin(p[3]) * 8 * side, z: p[2] + Math.cos(p[3]) * 8 * side });
      ys.push(p[1]);
    }
    this.addLine('spur', pts, ys, 2, false);
    w.events.emit('rail_build', b.x, b.z, 0.85, 'Terminal de cargas liga o distrito industrial à ferrovia', { headline: 'Nova linha de carga liga o distrito industrial à ferrovia', entity: { kind: 'building', id: b.id }, ref: b.id, visual: 0.8 });
    return true;
  }

  private buildMetro(): boolean {
    const w = this.w, R = w.roads;
    // corridor between the two densest areas far apart
    const F = w.fields;
    const cells: { k: number; v: number }[] = [];
    for (let k = 0; k < F.G * F.G; k++) cells.push({ k, v: F.f.resDensity[k] + F.f.jobDensity[k] });
    cells.sort((a, b) => b.v - a.v);
    const [ax, az] = F.center(cells[0].k);
    let bx = 0, bz = 0;
    for (const c of cells.slice(1, 200)) { const [x, z] = F.center(c.k); if (Math.hypot(x - ax, z - az) > 1600) { bx = x; bz = z; break; } }
    if (!bx) return false;
    const na = R.nearestNode(ax, az, 300), nb = R.nearestNode(bx, bz, 300);
    if (!na || !nb) return false;
    R.buildBudget = 4;
    const route = R.route(na.id, nb.id);
    if (!route) return false;
    const pts: P2[] = [{ x: na.x, z: na.z }];
    for (const de of route) { const e = R.edges[de >> 1]; const n = R.nodes[(de & 1) === 0 ? e.b : e.a]; pts.push({ x: n.x, z: n.z }); }
    const ys = pts.map((p) => Math.max(0, w.terrain.heightAt(p.x, p.z)) + 9);
    for (let it = 0; it < 4; it++) for (let i = 1; i < ys.length - 1; i++) ys[i] = (ys[i - 1] + ys[i] * 2 + ys[i + 1]) / 4;
    const l = this.addLine('metro', pts, ys, 2, true);
    const stops: Stop[] = [];
    for (let s = 0; s <= l.len; s += 650) {
      const p = this.at(l, s);
      const b = this.placeAlong(l, s, 'metroStation', 6);
      l.stations.push({ s, b: b?.id ?? -1, name: 'Metrô ' + w.districtName(p[0], p[2]), stop: stops.length });
      stops.push({ x: p[0], z: p[2], node: -1, s, name: 'Metrô ' + w.districtName(p[0], p[2]) });
    }
    l.built = 0;
    this.pendingStops.set(l.id, stops);
    w.events.emit('line_opened', ax, az, 1, `Metrô Linha 1 em construção entre ${w.districtName(ax, az)} e ${w.districtName(bx, bz)}`, { headline: 'Metrópole ganha sua primeira linha de metrô', visual: 1 });
    return true;
  }

  /** mark the rail corridor so nothing is built on top of new lines */
  reserve(l: RLine) {
    for (let i = 0; i < l.x.length - 1; i++) {
      const r = this.w.occ.segRect(l.x[i], l.z[i], l.x[i + 1], l.z[i + 1], 6);
      this.w.occ.forRect(r.cx, r.cz, r.angle, r.w, r.d, (k) => { if (k >= 0 && this.w.occ.grid[k] === 0) this.w.occ.grid[k] = OCC_RAIL; });
    }
  }

  // ------------------------------------------------------------------ cargo chains (trucks)
  cargoHourly() {
    const w = this.w;
    if (w.traffic.capacityLeft < 400) return;
    const list = w.buildings.list.filter((b) => b.state === 'done' && !b.abandoned);
    const by = (k: (b: Building) => boolean) => list.filter(k);
    const farms = by((b) => b.kind === 'farm'), food = by((b) => b.kind === 'foodPlant'), shops = by((b) => b.kind === 'com' || b.kind === 'mall' || b.kind === 'restaurant');
    const mines = by((b) => b.kind === 'mine'), steel = by((b) => b.kind === 'steelMill'), fact = by((b) => b.kind === 'factory' || b.kind === 'warehouse');
    const exitB = this.terminal ?? by((b) => b.kind === 'port')[0] ?? null;
    const chains: [Building[], Building[], VType][] = [[farms, food, VType.Truck], [food, shops, VType.Van], [mines, steel, VType.Truck], [steel, fact, VType.Truck], [fact, exitB ? [exitB] : shops, VType.Truck]];
    for (const [src, dst, vt] of chains) {
      if (!src.length || !dst.length) continue;
      const n = Math.min(4, Math.ceil(src.length / 3));
      for (let k = 0; k < n; k++) {
        const a = src[Math.floor(w.rng.next() * src.length)];
        let b = dst[0], bd = Infinity;
        for (const d of dst) { const dd = Math.hypot(d.x - a.x, d.z - a.z) + w.rng.next() * 400; if (dd < bd) { bd = dd; b = d; } }
        const plan = carPlan(w.roads, a, b);
        if (plan) {
          w.traffic.spawn(vt, plan.path, plan.startS, plan.destS, { kind: P_CARGO, id: b.id, aux: a.id }, a.id, b.id);
          w.cargoFlows.push(a.x, a.z, b.x, b.z, vt === VType.Van ? 1 : 2);
          if (w.cargoFlows.length > 600) w.cargoFlows.splice(0, w.cargoFlows.length - 600);
        }
      }
    }
  }

  stationViews(): RailStationView[] { const v = this.dirtyStations; this.dirtyStations = []; return v; }
}
