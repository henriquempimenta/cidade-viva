import { DAY_SECONDS, DAYS_PER_YEAR, HOUR_SECONDS, MAX_CITIZENS, PED_FLAG_FUNERAL, PED_FLAG_LUGGAGE, PED_FLAG_TOURIST, VType } from '../shared/constants';
import { FIRST_F, FIRST_M, LAST } from '../shared/names';
import { MinHeap } from './heap';
import type { Building } from './buildings';
import type { World } from './world';
import { carPlan, carPlanFromNode, carPlanToNode, doorOf, pathLength, walkPoints, type CarPlan } from './trips';
import { P_CITIZEN, P_FUNERAL, P_MOVING } from './traffic';
import { PED_FLAG_BIKE } from './peds';
import type { PlaceCat } from './places';
import { KINDS } from '../shared/catalog';

export enum Act { Home, Sleep, Work, Study, Shop, Eat, Gym, Park, Bar, Beach, Church, Visit, Doctor, Culture, Sightsee, Hotel, Away, Funeral, Game }
export const ACT_LABEL = ['em casa', 'dormindo', 'trabalhando', 'estudando', 'fazendo compras', 'almoçando/jantando', 'malhando', 'passeando no parque', 'no bar com amigos', 'na praia', 'no culto', 'visitando amigos', 'em consulta médica', 'em programa cultural', 'fazendo turismo', 'no hotel', 'fora da cidade', 'no velório', 'assistindo ao jogo'];
const NEEDS = ['hunger', 'sleep', 'hygiene', 'social', 'fun', 'health', 'safety', 'money'] as const;
export const TRAITS = ['sociável', 'caseiro', 'ambicioso', 'esportista', 'religioso', 'boêmio', 'cultural', 'praiano'];
const T_SOCIAL = 1, T_HOME = 2, T_AMB = 4, T_SPORT = 8, T_REL = 16, T_BOHO = 32, T_CULT = 64, T_BEACH = 128;
export const EDU_LABEL = ['sem escolaridade', 'ensino fundamental', 'ensino médio', 'ensino superior'];
const COURSES = ['engenharia', 'medicina', 'direito', 'arquitetura', 'computação', 'administração', 'enfermagem', 'pedagogia', 'economia', 'biologia', 'artes', 'jornalismo'];
export const MODE_LABEL = ['a pé', 'bicicleta', 'carro', 'ônibus', 'trem/metrô', '—'];
export const ST_IN = 0, ST_WALK = 1, ST_CAR = 2, ST_TRANSIT = 3, ST_VIRTUAL = 4, ST_AWAY = 7;

export interface Household { id: number; members: number[]; home: number; car: boolean; wealth: number; money: number; movedDay: number; searching: boolean; unhappyDays: number; tourist: boolean; leaveDay: number }

export class Citizens {
  max = 0;
  alive = new Uint8Array(0);
  age = new Float32Array(0);
  sex = new Uint8Array(0);
  hh = new Int32Array(0);
  edu = new Uint8Array(0);
  studying = new Uint8Array(0); // 0 no,1 daycare,2 school,3 high,4 university
  school = new Int32Array(0);
  job = new Int32Array(0);
  jobEdu = new Uint8Array(0);
  income = new Float32Array(0);
  money = new Float32Array(0);
  health = new Float32Array(0);
  traits = new Uint8Array(0);
  needs = new Float32Array(0);
  state = new Uint8Array(0);
  loc = new Int32Array(0);
  act = new Uint8Array(0);
  actUntil = new Float32Array(0);
  lastUpd = new Float32Array(0);
  slot = new Int32Array(0);
  tripDest = new Int32Array(0);
  tripAct = new Uint8Array(0);
  tripDur = new Float32Array(0);
  tripMode = new Uint8Array(0);
  first = new Uint16Array(0);
  last = new Uint16Array(0);
  birthYear = new Int16Array(0);
  partner = new Int32Array(0);
  happiness = new Float32Array(0);
  shiftStart = new Float32Array(0);
  workedDay = new Int32Array(0);
  friends = new Int32Array(0);
  tourist = new Uint8Array(0);
  modeCount = [0, 0, 0, 0, 0];
  bio: { year: number; text: string }[][] = [];
  agenda: { h: number; act: Act; done: boolean }[][] = [];
  households = new Map<number, Household>();
  private nextHH = 1;
  private free: number[] = [];
  count = 0;
  private heap = new MinHeap();
  followed = -1;
  deathsToday = 0;
  birthsToday = 0;

  constructor(private w: World) { this.grow(MAX_CITIZENS); }

