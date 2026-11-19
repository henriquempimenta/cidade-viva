import { DAYS_PER_YEAR } from '../shared/constants';
import { FIRST_F, FIRST_M, LAST } from '../shared/names';
import { clamp } from '../shared/rng';
import type { Building } from './buildings';
import type { World } from './world';

/**
 * Integrity & corruption.
 *
 * Corruption is not a rule ("put X here"): it is a scalar that quietly weakens the city's
 * existing feedback loops. Pressure comes from inequality, low schooling, budget stress,
 * land-value windfalls from construction and from whoever holds office; control comes from
 * press & culture, schooling, transparency, social trust and investigations. Its effects
 * flow through mechanisms that already exist and stay explainable:
 *   • public works lose money (diversion, booked in the ledger) and can stall for years;
 *   • permits are "eased": the neighbours' rejection weighs less — shown as its own term in
 *     "Por que aqui?" — so unwanted uses creep closer to homes;
 *   • bribes blunt policing → crime rises;
 *   • abandoned property is never inspected or expropriated: it decays, gets occupied,
 *     burns, and after years may collapse by itself;
 *   • social trust erodes happiness and investment.
 * Investigations and elections (every 4 years) can break the cycle — or not.
 */
export interface Mayor { name: string; greed: number; since: number; female: boolean }

const OPS = ['Concreto Armado', 'Alicerce', 'Viga Mestra', 'Asfalto Fino', 'Caixa-Forte', 'Maré Baixa', 'Planta Baixa', 'Tijolo Quente', 'Água Turva', 'Meio-Fio', 'Pedra Fundamental', 'Linha Reta'];

export class Integrity {
  /** city-wide corruption index 0..1 */
  index = 0.15;
  /** social trust 0..1 */
  trust = 0.7;
  mayor: Mayor;
  diverted = 0; // money lost to diversion (all time)
  divertedYear = 0;
  investigations = 0;
  lastInvestigationDay = -99;
  lastElectionDay = 0;
  scandals = 0; // recent scandal pressure, decays
  collapses = 0;
  history: number[] = [];

  constructor(private w: World) {
    this.mayor = this.newMayor(0);
    this.index = clamp(0.08 + w.params.corruption * 0.25, 0, 1);
  }

  private newMayor(day: number): Mayor {
    const r = this.w.rng, female = r.chance(0.45);
    const name = `${(female ? FIRST_F : FIRST_M)[r.int(0, 39)]} ${LAST[r.int(0, 39)]}`;
    // honesty varies a lot from one administration to the next; the base propensity shifts it
    const greed = clamp(0.25 + r.next() * 1.1 + (this.w.params.corruption - 0.35) * 0.9, 0.05, 1.6);
    return { name, greed, since: day, female };
  }
  get mayorTitle() { return this.mayor.female ? 'prefeita' : 'prefeito'; }

  /** bribe pressure at a location (0..~0.8): how much neighbours' objections get waved through */
  bribe(x: number, z: number) {
    const local = this.w.fields.sample('corruption', x, z);
    return clamp(local * 0.95, 0, 0.8);
  }
  /** fraction of police coverage lost to payoffs at a field cell */
  policeLeak(k: number) { return clamp(this.w.fields.f.corruption[k] * 0.6, 0, 0.6); }

  /** called when the city hall approves a project: returns the money that disappears */
  divert(label: string, cost: number): number {
    const leak = cost * clamp(this.index * 0.55 * this.mayor.greed, 0, 0.6);
    if (leak < 20) return 0;
    this.diverted += leak; this.divertedYear += leak;
    this.w.cityHall.book(`Superfaturamento em ${label.toLowerCase()}`, -leak);
    return leak;
  }

