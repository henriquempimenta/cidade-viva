import { KINDS } from '../shared/catalog';
import { HOUR_SECONDS } from '../shared/constants';
import { clamp } from '../shared/rng';
import type { Building } from './buildings';
import type { Household } from './citizens';
import type { World } from './world';

const WAGE = [38, 62, 105, 190];

interface Immigrant { wealth: number; size: number; tries: number }

/** Jobs, schools, housing market, business accounts and RCI demand. */
export class Economy {
  seekers = new Set<number>();
  private vacancyList: Building[] = [];
  private homeVac: Building[][] = [[], [], []];
  unservedShopping = 0;
  pending: Immigrant[] = [];
  movers: { h: Household; reason: string; since: number }[] = [];
  priceIndex = 1;
  gdpToday = 0; gdp = 0;
  wagesToday = 0;
  taxToday = 0;
  unservedSchool = 0;
  homelessDemand = [0, 0, 0];
  jobsTotal = 0; vacancies = 0; employed = 0; unemployed = 0; students = 0;
  avgIncome = 0;
  exportDemand = 0;
  crisis = 0; // >0 during injected economic crisis
  boomQueue = 0;
  railBonus = 0;

  constructor(private w: World) {}

  wage(edu: number) { return WAGE[edu] * this.priceIndex * (1 + this.w.era * 0.12) * (this.crisis > 0 ? 0.85 : 1); }

  seekJobSoon(i: number) { if (this.w.citizens.job[i] < 0) this.seekers.add(i); }

  leaveJob(i: number) {
    const C = this.w.citizens;
    const b = this.w.buildings.byId.get(C.job[i]);
    if (b) b.workers = b.workers.filter((x) => x !== i);
    C.job[i] = -1; C.income[i] = 0;
    if (C.alive[i] && C.age[i] >= 18 && C.age[i] < 65 && C.studying[i] === 0) this.seekers.add(i);
  }
  leaveSchool(i: number) {
    const C = this.w.citizens;
    const b = this.w.buildings.byId.get(C.school[i]);
    if (b) b.students = b.students.filter((x) => x !== i);
    C.school[i] = -1;
  }

  findSchool(i: number) {
    const C = this.w.citizens;
    const st = C.studying[i];
    const kinds = st === 1 ? ['daycare'] : st === 2 ? ['school'] : st === 3 ? ['highSchool', 'school'] : ['university'];
    const h = C.households.get(C.hh[i]);
    const home = h ? this.w.buildings.byId.get(h.home) : null;
    if (!home) return;
    let best: Building | null = null, bd = Infinity;
    for (const b of this.w.buildings.list) {
      if (b.state !== 'done' || !kinds.includes(b.kind)) continue;
      const cap = (KINDS[b.kind].service?.capacity ?? 300) * (b.kind === kinds[0] ? 1 : 0.5);
      if (b.students.length >= cap) continue;
      const d = Math.hypot(b.x - home.x, b.z - home.z);
      if (d < bd) { bd = d; best = b; }
    }
    if (best && bd < 4000) { C.school[i] = best.id; best.students.push(i); }
    else this.unservedSchool++;
  }

  wantsToMove(h: Household, reason: string) {
    if (h.searching) return;
    h.searching = true;
    this.movers.push({ h, reason, since: this.w.day });
  }

  /** a shop/restaurant visit: money flows from household to business */
  spend(i: number, b: Building, amount: number) {
    const h = this.w.citizens.households.get(this.w.citizens.hh[i]);
    if (!h || h.money < amount) return;
    const a = amount * this.priceIndex;
    h.money -= a;
    b.revenue += a;
    b.customers++;
  }