  /** population storage grows on demand — there is no hard population cap */
  private grow(n: number) {
    const old = this.max;
    if (n <= old) return;
    { const b = new Uint8Array(n * 1); b.set(this.alive);  this.alive = b; }
    { const b = new Float32Array(n * 1); b.set(this.age);  this.age = b; }
    { const b = new Uint8Array(n * 1); b.set(this.sex);  this.sex = b; }
    { const b = new Int32Array(n * 1); b.set(this.hh);  this.hh = b; }
    { const b = new Uint8Array(n * 1); b.set(this.edu);  this.edu = b; }
    { const b = new Uint8Array(n * 1); b.set(this.studying);  this.studying = b; }
    { const b = new Int32Array(n * 1); b.set(this.school); b.fill(-1, old * 1); this.school = b; }
    { const b = new Int32Array(n * 1); b.set(this.job); b.fill(-1, old * 1); this.job = b; }
    { const b = new Uint8Array(n * 1); b.set(this.jobEdu);  this.jobEdu = b; }
    { const b = new Float32Array(n * 1); b.set(this.income);  this.income = b; }
    { const b = new Float32Array(n * 1); b.set(this.money);  this.money = b; }
    { const b = new Float32Array(n * 1); b.set(this.health);  this.health = b; }
    { const b = new Uint8Array(n * 1); b.set(this.traits);  this.traits = b; }
    { const b = new Float32Array(n * 8); b.set(this.needs);  this.needs = b; }
    { const b = new Uint8Array(n * 1); b.set(this.state);  this.state = b; }
    { const b = new Int32Array(n * 1); b.set(this.loc); b.fill(-1, old * 1); this.loc = b; }
    { const b = new Uint8Array(n * 1); b.set(this.act);  this.act = b; }
    { const b = new Float32Array(n * 1); b.set(this.actUntil);  this.actUntil = b; }
    { const b = new Float32Array(n * 1); b.set(this.lastUpd);  this.lastUpd = b; }
    { const b = new Int32Array(n * 1); b.set(this.slot); b.fill(-1, old * 1); this.slot = b; }
    { const b = new Int32Array(n * 1); b.set(this.tripDest); b.fill(-1, old * 1); this.tripDest = b; }
    { const b = new Uint8Array(n * 1); b.set(this.tripAct);  this.tripAct = b; }
    { const b = new Float32Array(n * 1); b.set(this.tripDur);  this.tripDur = b; }
    { const b = new Uint8Array(n * 1); b.set(this.tripMode);  this.tripMode = b; }
    { const b = new Uint16Array(n * 1); b.set(this.first);  this.first = b; }
    { const b = new Uint16Array(n * 1); b.set(this.last);  this.last = b; }
    { const b = new Int16Array(n * 1); b.set(this.birthYear);  this.birthYear = b; }
    { const b = new Int32Array(n * 1); b.set(this.partner); b.fill(-1, old * 1); this.partner = b; }
    { const b = new Float32Array(n * 1); b.set(this.happiness);  this.happiness = b; }
    { const b = new Float32Array(n * 1); b.set(this.shiftStart);  this.shiftStart = b; }
    { const b = new Int32Array(n * 1); b.set(this.workedDay); b.fill(-1, old * 1); this.workedDay = b; }
    { const b = new Int32Array(n * 3); b.set(this.friends); b.fill(-1, old * 3); this.friends = b; }
    { const b = new Uint8Array(n * 1); b.set(this.tourist);  this.tourist = b; }
    this.bio.length = n; this.agenda.length = n;
    for (let i = n - 1; i >= old; i--) this.free.push(i);
    this.max = n;
  }

  get rng() { return this.w.rng; }
  name(i: number) { return `${(this.sex[i] ? FIRST_F : FIRST_M)[this.first[i] % 40]} ${LAST[this.last[i] % 40]}`; }
  need(i: number, k: number) { return this.needs[i * 8 + k]; }
  addBio(i: number, text: string) {
    const b = this.bio[i] ?? (this.bio[i] = []);
    b.push({ year: this.w.year, text });
    if (b.length > 30) b.splice(1, 1);
  }

  add(opts: { age: number; sex?: number; edu?: number; last?: number; hh: number; tourist?: boolean; bornHere?: boolean }): number {
    if (!this.free.length) this.grow(this.max * 2);
    const i = this.free.pop()!;
    const r = this.rng;
    this.alive[i] = 1;
    this.age[i] = opts.age;
    this.sex[i] = opts.sex ?? (r.chance(0.5) ? 1 : 0);
    this.hh[i] = opts.hh;
    this.edu[i] = opts.edu ?? 0;
    this.studying[i] = 0; this.school[i] = -1; this.job[i] = -1; this.income[i] = 0;
    this.money[i] = r.range(20, 200);
    this.health[i] = r.range(0.75, 1);
    let t = 0;
    for (let k = 0; k < 8; k++) if (r.chance(0.22)) t |= 1 << k;
    this.traits[i] = t;
    for (let k = 0; k < 8; k++) this.needs[i * 8 + k] = r.range(0.5, 0.95);
    this.state[i] = ST_IN;
    this.act[i] = Act.Home;
    this.lastUpd[i] = this.w.t;
    this.slot[i] = -1;
    this.first[i] = r.int(0, 39);
    this.last[i] = opts.last ?? r.int(0, 39);
    this.birthYear[i] = this.w.year - Math.floor(opts.age);
    this.partner[i] = -1;
    this.happiness[i] = 0.7;
    this.shiftStart[i] = r.range(6, 10);
    this.workedDay[i] = -1;
    this.tourist[i] = opts.tourist ? 1 : 0;
    this.bio[i] = [];
    this.agenda[i] = [];
    for (let k = 0; k < 3; k++) this.friends[i * 3 + k] = -1;
    this.count++;
    this.schedule(i, this.w.t + r.range(1, HOUR_SECONDS * 2));
    return i;
  }

  remove(i: number) {
    if (!this.alive[i]) return;
    this.endTrip(i);
    this.w.economy.leaveJob(i);
    this.w.economy.leaveSchool(i);
    const h = this.households.get(this.hh[i]);
    if (h) {
      h.members = h.members.filter((m) => m !== i);
      if (!h.members.length) this.removeHousehold(h);
    }
    if (this.partner[i] >= 0) this.partner[this.partner[i]] = -1;
    this.alive[i] = 0;
    this.free.push(i);
    this.count--;
    if (this.followed === i) this.followed = -1;
  }

