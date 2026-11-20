import { KINDS } from '../shared/catalog';
import type { PowerLineView } from '../shared/protocol';
import type { Building } from './buildings';
import type { World } from './world';
import { carPlan } from './trips';
import { P_GARBAGE } from './traffic';
import { VType } from '../shared/constants';

/** Power, water, sewage and garbage: supply vs demand, visible failures. */
export class Utilities {
  power = { supply: 0, demand: 0 };
  water = { supply: 0, demand: 0 };
  sewage = { cap: 0, prod: 0 };
  garbage = { cap: 0, prod: 0, stock: 0 };
  outage: Uint8Array;
  blackout = false;
  waterShortage = false;
  powerLines: PowerLineView[] = [];
  dirtyLines = new Set<number>();
  private lineBuilt = new Map<number, number>(); // plant building -> line id
  private garbageQuota = new Map<number, { left: number; loadPerTruck: number }>();
  private garbageDispatched = new Set<number>();
  forcedBlackout = 0;
  untreated = 0;
  private outfall = -1;

  constructor(private w: World) {
    this.outage = new Uint8Array(w.fields.G * w.fields.G);
  }

  /** road-graph nodes reachable from a set of active utility sources (and their finished transmission endpoints) */
  private reachableNodes(sources: Building[], includeLines = false): Set<number> {
    const R = this.w.roads;
    const vis = new Set<number>();
    const queue: number[] = [];
    const seedPoint = (x: number, z: number) => {
      const n = R.nearestNode(x, z, 260, (q) => q.edges.some((id) => R.edges[id]?.alive && R.edges[id].progress >= 1));
      if (n && !vis.has(n.id)) { vis.add(n.id); queue.push(n.id); }
    };
    for (const s of sources) {
      if (s.edge >= 0 && R.edges[s.edge]?.alive && R.edges[s.edge].progress >= 1) {
        const e = R.edges[s.edge];
        if (!vis.has(e.a)) { vis.add(e.a); queue.push(e.a); }
        if (!vis.has(e.b)) { vis.add(e.b); queue.push(e.b); }
      } else {
        seedPoint(s.x, s.z);
      }
      if (includeLines) {
        const lid = this.lineBuilt.get(s.id);
        if (lid !== undefined && lid >= 0) {
          const line = this.powerLines[lid];
          if (line && line.progress >= 1 && line.pts.length >= 3) {
            seedPoint(line.pts[line.pts.length - 3], line.pts[line.pts.length - 1]);
          }
        }
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const u = queue[head];
      for (const eid of R.nodes[u].edges) {
        const e = R.edges[eid];
        if (!e.alive || e.progress < 1) continue;
        const v = e.a === u ? e.b : e.a;
        if (!vis.has(v)) { vis.add(v); queue.push(v); }
      }
    }
    return vis;
  }

  /** is building `b` physically connected to any active source via the road/distribution network or local proximity? */
  private isConnected(b: Building, sources: Building[], nodes: Set<number>): boolean {
    if (!sources.length) return false;
    const R = this.w.roads;
    if (b.edge >= 0) {
      const e = R.edges[b.edge];
      if (e?.alive && e.progress >= 1 && (nodes.has(e.a) || nodes.has(e.b))) return true;
    }
    const nearNode = R.nearestNode(b.x, b.z, 120, (q) => nodes.has(q.id));
    if (nearNode) return true;
    for (const s of sources) if (Math.hypot(b.x - s.x, b.z - s.z) < 250) return true;
    return false;
  }

  hourly() {
    const w = this.w;
    let ps = 0, pd = 0, ws = 0, wd = 0, sc = 0, gc = 0;
    const activePlants: Building[] = [];
    const wsrc: Building[] = [];
    for (const b of w.buildings.list) {
      if (b.state !== 'done' || b.abandoned) continue;
      const d = b.def;
      const scale = d.public ? 1 : 1 + b.floors * 0.15;
      if (d.power < 0) {
        if (!this.lineBuilt.has(b.id) && d.cat === 'power') this.buildLine(b);
        const lid = this.lineBuilt.get(b.id);
        const lineReady = lid === undefined || lid < 0 || (this.powerLines[lid]?.progress ?? 0) >= 1;
        // remote power plants deliver power only after their transmission line finishes construction
        if (lineReady) {
          ps += -d.power * (b.kind === 'windFarm' ? 0.5 + w.weather.wind * 0.6 : b.kind === 'solarFarm' ? 0.4 + (1 - w.weather.rain) * 0.6 : 1);
          activePlants.push(b);
        }
      } else pd += d.power * scale * (b.households.length ? 1 : 0.6);
      if (d.waterUse < 0) { ws += -d.waterUse; wsrc.push(b); }
      else wd += d.waterUse * scale * 2;
      if (d.sewageCap) sc += d.sewageCap;
      if (d.garbageCap) gc += d.garbageCap;
    }
    this.power = { supply: ps, demand: pd * 4 };
    this.water = { supply: ws, demand: wd * 3 };
    this.sewage = { cap: sc, prod: wd * 2.4 };
    this.garbage.cap = gc;
    // ---- connectivity + load-shedding outages ----
    const F = w.fields, G = F.G;
    this.outage.fill(0);
    const pNodes = this.reachableNodes(activePlants, true);
    const wNodes = this.reachableNodes(wsrc, false);
    const deficitP = this.forcedBlackout > 0 ? 0.6 : Math.max(0, 1 - ps / Math.max(1, this.power.demand));
    const deficitW = Math.max(0, 1 - ws / Math.max(1, this.water.demand));
    const wasBlack = this.blackout, wasDry = this.waterShortage;
    this.blackout = deficitP > 0.02 || (pd > 0 && activePlants.length === 0);
    this.waterShortage = deficitW > 0.03 || (wd > 0 && wsrc.length === 0);
    const cells: { k: number; dp: number; dw: number; load: number }[] = [];
    if (this.blackout || this.waterShortage) {
      for (let k = 0; k < G * G; k++) {
        const load = F.f.resDensity[k] + F.f.jobDensity[k] * 0.5;
        if (load < 0.05) continue;
        const [x, z] = F.center(k);
        let dp = Infinity, dw = Infinity;
        for (const p of activePlants) dp = Math.min(dp, Math.hypot(p.x - x, p.z - z));
        for (const p of wsrc) dw = Math.min(dw, Math.hypot(p.x - x, p.z - z));
        cells.push({ k, dp, dw, load });
      }
    }
    const total = cells.reduce((a, c) => a + c.load, 0);
    const loadOutage = new Uint8Array(G * G);
    if (this.blackout) {
      cells.sort((a, b) => b.dp - a.dp);
      let acc = 0;
      for (const c of cells) { if (acc > total * Math.min(0.85, Math.max(deficitP, activePlants.length ? 0 : 1) * 1.3)) break; loadOutage[c.k] = 1; acc += c.load; }
    }
    const loadDry = new Uint8Array(G * G);
    if (this.waterShortage) {
      cells.sort((a, b) => b.dw - a.dw);
      let acc = 0;
      for (const c of cells) { if (acc > total * Math.min(0.85, Math.max(deficitW, wsrc.length ? 0 : 1) * 1.3)) break; loadDry[c.k] = 1; acc += c.load; }
    }
    this.outage.set(loadOutage);
    const dry = loadDry.slice();
    // evaluate every building against read-only load-shedding grids (never order-dependent)
    const connP = new Uint16Array(G * G), discP = new Uint16Array(G * G);
    const connW = new Uint16Array(G * G), discW = new Uint16Array(G * G);
    for (const b of w.buildings.list) {
      const k = F.idx(b.x, b.z);
      const pw = !loadOutage[k] && this.isConnected(b, activePlants, pNodes);
      const wt = !loadDry[k] && this.isConnected(b, wsrc, wNodes);
      if (pw !== b.powered || wt !== b.watered) { b.powered = pw; b.watered = wt; }
      if (b.state === 'done' && !b.abandoned) {
        if (pw) connP[k]++; else discP[k]++;
        if (wt) connW[k]++; else discW[k]++;
      }
    }
    for (let k = 0; k < G * G; k++) {
      if (discP[k] > 0 && connP[k] === 0) this.outage[k] = 1;
      if (discW[k] > 0 && connW[k] === 0) dry[k] = 1;
      F.f.power[k] = this.outage[k] ? 0 : 1;
      F.f.waterSupply[k] = dry[k] ? 0 : 1;
    }
    if (this.blackout && !wasBlack) {
      const c = cells.find((x) => this.outage[x.k]);
      const [x, z] = c ? F.center(c.k) : [w.center.x, w.center.z];
      w.events.emit('blackout', x, z, 0.9, `Apagão: a demanda de energia (${this.power.demand.toFixed(0)} MW) supera a oferta (${ps.toFixed(0)} MW)`, { headline: `Apagão deixa bairros no escuro; demanda supera a geração`, visual: w.dayFrac > 0.75 || w.dayFrac < 0.25 ? 1 : 0.4 });
    }
    if (this.waterShortage && !wasDry) w.events.emit('water', w.center.x, w.center.z, 0.6, 'Falta d’água atinge bairros afastados das estações', { headline: 'Torneiras secas: falta d’água em bairros da periferia' });
    if (this.forcedBlackout > 0) this.forcedBlackout--;
    // ---- untreated sewage goes to the river ----
    this.untreated = Math.max(0, this.sewage.prod - this.sewage.cap);
    if (this.outfall < 0) this.outfall = w.terrain.riverIndex(w.center.x, w.center.z);
    // ---- power lines from remote plants (advance construction) ----
    for (const l of this.powerLines) if (l.progress < 1) { l.progress = Math.min(1, l.progress + 0.12); this.dirtyLines.add(l.id); }
    // ---- stagger garbage collection dispatches across the day (1–2 trucks/hour/facility) ----
    this.dispatchGarbageHourly();
  }

  private dispatchGarbageHourly() {
    const w = this.w;
    if (!this.garbageQuota.size || w.traffic.capacityLeft < 200) return;
    const dirty = w.buildings.list.filter((b) => b.garbage > 0.3 && b.state === 'done' && !b.def.public).sort((a, b) => b.garbage - a.garbage);
    if (!dirty.length) return;
    for (const [facId, q] of this.garbageQuota) {
      if (q.left <= 0) continue;
      const fac = w.buildings.byId.get(facId);
      if (!fac || !fac.alive || fac.abandoned || fac.state !== 'done') { q.left = 0; continue; }
      const batch = Math.min(2, q.left);
      let sent = 0;
      for (const tgt of dirty) {
        if (sent >= batch || w.traffic.capacityLeft < 200) break;
        if (this.garbageDispatched.has(tgt.id)) continue;
        const plan = carPlan(w.roads, fac, tgt);
        if (!plan) continue;
        const slot = w.traffic.spawn(VType.Garbage, plan.path, plan.startS, plan.destS, { kind: P_GARBAGE, id: tgt.id, aux: q.loadPerTruck }, fac.id, tgt.id);
        if (slot < 0) break; // facility exit lane is occupied right now: retry on the next hour instead of hammering spawn
        this.garbageDispatched.add(tgt.id);
        q.left--;
        sent++;
      }
    }
  }

  riverInput(arr: Float32Array) {
    if (this.outfall >= 0 && this.untreated > 0) arr[Math.min(arr.length - 1, this.outfall)] += this.untreated / 2500;
  }

  private buildLine(p: Building) {
    const w = this.w;
    this.lineBuilt.set(p.id, -1);
    const d = Math.hypot(p.x - w.center.x, p.z - w.center.z);
    if (d < 250) return;
    // line toward the city center, stopping at the urban edge
    const pts: number[] = [];
    const n = Math.max(2, Math.ceil(d / 90));
    const ex = w.center.x + (p.x - w.center.x) * Math.min(1, (w.cityRadius * 0.5) / d), ez = w.center.z + (p.z - w.center.z) * Math.min(1, (w.cityRadius * 0.5) / d);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = p.x + (ex - p.x) * t, z = p.z + (ez - p.z) * t;
      pts.push(x, Math.max(0, w.terrain.heightAt(x, z)), z);
    }
    const id = this.powerLines.length;
    this.powerLines.push({ id, pts, progress: 0 });
    this.lineBuilt.set(p.id, id);
    this.dirtyLines.add(id);
    w.events.emit('power_line', (p.x + ex) / 2, (p.z + ez) / 2, 0.5, `Linha de transmissão sendo esticada desde a ${KINDS[p.kind].label.toLowerCase()}`, { visual: 0.7 });
  }