  /** a newly started public work may stall: skeleton and idle site for months or years */
  maybeStall(b: Building) {
    const w = this.w, r = w.rng;
    const p = clamp(this.index * this.mayor.greed * 0.35 - 0.03, 0, 0.45);
    if (!r.chance(p)) return;
    // stall begins somewhere in the structure phase
    b.stalledUntil = w.day + Math.round(r.range(6, 30) + this.index * r.range(20, 140)) ; // up to ~14 years
    (b as Building & { stallAt?: number }).stallAt = r.range(0.35, 0.75);
  }
  /** true while the building should not advance */
  frozen(b: Building): boolean {
    if (b.stalledUntil < 0) return false;
    const at = (b as Building & { stallAt?: number }).stallAt ?? 0.5;
    if (b.progress < at) return false; // works run normally until the money runs out
    if (this.w.day >= b.stalledUntil) {
      b.stalledUntil = -1;
      const years = Math.max(1, Math.round((this.w.day - b.builtDay) / DAYS_PER_YEAR));
      this.w.events.emit('works_resumed', b.x, b.z, 0.55, `Obras retomadas: ${b.name}`, { ref: b.id, entity: { kind: 'building', id: b.id }, headline: `Depois de ${years} ano${years > 1 ? 's' : ''} parada, obra de ${b.def.label.toLowerCase()} é retomada`, visual: 0.7 });
      return false;
    }
    if (!(b as Building & { stallNews?: boolean }).stallNews) {
      (b as Building & { stallNews?: boolean }).stallNews = true;
      this.scandals += 0.5;
      this.w.events.emit('works_stalled', b.x, b.z, 0.6, `Obra parada: ${b.name}`, { ref: b.id, entity: { kind: 'building', id: b.id }, headline: `Dinheiro acaba e obra de ${b.def.label.toLowerCase()} fica parada no esqueleto`, visual: 0.65 });
    }
    return true;
  }

  /** local corruption field: where capture happens (construction money, weak policing, blight) */
  hourly() {
    const w = this.w, F = w.fields, f = F.f, G = F.G;
    if (w.hourIdx % 6 !== 0) return;
    const src = new Float32Array(G * G);
    for (const id of w.buildings.underConstruction) { const b = w.buildings.byId.get(id); if (b) F.splat(src, b.x, b.z, 0.6 + (b.def.cost ?? 0) / 2000, 120); }
    const loc = f.corruption;
    const tmp = new Float32Array(G * G);
    F.blur(src, tmp, 4);
    for (let k = 0; k < G * G; k++) {
      const people = f.resDensity[k] + f.jobDensity[k] * 0.5;
      if (people < 0.03 && tmp[k] < 0.01) { loc[k] *= 0.9; continue; }
      const target = this.index * (0.45 + Math.min(0.6, tmp[k] * 0.8) + f.crime[k] * 0.5 + (1 - Math.min(1, f.cov_police[k])) * 0.2 + (1 - Math.min(1, f.cov_culture[k])) * 0.15);
      loc[k] += (clamp(target, 0, 1.2) - loc[k]) * 0.4;
    }
  }