  newHousehold(home: number, wealth: number, tourist = false): Household {
    const h: Household = { id: this.nextHH++, members: [], home, car: false, wealth, money: 0, movedDay: this.w.day, searching: false, unhappyDays: 0, tourist, leaveDay: -1 };
    this.households.set(h.id, h);
    const b = this.w.buildings.byId.get(home);
    if (b) b.households.push(h.id);
    return h;
  }
  removeHousehold(h: Household) {
    const b = this.w.buildings.byId.get(h.home);
    if (b) b.households = b.households.filter((x) => x !== h.id);
    this.households.delete(h.id);
  }
  moveHousehold(h: Household, home: number) {
    const old = this.w.buildings.byId.get(h.home);
    if (old) old.households = old.households.filter((x) => x !== h.id);
    h.home = home;
    h.movedDay = this.w.day;
    const b = this.w.buildings.byId.get(home);
    if (b) b.households.push(h.id);
  }

  /** a family arrives in town (immigration) */
  createFamily(home: Building, wealth: number, opts: { size?: number; eduBias?: number; arriving?: boolean; fromVillage?: boolean } = {}): Household | null {
    const r = this.rng;
    const size = opts.size ?? r.weighted([1, 2, 3, 4, 5], (n) => [0.25, 0.3, 0.2, 0.18, 0.07][n - 1])!;
    if (this.free.length < size) this.grow(this.max * 2 + size);
    const h = this.newHousehold(home.id, wealth);
    h.car = r.next() < [0.25, 0.65, 0.95][wealth] * (this.w.era >= 1 ? 1 : 0.6);
    h.money = [200, 800, 3000][wealth] * r.range(0.5, 1.5);
    const last = r.int(0, 39);
    const p = this.w.params;
    const eduOf = (age: number) => {
      if (age < 15) return 0;
      const bias = (opts.eduBias ?? p.initialEducation) + wealth * 0.18 + this.w.era * 0.06;
      const x = r.next() + bias - 0.5;
      return x < 0.15 ? 0 : x < 0.55 ? 1 : x < 0.85 || age < 22 ? 2 : 3;
    };
    const a1 = r.range(20, 62);
    const c1 = this.add({ age: a1, edu: eduOf(a1), last, hh: h.id });
    h.members.push(c1);
    if (size >= 2) {
      const a2 = Math.max(19, a1 + r.range(-6, 6));
      const c2 = this.add({ age: a2, edu: eduOf(a2), last, hh: h.id, sex: 1 - this.sex[c1] });
      if (c2 >= 0) { h.members.push(c2); this.partner[c1] = c2; this.partner[c2] = c1; }
    }
    for (let k = 2; k < size; k++) {
      const age = Math.max(0, Math.min(a1 - 18, r.range(0, 17)));
      const c = this.add({ age, edu: age > 15 ? 1 : 0, last, hh: h.id });
      if (c >= 0) h.members.push(c);
    }
    const dist = this.w.districtName(home.x, home.z);
    for (const m of h.members) {
      this.loc[m] = home.id;
      if (opts.fromVillage) this.addBio(m, `Um dos primeiros moradores da vila, em ${dist}`);
      else this.addBio(m, `Chegou à cidade com ${h.members.length > 1 ? 'a família' : 'uma mala e muitos planos'} e foi morar em ${dist}`);
      if (this.age[m] >= 18 && this.age[m] < 66) this.w.economy.seekJobSoon(m);
      this.assignStudy(m);
    }
    // friends
    for (const m of h.members) for (let k = 0; k < 3; k++) if (this.count > 10) this.friends[m * 3 + k] = this.randomCitizen();
    return h;
  }

  randomCitizen(): number {
    for (let k = 0; k < 20; k++) { const i = Math.floor(this.rng.next() * this.max); if (this.alive[i] && !this.tourist[i]) return i; }
    return -1;
  }

  assignStudy(i: number) {
    const a = this.age[i];
    const want = a < 3 ? 0 : a < 6 ? 1 : a < 15 ? 2 : a < 18 ? 3 : a < 23 && this.edu[i] >= 2 && this.studying[i] === 4 ? 4 : 0;
    if (want !== this.studying[i] || (want > 0 && this.school[i] < 0)) {
      this.w.economy.leaveSchool(i);
      this.studying[i] = want;
      if (want > 0) this.w.economy.findSchool(i);
    }
  }

  schedule(i: number, t: number) { this.actUntil[i] = t; this.heap.push(i, t); }

  // ------------------------------------------------------------------ routine
  step(dt: number) {
    const now = this.w.t;
    let budget = 450;
    while (this.heap.size && this.heap.peekPri() <= now && budget-- > 0) {
      const i = this.heap.pop();
      if (!this.alive[i]) continue;
      if (Math.abs(this.actUntil[i] - now) > 1e6) continue;
      if (this.actUntil[i] > now + 0.01) continue; // rescheduled later; stale heap entry
      if (this.state[i] === ST_VIRTUAL) { this.arrive(i); continue; }
      if (this.state[i] !== ST_IN) continue; // moving physically; arrival callback will reschedule
      this.decide(i);
    }
    void dt;
  }

  private decayNeeds(i: number) {
    const now = this.w.t;
    const hours = Math.min(48, (now - this.lastUpd[i]) / HOUR_SECONDS);
    this.lastUpd[i] = now;
    if (hours <= 0) return;
    const n = this.needs, o = i * 8;
    const a = this.act[i];
    const at = this.state[i] === ST_IN;
    n[o] -= 0.055 * hours;
    n[o + 1] += a === Act.Sleep && at ? 0.13 * hours : -0.04 * hours;
    n[o + 2] += a === Act.Home || a === Act.Sleep || a === Act.Gym ? 0.08 * hours : -0.035 * hours;
    n[o + 3] += a === Act.Visit || a === Act.Bar || a === Act.Church || a === Act.Park || a === Act.Game ? 0.15 * hours : a === Act.Work || a === Act.Study ? 0.02 * hours : -0.03 * hours;
    n[o + 4] += a === Act.Park || a === Act.Culture || a === Act.Beach || a === Act.Bar || a === Act.Gym || a === Act.Sightsee || a === Act.Game ? 0.16 * hours : -0.03 * hours;
    n[o + 5] = this.health[i];
    if ((a === Act.Eat || a === Act.Home) && at) n[o] += 0.25 * hours;
    for (let k = 0; k < 8; k++) n[o + k] = Math.max(0, Math.min(1, n[o + k]));
  }

