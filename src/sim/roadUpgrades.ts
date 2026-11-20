import { RoadClass, ROAD_NAMES } from '../shared/constants';
import { angDiff, projSeg, type REdge, type RNode } from './roads';
import type { World } from './world';

interface Option { label: string; benefit: number; cost: number; ratio: number; feasible: boolean; note: string; apply?: () => void }
export interface UpgradeDecision { day: number; chosen: string; options: Option[]; edge: number }

const PEAK_HOURS = 6; // equivalent hours/day at peak-like load

/**
 * Congestion-driven road upgrades. When an edge stays above v/c 0.85 for several days,
 * the city hall simulates alternatives (BPR travel-time savings) and builds the best one.
 */
export class RoadUpgrades {
  decisions = new Map<number, UpgradeDecision>();
  history: UpgradeDecision[] = [];
  private lastDay = -1;
  constructor(private w: World) {}

  private bpr(t0: number, vol: number, cap: number) { return t0 * (1 + 0.15 * Math.pow(vol / Math.max(1, cap), 4)); }

  /** vehicle-minutes saved per day if capacity of e changes to newCap (and volume factor) */
  private savings(e: REdge, newCap: number, volFactor = 1, speedF = 1): number {
    const R = this.w.roads;
    const cap = R.capacity(e);
    const t0 = e.len / R.freeSpeed(e);
    let s = 0;
    for (const d of [0, 1]) {
      const v = e.volume[d];
      s += v * (this.bpr(t0, v, cap) - this.bpr(t0 / speedF, v * volFactor, newCap)) * PEAK_HOURS;
    }
    return s / 60;
  }

  daily() {
    const w = this.w, R = w.roads;
    if (w.day === this.lastDay) return;
    this.lastDay = w.day;
    const cands = R.edges.filter((e) => e.alive && e.progress >= 1 && !e.upgrading && !e.bridge && e.deck === undefined && e.lat === undefined && e.vcHistory.slice(-4).filter((v) => v > 0.85).length >= 3);
    cands.sort((a, b) => Math.max(...b.volume) / R.capacity(b) - Math.max(...a.volume) / R.capacity(a));
    let done = 0;
    for (const e of cands) {
      if (done >= 1 + (w.era >= 2 ? 1 : 0)) break;
      const dec = this.evaluate(e);
      if (!dec) continue;
      this.decisions.set(e.id, dec);
      this.history.push(dec);
      done++;
    }
    // intersections with long delays even without congested links
    for (const n of R.nodes) {
      // roundabouts are left alone; signals (plain or smart) that stay jammed escalate to a grade separation
      if (!n.alive || n.deck || n.edges.length < 3 || n.delay < 25 || n.control === 3 || w.structures.flown.has(n.id)) continue;
      const opt = this.junctionOptions(n);
      const best = opt.filter((o) => o.feasible).sort((a, b) => b.ratio - a.ratio)[0];
      // big works are judged by payback: vehicle-minutes saved valued at ~0.5/min must repay the work in ~10 years
      // (120 days) and the treasury must keep a margin
      const big = !!best && best.cost > 3000;
      if (best && (big ? best.ratio > 1 / 60 && w.budget.money > best.cost * 1.3 && !w.structures.busy() : best.ratio > 0.4 && w.budget.money > best.cost)) {
        best.apply!();
        w.budget.money -= best.cost;
        const dec: UpgradeDecision = { day: w.day, chosen: best.label, options: opt.map(strip), edge: n.edges[0] };
        for (const id of n.edges) this.decisions.set(id, dec);
        if (!/^(Elevado|Túnel)/.test(best.label)) w.events.emit('road_upgrade', n.x, n.z, 0.55, `${best.label} no cruzamento (espera média ${n.delay.toFixed(0)} s)`, { ref: n.id, headline: w.rng.chance(0.4) ? `Cruzamento congestionado ganha ${best.label.toLowerCase()}` : undefined, visual: 0.6 });
        break;
      }
    }
  }