  daily() {
    const w = this.w, p = w.params, r = w.rng, F = w.fields.f, C = w.citizens;
    // ---------- pressure vs control ----------
    let poor = 0, rich = 0, n = 0;
    for (const h of C.households.values()) { if (h.tourist) continue; n += h.members.length; if (h.wealth === 0) poor += h.members.length; else if (h.wealth === 2) rich += h.members.length; }
    const ineq = n ? clamp((poor / n) * (0.4 + (rich / n) * 4), 0, 1) : 0.3;
    const edu = clamp(w.statsEdu / 3, 0, 1);
    const stress = clamp((w.budget.money < 0 ? 0.5 : 0) + w.budget.debt / (8000 + w.population * 3) * 0.5, 0, 1);
    const boom = clamp(w.buildings.underConstruction.size / Math.max(20, w.buildings.list.length) * 4, 0, 1);
    let cult = 0, rd = 0;
    for (let k = 0; k < F.resDensity.length; k++) { if (F.resDensity[k] < 0.01) continue; cult += Math.min(1, F.cov_culture[k] + F.cov_education[k] * 0.4) * F.resDensity[k]; rd += F.resDensity[k]; }
    const press = rd ? cult / rd : 0;
    // bigger budgets attract capture: pressure grows with the size of the city
    const scale = clamp((Math.log10(Math.max(100, w.population)) - 2) / 2.5, 0, 1) * 0.22;
    const pressure = p.corruption * 0.55 + ineq * 0.3 + (1 - edu) * 0.25 + stress * 0.25 + boom * 0.2 + scale;
    const control = p.transparency * 0.42 + press * 0.2 + edu * 0.15 + this.trust * 0.1 + (w.day - this.lastInvestigationDay < 24 ? 0.3 : 0);
    // never fully zero: some petty corruption survives even in clean administrations
    this.index = clamp(this.index + 0.012 * (pressure * this.mayor.greed - control * 0.85), 0.03 + p.corruption * 0.12, 0.98);
    // ---------- trust ----------
    const trustTarget = clamp(0.95 - this.index * 0.7 - w.services.avgCrime * 0.5 - this.scandals * 0.04, 0.05, 1);
    this.trust += (trustTarget - this.trust) * 0.08;
    this.scandals *= 0.93;
    this.history.push(this.index);
    if (this.history.length > 400) this.history.shift();
    if (w.day % DAYS_PER_YEAR === 0) this.divertedYear = 0;
    this.neglect();
    // ---------- investigations ----------
    const pInv = clamp(this.index * (p.transparency * 0.6 + press * 0.4 + 0.1) * 0.06 + this.scandals * 0.004, 0, 0.25);
    if (w.day - this.lastInvestigationDay > 12 && this.index > 0.25 && r.chance(pInv)) this.investigate();
    // ---------- elections every 4 years ----------
    if (w.day > 0 && w.day % (DAYS_PER_YEAR * 4) === 0 && w.day !== this.lastElectionDay) this.election();
  }

  private investigate() {
    const w = this.w, r = w.rng;
    this.lastInvestigationDay = w.day;
    this.investigations++;
    const op = OPS[(this.investigations * 7 + r.int(0, OPS.length - 1)) % OPS.length];
    const arrests = Math.max(2, Math.round(this.index * 20 + r.range(0, 6)));
    const hall = w.buildings.list.find((b) => b.kind === 'cityHall' || b.def.public) ?? null;
    const x = hall?.x ?? w.center.x, z = hall?.z ?? w.center.z;
    this.index *= 0.6;
    this.scandals += 2;
    this.trust = clamp(this.trust - 0.08, 0, 1);
    // stalled works get audited: some restart
    for (const b of w.buildings.list) if (b.stalledUntil >= 0 && r.chance(0.5)) b.stalledUntil = w.day + r.int(1, 6);
    const implicated = this.mayor.greed > 0.9 && r.chance(0.55);
    w.events.emit('investigation', x, z, 0.9, `Operação ${op}: ${arrests} presos por desvio de verbas`, {
      headline: `Operação ${op} prende ${arrests} por fraude em obras públicas${implicated ? ` e afasta ${this.mayorTitle} ${this.mayor.name}` : ''}`, visual: 0.6,
    });
    if (implicated) {
      const old = this.mayor;
      this.mayor = this.newMayor(w.day);
      this.mayor.greed = Math.min(this.mayor.greed, 0.8); // the vice takes over under scrutiny
      w.events.emit('mayor', x, z, 0.8, `${old.name} é afastad${old.female ? 'a' : 'o'}; ${this.mayor.name} assume a prefeitura`, { headline: `${this.mayor.name} assume a prefeitura após afastamento de ${old.name}`, visual: 0.5 });
    }
  }

