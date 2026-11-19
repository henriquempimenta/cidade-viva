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
  forcedBlackout = 0;
  untreated = 0;
  private outfall = -1;

  constructor(private w: World) {
    this.outage = new Uint8Array(w.fields.G * w.fields.G);
  }

  hourly() {
    const w = this.w;
    let ps = 0, pd = 0, ws = 0, wd = 0, sc = 0, gc = 0;
    const plants: Building[] = [];
    const wsrc: Building[] = [];
    for (const b of w.buildings.list) {
      if (b.state !== 'done' || b.abandoned) continue;
      const d = b.def;
      const scale = d.public ? 1 : 1 + b.floors * 0.15;
      if (d.power < 0) { ps += -d.power * (b.kind === 'windFarm' ? 0.5 + w.weather.wind * 0.6 : b.kind === 'solarFarm' ? 0.4 + (1 - w.weather.rain) * 0.6 : 1); plants.push(b); }
      else pd += d.power * scale * (b.households.length ? 1 : 0.6);
      if (d.waterUse < 0) { ws += -d.waterUse; wsrc.push(b); }
      else wd += d.waterUse * scale * 2;
      if (d.sewageCap) sc += d.sewageCap;
      if (d.garbageCap) gc += d.garbageCap;
    }
    this.power = { supply: ps, demand: pd * 4 };
    this.water = { supply: ws, demand: wd * 3 };
    this.sewage = { cap: sc, prod: wd * 2.4 };
    this.garbage.cap = gc;
    // ---- outages: districts far from sources fail first ----
    const F = w.fields, G = F.G;
    this.outage.fill(0);
    const deficitP = this.forcedBlackout > 0 ? 0.6 : Math.max(0, 1 - ps / Math.max(1, this.power.demand));
    const deficitW = Math.max(0, 1 - ws / Math.max(1, this.water.demand));
    const wasBlack = this.blackout, wasDry = this.waterShortage;
    this.blackout = deficitP > 0.02;
    this.waterShortage = deficitW > 0.03;
    const cells: { k: number; dp: number; dw: number; load: number }[] = [];
    if (this.blackout || this.waterShortage) {
      for (let k = 0; k < G * G; k++) {
        const load = F.f.resDensity[k] + F.f.jobDensity[k] * 0.5;
        if (load < 0.05) continue;
        const [x, z] = F.center(k);
        let dp = Infinity, dw = Infinity;
        for (const p of plants) dp = Math.min(dp, Math.hypot(p.x - x, p.z - z));
        for (const p of wsrc) dw = Math.min(dw, Math.hypot(p.x - x, p.z - z));
        cells.push({ k, dp, dw, load });
      }
    }
    const total = cells.reduce((a, c) => a + c.load, 0);
    if (this.blackout) {
      cells.sort((a, b) => b.dp - a.dp);
      let acc = 0;
      for (const c of cells) { if (acc > total * Math.min(0.85, deficitP * 1.3)) break; this.outage[c.k] = 1; acc += c.load; }
    }
    const dry = new Uint8Array(G * G);
    if (this.waterShortage) {
      cells.sort((a, b) => b.dw - a.dw);
      let acc = 0;
      for (const c of cells) { if (acc > total * Math.min(0.85, deficitW * 1.3)) break; dry[c.k] = 1; acc += c.load; }
    }
    for (const b of w.buildings.list) {
      const k = F.idx(b.x, b.z);
      const pw = !this.outage[k], wt = !dry[k];
      if (pw !== b.powered || wt !== b.watered) { b.powered = pw; b.watered = wt; }
    }
    for (let k = 0; k < G * G; k++) { F.f.power[k] = this.outage[k] ? 0 : 1; F.f.waterSupply[k] = dry[k] ? 0 : 1; }
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
    // ---- power lines from remote plants ----
    for (const p of plants) if (!this.lineBuilt.has(p.id) && p.def.cat === 'power') this.buildLine(p);
    for (const l of this.powerLines) if (l.progress < 1) { l.progress = Math.min(1, l.progress + 0.12); this.dirtyLines.add(l.id); }
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

  /** garbage: production, accumulation and collection trucks */
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
    // collection capacity limited by facilities
    const facilities = w.buildings.list.filter((b) => b.def.garbageCap && b.state === 'done');
    let capacity = facilities.reduce((a, b) => a + (b.def.garbageCap ?? 0) * 0.02, 0);
    this.garbage.stock += Math.min(prod, capacity);
    const sorted = w.buildings.list.filter((b) => b.garbage > 0.3).sort((a, b) => b.garbage - a.garbage);
    for (const b of sorted) {
      if (capacity <= 0) break;
      const take = Math.min(b.garbage, capacity);
      b.garbage -= take; capacity -= take;
      if (b.garbage < 0.5 && b.garbage + take >= 1.5) w.buildings.dirty.add(b.id);
    }
    for (const b of w.buildings.list) if (b.garbage > 1.5 && (b.id + w.day) % 3 === 0) w.buildings.dirty.add(b.id);
    // field
    const F = w.fields;
    F.f.garbage.fill(0);
    for (const b of w.buildings.list) if (b.garbage > 1) F.splat(F.f.garbage, b.x, b.z, Math.min(1, (b.garbage - 1) * 0.3), 60);
    // trucks: visible collection rounds
    for (const fac of facilities) {
      for (let k = 0; k < 3; k++) {
        const tgt = sorted[Math.floor(w.rng.next() * Math.min(40, sorted.length))];
        if (!tgt || w.traffic.capacityLeft < 300) break;
        const plan = carPlan(w.roads, fac, tgt);
        if (plan) w.traffic.spawn(VType.Garbage, plan.path, plan.startS, plan.destS, { kind: P_GARBAGE, id: tgt.id, aux: fac.id }, fac.id, tgt.id);
      }
    }
  }

  outageGrid = () => this.outage;
}
