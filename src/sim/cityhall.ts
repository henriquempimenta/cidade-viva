import { KINDS } from '../shared/catalog';
import { RoadClass } from '../shared/constants';
import type { FieldName } from '../shared/catalog';
import { clamp } from '../shared/rng';
import type { Building, Candidate, Decision } from './buildings';
import { evaluate, profileFor, sampleSites, topAlternatives } from './siting';
import type { World } from './world';

interface Project {
  kind: string;
  label: string;
  motive: string;
  benefit: number;
  cost: number;
  critical?: boolean;
  gapField?: FieldName; // coverage field whose gap this project fills
  radius?: number;
  filter?: (c: Candidate) => boolean;
  run?: () => boolean; // non-building project
  near?: { x: number; z: number; r: number };
}

export interface CityHallLog { day: number; chosen: string[]; rejected: string[]; money: number }

/** Autonomous city hall: detects unmet needs, generates projects, ranks them by cost-benefit, builds. */
export class CityHall {
  log: CityHallLog[] = [];
  lastCrimeReaction = -10;
  queue: string[] = [];
  /** money in/out, newest first (shown in the Prefeitura tab) */
  ledger: { day: number; text: string; value: number }[] = [];
  breakdown = { taxes: 0, tariffs: 0, transfers: 0, tourism: 0, upkeep: 0, roads: 0, staff: 0, transit: 0, interest: 0 };
  constructor(private w: World) {}

  book(text: string, value: number) {
    this.ledger.unshift({ day: this.w.day, text, value: Math.round(value) });
    if (this.ledger.length > 40) this.ledger.pop();
  }

  get money() { return this.w.budget.money; }

  /** daily accounting */
  daily() {
    const w = this.w, B = w.budget, p = w.params;
    let maint = 0;
    for (const b of w.buildings.list) if (b.def.public && b.state === 'done') maint += b.def.maint * 6;
    const upkeep = maint;
    let roadKm = 0;
    for (const e of w.roads.edges) if (e.alive && e.progress >= 1) roadKm += e.len / 1000;
    const roads = roadKm * (10 + w.era * 6), staff = w.population * (0.9 + w.era * 0.45), transit = (w.transitCost?.() ?? 0);
    maint += roads + staff + transit;
    const tariffs = w.population * 0.35 * w.economy.priceIndex; // water/power/garbage fees
    const transfers = (250 + w.population * 0.25) * p.budgetMult; // state & federal transfers
    const municipalTax = w.population * p.taxRate * 18 * w.economy.priceIndex; // IPTU/ISS-like, bounded per capita
    const income = municipalTax * p.budgetMult + tariffs + transfers + (w.tourismTax?.() ?? 0);
    const interest = B.debt * 0.004;
    B.income = income; B.expenses = maint + interest;
    B.money += income - maint - interest;
    const tourism = w.tourismTax?.() ?? 0;
    this.breakdown = { taxes: municipalTax * p.budgetMult, tariffs, transfers, tourism, upkeep, roads, staff, transit, interest };
    this.book('Resultado do dia (receitas − custeio)', income - maint - interest);
    // loans: take when broke and critical needs exist, repay when rich
    if (B.money < -500 && B.debt < 8000 + w.population * 3) {
      const loan = 4000 + w.population;
      B.debt += loan; B.money += loan;
      this.book('Empréstimo contratado', loan);
      w.events.emit('loan', w.center.x, w.center.z, 0.3, `Prefeitura contrai empréstimo de $${Math.round(loan).toLocaleString('pt-BR')}`, { headline: w.rng.chance(0.4) ? 'Prefeitura recorre a empréstimo para manter investimentos' : undefined });
    } else if (B.money > 20000 && B.debt > 0) {
      const pay = Math.min(B.debt, B.money - 15000);
      B.debt -= pay; B.money -= pay;
      if (pay > 0) this.book('Amortização da dívida', -pay);
    }
  }

