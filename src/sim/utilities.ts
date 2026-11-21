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

  /** strict building -> live road node attachment (b.edge if valid, else immediate <= 45 m lot frontage) */
  private buildingNode(b: Building): number {
    const R = this.w.roads;
    if (b.edge >= 0) {
      const e = R.edges[b.edge];
      if (e?.alive && e.progress >= 1) return e.a;
    }
    const nearNode = R.nearestNode(b.x, b.z, 45, (q) => q.edges.some((id) => R.edges[id]?.alive && R.edges[id].progress >= 1));
    return nearNode ? nearNode.id : -1;
  }

  /** build road-graph connected component Union-Find parent array */
  private buildRoadDSU(): Int32Array {
    const R = this.w.roads;
    const N = R.nodes.length;
    const parent = new Int32Array(N);
    for (let i = 0; i < N; i++) parent[i] = i;
    const find = (x: number): number => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    for (const e of R.edges) {
      if (!e.alive || e.progress < 1) continue;
      const ra = find(e.a), rb = find(e.b);
      if (ra !== rb) parent[rb] = ra;
    }
    return parent;
  }

  private dsuFind(parent: Int32Array, x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }

  private dsuUnion(parent: Int32Array, a: number, b: number) {
    const ra = this.dsuFind(parent, a), rb = this.dsuFind(parent, b);
    if (ra !== rb) parent[rb] = ra;
  }

  hourly() {
    const w = this.w, R = w.roads;
    let ps = 0, pd = 0, ws = 0, wd = 0, sc = 0, gc = 0;
    const activePlants: { b: Building; supply: number; lineNode: number }[] = [];
    const wsrc: { b: Building; supply: number }[] = [];
    const waterDSU = this.buildRoadDSU();
    const powerDSU = waterDSU.slice();
    const liveNode = (q: { edges: number[] }) => q.edges.some((id) => R.edges[id]?.alive && R.edges[id].progress >= 1);

    // 1. Collect sources and bridge components via completed power transmission lines
    for (const b of w.buildings.list) {
      if (b.state !== 'done' || b.abandoned) continue;
      const d = b.def;
      const scale = d.public ? 1 : 1 + b.floors * 0.15;
      if (d.power < 0) {
        if (!this.lineBuilt.has(b.id) && d.cat === 'power' && d.offRoad) this.buildLine(b);
        const lid = this.lineBuilt.get(b.id);
        const lineReady = lid === undefined || lid < 0 || (this.powerLines[lid]?.progress ?? 0) >= 1;
        // remote power plants deliver power only after their transmission line finishes construction
        if (lineReady) {
          const gen = -d.power * (b.kind === 'windFarm' ? 0.5 + w.weather.wind * 0.6 : b.kind === 'solarFarm' ? 0.4 + (1 - w.weather.rain) * 0.6 : 1);
          let lineNode = -1;
          if (lid !== undefined && lid >= 0) {
            const line = this.powerLines[lid];
            if (line && line.progress >= 1 && line.pts.length >= 3) {
              const dst = R.nearestNode(line.pts[line.pts.length - 3], line.pts[line.pts.length - 1], 260, liveNode);
              if (dst) lineNode = dst.id;
            }
          }
          const bn = this.buildingNode(b);
          if (bn >= 0 && lineNode >= 0) this.dsuUnion(powerDSU, bn, lineNode);
          const gridNode = bn >= 0 ? bn : lineNode;
          if (gridNode >= 0) {
            ps += gen;
            activePlants.push({ b, supply: gen, lineNode: gridNode });
          }
        }
      } else pd += d.power * scale * (b.households.length ? 1 : 0.6);
      if (d.waterUse < 0) {
        if (this.buildingNode(b) >= 0) {
          const gen = -d.waterUse;
          ws += gen;
          wsrc.push({ b, supply: gen });
        }
      } else wd += d.waterUse * scale * 2;
      if (d.sewageCap) sc += d.sewageCap;
      if (d.garbageCap) gc += d.garbageCap;
    }
    this.power = { supply: ps, demand: pd * 4 };
    this.water = { supply: ws, demand: wd * 3 };
    this.sewage = { cap: sc, prod: wd * 2.4 };
    this.garbage.cap = gc;

    // 2. Per-connected-component supply, demand, and load-shedding (never cross-subsidizing disconnected islands)
    interface Comp { supply: number; demand: number; sources: Building[]; consumers: { b: Building; dem: number; dist: number }[] }
    const pComps = new Map<number, Comp>();
    const wComps = new Map<number, Comp>();
    const getComp = (m: Map<number, Comp>, root: number): Comp => {
      let c = m.get(root);
      if (!c) m.set(root, (c = { supply: 0, demand: 0, sources: [], consumers: [] }));
      return c;
    };

    for (const p of activePlants) {
      const nid = p.lineNode;
      if (nid < 0) continue;
      const c = getComp(pComps, this.dsuFind(powerDSU, nid));
      c.supply += p.supply;
      c.sources.push(p.b);
    }
    for (const wsItem of wsrc) {
      const nid = this.buildingNode(wsItem.b);
      if (nid < 0) continue;
      const c = getComp(wComps, this.dsuFind(waterDSU, nid));
      c.supply += wsItem.supply;
      c.sources.push(wsItem.b);
    }

    const poweredBuildings = new Set<number>();
    const wateredBuildings = new Set<number>();
    for (const b of w.buildings.list) {
      const nid = this.buildingNode(b);
      const d = b.def;
      const scale = d.public ? 1 : 1 + b.floors * 0.15;
      const activeConsumer = b.state === 'done' && !b.abandoned;
      if (nid >= 0) {
        const pr = this.dsuFind(powerDSU, nid);
        const pc = pComps.get(pr);
        if (d.power < 0) {
          if (pc && pc.sources.length > 0) poweredBuildings.add(b.id);
        } else {
          const dem = activeConsumer ? d.power * scale * (b.households.length ? 1 : 0.6) * 4 : 0;
          if (pc && pc.sources.length > 0) {
            pc.demand += dem;
            pc.consumers.push({ b, dem, dist: 0 });
            poweredBuildings.add(b.id);
          }
        }
        const wr = this.dsuFind(waterDSU, nid);
        const wc = wComps.get(wr);
        if (d.waterUse < 0) {
          if (wc && wc.sources.length > 0) wateredBuildings.add(b.id);
        } else {
          const dem = activeConsumer ? d.waterUse * scale * 2 * 3 : 0;
          if (wc && wc.sources.length > 0) {
            wc.demand += dem;
            wc.consumers.push({ b, dem, dist: 0 });
            wateredBuildings.add(b.id);
          }
        }
      }
    }

    let anyPowerDeficit = this.forcedBlackout > 0 || (pd > 0 && activePlants.length === 0);
    let anyWaterDeficit = wd > 0 && wsrc.length === 0;
    let blackoutPos: [number, number] | null = null;

    // Shed farthest consumers within each deficit power component only
    for (const comp of pComps.values()) {
      const deficit = this.forcedBlackout > 0 ? 0.6 : comp.demand > 0 ? Math.max(0, 1 - comp.supply / comp.demand) : 0;
      if (deficit <= 0.02) continue;
      anyPowerDeficit = true;
      for (const item of comp.consumers) {
        let md = Infinity;
        for (const s of comp.sources) md = Math.min(md, Math.hypot(s.x - item.b.x, s.z - item.b.z));
        item.dist = md;
      }
      comp.consumers.sort((a, b) => b.dist - a.dist || b.b.id - a.b.id);
      const targetShed = Math.max(comp.demand - comp.supply, comp.demand * Math.min(0.95, deficit));
      let shed = 0;
      for (const item of comp.consumers) {
        if (shed >= targetShed && (comp.demand - shed) <= comp.supply) break;
        poweredBuildings.delete(item.b.id);
        if (!blackoutPos) blackoutPos = [item.b.x, item.b.z];
        shed += item.dem;
      }
    }

    // Shed farthest consumers within each deficit water component only
    for (const comp of wComps.values()) {
      const deficit = comp.demand > 0 ? Math.max(0, 1 - comp.supply / comp.demand) : 0;
      if (deficit <= 0.03) continue;
      anyWaterDeficit = true;
      for (const item of comp.consumers) {
        let md = Infinity;
        for (const s of comp.sources) md = Math.min(md, Math.hypot(s.x - item.b.x, s.z - item.b.z));
        item.dist = md;
      }
      comp.consumers.sort((a, b) => b.dist - a.dist || b.b.id - a.b.id);
      const targetShed = Math.max(comp.demand - comp.supply, comp.demand * Math.min(0.95, deficit));
      let shed = 0;
      for (const item of comp.consumers) {
        if (shed >= targetShed && (comp.demand - shed) <= comp.supply) break;
        wateredBuildings.delete(item.b.id);
        shed += item.dem;
      }
    }

    const F = w.fields, G = F.G;
    this.outage.fill(0);
    const dry = new Uint8Array(G * G);
    const connP = new Uint16Array(G * G), discP = new Uint16Array(G * G);
    const connW = new Uint16Array(G * G), discW = new Uint16Array(G * G);
    for (const b of w.buildings.list) {
      const k = F.idx(b.x, b.z);
      const pw = poweredBuildings.has(b.id);
      const wt = wateredBuildings.has(b.id);
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

    const wasBlack = this.blackout, wasDry = this.waterShortage;
    this.blackout = anyPowerDeficit;
    this.waterShortage = anyWaterDeficit;
    if (this.blackout && !wasBlack) {
      const [x, z] = blackoutPos ?? [w.center.x, w.center.z];
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

  onGarbageArrived(targetId: number) {
    this.garbageDispatched.delete(targetId);
  }

  onGarbageStuck(facId: number, targetId: number) {
    this.garbageDispatched.delete(targetId);
    const q = this.garbageQuota.get(facId);
    if (q) q.left++;
  }

  private dispatchGarbageHourly() {
    const w = this.w;
    if (!this.garbageQuota.size || w.traffic.count >= 3000) return;
    const dirty = w.buildings.list.filter((b) => b.garbage > 0.2 && b.state === 'done' && !b.def.public).sort((a, b) => b.garbage - a.garbage);
    if (!dirty.length) return;
    for (const [facId, q] of this.garbageQuota) {
      if (q.left <= 0) continue;
      const fac = w.buildings.byId.get(facId);
      if (!fac || !fac.alive || fac.abandoned || fac.state !== 'done') { q.left = 0; continue; }
      const batch = Math.min(3, q.left);
      let sent = 0;
      for (const tgt of dirty) {
        if (sent >= batch || w.traffic.count >= 3000) break;
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
      const cap = (fac.def.garbageCap ?? 100) * 0.05;
      const rounds = Math.min(24, Math.max(3, Math.ceil(cap / 4)));
      const loadPerTruck = Math.max(4, Math.round((cap / rounds) * 10)); // tenths of garbage units in pAux
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