  // ---------------------------------------------------------------- hourly
  hourly() {
    const w = this.w;
    const C = w.citizens;
    // vacancy index
    this.vacancyList = [];
    this.homeVac = [[], [], []];
    let jobs = 0, vac = 0;
    for (const b of w.buildings.list) {
      if (b.state !== 'done' || b.abandoned) continue;
      const cap = b.jobCap[0] + b.jobCap[1] + b.jobCap[2] + b.jobCap[3];
      jobs += cap;
      if (b.workers.length < cap) { this.vacancyList.push(b); vac += cap - b.workers.length; }
      if (b.hhCap > b.households.length && (b.def.cat === 'res' || b.def.cat === 'informal' || b.kind === 'com')) {
        const tier = b.def.cat === 'informal' ? 0 : b.kind === 'com' ? 1 : b.wealth;
        this.homeVac[tier].push(b);
      }
    }
    this.jobsTotal = jobs; this.vacancies = vac;
    // job matching
    let budget = 260;
    for (const i of this.seekers) {
      if (budget-- <= 0) break;
      if (!C.alive[i] || C.job[i] >= 0 || C.age[i] < 16 || C.age[i] >= 65 || C.studying[i] > 0 && C.studying[i] < 4) { this.seekers.delete(i); continue; }
      const h = C.households.get(C.hh[i]);
      const home = h ? w.buildings.byId.get(h.home) : null;
      if (!home || !this.vacancyList.length) continue;
      let best: Building | null = null, bs = -Infinity, bl = 0;
      for (let k = 0; k < 14; k++) {
        const b = this.vacancyList[Math.floor(w.rng.next() * this.vacancyList.length)];
        for (let lvl = Math.min(3, C.edu[i]); lvl >= 0; lvl--) {
          const filled = b.workers.filter((x) => C.jobEdu[x] === lvl).length;
          if (filled >= b.jobCap[lvl]) continue;
          const d = Math.hypot(b.x - home.x, b.z - home.z);
          const s = this.wage(lvl) / 40 - d / 900 + w.rng.next() * 0.5;
          if (s > bs) { bs = s; best = b; bl = lvl; }
          break;
        }
      }
      if (!best) continue;
      const first = !C.bio[i]?.some((x) => x.text.startsWith('Primeiro emprego') || x.text.startsWith('Começou a trabalhar'));
      C.job[i] = best.id; C.jobEdu[i] = bl; C.income[i] = this.wage(bl) * (0.85 + w.rng.next() * 0.3);
      best.workers.push(i);
      this.seekers.delete(i);
      C.addBio(i, `${first ? 'Primeiro emprego' : 'Começou a trabalhar'} em ${best.name}`);
      C.shiftStart[i] = best.def.cat === 'com' ? w.rng.range(7.5, 11) : best.def.cat === 'ind' ? w.rng.range(5.5, 8) : best.def.public ? w.rng.range(6, 9) : w.rng.range(7.5, 9.5);
    }
    // housing: immigrants and movers
    this.housing();
    if (w.hourIdx % 6 === 0) w.places.rebuild(w.buildings.list);
  }

  private pickHome(tier: number, near?: { x: number; z: number }): Building | null {
    const w = this.w;
    let list = this.homeVac[tier];
    if (!list.length && tier === 1) list = this.homeVac[0].length && w.rng.chance(0.4) ? this.homeVac[0] : this.homeVac[2];
    if (!list.length && tier === 0) list = this.homeVac[1];
    if (!list.length) return null;
    let best: Building | null = null, bs = -Infinity;
    for (let k = 0; k < 10; k++) {
      const b = list[Math.floor(w.rng.next() * list.length)];
      if (b.households.length >= b.hhCap) continue;
      const F = w.fields;
      let s = F.sample('beauty', b.x, b.z) * (0.3 + tier * 0.4) - F.sample('airPollution', b.x, b.z) * (0.5 + tier) - F.sample('crime', b.x, b.z) * (0.4 + tier * 0.5) + F.sample('accessibility', b.x, b.z) * 0.6 + w.rng.next() * 0.4;
      if (near) s -= Math.hypot(b.x - near.x, b.z - near.z) / 1500;
      if (s > bs) { bs = s; best = b; }
    }
    return best;
  }