  /** planning cycle */
  cycle() {
    const w = this.w;
    const projects = this.detectNeeds();
    // rank by benefit / cost (critical first)
    projects.sort((a, b) => (b.critical ? 1e6 : 0) + b.benefit / Math.max(1, b.cost) * 1000 - ((a.critical ? 1e6 : 0) + a.benefit / Math.max(1, a.cost) * 1000));
    let budget = w.budget.money * 0.7 + (w.budget.debt < 4000 ? 2500 : 0);
    const maxWorks = 2 + w.era * 2;
    let active = 0;
    for (const id of w.buildings.underConstruction) { const b = w.buildings.byId.get(id); if (b?.def.public) active++; }
    const chosen: string[] = [], rejected: string[] = [];
    for (const pr of projects) {
      if (active >= maxWorks) { rejected.push(`${pr.label} (limite de obras simultâneas)`); continue; }
      if (pr.cost > budget && !(pr.critical && pr.cost < budget + 6000)) { rejected.push(`${pr.label} (sem orçamento: $${Math.round(pr.cost)})`); continue; }
      const built = pr.run ? null : this.build(pr);
      const ok = pr.run ? pr.run() : !!built;
      if (ok) {
        budget -= pr.cost; w.budget.money -= pr.cost; chosen.push(`${pr.label} — ${pr.motive}`); active++; this.book(pr.label, -pr.cost);
        const leak = w.integrity?.divert(pr.label, pr.cost) ?? 0;
        w.budget.money -= leak;
        if (built) w.integrity?.maybeStall(built);
      }
      else rejected.push(`${pr.label} (sem local viável)`);
    }
    this.log.push({ day: w.day, chosen, rejected: rejected.slice(0, 8), money: w.budget.money });
    if (this.log.length > 60) this.log.shift();
  }

  private has(kind: string) { return this.w.buildings.list.some((b) => b.kind === kind); }
  private count(kinds: string[]) { return this.w.buildings.list.filter((b) => kinds.includes(b.kind)).length; }
  private building(kinds: string[]) { return this.w.buildings.list.some((b) => kinds.includes(b.kind) && b.state !== 'done'); }