  private election() {
    const w = this.w, r = w.rng;
    this.lastElectionDay = w.day;
    const approval = w.avgHappiness() * 0.55 + this.trust * 0.3 + (1 - this.index) * 0.15 - this.scandals * 0.03 + r.range(-0.08, 0.08);
    const year = Math.floor(w.day / DAYS_PER_YEAR) + 1;
    const x = w.center.x, z = w.center.z;
    if (approval > 0.55 && w.day - this.mayor.since < DAYS_PER_YEAR * 8) {
      w.events.emit('election', x, z, 0.75, `Eleições no ano ${year}: ${this.mayor.name} é reeleit${this.mayor.female ? 'a' : 'o'}`, { headline: `${this.mayor.name} é reeleit${this.mayor.female ? 'a' : 'o'} com ${Math.round(50 + approval * 30)}% dos votos`, visual: 0.6 });
      return;
    }
    const old = this.mayor;
    this.mayor = this.newMayor(w.day);
    // voters tired of scandals pick someone running on transparency (who may or may not deliver)
    if (this.scandals > 1.5) this.mayor.greed *= 0.7;
    w.events.emit('election', x, z, 0.85, `Eleições no ano ${year}: ${this.mayor.name} derrota ${old.name}`, {
      headline: `${this.mayor.female ? 'Nova prefeita' : 'Novo prefeito'}, ${this.mayor.name}, assume prometendo ${this.scandals > 1.5 ? 'acabar com a corrupção' : this.trust < 0.45 ? 'recuperar a confiança' : 'continuidade com mudança'}`, visual: 0.6,
    });
  }

  /** abandonment, neglect, occupation and collapse */
  private neglect() {
    const w = this.w, r = w.rng, B = w.buildings;
    const deficit = w.economy.homelessDemand.reduce((a, b) => a + b, 0);
    let occupiedToday = 0;
    for (const b of B.list) {
      if (!b.alive || b.state !== 'done' || b.def.public || b.heritage) continue;
      // empty homes in unattractive places end up abandoned
      if (!b.abandoned && (b.def.cat === 'res' || b.def.cat === 'informal')) {
        b.emptyDays = b.households.length ? 0 : b.emptyDays + 1;
        const lv = w.fields.sample('landValue', b.x, b.z);
        if (b.emptyDays > 10 + lv * 30) { this.abandon(b, 'sem moradores há meses'); }
      }
      if (!b.abandoned) { if (b.squatted) b.decay = Math.min(1, b.decay + 0.004); continue; }
      const local = w.fields.sample('corruption', b.x, b.z);
      const years = (w.day - b.abandonedDay) / DAYS_PER_YEAR;
      // where institutions work, derelicts are inspected and dealt with in weeks
      const enforce = clamp((1 - local * 1.6) * (1 - this.index * 1.5) * 0.05 * (w.budget.money > 0 ? 1 : 0.3), 0, 0.05);
      if (years > 0.5 && r.chance(enforce)) {
        w.events.emit('expropriation', b.x, b.z, 0.5, `Prefeitura desapropria imóvel abandonado: ${b.name}`, { ref: b.id, entity: { kind: 'building', id: b.id }, headline: years > 3 ? `Após ${Math.round(years)} anos, prefeitura desapropria e demole ${b.def.label.toLowerCase()} abandonado` : undefined, visual: 0.6 });
        B.demolish(b);
        continue;
      }
      // neglect: about 10–15 years to ruin, faster in rain and with occupants, slower for sturdy towers
      const rate = (1 / (DAYS_PER_YEAR * 13)) * (1 + w.weather.rain * 0.6) * (b.squatted ? 1.4 : 1) * (b.floors > 6 ? 0.7 : 1) * (1 + local * 0.5);
      const before = Math.floor(b.decay * 4);
      b.decay = Math.min(1, b.decay + rate);
      if (Math.floor(b.decay * 4) !== before) B.dirty.add(b.id);
      // occupation by homeless families when housing is short
      if (!b.squatted && (b.def.cat === 'res' || b.def.cat === 'informal') && deficit > 2 && occupiedToday < 2 && years > 0.3 && r.chance(0.04 + local * 0.08)) {
        b.squatted = true; b.abandoned = false; b.wealth = 0; occupiedToday++;
        B.dirty.add(b.id);
        w.events.emit('occupation', b.x, b.z, 0.55, `Famílias sem teto ocupam ${b.name}`, { ref: b.id, entity: { kind: 'building', id: b.id }, headline: years > 2 ? `Prédio abandonado há ${Math.round(years)} anos vira ocupação em ${w.districtName(b.x, b.z)}` : undefined, visual: 0.55 });
        continue;
      }
      // abandoned sheds, hotels and shops get occupied too (they stay derelict, but people live there)
      if (!b.squatted && b.def.cat !== 'res' && b.def.cat !== 'informal' && years > 0.5 && occupiedToday < 2 && (deficit > 2 || w.fields.sample('crime', b.x, b.z) > 0.15) && r.chance(0.02 + local * 0.06)) {
        b.squatted = true; occupiedToday++;
        B.dirty.add(b.id);
        w.events.emit('occupation', b.x, b.z, 0.55, `Famílias sem teto ocupam ${b.name}`, { ref: b.id, entity: { kind: 'building', id: b.id }, headline: `${b.def.label} abandonado há ${Math.max(1, Math.round(years))} ano(s) vira ocupação em ${w.districtName(b.x, b.z)}`, visual: 0.55 });
      }
      // collapse after decades of neglect
      if (b.decay > 0.75 && r.chance((b.decay - 0.75) * 0.06)) this.collapse(b, years);
    }
    // squatted buildings keep decaying and can collapse with people inside
    for (const b of B.list) if (b.alive && b.squatted && b.state === 'done' && b.decay > 0.85 && r.chance((b.decay - 0.85) * 0.05)) this.collapse(b, (w.day - b.abandonedDay) / DAYS_PER_YEAR);
  }