  private hourOf(t: number) { return ((t % DAY_SECONDS) / DAY_SECONDS) * 24; }

  decide(i: number) {
    const w = this.w;
    this.decayNeeds(i);
    const r = this.rng;
    const now = w.t;
    const hour = this.hourOf(now);
    const day = w.day;
    const n = this.needs, o = i * 8;
    const tr = this.traits[i];
    const h = this.households.get(this.hh[i]);
    if (!h) { this.remove(i); return; }
    const home = w.buildings.byId.get(h.home);
    if (!home) { this.schedule(i, now + HOUR_SECONDS); return; }
    const here = w.buildings.byId.get(this.loc[i]) ?? home;
    if (this.tourist[i]) { w.tourism2?.decideTourist(i, here, hour); return; }
    const age = this.age[i];
    const opts: [Act, number][] = [];
    const sunday = day % 7 === 6;
    // obligations
    if (this.job[i] >= 0 && !sunday && this.workedDay[i] !== day) {
      const st = this.shiftStart[i];
      if (hour >= st - 1 && hour < st + 3) opts.push([Act.Work, 4 * (tr & T_AMB ? 1.2 : 1)]);
    }
    if (this.school[i] >= 0 && !sunday && this.workedDay[i] !== day && hour >= 6.5 && hour < 10) opts.push([Act.Study, 4]);
    // needs
    const night = hour >= 22 || hour < 6;
    opts.push([Act.Sleep, night ? 2 + (1 - n[o + 1]) * 3 : (1 - n[o + 1]) * 1.2]);
    opts.push([Act.Home, 0.7 + (tr & T_HOME ? 0.6 : 0) + (1 - n[o + 2]) * 0.8 + w.weather.rain * 0.6]);
    const awake = hour >= 7 && hour < 22;
    if (awake) {
      opts.push([Act.Eat, (1 - n[o]) * 2.2 * (hour > 11 && hour < 14 || hour > 19 && hour < 21.5 ? 1.4 : 0.7) * (h.money > 50 ? 1 : 0.4)]);
      if (hour >= 8 && hour < 21) opts.push([Act.Shop, 0.35 + (1 - n[o]) * 0.9 + r.next() * 0.3]);
      if (age > 12) opts.push([Act.Visit, (1 - n[o + 3]) * 1.6 * (tr & T_SOCIAL ? 1.4 : 1)]);
      opts.push([Act.Park, (1 - n[o + 4]) * 1.2 * (1 - w.weather.rain) * (hour < 19 ? 1 : 0.3) * (w.places.has('park') ? 1 : 0)]);
      if (tr & T_SPORT || r.chance(0.15)) opts.push([Act.Gym, (1 - n[o + 4]) * 1.3 * (w.places.has('gym') ? 1 : 0)]);
      if (tr & T_CULT || r.chance(0.2)) opts.push([Act.Culture, (1 - n[o + 4]) * 1.4 * (w.places.has('culture') ? 1 : 0) * (hour > 14 ? 1 : 0.3)]);
      if ((tr & T_BEACH || r.chance(0.2)) && w.beachOk()) opts.push([Act.Beach, (1 - n[o + 4]) * 1.8 * (w.season === 1 ? 1.5 : 0.6) * (1 - w.weather.rain)]);
      if (this.health[i] < 0.55) opts.push([Act.Doctor, (1 - this.health[i]) * 4 * (w.places.has('doctor') ? 1 : 0.1)]);
      if (sunday && tr & T_REL && hour < 12) opts.push([Act.Church, 3]);
      if (w.gameDay === day && hour > 15 && hour < 21 && age > 10 && w.places.has('stadium')) opts.push([Act.Game, 1.5 + (tr & T_SPORT ? 1.5 : 0)]);
    }
    if (age > 17 && (hour >= 19 || hour < 1)) opts.push([Act.Bar, (1 - n[o + 3]) * 1.3 * (tr & T_BOHO ? 2 : 0.7) * (w.places.has('bar') ? 1 : 0)]);
    // pick: softmax-ish
    let best = Act.Home, bs = -1;
    for (const [a, u] of opts) { const s = u + r.next() * 0.4; if (s > bs) { bs = s; best = a; } }
    this.perform(i, best, here, home, h, hour);
  }

