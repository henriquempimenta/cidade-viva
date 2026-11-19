import { HOUR_SECONDS, MAX_TRAIN_CARS, RoadClass, TRAIN_STRIDE, VType } from '../shared/constants';
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

interface RLine { id: number; kind: 'main' | 'metro' | 'spur'; x: number[]; y: number[]; z: number[]; cum: number[]; tracks: number; elevated: boolean; len: number; transit?: Line; stations: { s: number; b: number; name: string; stop: number }[] }
interface Train { id: number; line: number; kind: 'pass' | 'freight' | 'metro'; s: number; dir: number; v: number; vmax: number; cars: number[]; dwell: number; served: Set<number>; gen: number }
interface Crossing { edge: number; t: number; line: number; s: number; x: number; z: number; y: number; angle: number; separated: boolean; closed: boolean }

const CAR_LEN = [17, 20, 17, 15, 16, 19];

/** Railways: regional line (freight + passengers), stations, freight terminal, level crossings, duplication, metro. */
export class Rail {
  lines: RLine[] = [];
  trains: Train[] = [];
  crossings: Crossing[] = [];
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

  constructor(private w: World) {
    const T = w.terrain;
    const path = w.railPath;
    const ys = path.map((p) => Math.max(T.heightAt(p.x, p.z), 0));
    for (let it = 0; it < 6; it++) for (let i = 1; i < ys.length - 1; i++) ys[i] = (ys[i - 1] + ys[i] * 2 + ys[i + 1]) / 4;
    const wet = path.map((p) => T.heightAt(p.x, p.z) < T.seaLevel + 0.5);
    const y = ys.map((v, i) => (wet[Math.max(0, i - 1)] || wet[i] || wet[Math.min(ys.length - 1, i + 1)] ? Math.max(v, 6) : v) + 0.4);
    this.addLine('main', path, y, 1, false);
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
    for (const l of this.lines) if (l.kind === 'metro' && w.t - this.lastMetro > HOUR_SECONDS * 0.5) { this.dispatch(l, 'metro'); this.lastMetro = w.t; }
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
  computeCrossings() {
    const w = this.w, R = w.roads;
    this.crossVer = w.roads.topoVer;
    const old = new Map(this.crossings.map((c) => [`${c.edge}`, c.separated]));
    const out: Crossing[] = [];
    for (const l of this.lines) {
      if (l.elevated) continue;
      for (const e of R.edges) {
        if (!e.alive || e.progress < 1 || e.bridge || e.elevated) continue;
        const a = R.nodes[e.a], b = R.nodes[e.b];
        const minx = Math.min(a.x, b.x) - 5, maxx = Math.max(a.x, b.x) + 5, minz = Math.min(a.z, b.z) - 5, maxz = Math.max(a.z, b.z) + 5;
        for (let i = 0; i < l.x.length - 1; i++) {
          if (Math.max(l.x[i], l.x[i + 1]) < minx || Math.min(l.x[i], l.x[i + 1]) > maxx || Math.max(l.z[i], l.z[i + 1]) < minz || Math.min(l.z[i], l.z[i + 1]) > maxz) continue;
          const hit = segInt(a.x, a.z, b.x, b.z, l.x[i], l.z[i], l.x[i + 1], l.z[i + 1]);
          if (!hit) continue;
          const s = l.cum[i] + Math.hypot(l.x[i + 1] - l.x[i], l.z[i + 1] - l.z[i]) * hit.u;
          out.push({ edge: e.id, t: hit.t, line: l.id, s, x: hit.x, z: hit.z, y: Math.max(0, w.terrain.heightAt(hit.x, hit.z)) + 0.2, angle: Math.atan2(b.z - a.z, b.x - a.x), separated: old.get(`${e.id}`) ?? false, closed: false });
        }
      }
    }
    this.crossings = out;
    this.crossingsDirty = true;
  }
  crossingViews(): CrossingView[] { return this.crossings.map((c) => ({ x: c.x, z: c.z, y: c.y, angle: c.angle, closed: c.closed, separated: c.separated })); }
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
        out.push({ id: id++, pts, tracks: l.tracks, progress: 1, bridge: bridge && l.kind !== 'metro', elevated: l.elevated || (bridge && l.kind === 'main' && pts[1] > 3), metro: l.kind === 'metro', spur: l.kind === 'spur' });
      }
    }
    return out;
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
    // grade separation of busy level crossings
    for (const c of this.crossings) {
      if (c.separated) continue;
      const e = w.roads.edges[c.edge];
      if (!e?.alive) continue;
      const vol = e.volume[0] + e.volume[1];
      if (vol > 45 && w.era >= 1) {
        out.push({ kind: 'rail_viaduct', label: 'Viaduto sobre a ferrovia', motive: `Passagem de nível com ${vol.toFixed(0)} veículos/h na ${e.name}`, benefit: vol / 2, cost: 1100, run: () => this.separate(c) });
        break;
      }
    }
    // metro in the metropolis
    if (w.era >= 3 && !this.lines.some((l) => l.kind === 'metro') && w.budget.money > 9000) out.push({ kind: 'metro', label: 'Metrô', motive: 'Corredor de maior demanda da metrópole', benefit: 60, cost: 8000, run: () => this.buildMetro() });
    return out;
  }

  private separate(c: Crossing): boolean {
    const w = this.w;
    const l = this.lines[c.line];
    c.separated = true;
    // lift the rail over the road with smooth ramps
    for (let i = 0; i < l.x.length; i++) {
      const d = Math.abs(l.cum[i] - c.s);
      if (d < 160) l.y[i] = Math.max(l.y[i], c.y + 7.5 * Math.cos((d / 160) * Math.PI / 2) ** 0.6);
    }
    this.dirtyViews = true;
    this.crossingsDirty = true;
    w.events.emit('road_upgrade', c.x, c.z, 0.8, 'Passagem de nível vira viaduto ferroviário', { headline: 'Fim das cancelas: ferrovia passa por cima da avenida', visual: 0.9 });
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
    l.transit = w.transitSys.addRailLine('metro', 'Metrô Linha 1', stops, l.x.flatMap((x, i) => [x, l.y[i], l.z[i]]), HOUR_SECONDS * 0.5);
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