  private housing() {
    const w = this.w;
    const C = w.citizens;
    this.homelessDemand = [0, 0, 0];
    // immigrants
    const keep: Immigrant[] = [];
    for (const im of this.pending) {
      const home = this.pickHome(im.wealth);
      if (home) {
        const h = C.createFamily(home, im.wealth, { size: im.size, arriving: true });
        if (h) { C.arriveFromHighway(h); continue; }
      }
      im.tries++;
      this.homelessDemand[im.wealth] += im.size;
      if (im.tries < 36) keep.push(im);
    }
    this.pending = keep.slice(-600);
    // movers
    const stay: typeof this.movers = [];
    for (const m of this.movers) {
      const h = m.h;
      if (!C.households.has(h.id)) continue;
      const cur = w.buildings.byId.get(h.home);
      const job = h.members.map((x) => w.buildings.byId.get(C.job[x])).find(Boolean);
      const home = this.pickHome(h.wealth, job ?? cur ?? undefined);
      if (home && home.id !== h.home) {
        C.moveHousehold(h, home.id);
        h.searching = false;
        const dist = w.districtName(home.x, home.z);
        for (const x of h.members) {
          C.addBio(x, `Mudou-se para ${dist} (${m.reason})`);
          if (C.state[x] === 0) C.loc[x] = C.loc[x] === cur?.id ? home.id : C.loc[x];
        }
        if (cur && w.traffic.capacityLeft > 80 && w.rng.chance(0.5)) {
          const plan = w.carPlan(cur, home);
          if (plan) w.traffic.spawn(6 /* Truck */ as never, plan.path, plan.startS, plan.destS, { kind: 9, id: -1, aux: 0 }, cur.id, home.id);
        }
        continue;
      }
      if (!cur) { this.homelessDemand[h.wealth] += h.members.length; if (w.day - m.since > 2) { C.leaveCity(h, 'não encontrou moradia'); continue; } }
      if (w.day - m.since > 4 && cur) { h.searching = false; continue; }
      stay.push(m);
    }
    this.movers = stay;
  }