  /** uncovered population around a point for a coverage field */
  private uncovered(field: FieldName, x: number, z: number, r: number): number {
    const F = this.w.fields, G = F.G, c = F.cell;
    const res = F.f.resDensity, cov = F.f[field];
    const i0 = Math.max(0, Math.floor((x - r) / c)), i1 = Math.min(G - 1, Math.floor((x + r) / c));
    const j0 = Math.max(0, Math.floor((z - r) / c)), j1 = Math.min(G - 1, Math.floor((z + r) / c));
    let s = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) * c - x, dz = (j + 0.5) * c - z;
      if (dx * dx + dz * dz > r * r) continue;
      const k = j * G + i;
      s += res[k] * Math.max(0, 1 - cov[k]);
    }
    return s;
  }
  private totalUncovered(field: FieldName): number {
    const F = this.w.fields;
    let s = 0;
    for (let k = 0; k < F.G * F.G; k++) s += F.f.resDensity[k] * Math.max(0, 1 - F.f[field][k]);
    return s / 3;
  }

  detectNeeds(): Project[] {
    const w = this.w, U = w.utils, era = w.era, pop = w.population, p = w.params;
    const out: Project[] = [];
    const add = (kind: string, benefit: number, motive: string, extra: Partial<Project> = {}) => {
      const def = KINDS[kind];
      if (!def || def.eraMin > era) return;
      out.push({ kind, label: def.label, motive, benefit, cost: def.cost, ...extra });
    };
    // ---- energy ----
    const pw = U.power;
    const growth = 1.25;
    if (pw.demand * growth > pw.supply && !this.building(['dieselGen', 'thermalPlant', 'hydroPlant', 'windFarm', 'solarFarm', 'nuclearPlant'])) {
      const deficit = pw.demand * growth - pw.supply;
      const motive = `Demanda de energia ${pw.demand.toFixed(0)} MW (+25% de reserva) vs oferta ${pw.supply.toFixed(0)} MW`;
      const crit = pw.demand > pw.supply;
      const opts: [string, number][] = [];
      const clean = 1 - p.pollutionTolerance * 0.7;
      if (era === 0) opts.push(['dieselGen', 1]);
      if (era >= 1) opts.push(['thermalPlant', 1.1 - clean * 0.5 * (p.envPreservation + 0.5)]);
      if (era === 1 && this.count(['dieselGen']) < 6) opts.push(['dieselGen', deficit < 60 ? 0.5 : 0.1]);
      if (era >= 2) opts.push(['hydroPlant', 1.0 + clean * 0.3], ['windFarm', 0.8 + clean * 0.6 * p.envPreservation], ['solarFarm', 0.75 + clean * 0.6 * p.envPreservation]);
      if (era >= 3) opts.push(['nuclearPlant', deficit > 1500 ? 1.2 : 0.3]);
      for (const [k, pref] of opts) {
        const cap = -KINDS[k].power;
        const benefit = Math.min(cap, deficit + 100) / 10 * pref + (crit ? 30 : 0);
        add(k, benefit, motive + ` · escolha por custo-benefício (preferência ${pref.toFixed(2)})`, { critical: crit && k !== 'nuclearPlant', cost: KINDS[k].cost * p.energyCost, filter: k === 'hydroPlant' ? (c) => w.terrain.distToRiver(c.x, c.z) < 140 : undefined });
      }
    }
    // ---- water ----
    const wa = U.water;
    if (wa.demand * 1.2 > wa.supply && !this.building(['well', 'waterPump', 'waterTreatment', 'waterTower'])) {
      const crit = wa.demand > wa.supply;
      const motive = `Consumo de água ${wa.demand.toFixed(0)} vs capacidade ${wa.supply.toFixed(0)}`;
      if (era === 0 && wa.demand < 200) add('well', 20 + (crit ? 30 : 0), motive, { critical: crit });
      add('waterPump', 25 + (crit ? 30 : 0), motive + ' · captação no rio', { critical: crit, filter: (c) => w.terrain.distToRiver(c.x, c.z) < 180 });
      if (era >= 1) add('waterTreatment', 40 + (crit ? 30 : 0), motive + ' · estação de tratamento', { critical: crit });
      if (pop > 400) add('waterTower', 10, 'Reservatório para regularizar a pressão');
    }
    // ---- sewage ----
    if (U.sewage.prod > U.sewage.cap * 0.9 && pop > 500 && !this.building(['sewagePlant'])) {
      const frac = (U.sewage.prod - U.sewage.cap) / Math.max(1, U.sewage.prod);
      add('sewagePlant', 15 + frac * 60 + w.fields.riverPol.reduce((a, b) => Math.max(a, b), 0) * 20, `${Math.round(frac * 100)}% do esgoto vai sem tratamento para o rio`, { filter: (c) => w.terrain.distToRiver(c.x, c.z) < 400 });
    }
    // ---- garbage ----
    const facilities = w.buildings.list.filter((b) => b.def.garbageCap);
    const piles = w.buildings.list.filter((b) => b.garbage > 1.5).length;
    const capUsed = U.garbage.stock / Math.max(1, facilities.reduce((a, b) => a + (b.def.garbageCap ?? 0), 0));
    if ((!facilities.length && pop > 150) || piles > 15 + pop / 100 || capUsed > 0.8) {
      if (!this.building(['dump', 'landfill', 'recycling', 'incinerator'])) {
        const motive = !facilities.length ? 'A cidade não tem destino para o lixo' : piles > 15 ? `${piles} imóveis com lixo acumulado na calçada` : 'Lixão perto da capacidade';
        add(era === 0 ? 'dump' : 'landfill', 25 + piles * 0.5, motive);
        if (era >= 2) { add('recycling', 22 + piles * 0.5 + p.envPreservation * 15, motive + ' · reciclagem'); add('incinerator', 18 + piles * 0.4, motive + ' · incineração'); }
        if (era === 0 && facilities.length) add('dump', 20, motive);
      }
    }
    // ---- health ----
    const hGap = this.totalUncovered('cov_health');
    if (hGap > 20) {
      add('clinic', hGap / 8, `${Math.round(hGap)} moradores sem cobertura de saúde`, { gapField: 'cov_health', radius: 600 });
      if (pop > 2200) add('hospital', hGap / 5 + (this.has('hospital') ? 0 : 20), `${Math.round(hGap)} moradores sem cobertura · cidade sem hospital`, { gapField: 'cov_health', radius: 1500 });
    }
    // ---- education ----
    const kidsOut = w.economy.unservedSchool;
    w.economy.unservedSchool = 0;
    if (kidsOut > 3 || this.totalUncovered('cov_education') > 40) {
      const motive = `${kidsOut} alunos sem vaga`;
      add('school', 10 + kidsOut * 0.8, motive, { gapField: 'cov_education', radius: 800 });
      add('daycare', 5 + kidsOut * 0.2, motive + ' (creche)', { gapField: 'cov_education', radius: 500 });
      if (pop > 900) add('highSchool', 8 + kidsOut * 0.6, motive + ' (ensino médio)', { gapField: 'cov_education', radius: 1200 });
      if (pop > 3500 && !this.has('university')) add('university', 40, 'Formar mão de obra qualificada para a economia', { gapField: 'cov_education', radius: 2500 });
      if (pop > 1200 && this.count(['library']) < pop / 3000) add('library', 8, 'Biblioteca pública', { gapField: 'cov_culture', radius: 900 });
    }
    // ---- police: react to rising crime ----
    const crimeGap = this.crimeGap();
    const trend = w.services.crimeTrend();
    if (crimeGap > 3 || (trend > 2 && w.day - this.lastCrimeReaction > 4)) {
      const hot = this.crimeHotspot();
      add('police', crimeGap * 2 + Math.max(0, trend) * 4 + 6, `Criminalidade em alta${hot ? ` em ${w.districtName(hot.x, hot.z)}` : ''} (ocorrências/dia: ${w.services.crimeHistory.slice(-3).join(', ')})`, { gapField: 'cov_police', radius: 800, near: hot ? { x: hot.x, z: hot.z, r: 700 } : undefined });
      if (pop > 4000 && !this.has('prison')) add('prison', 10, 'Sistema prisional saturado');
    }
    // ---- fire ----
    const fGap = this.totalUncovered('cov_fire');
    if (fGap > 30 && pop > 250) add('fire', fGap / 10 + w.services.firesToday * 5, `${Math.round(fGap)} moradores longe de um quartel de bombeiros`, { gapField: 'cov_fire', radius: 900 });
    // ---- deathcare ----
    if ((w.deathsUnserved > 0 || (!this.has('cemetery') && pop > 250)) && !this.building(['cemetery', 'crematorium'])) {
      add('cemetery', 15 + w.deathsUnserved * 3, w.deathsUnserved ? `${w.deathsUnserved} sepultamentos fora da cidade` : 'A cidade precisa de um cemitério');
      if (era >= 2) add('crematorium', 8 + w.deathsUnserved * 2, 'Cemitério perto da capacidade');
      w.deathsUnserved = 0;
    }
    // ---- parks & brownfields ----
    const pGap = this.totalUncovered('cov_parks');
    if (pGap > 40) {
      if (this.count(['plaza']) < pop / 250 + 2) add('plaza', pGap / 25, `${Math.round(pGap)} moradores sem área verde próxima`, { gapField: 'cov_parks', radius: 350 });
      add('park', pGap / 18, `${Math.round(pGap)} moradores sem área verde próxima`, { gapField: 'cov_parks', radius: 500 });
    }
    const brown = w.buildings.list.find((b) => b.abandoned && b.def.cat === 'ind' && w.fields.sample('soilPollution', b.x, b.z) > 0.5);
    if (brown && w.budget.money > 3000) out.push({ kind: 'park', label: 'Parque em área industrial', motive: `Solo contaminado de ${brown.name} desvaloriza o entorno`, benefit: 18, cost: 900, run: () => this.brownfieldPark(brown) });
    if (pop > 1500 && era >= 1 && this.count(['sportsCenter']) < pop / 4000) add('sportsCenter', 6, 'Equipamento esportivo');
    // ---- culture ----
    if (era >= 1 && this.count(['cinema']) < pop / 4000) add('cinema', 6 + pop / 2000, 'Lazer: a cidade não tem cinema');
    if (era >= 2 && this.count(['theater']) < pop / 8000 + 0.5) add('theater', 8, 'Vida cultural e atração turística');
    if (era >= 2 && !this.has('museum')) add('museum', 10, 'Preservar a história da cidade · atração turística');
    if (era >= 1 && this.count(['postOffice']) < pop / 5000) add('postOffice', 3, 'Correios');
    if (pop > 600 && this.count(['church', 'cathedral']) < pop / 3000 + 1) add('church', 4, 'Nova paróquia');
    // ---- roads: paving and bridges ----
    if (era >= 1) {
      const dirt = w.roads.edges.filter((e) => e.alive && e.progress >= 1 && e.cls === RoadClass.Dirt && !e.upgrading);
      if (dirt.length) out.push({ kind: 'pave', label: 'Pavimentação', motive: `${dirt.length} trechos de terra`, benefit: dirt.length * 0.6, cost: 120, run: () => this.pave(dirt) });
    }
    const bridge = w.bridgeProject?.();
    if (bridge) out.push(bridge as Project);
    for (const pr of w.extraProjects?.() ?? []) out.push(pr as Project);
    // ---- landmarks: when the city is rich ----
    if (era >= 2 && w.budget.money > 18000 && w.budget.debt < 1000) {
      const opts = ['landmarkTower', 'cathedral', 'monument', 'stadium'].filter((k) => !this.has(k) && KINDS[k].eraMin <= era);
      if (opts.length) {
        const k = opts[Math.floor(w.rng.next() * opts.length)];
        add(k, 25, 'Prefeitura com caixa alto investe numa obra-símbolo');
      }
    }
    return out;
  }

  private crimeGap(): number {
    const F = this.w.fields;
    let s = 0;
    for (let k = 0; k < F.G * F.G; k++) if (F.f.crime[k] > 0.3) s += F.f.crime[k] * F.f.resDensity[k] * (1 - Math.min(1, F.f.cov_police[k]));
    return s / 6;
  }
  private crimeHotspot(): { x: number; z: number } | null {
    const F = this.w.fields;
    let best = -1, bs = 0;
    for (let k = 0; k < F.G * F.G; k++) { const s = F.f.crime[k] * (F.f.resDensity[k] + 1) * (1.2 - Math.min(1, F.f.cov_police[k])); if (s > bs) { bs = s; best = k; } }
    if (best < 0) return null;
    const [x, z] = F.center(best);
    return { x, z };
  }

  /** site selection for a public building — same utility machinery as the market, explained by "Por que aqui?" */
  build(pr: Project): Building | null {
    const w = this.w;
    const def = KINDS[pr.kind];
    const bw = w.rng.range(def.w[0], def.w[1]), bd = w.rng.range(def.d[0], def.d[1]);
    let cands = sampleSites(w.siteCtx(), bw, bd, bw * bd > 1600 ? 90 : 45, { offRoad: def.offRoad, nearX: pr.near?.x, nearZ: pr.near?.z, nearR: pr.near?.r, maxSlope: bw * bd > 1600 ? 0.24 : undefined });
    if (pr.filter) cands = cands.filter(pr.filter);
    if (!cands.length) return null;
    const prof = { ...profileFor(pr.kind, 1, w.params) };
    if (pr.kind === 'hydroPlant' || pr.kind === 'waterPump' || pr.kind === 'sewagePlant') prof.river = 1.2;
    if (pr.kind === 'windFarm') prof.windy = 1.4;
    if (pr.kind === 'police') prof.crime = 0.8; // go where crime is
    if (!pr.gapField) { prof.gap = 0; prof.coverageOverlap = 0; prof.centrality = def.undesir > 0.5 ? 0 : 0.6; }
    const same = w.buildings.list.filter((b) => b.kind === pr.kind || (pr.gapField && b.def.service?.type === def.service?.type));
    for (const c of cands) evaluate(w.siteCtx(), c, pr.kind, prof, bw, bd, (cc) => {
      const extra: Record<string, number> = {};
      if (pr.gapField) {
        extra.gap = clamp(this.uncovered(pr.gapField, cc.x, cc.z, pr.radius ?? 600) / 40, 0, 3);
        extra.coverageOverlap = same.some((b) => Math.hypot(b.x - cc.x, b.z - cc.z) < (pr.radius ?? 600) * 0.6) ? 1 : 0;
      }
      return extra;
    });
    cands.sort((a, b) => b.total - a.total);
    const chosen = cands[0];
    const decision: Decision = {
      actor: 'Prefeitura', kind: pr.kind, day: w.day, motive: pr.motive, chosen: { ...chosen, terms: { ...chosen.terms } },
      alternatives: topAlternatives(cands, chosen, 5), sampled: cands.length,
    };
    if (chosen.edge < 0 && !w.buildAccessRoad(chosen, bw, bd)) return null;
    const b = w.buildings.create(pr.kind, chosen, { era: w.era, day: w.day, w: bw, d: bd, maxDensity: 5, decision });
    b.publicProject = pr.motive;
    w.onBuildingStarted(b);
    w.events.emit('city_hall', b.x, b.z, 0.55, `Prefeitura inicia: ${def.label} — ${pr.motive}`, {
      ref: b.id, entity: { kind: 'building', id: b.id }, headline: def.cost >= 900 || pr.kind === 'police' ? `Prefeitura anuncia ${def.label.toLowerCase()}: ${pr.motive.toLowerCase()}` : undefined,
    });
    if (pr.kind === 'police') this.lastCrimeReaction = w.day;
    return b;
  }

  private pave(dirt: import('./roads').REdge[]): boolean {
    const w = this.w;
    let n = 0;
    for (const e of dirt.slice(0, 4)) {
      e.upgrading = true;
      e.upgradeTo = { cls: RoadClass.Local, lanes: 1 };
      e.workP = 0;
      w.roadWorks.set(e.id, { motive: 'Pavimentação', speed: 0.5, kind: 'upgrade' });
      n++;
    }
    if (n) {
      const e = dirt[0], a = w.roads.nodes[e.a];
      w.events.emit('road_upgrade', a.x, a.z, 0.35, `Pavimentação de ${n} trechos de terra`, { entity: { kind: 'edge', id: e.id }, ref: e.id });
    }
    return n > 0;
  }

  private brownfieldPark(b: Building): boolean {
    const w = this.w;
    const cand: Candidate = { x: b.x, z: b.z, angle: b.angle, edge: b.edge, t: b.edgeT, side: b.side, access: b.access, offDist: 0, total: 0, terms: {} };
    evaluate(w.siteCtx(), cand, 'park', profileFor('park', 1, w.params), b.w, b.d);
    const decision: Decision = { actor: 'Prefeitura', kind: 'park', day: w.day, motive: `Reconversão: ${b.name} abandonado com solo contaminado vira parque`, chosen: cand, alternatives: [], sampled: 1 };
    b.pendingRebuild = { kind: 'park', level: 1, wealth: 1, floors: 1, decision, variant: 1 };
    w.evict(b);
    w.buildings.demolish(b);
    w.events.emit('reconversion', b.x, b.z, 0.8, `Antiga ${b.def.label.toLowerCase()} será transformada em parque`, { headline: `Área industrial abandonada vira o Parque ${b.name.split(' ').pop()}`, ref: b.id, visual: 0.8 });
    return true;
  }
}