  perform(i: number, a: Act, here: Building, home: Building, h: Household, hour: number) {
    const w = this.w;
    const r = this.rng;
    let dest: Building | null = null;
    let dur = HOUR_SECONDS * r.range(0.6, 1.6);
    const cat = (c: PlaceCat) => w.places.pick(c, here.x, here.z, () => r.next());
    switch (a) {
      case Act.Sleep:
        dest = home;
        dur = HOUR_SECONDS * (hour >= 20 ? 24 - hour + r.range(5.5, 7.5) : hour < 6 ? Math.max(1, r.range(5.5, 7) - hour) : 1.2);
        break;
      case Act.Home: dest = home; dur = HOUR_SECONDS * r.range(0.8, 2.5); break;
      case Act.Work: dest = w.buildings.byId.get(this.job[i]) ?? null; dur = HOUR_SECONDS * r.range(7.5, 9.5); this.workedDay[i] = w.day; break;
      case Act.Study: dest = w.buildings.byId.get(this.school[i]) ?? null; dur = HOUR_SECONDS * (this.studying[i] === 4 ? r.range(5, 8) : r.range(4.5, 6)); this.workedDay[i] = w.day; break;
      case Act.Eat: dest = h.money > 80 && r.chance(0.6) ? cat('eat') : home; dur = HOUR_SECONDS * r.range(0.6, 1.4); break;
      case Act.Shop: dest = cat('shop'); dur = HOUR_SECONDS * r.range(0.4, 1.2); if (!dest) w.economy.unservedShopping++; break;
      case Act.Visit: {
        const f = this.friends[i * 3 + r.int(0, 2)];
        const fh = f >= 0 && this.alive[f] ? this.households.get(this.hh[f]) : null;
        dest = fh ? w.buildings.byId.get(fh.home) ?? null : cat('park');
        dur = HOUR_SECONDS * r.range(1, 2.5);
        break;
      }
      case Act.Park: dest = cat('park'); break;
      case Act.Gym: dest = cat('gym'); break;
      case Act.Culture: dest = cat('culture'); dur = HOUR_SECONDS * r.range(1.5, 3); break;
      case Act.Bar: dest = cat('bar'); dur = HOUR_SECONDS * r.range(1.5, 3); break;
      case Act.Church: dest = cat('church'); dur = HOUR_SECONDS * 1.5; break;
      case Act.Doctor: dest = cat('doctor'); dur = HOUR_SECONDS * r.range(1, 2); if (dest) this.health[i] = Math.min(1, this.health[i] + 0.3); break;
      case Act.Beach: dest = w.beachPlace(here); dur = HOUR_SECONDS * r.range(2, 4); break;
      case Act.Game: dest = cat('stadium'); dur = HOUR_SECONDS * 2.5; break;
      default: dest = home;
    }
    if (!dest) { dest = home; a = Act.Home; }
    this.agenda[i].push({ h: hour, act: a, done: false });
    if (this.agenda[i].length > 12) this.agenda[i].shift();
    dest.visitors++;
    if (dest.def.cat === 'com' || dest.kind === 'restaurant') w.economy.spend(i, dest, a === Act.Eat ? 18 : a === Act.Shop ? 25 : 12);
    if (dest.id === this.loc[i]) {
      this.act[i] = a;
      this.schedule(i, w.t + dur);
      return;
    }
    this.startTrip(i, here, dest, a, dur);
  }

  /** mode choice + spawn a physical agent or a virtual trip */
  startTrip(i: number, from: Building, to: Building, a: Act, dur: number) {
    const w = this.w;
    const r = this.rng;
    const h = this.households.get(this.hh[i])!;
    const d = Math.hypot(to.x - from.x, to.z - from.z) * 1.3;
    const plan = carPlan(w.roads, from, to);
    this.tripDest[i] = to.id; this.tripAct[i] = a; this.tripDur[i] = dur;
    this.act[i] = a;
    if (!plan) { this.virtualArrive(i, d / 6 + 30); return; }
    const tp = w.params.transitPriority;
    const vot = 0.3 + this.income[i] / 80; // value of time
    const rain = w.weather.rain;
    const len = pathLength(w.roads, plan);
    w.transitSys?.recordTrip(from, to, len);
    const costs: number[] = [Infinity, Infinity, Infinity, Infinity, Infinity];
    costs[0] = len < 1800 ? (len / 1.35) * vot * (1 + rain * 1.5) : Infinity;
    if ((this.traits[i] & T_SPORT || this.age[i] < 30 && h.wealth === 0) && len < 4500 && this.age[i] > 10 && this.age[i] < 65) costs[1] = (len / 4.5) * vot * (1 + rain * 2) + 20;
    if (h.car && this.age[i] >= 18) costs[2] = (plan.time + 60) * vot + len * 0.012 * (1 + tp * 1.5) + w.fields.sample('landValue', to.x, to.z) * 15 * (1 + tp);
    const tr = w.transit2?.transitOption(from, to, len);
    if (tr) costs[tr.mode] = tr.time * vot * (1 - tp * 0.35) + tr.fare;
    let mode = 0, mc = Infinity;
    for (let m = 0; m < 5; m++) if (costs[m] < mc) { mc = costs[m]; mode = m; }
    if (mc === Infinity) mode = h.car ? 2 : 0;
    this.tripMode[i] = mode;
    this.modeCount[mode]++;
    if (mode === 3 || mode === 4) {
      if (w.transit2?.board(i, from, to, tr!)) { this.state[i] = ST_TRANSIT; return; }
      mode = 0;
    }
    if (mode === 2) {
      const vt = this.income[i] > 200 && r.chance(0.25) ? VType.Car : r.chance(0.08) ? VType.Moto : r.chance(0.05) && w.era >= 1 ? VType.Taxi : VType.Car;
      if (w.traffic.capacityLeft > 60 && w.lodAllowsVehicle(from.x, from.z)) {
        const slot = w.traffic.spawn(vt, plan.path, plan.startS, plan.destS, { kind: P_CITIZEN, id: i, aux: 0 }, from.id, to.id);
        if (slot >= 0) { this.state[i] = ST_CAR; this.slot[i] = slot; return; }
        // no room to pull out onto the street: a short trip changes mode to walking instead of teleporting
        if (len < 1500) { mode = 0; this.modeCount[2]--; this.modeCount[0]++; this.tripMode[i] = 0; }
      }
      if (mode === 2) {
      // virtual car trip still loads the network
      for (const de of plan.path) w.roads.loadVirtual(de, from.id, to.id, vt === VType.Moto ? 1 : 0);
      this.virtualArrive(i, plan.time + 30);
      return;
      }
    }
    const speed = mode === 1 ? r.range(4, 5.5) : r.range(1.2, 1.5) * (this.age[i] > 70 ? 0.75 : 1);
    if (w.peds.capacityLeft > 30) {
      const pts = walkPoints(w.roads, plan, doorOf(w.roads, from), doorOf(w.roads, to));
      const slot = w.peds.spawn(pts, i, speed, (mode === 1 ? PED_FLAG_BIKE : 0) | (this.tourist[i] ? PED_FLAG_TOURIST | (a === Act.Hotel ? PED_FLAG_LUGGAGE : 0) : 0), this.colorOf(i));
      if (slot >= 0) { this.state[i] = ST_WALK; this.slot[i] = slot; return; }
    }
    this.virtualArrive(i, len / speed);
  }