  abandon(b: Building, why: string) {
    const w = this.w;
    b.abandoned = true; b.abandonedDay = w.day; b.emptyDays = 0;
    w.buildings.dirty.add(b.id);
    w.events.emit('abandoned', b.x, b.z, 0.35, `${b.name} é abandonado (${why})`, { ref: b.id, entity: { kind: 'building', id: b.id }, visual: 0.4 });
  }

  private collapse(b: Building, years: number) {
    const w = this.w;
    this.collapses++;
    const y = Math.max(1, Math.round(years));
    const people = b.squatted ? b.households.length : 0;
    if (people) {
      for (const hid of b.households) { const h = w.citizens.households.get(hid); if (h) for (const m of h.members) w.citizens.addBio(m, `Escapou do desabamento da ocupação ${b.name}`); }
      w.evict(b);
    }
    b.pendingRebuild = undefined;
    w.buildings.demolish(b);
    this.scandals += 1;
    w.events.emit('collapse', b.x, b.z, 0.95, `${b.name} desaba após ${y} anos de abandono`, {
      ref: b.id, entity: { kind: 'building', id: b.id }, visual: 1,
      headline: people ? `Ocupação desaba em ${w.districtName(b.x, b.z)}; ${people} famílias desalojadas` : `Prédio abandonado há ${y} anos desaba sozinho em ${w.districtName(b.x, b.z)}`,
    });
  }

  report() {
    let stalled = 0, derelict = 0, squatted = 0, years = 0;
    for (const b of this.w.buildings.list) {
      if (b.stalledUntil >= 0) stalled++;
      if (b.abandoned) { derelict++; years += (this.w.day - b.abandonedDay) / DAYS_PER_YEAR; }
      if (b.squatted) squatted++;
    }
    const m = this.mayor;
    return {
      index: this.index, trust: this.trust, mayor: m.name, mayorTitle: this.mayorTitle, since: Math.floor(m.since / DAYS_PER_YEAR) + 1,
      nextElection: Math.floor((this.lastElectionDay + DAYS_PER_YEAR * 4) / DAYS_PER_YEAR) + 1, diverted: Math.round(this.diverted), divertedYear: Math.round(this.divertedYear),
      stalled, derelict, squatted, avgAbandonYears: derelict ? years / derelict : 0, investigations: this.investigations, collapses: this.collapses,
    };
  }
}
