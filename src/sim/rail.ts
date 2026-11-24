import { HOUR_SECONDS, MAX_TRAIN_CARS, ROAD_HALF_WIDTH, RoadClass, TRAIN_STRIDE, VType } from '../shared/constants';
import { edgeHalfWidth, SIDEWALK_WIDTH } from '../shared/roadGeom';
import type { CrossingView, RailEdgeView, RailStationView } from '../shared/protocol';
import type { Building, Candidate } from './buildings';
import { segRectDist } from './geom';
import { OCC_RAIL } from './occupancy';
import type { P2 } from './regional';
import { segInt } from './roads';
import type { Line, Stop } from './transit';
import { carPlan } from './trips';
import { laneOffset, P_CARGO } from './traffic';
import type { World } from './world';
import { KINDS } from '../shared/catalog';

interface RStation { s: number; b: number; name: string; stop: number; stopId: number }
interface RLine { /** construction progress 0..1 (lines built during the game grow along their length) */ built?: number; id: number; kind: 'main' | 'metro' | 'spur'; x: number[]; y: number[]; z: number[]; cum: number[]; tracks: number; elevated: boolean; len: number; transit?: Line; stations: RStation[]; openStations: RStation[] }
interface Train { id: number; line: number; kind: 'pass' | 'freight' | 'metro'; s: number; dir: number; v: number; vmax: number; cars: number[]; dwell: number; served: Set<number>; gen: number; /** lateral track side (-1..+1 in fixed +s line normal) for smooth post-terminal crossover on double track */ trackSide?: number }
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
  private metroPackedAnnounced = false;
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
    const main = this.addLine('main', path, y, 1, false);
    this.gradeLineTerrain(main);
    w.roads.railCheck = (ax, az, bx, bz, cls) => this.roadCheck(ax, az, bx, bz, cls);
  }

  /** Grade terrain under ground-level stretches of a rail line and re-sync rail elevations cleanly. */
  gradeLineTerrain(l: RLine) {
    if (l.elevated) return;
    const changed = this.w.terraforming.gradeRail(l.x, l.y, l.z, l.tracks, l.elevated);
    const T = this.w.terrain;
    let moved = changed;
    for (let i = 0; i < l.x.length; i++) {
      const gh = T.heightAt(l.x[i], l.z[i]);
      const my = T.meshY(l.x[i], l.z[i]);
      const meshG = Math.max(gh, my);
      if (meshG < T.seaLevel + 0.35) continue;
      if (l.y[i] < meshG + 0.14) {
        l.y[i] = meshG + 0.18;
        moved = true;
      }
    }
    if (changed) {
      // Re-sync any buildings or roads adjacent to the newly graded rail corridor
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < l.x.length; i++) {
        if (l.x[i] < minX) minX = l.x[i];
        if (l.x[i] > maxX) maxX = l.x[i];
        if (l.z[i] < minZ) minZ = l.z[i];
        if (l.z[i] > maxZ) maxZ = l.z[i];
      }
      if (minX <= maxX) {
        const cx = (minX + maxX) * 0.5, cz = (minZ + maxZ) * 0.5;
        const rad = Math.hypot(maxX - minX, maxZ - minZ) * 0.5 + 32;
        this.w.resyncInfrastructureNear(cx, cz, rad);
      }
    }
    if (moved) this.dirtyViews = true;
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
    const l: RLine = { id: this.lines.length, kind, x: path.map((p) => p.x), y, z: path.map((p) => p.z), cum, tracks, elevated, len: cum[cum.length - 1], stations: [], openStations: [] };
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

  /** Synchronize main-line openStations and transit stops strictly with completed (state === 'done') station buildings. */
  syncOpenStations() {
    const w = this.w;
    const main = this.lines[0];
    if (!main) return;
    const prevIds = main.openStations.map((s) => s.b).join(',');
    const open = main.stations.filter((st) => {
      const b = w.buildings.byId.get(st.b);
      return !!b && b.alive && b.state === 'done';
    });
    open.sort((a, c) => a.s - c.s);
    const nextIds = open.map((s) => s.b).join(',');
    if (prevIds === nextIds && (!open.length || !!main.transit)) return;
    main.openStations = open;
    if (!open.length) {
      if (main.transit) w.transitSys.replaceStops(main.transit, []);
      return;
    }
    const stops: Stop[] = open.map((st) => {
      const p = this.at(main, st.s);
      return { id: st.stopId, x: p[0], z: p[2], node: -1, edge: -1, dir: 0, s: st.s, curbX: p[0], curbZ: p[2], ux: Math.cos(p[3]), uz: Math.sin(p[3]), name: st.name };
    });
    if (!main.transit) main.transit = w.transitSys.addRailLine('rail', 'Trem Regional', stops, [], HOUR_SECONDS * 1.5);
    else w.transitSys.replaceStops(main.transit, stops);
    main.transit.pts = main.x.flatMap((x, i) => [x, main.y[i], main.z[i]]);
  }

  // ------------------------------------------------------------------ simulation
  step(dt: number) {
    const w = this.w;
    const main = this.lines[0];
    if (main.stations.length !== main.openStations.length) this.syncOpenStations();
    // schedules
    const freightGap = HOUR_SECONDS * (this.terminal ? 2 : 3.5);
    if (w.t - this.lastFreight > freightGap) { if (this.dispatch(main, 'freight')) this.lastFreight = w.t; }
    if (main.openStations.length && w.t - this.lastPass > HOUR_SECONDS * (w.era >= 2 ? 1.2 : 2)) { if (this.dispatch(main, 'pass')) this.lastPass = w.t; }
    // metro trains shuttle end to end and are never retired: dispatch only up to the line's fleet (one per ~700 m)
    for (const l of this.lines) if (l.kind === 'metro' && (l.built ?? 1) >= 1 && w.t - this.lastMetro > HOUR_SECONDS * 0.5 && this.trains.filter((t) => t.line === l.id).length < Math.max(2, Math.round(l.len / 700))) { this.dispatch(l, 'metro'); this.lastMetro = w.t; }
    // move
    for (const tr of this.trains) {
      const l = this.lines[tr.line];
      if (tr.dwell > 0) { tr.dwell -= dt; continue; }
      // next stop ahead
      let stopS = Infinity;
      const activeStations = l.kind === 'main' ? l.openStations : l.stations;
      const stops = tr.kind === 'freight' ? (this.terminal && l.kind === 'main' ? [{ s: this.terminalS, b: -1 }] : []) : activeStations;
      for (const st of stops) {
        if (tr.served.has(st.s)) continue;
        const d = (st.s - tr.s) * tr.dir;
        if (d > -1 && d < stopS) stopS = d;
      }
      const brake = 0.6;
      const vTarget = stopS < Infinity ? Math.min(tr.vmax, Math.sqrt(2 * brake * Math.max(0, stopS - 2)) + 0.5) : tr.vmax;
      tr.v += Math.max(-brake * 1.5, Math.min(0.5, vTarget - tr.v)) * dt;
      tr.v = Math.max(0, tr.v);
      const dsMove = tr.v * dt;
      tr.s += dsMove * tr.dir;
      // Smoothly transition double-track lateral side over the first ~35 m after departing a terminal reversal
      const targetSide = tr.dir > 0 ? 1 : -1;
      if (tr.trackSide === undefined) tr.trackSide = targetSide;
      else if (tr.trackSide !== targetSide && dsMove > 0) {
        const delta = targetSide - tr.trackSide;
        const maxStep = (2 / 35) * dsMove;
        tr.trackSide += Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
      }
      if (stopS < 3 && tr.v < 1.2) {
        const st = stops.find((x) => Math.abs(x.s - tr.s) < 4)!;
        if (st) {
          tr.served.add(st.s);
          tr.dwell = tr.kind === 'freight' ? 45 : 22;
          tr.v = 0;
          if (tr.kind === 'freight') { this.freightToday++; w.economy.railBonus = Math.min(2, (w.economy.railBonus ?? 0) + 0.2); }
          else if (l.transit) {
            const k = activeStations.indexOf(st as never);
            // riders board only a train heading to their station; capacity follows the consist
            const seats = tr.cars.reduce((n, c) => n + (c === 1 ? 120 : c === 5 ? 150 : 0), 0);
            if (k >= 0) {
              w.transitSys.serveStop(l.transit, k, tr.id + 100000, seats, (to) => (activeStations[to].s - st.s) * tr.dir > 0);
              if (l.kind === 'metro' && !this.metroPackedAnnounced && seats > 0) {
                const onboard = l.transit.onboard.get(tr.id + 100000)?.length ?? 0;
                if (onboard >= seats * 0.75) {
                  this.metroPackedAnnounced = true;
                  const mp = this.at(l, st.s);
                  w.events.emit('line_opened', mp[0], mp[2], 0.9, `Composição do Metrô Linha 1 parte lotada (${onboard} passageiros)`, { headline: 'Metrô registra primeira composição lotada', visual: 0.9 });
                }
              }
            }
          }
        }
      }
    }
    // the line card shows the trains actually running on it (not a stored zero)
    for (const l of this.lines) if (l.transit) l.transit.fleet = this.trains.reduce((n, t) => n + (t.line === l.id && t.kind !== 'freight' ? 1 : 0), 0);
    // end of line
    this.trains = this.trains.filter((tr) => {
      const l = this.lines[tr.line];
      const tail = this.consistSpan(tr.cars);
      if (tr.kind === 'metro') {
        if ((tr.dir > 0 && tr.s >= l.len) || (tr.dir < 0 && tr.s <= 0)) {
          // Bidirectional terminal reversal: move head to the former tail so all cars remain in-place inside [0, l.len]
          // Keep trackSide fixed on the current track throughout the 25 s dwell (smooth crossover begins only after departure)
          const oldDir = tr.dir;
          if (tr.trackSide === undefined) tr.trackSide = oldDir > 0 ? 1 : -1;
          const endS = Math.max(0, Math.min(l.len, tr.s));
          tr.dir = -oldDir;
          tr.cars.reverse();
          tr.s = Math.max(0, Math.min(l.len, endS - oldDir * tail));
          tr.v = 0;
          tr.dwell = Math.max(tr.dwell, 25);
          tr.served.clear();
          // Serve any terminal station covered by the stationary consist for the new return direction
          if (l.transit) {
            const seats = tr.cars.reduce((n, c) => n + (c === 1 ? 120 : c === 5 ? 150 : 0), 0);
            const lo = Math.min(endS, tr.s) - 4;
            const hi = Math.max(endS, tr.s) + 4;
            for (let k = 0; k < l.stations.length; k++) {
              const st = l.stations[k];
              if (st.s >= lo && st.s <= hi) {
                w.transitSys.serveStop(l.transit, k, tr.id + 100000, seats, (to) => (l.stations[to].s - st.s) * tr.dir > 0);
                tr.served.add(st.s);
              }
            }
          }
        }
        return true;
      }
      if ((tr.dir > 0 && tr.s > l.len + tail) || (tr.dir < 0 && tr.s < -tail)) {
        if (l.transit) {
          const pass = l.transit.onboard.get(tr.id + 100000) ?? [];
          for (const i of pass) {
            const r = w.transitSys.rides.get(i);
            w.transitSys.rides.delete(i);
            if (w.citizens.alive[i] && (!r || w.citizens.gen[i] === r.gen)) w.citizens.virtualArrive(i, 60);
          }
          l.transit.onboard.delete(tr.id + 100000);
        }
        return false;
      }
      return true;
    });
    // level crossings (vehicles and pedestrians)
    if (this.crossVer !== w.roads.topoVer && w.hourIdx % 1 === 0) this.computeCrossings();
    w.traffic.closedCrossings.clear();
    w.peds.closedGates.length = 0;
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
      if (c.closed) {
        let a = w.traffic.closedCrossings.get(c.edge);
        if (!a) w.traffic.closedCrossings.set(c.edge, (a = []));
        a.push(c.t);
        const e = w.roads.edges[c.edge];
        const railY = this.at(this.lines[c.line], c.s)[1];
        if (e?.alive) {
          const na = w.roads.nodes[e.a], nb = w.roads.nodes[e.b];
          const el = Math.hypot(nb.x - na.x, nb.z - na.z) || 1;
          w.peds.closedGates.push({
            x: c.x, z: c.z, y: railY,
            ux: (nb.x - na.x) / el, uz: (nb.z - na.z) / el,
            halfW: laneOffset(e, Math.max(0, e.lanes - 1)) + 5,
          });
        } else {
          w.peds.closedGates.push({ x: c.x, z: c.z, y: railY });
        }
      }
      void was;
    }
  }

  /** Total longitudinal span of a consist from front of car 0 to rear of the last car (including 0.8 m couplings). */
  private consistSpan(cars: number[]): number {
    let sum = 0;
    for (let i = 0; i < cars.length; i++) sum += CAR_LEN[cars[i]];
    return sum + 0.8 * Math.max(0, cars.length - 1);
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
    const span = this.consistSpan(cars);
    const startS = kind === 'metro' ? Math.min(l.len, span) : (dir > 0 ? -5 : l.len + 5);
    const tr: Train = {
      id: this.nextTrain++,
      line: l.id,
      kind,
      s: startS,
      dir,
      v: kind === 'metro' ? 0 : kind === 'freight' ? 12 : 18,
      vmax: kind === 'freight' ? 15 : kind === 'metro' ? 19 : 24,
      cars,
      dwell: kind === 'metro' ? 4 : 0,
      served: new Set(),
      gen: 0,
      trackSide: dir > 0 ? 1 : -1,
    };
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
    const l = this.lines[tr.line];
    const span = this.consistSpan(tr.cars);
    const sMid = Math.max(0, Math.min(l.len, tr.s - tr.dir * (span * 0.5)));
    const p = this.at(l, sMid);
    return { x: p[0], y: p[1] + 2, z: p[2], h: tr.dir > 0 ? p[3] : p[3] + Math.PI };
  }

  fillSnapshot(out: Float32Array): number {
    let n = 0;
    for (const tr of this.trains) {
      const l = this.lines[tr.line];
      const sideSign = tr.trackSide ?? (tr.dir > 0 ? 1 : -1);
      const side = l.tracks >= 2 ? 2.1 * sideSign : 0;
      const m = tr.cars.length;
      const carCenters: { s: number; c: number; len: number }[] = [];
      let off = 0;
      for (let k = 0; k < m; k++) {
        const c = tr.cars[k];
        const len = CAR_LEN[c];
        const s = tr.s - tr.dir * (off + len * 0.5);
        off += len + 0.8;
        carCenters.push({ s, c, len });
      }
      // Keep metro car snapshot indices spatially ordered across terminal reversals so interpolation never swaps cars
      if (tr.kind === 'metro' && tr.dir < 0) carCenters.reverse();
      for (let k = 0; k < carCenters.length; k++) {
        if (n >= MAX_TRAIN_CARS) break;
        const { s, c, len } = carCenters[k];
        if (s < 0 || s > l.len) continue;
        const bogieHalf = len * 0.34;
        const sF = Math.max(0, Math.min(l.len, s + tr.dir * bogieHalf));
        const sB = Math.max(0, Math.min(l.len, s - tr.dir * bogieHalf));
        const pF = this.at(l, sF);
        const pB = this.at(l, sB);
        const dx = pF[0] - pB[0];
        const dy = pF[1] - pB[1];
        const dz = pF[2] - pB[2];
        const horiz = Math.hypot(dx, dz);
        let xMid: number, yMid: number, zMid: number, h: number, pitch: number;
        if (horiz > 0.25) {
          xMid = (pF[0] + pB[0]) * 0.5;
          yMid = (pF[1] + pB[1]) * 0.5;
          zMid = (pF[2] + pB[2]) * 0.5;
          h = Math.atan2(dz, dx);
          pitch = Math.atan2(dy, horiz);
        } else {
          const p = this.at(l, s);
          xMid = p[0]; yMid = p[1]; zMid = p[2];
          h = tr.dir > 0 ? p[3] : p[3] + Math.PI;
          pitch = 0;
        }
        const hLine = tr.dir > 0 ? h : h + Math.PI;
        const o = n * TRAIN_STRIDE;
        out[o] = xMid - Math.sin(hLine) * side;
        out[o + 1] = yMid + 0.3;
        out[o + 2] = zMid + Math.cos(hLine) * side;
        out[o + 3] = h;
        out[o + 4] = c;
        out[o + 5] = tr.id;
        out[o + 6] = pitch;
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
    this.syncOpenStations();
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
          const cy = Math.max(0, w.terrain.heightAt(hit.x, hit.z), w.terrain.meshY(hit.x, hit.z)) + 0.2;
          out.push({ edge: e.id, t: hit.t, line: l.id, s, x: hit.x, z: hit.z, y: cy, angle: Math.atan2(b.z - a.z, b.x - a.x), separated: raised || (old.get(`${e.id}`) ?? false), closed: false, wait: 0, hot: 0 });
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
      const g = Math.max(0, T.heightAt(l.x[i], l.z[i]), T.meshY(l.x[i], l.z[i]));
      const target = Math.max(g + 0.16, c.y + 0.12);
      const ny = Math.max(g + 0.14, l.y[i] + (target - l.y[i]) * wgt);
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
        out.push({ id: id++, pts, tracks: l.tracks, progress, bridge: bridge && l.kind !== 'metro', elevated: l.elevated, metro: l.kind === 'metro', spur: l.kind === 'spur' });
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
      out.push({ kind: 'rail_dup', label: 'Duplicação da ferrovia', motive: `Trens esperando em via singela (${this.waitingSingle} esperas)`, benefit: 30, cost: 2500, run: () => { main.tracks = 2; this.duplicated = true; this.gradeLineTerrain(main); this.dirtyViews = true; const p = this.at(main, main.len / 2); w.events.emit('rail_build', p[0], p[2], 0.85, 'Ferrovia é duplicada: trens passam a cruzar sem esperar', { headline: 'Linha férrea ganha segunda via', visual: 0.8 }); return true; } });
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
        const plan = e.cls >= RoadClass.Collector && !c.bypassed && !w.structures?.busy() ? w.structures?.planOverRail(e, c.t) : null;
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
    w.events.emit('line_opened', p[0], p[2], 1, `${l.kind === 'metro' ? 'Metrô Linha 1' : 'Nova linha férrea'} começa a operar`, { headline: l.kind === 'metro' ? 'Metrô Linha 1 inaugurado e entra em operação' : undefined, visual: 1 });
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
    const searchR = Math.hypot(bw, bd) * 0.5 + 35;
    for (const ds of [0, 60, -60, 120, -120, 180, -180, 260, -260, 340, -340, 440, -440]) {
      for (const extra of [0, 10, 22, 34]) {
        for (const side of [1, -1]) {
          const p = this.at(l, s + ds);
          const nx = -Math.sin(p[3]) * side, nz = Math.cos(p[3]) * side;
          const cx = p[0] + nx * (offset + extra + bd / 2), cz = p[2] + nz * (offset + extra + bd / 2);
          // Never place a station/terminal over any road corridor (allowRoad = false)
          if (!w.occ.rectFree(cx, cz, p[3], bw + 2, bd + 2, false)) continue;
          if (w.terrain.heightAt(cx, cz) < 1) continue;
          // Continuous geometric clearance against all nearby active roads (carriageway + sidewalk + margin)
          const ca = Math.cos(p[3]), sa = Math.sin(p[3]);
          let roadConflict = false;
          for (const e of w.roads.edgesNear(cx, cz, searchR)) {
            if (!e.alive || e.deck !== undefined) continue;
            const ea = w.roads.nodes[e.a], eb = w.roads.nodes[e.b];
            if (!ea || !eb) continue;
            const minClr = edgeHalfWidth(e) + SIDEWALK_WIDTH + 0.5;
            if (segRectDist(ea.x - cx, ea.z - cz, eb.x - cx, eb.z - cz, ca, sa, bw * 0.5, bd * 0.5) < minClr) { roadConflict = true; break; }
          }
          if (roadConflict) continue;
          const pe = w.roads.nearestEdgePoint(cx, cz, 250, (e) => e.alive && e.progress >= 1 && e.cls !== RoadClass.Highway);
          const c: Candidate = { x: cx, z: cz, angle: p[3], edge: pe ? pe.edge.id : -1, t: pe ? pe.t : 0, side, access: pe ? pe.edge.a : w.roads.nearestNode(cx, cz, 800)?.id ?? 0, offDist: pe ? pe.d : 0, total: 0, terms: {} };
          if (!pe && !w.buildAccessRoad(c, bw, bd)) continue;
          const b = w.buildings.create(kind, c, { era: w.era, day: w.day, w: bw, d: bd, maxDensity: 5, decision: { actor: 'Prefeitura', kind, day: w.day, motive: kind === 'railStation' ? 'Ponto da ferrovia com mais moradores e empregos num raio de 700 m' : 'Ponto da ferrovia mais próximo das indústrias', chosen: c, alternatives: [], sampled: 1 } });
          w.onBuildingStarted(b);
          return b;
        }
      }
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
    main.stations.push({ s: this.projectS(main, b.x, b.z).s, b: b.id, name, stop: main.stations.length, stopId: w.transitSys.allocStopId() });
    main.stations.sort((a, c) => a.s - c.s);
    // only inaugurate into main.openStations & main.transit once construction finishes (b.state === 'done')
    this.syncOpenStations();
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
    const spur = this.addLine('spur', pts, ys, 2, false);
    this.gradeLineTerrain(spur);
    w.events.emit('rail_build', b.x, b.z, 0.85, 'Terminal de cargas liga o distrito industrial à ferrovia', { headline: 'Nova linha de carga liga o distrito industrial à ferrovia', entity: { kind: 'building', id: b.id }, ref: b.id, visual: 0.8 });
    return true;
  }

  private buildMetro(): boolean {
    const w = this.w, R = w.roads;
    // corridor between the two densest areas, with separation scaled to the actual urban footprint
    const F = w.fields;
    const cells: { k: number; v: number }[] = [];
    for (let k = 0; k < F.G * F.G; k++) {
      const v = F.f.resDensity[k] + F.f.jobDensity[k];
      if (v > 0.25) cells.push({ k, v });
    }
    if (cells.length < 2) return false;
    cells.sort((a, b) => b.v - a.v);
    const [ax, az] = F.center(cells[0].k);
    const minSep = Math.max(700, Math.min(1500, w.cityRadius * 1.15));
    let bx = 0, bz = 0;
    for (const c of cells.slice(1, 350)) { const [x, z] = F.center(c.k); if (Math.hypot(x - ax, z - az) >= minSep) { bx = x; bz = z; break; } }
    if (!bx) return false;
    const na = R.nearestNode(ax, az, 300), nb = R.nearestNode(bx, bz, 300);
    if (!na || !nb || na.id === nb.id) return false;
    R.buildBudget = 4;
    const route = R.route(na.id, nb.id);
    if (!route || route.length < 2) return false;
    const pts: P2[] = [{ x: na.x, z: na.z }];
    for (const de of route) { const e = R.edges[de >> 1]; const n = R.nodes[(de & 1) === 0 ? e.b : e.a]; pts.push({ x: n.x, z: n.z }); }
    const ys = pts.map((p) => Math.max(0, w.terrain.heightAt(p.x, p.z)) + 9);
    for (let it = 0; it < 4; it++) for (let i = 1; i < ys.length - 1; i++) ys[i] = (ys[i - 1] + ys[i] * 2 + ys[i + 1]) / 4;
    const l = this.addLine('metro', pts, ys, 2, true);
    const step = Math.max(450, Math.min(650, l.len / 3));
    const stops: Stop[] = [];
    for (let s = 0; s <= l.len; s += step) {
      const b = this.placeAlong(l, s, 'metroStation', 6);
      if (!b) continue; // never register a phantom stop without an actual station building
      const stS = this.projectS(l, b.x, b.z).s;
      const p = this.at(l, stS);
      const name = 'Metrô ' + w.districtName(b.x, b.z);
      b.name = name;
      const stopId = w.transitSys.allocStopId();
      l.stations.push({ s: stS, b: b.id, name, stop: stops.length, stopId });
      stops.push({ id: stopId, x: p[0], z: p[2], node: -1, edge: -1, dir: 0, s: stS, curbX: p[0], curbZ: p[2], ux: Math.cos(p[3]), uz: Math.sin(p[3]), name });
    }
    if (stops.length < 2) {
      // rollback: remove line and any single station placed
      for (const st of l.stations) { const b = w.buildings.byId.get(st.b); if (b) w.buildings.demolish(b); }
      this.lines.pop();
      this.dirtyViews = true;
      return false;
    }
    l.stations.sort((a, b) => a.s - b.s);
    l.stations.forEach((st, idx) => (st.stop = idx));
    stops.sort((a, b) => a.s - b.s);
    l.built = 0;
    this.pendingStops.set(l.id, stops);
    w.events.emit('line_opened', ax, az, 1, `Metrô Linha 1 em construção entre ${w.districtName(ax, az)} e ${w.districtName(bx, bz)} (${stops.length} estações)`, { headline: 'Metrópole ganha sua primeira linha de metrô', visual: 1 });
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