  colorOf(i: number) { return ((i * 2654435761) >>> 0) % 997 / 997; }

  virtualArrive(i: number, secs: number) {
    this.state[i] = ST_VIRTUAL;
    this.slot[i] = -1;
    this.schedule(i, this.w.t + Math.max(5, secs));
  }

  /** physical or virtual arrival */
  arrive(i: number) {
    if (!this.alive[i]) return;
    const w = this.w;
    this.state[i] = ST_IN;
    this.slot[i] = -1;
    const dest = this.tripDest[i];
    const b = w.buildings.byId.get(dest);
    const h = this.households.get(this.hh[i]);
    if (this.act[i] === Act.Away && h) { // left the city
      this.remove(i);
      return;
    }
    this.loc[i] = b ? dest : h?.home ?? -1;
    const ag = this.agenda[i];
    if (ag.length) ag[ag.length - 1].done = true;
    this.lastUpd[i] = w.t;
    this.schedule(i, w.t + this.tripDur[i]);
  }

  endTrip(i: number) {
    const s = this.slot[i];
    if (s >= 0) {
      if (this.state[i] === ST_CAR && this.w.traffic.pKind[s] === P_CITIZEN && this.w.traffic.pId[s] === i) this.w.traffic.despawn(s);
      if (this.state[i] === ST_WALK && this.w.peds.citizen[s] === i) this.w.peds.despawn(s);
    }
    this.slot[i] = -1;
  }