  // ---------------------------------------------------------------- daily
  daily() {
    const w = this.w;
    const C = w.citizens;
    const p = w.params;
    let wages = 0, emp = 0, unemp = 0, stud = 0, incSum = 0, incN = 0;
    for (let i = 0; i < C.max; i++) {
      if (!C.alive[i] || C.tourist[i]) continue;
      if (C.job[i] >= 0) { emp++; wages += C.income[i]; incSum += C.income[i]; incN++; }
      else if (C.age[i] >= 18 && C.age[i] < 65 && C.studying[i] === 0) unemp++;
      if (C.studying[i]) stud++;
    }
    this.employed = emp; this.unemployed = unemp; this.students = stud;
    this.avgIncome = incN ? incSum / incN : 0;
    this.wagesToday = wages;
    // households: wages in, cost of living out, wealth tier drift
    for (const h of C.households.values()) {
      if (h.tourist) continue;
      let inc = 0;
      for (const m of h.members) inc += C.income[m];
      const home = w.buildings.byId.get(h.home);
      const rent = home ? (8 + w.fields.sample('landValue', home.x, home.z) * 40 * (1 + home.level * 0.3)) * this.priceIndex * (1 + (w.tourism?.pressure ?? 0) * 0.6) : 0;
      const living = h.members.length * 14 * this.priceIndex;
      h.money += inc * (1 - p.taxRate) - rent - living;
      const perCap = inc / Math.max(1, h.members.length);
      const tier = perCap > 120 ? 2 : perCap > 45 ? 1 : 0;
      // happiness of members
      const env = home ? (w.fields.sample('beauty', home.x, home.z) * 0.2 - w.fields.sample('airPollution', home.x, home.z) * 0.35 - w.fields.sample('crime', home.x, home.z) * 0.3 - w.fields.sample('noise', home.x, home.z) * 0.15 + w.fields.sample('cov_parks', home.x, home.z) * 0.1 + (home.powered ? 0 : -0.2) + (home.watered ? 0 : -0.25) - home.garbage * 0.1) : -0.3;
      let hap = 0;
      for (const m of h.members) {
        const jobOk = C.job[m] >= 0 || C.age[m] < 18 || C.age[m] >= 65 || C.studying[m] ? 0.15 : -0.25;
        const needs = (C.needs[m * 8] + C.needs[m * 8 + 3] + C.needs[m * 8 + 4]) / 3;
        C.happiness[m] = clamp(0.45 + env + jobOk + (needs - 0.5) * 0.4 + (h.money > 0 ? 0.05 : -0.2) - p.taxRate * 0.6 + C.health[m] * 0.15 - 0.08 - (1 - (w.integrity?.trust ?? 0.7)) * 0.12, 0, 1);
        hap += C.happiness[m];
      }
      hap /= Math.max(1, h.members.length);
      h.unhappyDays = hap < 0.35 ? h.unhappyDays + 1 : 0;
      if (tier !== h.wealth && w.day - h.movedDay > 3 && w.rng.chance(0.25)) {
        h.wealth = tier;
        this.wantsToMove(h, tier > (home?.wealth ?? 1) ? 'melhorou de vida' : 'precisou economizar');
      } else if (home && hap < 0.4 && w.day - h.movedDay > 4 && w.rng.chance(0.15)) this.wantsToMove(h, 'insatisfação com o bairro');
      if (h.unhappyDays > 6 && w.rng.chance(0.2 + p.taxRate)) C.leaveCity(h, 'infelicidade e falta de oportunidades');
      if (!h.car && h.money > [1500, 2500, 4000][h.wealth] && w.rng.chance(0.1)) { h.car = true; h.carLoc = h.home; h.carUser = -1; h.carDriver = -1; h.money -= 800; }
    }
    // happiness heatmap
    {
      const F = w.fields, acc = new Float32Array(F.G * F.G), cnt = new Float32Array(F.G * F.G);
      for (const h of C.households.values()) { const b = w.buildings.byId.get(h.home); if (!b) continue; const k = F.idx(b.x, b.z); for (const m of h.members) { acc[k] += C.happiness[m]; cnt[k]++; } }
      const a2 = new Float32Array(F.G * F.G), c2 = new Float32Array(F.G * F.G);
      F.blur(acc, a2, 2); F.blur(cnt, c2, 2);
      for (let k = 0; k < a2.length; k++) F.f.happiness[k] = c2[k] > 0.01 ? a2[k] / c2[k] : 0;
    }
    for (const b of w.buildings.list) b.visitors = Math.round(b.visitors * 0.3);
    // businesses
    let profits = 0, taxB = 0;
    for (const b of w.buildings.list) {
      if (b.state !== 'done' || b.def.public || !b.def.jobs) { b.revenue = 0; b.customers = 0; continue; }
      if (b.abandoned) { b.revenue = 0; continue; }
      let wagesB = 0;
      for (const x of b.workers) wagesB += C.income[x];
      const cat = b.def.cat;
      let rev = b.revenue;
      if (cat === 'ind') rev += b.workers.length * 75 * this.priceIndex * (1 + this.railBonus * 0.15 * w.fields.sample('railAccess', b.x, b.z)) * (this.crisis > 0 ? 0.6 : 1) * (b.powered ? 1 : 0.4);
      if (cat === 'off') rev += b.workers.reduce((a, x) => a + 70 + C.edu[x] * 45, 0) * this.priceIndex * (this.crisis > 0 ? 0.7 : 1);
      if (cat === 'com') rev += b.workers.length * 25 * this.priceIndex;
      const profit = rev - wagesB - b.def.cost * 0.05;
      const tax = Math.max(0, profit) * p.taxRate;
      b.profit = b.profit * 0.6 + (profit - tax) * 0.4;
      profits += profit; taxB += tax;
      b.revenue = 0; b.customers = 0;
      b.badDays = b.profit < 0 && b.workers.length < (b.jobCap[0] + b.jobCap[1] + b.jobCap[2] + b.jobCap[3]) * 0.6 + 1 ? b.badDays + 1 : Math.max(0, b.badDays - 1);
      if (b.badDays > 5 && w.rng.chance(0.3)) this.bankrupt(b);
    }
    this.taxToday = wages * p.taxRate + taxB;
    this.gdpToday = wages + profits;
    this.gdp = this.gdp * 0.5 + this.gdpToday * 0.5;
    // inflation: demand pressure vs supply
    const pressure = clamp((this.vacancies < this.employed * 0.03 ? 0.01 : 0) + (this.homelessDemand[0] + this.homelessDemand[1] > 30 ? 0.006 : 0) - (this.crisis > 0 ? 0.01 : 0), -0.01, 0.02);
    this.priceIndex *= 1 + 0.001 + pressure;
    if (this.crisis > 0) this.crisis--;
    this.railBonus *= 0.7;
    // immigration flow
    const attract = clamp(0.4 + w.avgHappiness() * 0.8 + Math.min(1, this.vacancies / 60) * 0.8 - p.taxRate * 1.5 - (this.crisis > 0 ? 0.6 : 0), 0, 2.2);
    const base = (7 + Math.min(110, this.vacancies * 0.6) + w.era * 5 + Math.min(40, w.day * 0.4)) * p.immigration * attract + this.boomQueue;
    this.boomQueue = 0;
    const families = Math.round(base / 2.6);
    for (let k = 0; k < families; k++) {
      const r = w.rng.next();
      const ineq = p.inequality;
      const eduCity = (this.vacancies > 0 ? 0.1 : 0) + w.era * 0.05;
      const wealth = r < 0.28 + ineq * 0.35 - eduCity ? 0 : r < 0.9 - ineq * 0.08 ? 1 : 2;
      this.pending.push({ wealth, size: w.rng.weighted([1, 2, 3, 4, 5], (n) => [0.25, 0.3, 0.2, 0.18, 0.07][n - 1])!, tries: 0 });
    }
    this.computeDemand();
  }