  /** garbage: production, accumulation and real collection rounds (trucks must actually reach the block) */
  daily() {
    const w = this.w;
    let prod = 0;
    for (const b of w.buildings.list) {
      if (b.state !== 'done' || b.def.public) continue;
      const g = (b.households.length * 0.4 + b.workers.length * 0.15) * 0.1;
      prod += g;
      b.garbage += g;
    }
    this.garbage.prod = prod;
    const facilities = w.buildings.list.filter((b) => b.def.garbageCap && b.state === 'done' && !b.abandoned);
    // set daily collection quota per facility; trucks are dispatched staggered in hourly() so gates never jam
    this.garbageQuota.clear();
    this.garbageDispatched.clear();
    for (const fac of facilities) {
      const cap = (fac.def.garbageCap ?? 100) * 0.02;
      const rounds = Math.min(20, Math.max(2, Math.ceil(cap / 5)));
      const loadPerTruck = Math.max(3, Math.round((cap / rounds) * 10)); // tenths of garbage units in pAux
      this.garbageQuota.set(fac.id, { left: rounds, loadPerTruck });
    }
    // dispatch the first shift right away (1-2 trucks per facility)
    this.dispatchGarbageHourly();
    for (const b of w.buildings.list) if (b.garbage > 1.5 && (b.id + w.day) % 3 === 0) w.buildings.dirty.add(b.id);
    // field reflects real uncollected garbage on the streets
    const F = w.fields;
    F.f.garbage.fill(0);
    for (const b of w.buildings.list) if (b.garbage > 1) F.splat(F.f.garbage, b.x, b.z, Math.min(1, (b.garbage - 1) * 0.3), 60);
  }

  outageGrid = () => this.outage;
}