  evaluate(e: REdge): UpgradeDecision | null {
    const w = this.w, R = w.roads;
    const a = R.nodes[e.a], b = R.nodes[e.b];
    const cap = R.capacity(e);
    const opts: Option[] = [];
    // 1. widen
    {
      const lanes = e.lanes + 1;
      const feasible = lanes <= (e.cls === RoadClass.Highway ? 4 : 3) && !e.oneway;
      const nc = cap * lanes / e.lanes;
      const benefit = this.savings(e, nc);
      const cost = e.len * (2.5 + lanes) * (lanes >= 3 ? 1.8 : 1);
      const newCls = e.cls < RoadClass.Collector ? RoadClass.Collector : e.cls < RoadClass.Avenue && lanes >= 2 ? RoadClass.Avenue : e.cls;
      opts.push({ label: lanes >= 2 && e.cls < RoadClass.Avenue ? 'Alargar para avenida com canteiro' : 'Alargar a via (+1 faixa)', benefit, cost, ratio: benefit / cost, feasible, note: feasible ? `${e.lanes}→${lanes} faixas por sentido` : 'sem espaço lateral',
        apply: () => this.startWork(e, { lanes, cls: newCls }, 'Alargamento') });
    }
    // 2. one-way pair with a parallel street
    const par = this.parallel(e);
    {
      const feasible = !!par && !e.oneway && !par.oneway && e.cls <= RoadClass.Collector && par.cls <= RoadClass.Collector;
      const benefit = feasible ? this.savings(e, cap * 1.7) + this.savings(par!, R.capacity(par!) * 1.7) * 0.5 : 0;
      const cost = (e.len + (par?.len ?? 0)) * 0.6 + 60;
      opts.push({ label: 'Binário de mão única', benefit, cost, ratio: benefit / cost, feasible, note: feasible ? `com a ${par!.name}` : 'sem paralela adequada', apply: () => this.oneWayPair(e, par!) });
    }
    // 3. parallel relief road
    const relief = this.reliefPlan(e);
    {
      const feasible = !!relief;
      const benefit = feasible ? this.savings(e, cap, 0.62) : 0;
      const cost = relief ? relief.len * 3 + 80 : 0;
      opts.push({ label: 'Abrir via paralela', benefit, cost: cost || 1, ratio: feasible ? benefit / cost : 0, feasible, note: feasible ? `${relief!.len.toFixed(0)} m de nova via` : 'sem corredor livre',
        apply: () => { const ne = R.applyPlan(relief!, { progress: 0, day: w.day, name: R.streetName(RoadClass.Collector) }); w.onRoadStarted(ne, 'Via paralela para desafogar ' + e.name); } });
    }
    // 4. junction treatment at the busiest end
    const node = a.delay > b.delay ? a : b;
    for (const o of this.junctionOptions(node)) opts.push(o);
    // 5. bus lane / BRT when buses run here and the road is wide
    if (e.lanes >= 2 && !e.busLane && w.transitAPI?.ridersOn(e.id)) {
      const riders = w.transitAPI.ridersOn(e.id);
      const benefit = riders * 0.6 - this.savings(e, cap * 0.8) * -1 * 0.2;
      opts.push({ label: 'Faixa exclusiva de ônibus (BRT)', benefit, cost: e.len * 1.2, ratio: benefit / (e.len * 1.2), feasible: true, note: `${riders} passageiros/dia na linha`, apply: () => this.busLane(e) });
    }
    // 6. bypass / ring road for congested highways through the city
    if (e.cls === RoadClass.Highway && w.era >= 2) {
      const benefit = this.savings(e, cap, 0.55) * 1.5;
      opts.push({ label: 'Contorno rodoviário', benefit, cost: 4000, ratio: benefit / 4000, feasible: w.budget.money > 6000, note: 'tira o tráfego de passagem do centro', apply: () => w.buildBypass?.() });
    }
    const feasible = opts.filter((o) => o.feasible && o.benefit > 0);
    feasible.sort((x, y) => y.ratio - x.ratio);
    const best = feasible[0];
    const money = w.budget.money;
    if (!best || (best.cost > money * 0.8 && best.cost > 250) || best.cost > money + 2000) {
      return { day: w.day, chosen: best ? `${best.label} (adiado: sem orçamento)` : 'nenhuma alternativa viável', options: opts.map(strip), edge: e.id };
    }
    best.apply!();
    w.budget.money -= best.cost;
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const vc = Math.max(...e.volume) / cap;
    w.events.emit('road_upgrade', mid.x, mid.z, 0.75, `${best.label}: ${e.name} operava a ${(vc * 100).toFixed(0)}% da capacidade em ${e.vcHistory.slice(-4).filter((v) => v > 0.85).length} dos últimos 4 dias`, {
      entity: { kind: 'edge', id: e.id }, ref: e.id, visual: 0.8,
      headline: `Congestionamento crônico na ${e.name} leva prefeitura a ${best.label.toLowerCase()}`,
    });
    e.congestedDays = 0;
    e.vcHistory = [];
    return { day: w.day, chosen: best.label, options: opts.map(strip), edge: e.id };
  }