  bankrupt(b: Building) {
    const w = this.w;
    for (const x of [...b.workers]) { w.citizens.addBio(x, `Perdeu o emprego com o fechamento de ${b.name}`); this.leaveJob(x); }
    b.abandoned = true;
    b.abandonedDays = 0;
    b.abandonedDay = w.day;
    b.badDays = 0;
    w.buildings.dirty.add(b.id);
    w.events.emit('bankruptcy', b.x, b.z, 0.45, `${b.name} fecha as portas`, { ref: b.id, entity: { kind: 'building', id: b.id }, headline: b.def.cat === 'ind' && w.rng.chance(0.6) ? `${b.name} encerra atividades e demite ${b.jobCap.reduce((a, c) => a + c, 0)} funcionários` : undefined });
  }

  computeDemand() {
    const w = this.w;
    const C = w.citizens;
    const p = w.params;
    let comCap = 0, indCap = 0, offCap = 0, vacHomes = 0, offVac = 0, indVac = 0, comVac = 0;
    for (const b of w.buildings.list) {
      const cap = b.jobCap[0] + b.jobCap[1] + b.jobCap[2] + b.jobCap[3];
      const built = b.state === 'done' && !b.abandoned;
      if (b.def.cat === 'com') { comCap += cap; if (built) comVac += cap - b.workers.length; }
      if (b.def.cat === 'ind') { indCap += cap; if (built) indVac += Math.max(0, cap - b.workers.length); }
      if (b.def.cat === 'off') { offCap += cap; if (built) offVac += Math.max(0, cap - b.workers.length); }
      if ((b.def.cat === 'res' || b.def.cat === 'informal') && b.state !== 'demolishing') vacHomes += Math.max(0, b.hhCap - b.households.length);
    }
    let lowEduUnemp = 0, hiEduUnemp = 0;
    for (const i of this.seekers) { if (!C.alive[i]) continue; if (C.edu[i] >= 2) hiEduUnemp++; else lowEduUnemp++; }
    const pop = w.population;
    const taxF = 1 - (p.taxRate - 0.12) * 2.5;
    const vocInd = p.vocation === 'industria' ? 1.4 : p.vocation === 'agricultura' ? 1.1 : 0.7;
    const vocOff = p.vocation === 'servicos' ? 1.5 : p.vocation === 'turismo' ? 1.1 : 0.8;
    const pend = this.pending.reduce((a, im) => a + 1, 0);
    this.exportDemand = pop * 0.05 * vocInd;
    const d = w.demand;
    const eduF = 0.4 + w.era * 0.35 + Math.max(0, (this.avgEdu() - 1.2)) * 0.8;
    d.res = clamp((pend * 0.9 + this.movers.length * 0.3 - vacHomes * 0.8) * taxF, -40, 60);
    d.com = clamp(((pop * 0.12 * (1 + (w.tourism?.pressure ?? 0)) - comCap) / 6 + Math.min(10, this.unservedShopping * 0.02) - comVac * 0.15) * taxF, -40, 60);
    d.ind = clamp(((pop * 0.34 * vocInd + 30 + w.day * 5 - indCap) / 10 + lowEduUnemp * 0.08 - indVac * 0.05) * taxF * (this.crisis > 0 ? 0.2 : 1), -40, 60);
    // investors shy away from cities where contracts and permits cannot be trusted
    d.off = clamp(((pop * 0.07 * vocOff * eduF * (0.55 + 0.45 * (w.integrity?.trust ?? 0.7)) - offCap) / 8 + hiEduUnemp * 0.1 - offVac * 0.06) * taxF * (this.crisis > 0 ? 0.3 : 1), -40, 60);
    this.unservedShopping *= 0.3;
  }

  avgEdu(): number {
    const C = this.w.citizens;
    let s = 0, n = 0;
    for (let i = 0; i < C.max; i += 4) if (C.alive[i] && C.age[i] >= 18 && !C.tourist[i]) { s += C.edu[i]; n++; }
    return n ? s / n : 1;
  }
  static HOUR = HOUR_SECONDS;
}