  // ------------------------------------------------------------------ lifecycle (daily)
  daily() {
    const w = this.w;
    const r = this.rng;
    const p = w.params;
    this.deathsToday = 0; this.birthsToday = 0;
    const yearFrac = 1 / DAYS_PER_YEAR;
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i] || this.tourist[i]) continue;
      const before = Math.floor(this.age[i]);
      this.age[i] += yearFrac;
      const after = Math.floor(this.age[i]);
      const h = this.households.get(this.hh[i]);
      if (!h) { this.remove(i); continue; }
      // health drifts with environment
      const home = w.buildings.byId.get(h.home);
      if (home) {
        const air = w.fields.sample('airPollution', home.x, home.z);
        const cov = w.fields.sample('cov_health', home.x, home.z);
        const sick = w.epidemic > 0 ? w.epidemic * 0.03 * (1 + w.fields.sample('resDensity', home.x, home.z) / 10) * (home.watered ? 1 : 2) : 0;
        this.health[i] = Math.max(0.05, Math.min(1, this.health[i] + 0.02 * cov - 0.015 * air - (this.age[i] > 60 ? 0.006 : 0) - (r.chance(sick) ? 0.35 : 0) + 0.01));
      }
      if (after !== before) this.birthday(i, after, h);
      // death (Gompertz hazard tuned by life expectancy)
      const le = p.lifeExpectancy;
      const hazardYear = 0.0005 * Math.exp(0.085 * (this.age[i] - (le - 76))) * (1.6 - this.health[i]);
      if (r.chance(Math.min(0.5, hazardYear * yearFrac * 1.4))) { this.die(i, h); continue; }
    }
    // couples & births
    for (const h of this.households.values()) {
      if (h.tourist || h.members.length >= 6) continue;
      const adults = h.members.filter((m) => this.age[m] >= 20 && this.age[m] <= 42 && this.partner[m] >= 0);
      if (adults.length >= 1 && r.chance(0.012 * p.natality * (h.members.length < 3 ? 1.4 : 0.7))) this.birth(h);
    }
    // marriages among singles
    const singles: number[] = [];
    for (let i = 0; i < this.max; i++) if (this.alive[i] && !this.tourist[i] && this.partner[i] < 0 && this.age[i] > 21 && this.age[i] < 45) singles.push(i);
    for (let k = 0; k < Math.min(6, singles.length / 20); k++) {
      const a = singles[Math.floor(r.next() * singles.length)], b = singles[Math.floor(r.next() * singles.length)];
      if (a === b || this.hh[a] === this.hh[b] || this.partner[a] >= 0 || this.partner[b] >= 0) continue;
      if (Math.abs(this.age[a] - this.age[b]) > 10) continue;
      this.marry(a, b);
    }
  }

  private birthday(i: number, age: number, h: Household) {
    const w = this.w;
    if (age === 6 || age === 15 || age === 18 || age === 3) {
      if (age === 15 && this.studying[i] === 2) { this.edu[i] = Math.max(this.edu[i], 1); this.addBio(i, 'Concluiu o ensino fundamental'); }
      if (age === 18 && this.studying[i] === 3) {
        this.edu[i] = Math.max(this.edu[i], 2);
        this.addBio(i, 'Formou-se no ensino médio');
        if (w.hasUniversity() && this.rng.chance(0.35 + h.wealth * 0.25 + (this.traits[i] & T_AMB ? 0.2 : 0))) {
          this.studying[i] = 4;
          const course = COURSES[(i * 7) % COURSES.length];
          this.addBio(i, `Entrou na universidade para estudar ${course}`);
        }
      }
      this.assignStudy(i);
      if (age === 6 && this.school[i] >= 0) this.addBio(i, `Começou a estudar na ${w.buildings.byId.get(this.school[i])?.name ?? 'escola'}`);
    }
    if (age === 23 && this.studying[i] === 4) {
      this.edu[i] = 3;
      this.studying[i] = 0;
      w.economy.leaveSchool(i);
      this.addBio(i, `Formou-se em ${COURSES[(i * 7) % COURSES.length]}`);
      w.events.emit('citizen', w.buildings.byId.get(h.home)?.x ?? 0, w.buildings.byId.get(h.home)?.z ?? 0, 0.2, `${this.name(i)} se forma em ${COURSES[(i * 7) % COURSES.length]}`, { entity: { kind: 'citizen', id: i } });
    }
    if (age >= 18 && this.studying[i] === 0 && this.job[i] < 0 && age < 66) w.economy.seekJobSoon(i);
    if (age === 65 && this.job[i] >= 0) {
      w.economy.leaveJob(i);
      this.addBio(i, 'Aposentou-se');
    }
  }

  private birth(h: Household) {
    const w = this.w;
    const parent = h.members.find((m) => this.partner[m] >= 0) ?? h.members[0];
    const c = this.add({ age: 0, last: this.last[parent], hh: h.id, edu: 0 });
    if (c < 0) return;
    h.members.push(c);
    const home = w.buildings.byId.get(h.home);
    this.loc[c] = h.home;
    const dist = home ? w.districtName(home.x, home.z) : 'a cidade';
    this.addBio(c, `Nasceu no ano ${w.year} no bairro ${dist}`);
    this.addBio(parent, `Nasceu ${this.sex[c] ? 'a filha' : 'o filho'} ${this.name(c).split(' ')[0]}`);
    this.birthsToday++;
    if (home) w.events.emit('birth', home.x, home.z, 0.15, `Nasce ${this.name(c)} em ${dist}`, { entity: { kind: 'citizen', id: parent } });
    // crowded? look for a bigger home
    if (home && h.members.length > (home.level <= 2 ? 4 : 5)) w.economy.wantsToMove(h, 'família cresceu');
  }

  private marry(a: number, b: number) {
    const w = this.w;
    this.partner[a] = b; this.partner[b] = a;
    const ha = this.households.get(this.hh[a])!, hb = this.households.get(this.hh[b])!;
    // b moves into a's household (and leaves the old one)
    hb.members = hb.members.filter((m) => m !== b);
    if (!hb.members.length) this.removeHousehold(hb);
    ha.members.push(b);
    this.hh[b] = ha.id;
    this.last[b] = this.rng.chance(0.5) ? this.last[a] : this.last[b];
    this.addBio(a, `Casou-se com ${this.name(b)}`);
    this.addBio(b, `Casou-se com ${this.name(a)}`);
    const home = w.buildings.byId.get(ha.home);
    if (home) {
      w.events.emit('wedding', home.x, home.z, 0.3, `Casamento: ${this.name(a)} e ${this.name(b)}`, { entity: { kind: 'citizen', id: a } });
      if (ha.members.length > (home.level <= 1 ? 3 : 5)) w.economy.wantsToMove(ha, 'casamento');
    }
  }

  die(i: number, h: Household) {
    const w = this.w;
    const home = w.buildings.byId.get(h.home);
    const name = this.name(i);
    this.deathsToday++;
    if (this.partner[i] >= 0) this.addBio(this.partner[i], `Ficou viúv${this.sex[this.partner[i]] ? 'a' : 'o'} de ${name}`);
    this.remove(i);
    if (home) w.funeral(home, name, h);
  }

  /** emigration: the household drives away along the highway */
  leaveCity(h: Household, reason: string) {
    const w = this.w;
    const home = w.buildings.byId.get(h.home);
    const exit = w.exitNode();
    for (const m of [...h.members]) {
      this.addBio(m, `Deixou a cidade (${reason})`);
      this.endTrip(m);
      w.economy.leaveJob(m); w.economy.leaveSchool(m);
    }
    if (home && exit >= 0) {
      const plan = carPlanToNode(w.roads, home, exit);
      const driver = h.members[0];
      if (plan && driver !== undefined) {
        const slot = w.traffic.spawn(VType.Van, plan.path, plan.startS, plan.destS, { kind: P_MOVING, id: -1, aux: 0 }, home.id, -1);
        void slot;
      }
    }
    for (const m of [...h.members]) this.remove(m);
    if (this.households.has(h.id)) this.removeHousehold(h);
  }

  /** immigrants enter through the highway */
  arriveFromHighway(h: Household) {
    const w = this.w;
    const home = w.buildings.byId.get(h.home);
    const entry = w.entryNode();
    if (!home || entry < 0) return;
    const plan: CarPlan | null = carPlanFromNode(w.roads, entry, home);
    if (!plan) return;
    const driver = h.members.find((m) => this.age[m] >= 18) ?? h.members[0];
    const vt = h.car ? VType.Car : VType.Bus;
    for (const m of h.members) {
      this.loc[m] = -1;
      this.tripDest[m] = home.id; this.tripAct[m] = Act.Home; this.tripDur[m] = HOUR_SECONDS; this.act[m] = Act.Home;
    }
    const slot = w.traffic.capacityLeft > 40 ? w.traffic.spawn(vt === VType.Bus ? VType.Car : vt, plan.path, plan.startS, plan.destS, { kind: P_CITIZEN, id: driver, aux: 1 }, -1, home.id) : -1;
    if (h.members.length >= 3 && w.traffic.capacityLeft > 40) {
      w.traffic.spawn(VType.Van, plan.path, plan.startS, plan.destS, { kind: P_MOVING, id: -1, aux: 0 }, -1, home.id); // caminhão de mudança
    }
    for (const m of h.members) {
      if (m === driver && slot >= 0) { this.state[m] = ST_CAR; this.slot[m] = slot; }
      else this.virtualArrive(m, plan.time + 20);
    }
    if (slot >= 0 && this.rng.chance(0.12)) w.events.emit('immigration', home.x, home.z, 0.35, `Família ${LAST[this.last[driver] % 40]} chega à cidade pela rodovia`, { entity: { kind: 'vehicle', id: slot, gen: w.traffic.gen[slot] } });
  }

  // ------------------------------------------------------------------ inspection
  inspect(i: number) {
    if (!this.alive[i]) return null;
    const w = this.w;
    const h = this.households.get(this.hh[i]);
    const home = h ? w.buildings.byId.get(h.home) : null;
    const job = this.job[i] >= 0 ? w.buildings.byId.get(this.job[i]) : this.school[i] >= 0 ? w.buildings.byId.get(this.school[i]) : null;
    const st = this.state[i];
    const a = this.act[i];
    let state: string;
    if (st === ST_IN) {
      const b = w.buildings.byId.get(this.loc[i]);
      state = b ? `Dentro de: ${b.name}, ${ACT_LABEL[a]}` : ACT_LABEL[a];
    } else {
      const dest = w.buildings.byId.get(this.tripDest[i]);
      const how = st === ST_CAR ? 'dirigindo' : st === ST_WALK ? (this.tripMode[i] === 1 ? 'pedalando' : 'caminhando') : st === ST_TRANSIT ? w.transit2?.describe(i) ?? 'no transporte público' : 'a caminho';
      state = `${how} para ${dest?.name ?? 'casa'} (${ACT_LABEL[this.tripAct[i]]})`;
    }
    const needs: Record<string, number> = {};
    NEEDS.forEach((k, idx) => (needs[k] = idx === 7 ? Math.min(1, (h?.money ?? 0) / 2000) : idx === 6 ? Math.max(0, 1 - w.fields.sample('crime', home?.x ?? 0, home?.z ?? 0)) : this.needs[i * 8 + idx]));
    const traits: string[] = [];
    TRAITS.forEach((t, k) => { if (this.traits[i] & (1 << k)) traits.push(t); });
    const fmtH = (x: number) => `${String(Math.floor(x)).padStart(2, '0')}:${String(Math.floor((x % 1) * 60)).padStart(2, '0')}`;
    return {
      id: i, name: this.name(i), age: Math.floor(this.age[i]), sex: this.sex[i] ? 'mulher' : 'homem', traits, edu: EDU_LABEL[this.edu[i]] + (this.studying[i] ? ` (estudando: ${['', 'creche', 'escola', 'ensino médio', 'universidade'][this.studying[i]]})` : ''),
      job: job ? `${job.name}${this.job[i] >= 0 ? '' : ' (estudante)'}` : this.age[i] >= 65 ? 'aposentado(a)' : this.age[i] < 6 ? '—' : 'desempregado(a)',
      home: home ? `${home.name} · ${w.districtName(home.x, home.z)}` : '—', income: this.income[i], money: h?.money ?? 0, needs, state, activity: ACT_LABEL[a],
      agenda: this.agenda[i].map((g) => ({ h: fmtH(g.h), act: ACT_LABEL[g.act], done: g.done })), bio: this.bio[i] ?? [],
      family: h ? h.members.filter((m) => m !== i).map((m) => `${this.name(m)} (${Math.floor(this.age[m])})`) : [],
      mode: MODE_LABEL[this.tripMode[i]], happiness: this.happiness[i], tourist: !!this.tourist[i], insideBuilding: st === ST_IN ? this.loc[i] : -1,
    };
  }

  /** world position for camera follow */
  position(i: number): { x: number; y: number; z: number; h: number; inside: boolean; building: number } | null {
    if (!this.alive[i]) return null;
    const w = this.w;
    const st = this.state[i];
    const s = this.slot[i];
    if (st === ST_CAR && s >= 0 && w.traffic.active[s]) { w.traffic.computePose(s); return { x: w.traffic.x[s], y: w.traffic.y[s], z: w.traffic.z[s], h: w.traffic.h[s], inside: false, building: -1 }; }
    if (st === ST_WALK && s >= 0 && w.peds.active[s]) { w.peds.pose(s); return { x: w.peds.x[s], y: Math.max(0.2, w.terrain.heightAt(w.peds.x[s], w.peds.z[s])) + 0.1, z: w.peds.z[s], h: w.peds.h[s], inside: false, building: -1 }; }
    if (st === ST_TRANSIT) { const p = w.transit2?.position(i); if (p) return p; }
    const bid = st === ST_IN ? this.loc[i] : this.tripDest[i];
    const b = w.buildings.byId.get(bid) ?? w.buildings.byId.get(this.households.get(this.hh[i])?.home ?? -1);
    if (!b) return null;
    return { x: b.x, y: b.y + b.height * 0.5, z: b.z, h: 0, inside: true, building: b.id };
  }

  static readonly PED_FLAGS = { PED_FLAG_TOURIST, PED_FLAG_LUGGAGE, PED_FLAG_FUNERAL };
  static readonly KINDS = KINDS;
}