  private junctionOptions(n: RNode): Option[] {
    const w = this.w, R = this.w.roads;
    const out: Option[] = [];
    if (n.edges.length < 3) return out;
    const flow = n.edges.reduce((s, id) => s + R.edges[id].volume[0] + R.edges[id].volume[1], 0);
    const delayMin = (n.delay * flow * PEAK_HOURS) / 60;
    const clsMax = Math.max(...n.edges.map((id) => R.edges[id].cls));
    const clsMin = Math.min(...n.edges.map((id) => R.edges[id].cls));
    if (n.control < 2) out.push({ label: 'Semáforo', benefit: delayMin * 0.5, cost: 60, ratio: (delayMin * 0.5) / 60, feasible: true, note: `espera média ${n.delay.toFixed(0)} s`, apply: () => this.setControl(n, 2) });
    if (n.control !== 3 && clsMax <= RoadClass.Collector && n.edges.length <= 4) out.push({ label: 'Rotatória', benefit: delayMin * 0.6, cost: 220, ratio: (delayMin * 0.6) / 220, feasible: this.roundaboutSpace(n), note: 'fluxo contínuo em vias locais', apply: () => this.setControl(n, 3) });
    if (n.control === 2 && w.era >= 2) out.push({ label: 'Semáforo inteligente', benefit: delayMin * 0.35, cost: 150, ratio: (delayMin * 0.35) / 150, feasible: true, note: 'tempos adaptados às filas', apply: () => this.setControl(n, 4) });
    // grade separation: only where a straight wide axis crosses the junction and only after signals failed
    if ((n.control === 2 || n.control === 4) && w.era >= 1 && clsMax >= RoadClass.Collector) {
      const axis = this.axis(n);
      const plan = axis && w.structures.planJunction(n, axis[0], axis[1]);
      if (axis && plan) {
        // the main flow stops queueing and the signal is left to the cross street: most of the delay goes
        const b = delayMin * 0.85;
        const kind = w.structures.prefers(plan), cost = w.structures.cost(plan, kind);
        const label = kind === 'fly' ? 'Elevado sobre o cruzamento' : 'Túnel sob o cruzamento';
        out.push({ label, benefit: b, cost, ratio: b / cost, feasible: w.budget.money > cost * 1.3, note: kind === 'fly' ? `o fluxo da ${axis[0].name} passa por cima (${Math.round(plan.len)} m)` : `bairro valorizado recusa elevado: túnel de ${Math.round(plan.len)} m`,
          apply: () => { w.structures.build(plan, kind, `espera média de ${n.delay.toFixed(0)} s no semáforo`); } });
      } else if (axis && !plan) out.push({ label: 'Elevado sobre o cruzamento', benefit: 0, cost: 0, ratio: 0, feasible: false, note: w.structures.why || 'sem trecho para as rampas', apply: () => {} });
    }
    return out;
  }

  /** the straight through-axis of a junction: two opposite arms, the busiest pair of wide roads */
  private axis(n: RNode): [REdge, REdge] | null {
    const R = this.w.roads;
    const inc = n.edges.map((id) => R.edges[id]).filter((e) => e.alive && e.progress >= 1 && e.deck === undefined);
    let best: [REdge, REdge] | null = null, bv = 0;
    for (let i = 0; i < inc.length; i++) for (let j = i + 1; j < inc.length; j++) {
      const a = inc[i], b = inc[j];
      if (Math.abs(angDiff(R.angleOf(a, n.id), R.angleOf(b, n.id)) - Math.PI) > 0.45) continue;
      if (Math.min(a.cls, b.cls) < RoadClass.Collector) continue;
      const v = Math.min(a.volume[0] + a.volume[1], b.volume[0] + b.volume[1]);
      if (v > bv) { bv = v; best = [a, b]; }
    }
    return best;
  }

  private roundaboutSpace(n: RNode): boolean {
    return this.w.occ.rectFree(n.x, n.z, 0, 14, 14, true);
  }

  setControl(n: RNode, c: number) {
    n.control = c;
    n.phases = [];
    this.w.roads.updateNodeGeom(n);
    this.w.roads.topoVer++;
  }

  interchange(n: RNode) {
    n.interchange = true;
    n.control = 0;
    this.w.roads.updateNodeGeom(n);
    this.w.roads.topoVer++;
    this.w.events.emit('road_upgrade', n.x, n.z, 0.8, 'Viaduto em construção no cruzamento', { visual: 0.9, headline: 'Novo viaduto elimina cruzamento em nível' });
  }

  private startWork(e: REdge, to: Partial<REdge>, motive: string) {
    e.upgrading = true;
    e.upgradeTo = to;
    e.workP = 0;
    this.w.roadWorks.set(e.id, { motive, speed: 0.35, kind: 'upgrade' });
    this.w.roads.dirtyEdges.add(e.id);
  }

  private busLane(e: REdge) { this.startWork(e, { busLane: true }, 'Faixa de ônibus'); }

  private oneWayPair(e: REdge, p: REdge) {
    const R = this.w.roads;
    // directions opposite: compare orientation
    const [ex, ez] = dirv(R, e), [px, pz] = dirv(R, p);
    const same = ex * px + ez * pz > 0;
    const before = [e.oneway, p.oneway, e.lanes, p.lanes, p.a, p.b];
    e.oneway = 1; p.oneway = 1;
    if (same) { const t = p.a; p.a = p.b; p.b = t; R.computePts(p); }
    e.lanes = e.lanes * 2; p.lanes = p.lanes * 2;
    R.topoVer++;
    // keep the network strongly connected: test reachability both ways
    const ok = R.route(e.a, e.b) && R.route(e.b, e.a) && R.route(p.a, p.b) && R.route(p.b, p.a);
    if (!ok) {
      [e.oneway, p.oneway, e.lanes, p.lanes, p.a, p.b] = before;
      R.computePts(p);
      R.topoVer++;
      return;
    }
    R.dirtyEdges.add(e.id); R.dirtyEdges.add(p.id);
  }

  private parallel(e: REdge): REdge | null {
    const R = this.w.roads;
    const a = R.nodes[e.a], b = R.nodes[e.b];
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const ang = Math.atan2(b.z - a.z, b.x - a.x);
    let best: REdge | null = null, bd = Infinity;
    for (const o of R.edgesNear(mx, mz, 170)) {
      if (o.id === e.id || !o.alive || o.progress < 1 || o.a === e.a || o.a === e.b || o.b === e.a || o.b === e.b) continue;
      const oa = R.nodes[o.a], ob = R.nodes[o.b];
      const d = angDiff(Math.atan2(ob.z - oa.z, ob.x - oa.x), ang);
      if (Math.min(d, Math.PI - d) > 0.3) continue;
      const p = projSeg(mx, mz, oa.x, oa.z, ob.x, ob.z);
      if (p.d < 45 || p.d > 170) continue;
      if (p.d < bd) { bd = p.d; best = o; }
    }
    return best;
  }

  private reliefPlan(e: REdge) {
    const R = this.w.roads;
    const a = R.nodes[e.a], b = R.nodes[e.b];
    const ux = (b.x - a.x) / e.len, uz = (b.z - a.z) / e.len;
    for (const side of [1, -1]) for (const off of [80, 110, 140]) {
      const na = R.nearestNode(a.x - uz * off * side, a.z + ux * off * side, 45);
      if (!na) continue;
      const tx = b.x - uz * off * side, tz = b.z + ux * off * side;
      const plan = R.planSegment(na.id, tx, tz, RoadClass.Collector, {});
      if (plan.ok) return plan;
    }
    return null;
  }
}

function strip(o: Option) { return { label: o.label, benefit: o.benefit, cost: o.cost, ratio: o.ratio, feasible: o.feasible, note: o.note }; }
function dirv(R: World['roads'], e: REdge): [number, number] { const a = R.nodes[e.a], b = R.nodes[e.b]; return [(b.x - a.x) / e.len, (b.z - a.z) / e.len]; }
export const CLS_NAMES = ROAD_NAMES;
