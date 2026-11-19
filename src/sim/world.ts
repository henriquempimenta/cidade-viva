import { KINDS } from '../shared/catalog';
import { DAY_SECONDS, DAYS_PER_SEASON, DAYS_PER_YEAR, ERA_POP, ERAS, HOUR_SECONDS, RoadClass, SEASONS } from '../shared/constants';
import type { SimParams } from '../shared/params';
import type { BuildingView, EdgeView, NodeView, RailEdgeView, WorldDiff, WorldInit } from '../shared/protocol';
import { RNG, clamp } from '../shared/rng';
import { DISTRICT_PREFIX, DISTRICT_SUFFIX } from '../shared/names';
import { Building, Buildings, Candidate } from './buildings';
import { EventBus } from './events';
import { Fields } from './fields';
import { updateFields } from './fieldsUpdate';
import { Occupancy, OCC_RAIL } from './occupancy';
import { Market, RoadGrowth } from './planner';
import { borderPoint, chaikin, resample, simplify, terrainPath, type P2 } from './regional';
import { RoadNetwork, type REdge } from './roads';
import { type SiteContext } from './siting';
import { Terrain } from './terrain';
import { Weather } from './weather';

export interface District { id: number; name: string; x: number; z: number; founded: number }

// Optional subsystems (attached in later stages)
export interface RailLike { splatAccess(F: Fields, rail: Float32Array, transit: Float32Array): void }
export interface TransitLike { splatCoverage(F: Fields, transit: Float32Array): void }
export interface UtilitiesLike { riverInput(arr: Float32Array): void }
export interface TourismLike { pressure: number }

export class World {
  params: SimParams;
  rng: RNG;
  terrain: Terrain;
  occ: Occupancy;
  fields: Fields;
  roads: RoadNetwork;
  buildings: Buildings;
  market: Market;
  growth: RoadGrowth;
  events: EventBus;
  weather: Weather;
  rail: RailLike | null = null;
  transit: TransitLike | null = null;
  utilities: UtilitiesLike | null = null;
  tourism: TourismLike | null = null;

  t = 0; // motion seconds since start
  day = 0;
  hourIdx = 0;
  era = 0;
  center: P2 = { x: 0, z: 0 };
  cityRadius = 150;
  siteScarcity = 0;
  demand = { res: 0, com: 0, ind: 0, off: 0 };
  districts: District[] = [];
  highwayPath: P2[] = [];
  railPath: P2[] = [];
  hubNode = -1;
  roadWorks = new Map<number, { motive: string; speed: number; kind: 'new' | 'upgrade' }>();
  // stage-1 population model (replaced by citizens in stage 2)
  population = 0;
  households = 0;
  private hhSeq = 1;

  constructor(params: SimParams) {
    this.params = { ...params };
    this.rng = new RNG(params.seed);
    this.terrain = new Terrain(params.mapSize, params.terrain, params.seed);
    this.occ = new Occupancy(params.mapSize, this.terrain);
    this.fields = new Fields(this.terrain);
    this.roads = new RoadNetwork(this.terrain, this.occ, this.rng.fork(11));
    this.buildings = new Buildings(this.occ, this.terrain, this.rng.fork(12));
    this.market = new Market(this);
    this.growth = new RoadGrowth(this);
    this.events = new EventBus(() => ({ t: this.t, day: this.day }));
    this.weather = new Weather(this.rng.fork(13), params.seed);
    this.t = DAY_SECONDS * 0.29; // the story starts at dawn
    this.found();
  }

  // ---------------- clock ----------------
  get dayFrac() { return (this.t % DAY_SECONDS) / DAY_SECONDS; }
  get hour() { return this.dayFrac * 24; }
  get year() { return Math.floor(this.day / DAYS_PER_YEAR) + 1; }
  get season() { return Math.floor((this.day % DAYS_PER_YEAR) / DAYS_PER_SEASON); }
  dateLabel() { return `Ano ${this.year} · ${SEASONS[this.season]}`; }

  siteCtx(): SiteContext {
    return { terrain: this.terrain, roads: this.roads, occ: this.occ, fields: this.fields, rng: this.rng, params: this.params, center: this.center, cityRadius: this.cityRadius };
  }

  // ---------------- founding ----------------
  private found() {
    const T = this.terrain, S = T.size, rng = this.rng;
    // 1. village site: flat dry land near the river, middle of the map
    let best: P2 | null = null, bestS = -Infinity;
    for (let i = 0; i < 600; i++) {
      const p = T.river[Math.floor(rng.range(0.3, 0.7) * T.river.length)];
      const ang = rng.range(0, Math.PI * 2), r = rng.range(90, 260);
      const x = p.x + Math.cos(ang) * r, z = p.z + Math.sin(ang) * r;
      if (!T.inside(x, z, S * 0.2)) continue;
      const h = T.heightAt(x, z);
      if (h < 2.2 || T.isFlood(x, z)) continue;
      const slope = T.slopeAt(x, z) + T.slopeAt(x + 40, z) + T.slopeAt(x, z + 40) + T.slopeAt(x - 40, z) + T.slopeAt(x, z - 40);
      const d = T.distToRiver(x, z);
      const s = -slope * 12 - Math.abs(d - 160) / 80 - Math.hypot(x - S / 2, z - S / 2) / S + rng.next() * 0.3;
      if (s > bestS) { bestS = s; best = { x, z }; }
    }
    const village = best ?? { x: S / 2, z: S / 2 };
    this.center = { ...village };

    // 2. regional highway crossing the map through the village
    const seaSide = T.coastSide;
    const sides = [0, 1, 2, 3].filter((s) => s !== seaSide);
    const entrySide = rng.pick(sides);
    let exitSide = (entrySide + 2) % 4;
    if (exitSide === seaSide) exitSide = (entrySide + 1) % 4;
    const entry = borderPoint(S, entrySide, rng.range(0.3, 0.7));
    const exit = borderPoint(S, exitSide, rng.range(0.3, 0.7));
    const hwOpts = { slopeW: 40, waterW: 9, cell: 25 };
    const p1 = terrainPath(T, entry, village, hwOpts);
    const p2 = terrainPath(T, village, exit, hwOpts);
    let hp = simplify(p1.concat(p2.slice(1)), 18);
    hp = resample(chaikin(hp, 2), 85);
    this.highwayPath = hp;
    let prev = -1;
    for (let i = 0; i < hp.length; i++) {
      const n = this.roads.addNode(hp[i].x, hp[i].z);
      if (prev >= 0) {
        const a = this.roads.nodes[prev];
        const mid = { x: (a.x + n.x) / 2, z: (a.z + n.z) / 2 };
        const wet = T.isWater(mid.x, mid.z) || T.isWater(a.x * 0.75 + n.x * 0.25, a.z * 0.75 + n.z * 0.25) || T.isWater(a.x * 0.25 + n.x * 0.75, a.z * 0.25 + n.z * 0.75);
        this.roads.addEdge(prev, n.id, RoadClass.Highway, { progress: 1, bridge: wet, name: 'Rodovia Regional' });
      }
      prev = n.id;
    }
    // ensure bridge segments end on land: split long wet sequences are acceptable visually
    let hub = this.roads.nearestNode(village.x, village.z, 600);
    if (!hub) hub = this.roads.nodes[Math.floor(this.roads.nodes.length / 2)];
    this.hubNode = hub.id;
    this.center = { x: hub.x, z: hub.z };
    // grid orientation follows the highway at the hub
    const he = this.roads.edges[hub.edges[0]];
    this.growth.gridAngle = this.roads.angleOf(he, hub.id);

    // 3. regional railway corridor passing near the village (trains arrive later)
    const rSides = [0, 1, 2, 3].filter((s) => s !== seaSide && s !== entrySide);
    const rs = rng.pick(rSides);
    let re = (rs + 2) % 4;
    if (re === seaSide) re = (rs + 3) % 4;
    const perp = this.growth.gridAngle + Math.PI / 2;
    const via = { x: hub.x + Math.cos(perp) * 330, z: hub.z + Math.sin(perp) * 330 };
    const viaOk = T.heightAt(via.x, via.z) > 1 ? via : { x: hub.x - Math.cos(perp) * 330, z: hub.z - Math.sin(perp) * 330 };
    const rOpts = { slopeW: 160, waterW: 6, cell: 25, avoid: (x: number, z: number) => (Math.hypot(x - hub!.x, z - hub!.z) < 200 ? 4 : 0) };
    const r1 = terrainPath(T, borderPoint(S, rs, rng.range(0.25, 0.75), -40), viaOk, rOpts);
    const r2 = terrainPath(T, viaOk, borderPoint(S, re, rng.range(0.25, 0.75), -40), rOpts);
    this.railPath = resample(chaikin(simplify(r1.concat(r2.slice(1)), 20), 3), 20);
    for (let i = 0; i < this.railPath.length - 1; i++) {
      const a = this.railPath[i], b = this.railPath[i + 1];
      const r = this.occ.segRect(a.x, a.z, b.x, b.z, 9);
      this.occ.forRect(r.cx, r.cz, r.angle, r.w + 2, r.d, (k) => { if (k >= 0 && this.occ.grid[k] !== 3) this.occ.grid[k] = OCC_RAIL; });
    }
    this.clearTreesAlong(this.railPath, 9);
    this.clearTreesAlong(this.highwayPath, 14);

    this.districts.push({ id: 0, name: 'Centro Velho', x: hub.x, z: hub.z, founded: 0 });

    // 4. first dirt streets
    for (let i = 0; i < 40 && this.roads.edges.filter((e) => e.cls !== RoadClass.Highway).length < 5; i++) {
      this.growth.grow(1, 1);
    }
    for (const e of this.roads.edges) if (e.progress < 1) e.progress = 1;
    this.roadWorks.clear();
    updateFields(this);

    // 5. first buildings: a handful of houses, a well, a generator, a chapel
    const placeNow = (kind: string, wealth: number, motive: string) => {
      const b = this.market.develop(kind, wealth, motive);
      if (b) { b.state = 'done'; b.progress = 1; this.buildings.underConstruction.delete(b.id); this.onBuildingCompleted(b, true); }
      return b;
    };
    for (let i = 0; i < 9; i++) placeNow('res', i < 6 ? 0 : 1, 'Primeiros moradores');
    this.publicNow('well', 'Abastecimento de água da vila');
    this.publicNow('dieselGen', 'Energia elétrica da vila');
    this.publicNow('church', 'Capela da vila');
    placeNow('com', 1, 'Armazém da vila');
    updateFields(this);
  }

  clearTreesAlong(path: P2[], hw: number) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      this.buildings.clearTrees({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, angle: Math.atan2(b.z - a.z, b.x - a.x), w: Math.hypot(b.x - a.x, b.z - a.z) + 6, d: hw * 2 });
    }
  }

  /** place a public building immediately (founding) or via the city hall (later) */
  publicNow(kind: string, motive: string): Building | null {
    const def = KINDS[kind];
    const b = this.market.develop(kind, 1, motive);
    if (!b) return null;
    b.decision && (b.decision.actor = 'Prefeitura');
    b.state = 'done'; b.progress = 1;
    this.buildings.underConstruction.delete(b.id);
    this.onBuildingCompleted(b, true);
    void def;
    return b;
  }

  buildAccessRoad(c: Candidate, w: number, d: number): boolean {
    const n = this.roads.nodes[c.access];
    // connect the network to the lot boundary facing the node
    const ang = Math.atan2(n.z - c.z, n.x - c.x);
    const r = Math.hypot(w, d) / 2 + 8;
    const plan = this.roads.planSegment(n.id, c.x + Math.cos(ang) * r, c.z + Math.sin(ang) * r, RoadClass.Local, { allowBridge: false, maxGrade: 0.2 });
    if (!plan.ok) {
      // try a stub segment from node toward the site
      return false;
    }
    // the stub ends inside the lot: shorten so it stops at the lot boundary
    const e = this.roads.applyPlan(plan, { progress: 0, day: this.day });
    this.onRoadStarted(e, 'Acesso a novo empreendimento');
    c.edge = e.id; c.t = 1;
    return true;
  }

  districtName(x: number, z: number): string { return this.districtAt(x, z).name; }
  districtAt(x: number, z: number): District {
    let best = this.districts[0], bd = Infinity;
    for (const d of this.districts) { const dd = Math.hypot(d.x - x, d.z - z); if (dd < bd) { bd = dd; best = d; } }
    return best;
  }

  // ---------------- hooks ----------------
  onBuildingStarted(b: Building) {
    // new neighborhood?
    const near = this.districtAt(b.x, b.z);
    if (Math.hypot(near.x - b.x, near.z - b.z) > 520 && (b.def.cat === 'res' || b.def.cat === 'informal')) {
      const name = this.newDistrictName(b);
      this.districts.push({ id: this.districts.length, name, x: b.x, z: b.z, founded: this.day });
      this.events.emit('district', b.x, b.z, 0.7, `Surge um novo bairro: ${name}`, { headline: `Nasce o bairro ${name}`, visual: 0.7 });
    }
    b.district = this.districtAt(b.x, b.z).id;
    const def = b.def;
    const mag = def.public ? 0.5 + Math.min(0.5, def.cost / 4000) : 0.15 + b.floors * 0.04;
    this.events.emit('construction_start', b.x, b.z, mag, `Obra iniciada: ${def.label}${b.floors > 3 ? ` de ${b.floors} andares` : ''} em ${this.districtName(b.x, b.z)}`, {
      entity: { kind: 'building', id: b.id }, ref: b.id, visual: Math.min(1, 0.3 + b.floors * 0.06),
    });
  }

  onBuildingCompleted(b: Building, silent = false) {
    b.builtDay = this.day;
    const def = b.def;
    // stage-1 occupancy: households move in immediately
    if (!this.hasCitizens && b.hhCap > 0) for (let i = 0; i < b.hhCap; i++) b.households.push(this.hhSeq++);
    if (!silent) {
      const big = def.public || b.floors >= 8;
      this.events.emit('building_complete', b.x, b.z, big ? 0.7 : 0.25 + b.floors * 0.03, `${def.label} concluído em ${this.districtName(b.x, b.z)}`, {
        ref: b.id, entity: { kind: 'building', id: b.id }, visual: Math.min(1, 0.4 + b.floors * 0.05),
        headline: def.public && def.cost >= 300 ? `Inaugurado: ${b.name}` : b.floors >= 15 ? `Novo arranha-céu de ${b.floors} andares muda o skyline` : undefined,
      });
    }
    this.buildings.dirty.add(b.id);
  }

  hasCitizens = false;
  railSent = false;
  evict(b: Building) {
    if (!this.hasCitizens) b.households.length = 0;
  }

  onRoadStarted(e: REdge, motive: string) {
    this.roadWorks.set(e.id, { motive, speed: 0.45 + this.rng.next() * 0.2, kind: 'new' });
    const a = this.roads.nodes[e.a], b = this.roads.nodes[e.b];
    this.events.emit('road_start', (a.x + b.x) / 2, (a.z + b.z) / 2, e.bridge ? 0.85 : 0.2, `${e.bridge ? 'Construção de ponte' : 'Abertura de via'}: ${e.name}`, {
      entity: { kind: 'edge', id: e.id }, ref: e.id, visual: e.bridge ? 0.95 : 0.5,
      headline: e.bridge ? `Começa a construção da ponte da ${e.name}` : undefined,
    });
  }

  // ---------------- simulation step ----------------
  step(dt: number) {
    this.t += dt;
    this.roads.time = this.t;
    const newDay = Math.floor(this.t / DAY_SECONDS);
    const newHour = Math.floor(this.t / HOUR_SECONDS);
    this.weather.update(dt, this.dayFrac, this.season, this.params.raininess, this.params.snow, this.t);
    // construction progress
    for (const id of [...this.buildings.underConstruction]) {
      const b = this.buildings.byId.get(id);
      if (!b) { this.buildings.underConstruction.delete(id); continue; }
      const before = b.state;
      this.buildings.advance(b, dt * (this.weather.rain > 0.6 ? 0.6 : 1));
      if (b.state !== before && b.state === 'done') this.onBuildingCompleted(b);
    }
    for (const b of this.buildings.list) {
      if (b.state === 'demolishing') {
        this.buildings.advance(b, dt);
        if (!b.alive && b.pendingRebuild) this.startRebuild(b);
      }
    }
    // road works
    for (const [id, w] of this.roadWorks) {
      const e = this.roads.edges[id];
      if (!e.alive) { this.roadWorks.delete(id); continue; }
      const rate = (w.speed * dt) / Math.max(30, e.len) * (e.bridge ? 0.35 : 1) * (w.kind === 'upgrade' ? 0.8 : 1);
      e.progress = Math.min(1, e.progress + rate);
      this.roads.dirtyEdges.add(id);
      if (e.progress >= 1) {
        this.roadWorks.delete(id);
        if (w.kind === 'upgrade') this.finishUpgrade(e);
        else {
          this.roads.topoVer++;
          const a = this.roads.nodes[e.a], b = this.roads.nodes[e.b];
          this.events.emit('road_done', (a.x + b.x) / 2, (a.z + b.z) / 2, e.bridge ? 0.9 : 0.15, `${e.bridge ? 'Ponte inaugurada' : 'Via aberta'}: ${e.name}`, { ref: e.id, entity: { kind: 'edge', id: e.id }, headline: e.bridge ? `Ponte da ${e.name} é inaugurada` : undefined, visual: e.bridge ? 1 : 0.4 });
        }
      }
    }
    if (newHour !== this.hourIdx) { this.hourIdx = newHour; this.hourly(); }
    if (newDay !== this.day) { this.day = newDay; this.daily(); }
  }

  startRebuild(old: Building) {
    const r = old.pendingRebuild!;
    const c: Candidate = { x: old.x, z: old.z, angle: old.angle, edge: old.edge, t: old.edgeT, side: old.side, access: old.access, offDist: 0, total: 0, terms: {} };
    const b = this.buildings.create(r.kind, c, { level: r.level, wealth: r.wealth, era: this.era, day: this.day, w: old.w, d: old.d, maxDensity: this.params.maxDensity, decision: r.decision, variant: r.variant });
    b.replaces = old.id;
    this.onBuildingStarted(b);
  }

  finishUpgrade(e: REdge) {
    e.upgrading = false;
    if (e.upgradeTo) Object.assign(e, e.upgradeTo);
    e.upgradeTo = undefined;
    this.roads.computePts(e);
    this.roads.updateNodeGeom(this.roads.nodes[e.a]);
    this.roads.updateNodeGeom(this.roads.nodes[e.b]);
    this.roads.topoVer++;
    this.roads.dirtyEdges.add(e.id);
  }

  hourly() {
    this.roads.hourTick();
    updateFields(this);
    this.updateDemand();
    this.runMarket();
    this.updateEra();
    this.cityRadius = this.computeRadius();
  }

  daily() {
    this.roads.dayTick();
    if (this.day % 2 === 0) this.growth.closeLoops(2);
  }

  computeRadius(): number {
    let s = 0, n = 0;
    for (const b of this.buildings.list) { s += Math.hypot(b.x - this.center.x, b.z - this.center.z); n++; }
    return Math.max(150, n ? (s / n) * 1.7 : 150);
  }

  // ---------------- demand & market (stage 1: synthetic) ----------------
  updateDemand() {
    let hh = 0, hhCap = 0, jobs = 0, comJobs = 0, indJobs = 0;
    for (const b of this.buildings.list) {
      if (b.state !== 'done' && b.state !== 'demolishing') { hhCap += b.hhCap; continue; }
      hh += b.households.length; hhCap += b.hhCap;
      const j = b.jobCap[0] + b.jobCap[1] + b.jobCap[2] + b.jobCap[3];
      jobs += j;
      if (b.def.cat === 'com') comJobs += j;
      if (b.def.cat === 'ind') indJobs += j;
    }
    this.households = hh;
    this.population = Math.round(hh * 3.1);
    const workers = this.population * 0.5;
    this.demand.res = clamp((jobs * 1.15 - workers) / 3 + 6 * this.params.immigration - (hhCap - hh), -20, 40);
    this.demand.com = clamp(this.population * 0.06 - comJobs, -20, 40);
    this.demand.ind = clamp(workers * 0.4 - indJobs, -20, 40);
    this.demand.off = clamp(workers * 0.15 * (0.3 + this.era * 0.3) - (jobs - comJobs - indJobs), -20, 40);
  }

  runMarket() {
    const active = this.buildings.underConstruction.size;
    const maxSites = 6 + Math.floor(this.population / 120);
    let budget = Math.max(0, maxSites - active);
    this.siteScarcity *= 0.6;
    const d = this.demand;
    const tries: [string, number, number][] = [];
    if (d.res > 0) {
      const n = Math.ceil(d.res / 4);
      for (let i = 0; i < n; i++) {
        const r = this.rng.next();
        const ineq = this.params.inequality;
        const wealth = r < 0.3 + ineq * 0.4 ? 0 : r < 0.85 + ineq * 0.05 ? 1 : 2;
        tries.push(['res', wealth, d.res]);
      }
    }
    if (d.com > 0) tries.push(['com', 1, d.com]);
    if (d.ind > 0) {
      const v = this.params.vocation;
      const pool = v === 'agricultura' || this.era === 0 ? ['farm', 'farm', 'foodPlant', 'warehouse'] : ['factory', 'warehouse', 'foodPlant', 'farm'];
      if (this.era >= 1) pool.push('factory', 'steelMill');
      tries.push([this.rng.pick(pool), 1, d.ind]);
    }
    if (d.off > 0 && this.era >= 1) tries.push([this.era >= 2 && this.rng.chance(0.25) ? 'techPark' : 'off', 1, d.off]);
    for (const [kind, wealth, dem] of tries) {
      if (budget <= 0) break;
      if (this.rng.next() > Math.min(1, dem / 8 + 0.3)) continue;
      if (this.market.develop(kind, wealth, `Demanda ${kind === 'res' ? 'residencial' : kind === 'com' ? 'comercial' : 'por empregos'} (${dem.toFixed(0)})`)) budget--;
    }
    if (this.hourIdx % 3 === 0) this.market.redevelop(12);
    // grow roads when lots are scarce
    const need = this.siteScarcity > 0.6 ? 2 : this.rng.chance(0.25) ? 1 : 0;
    if (need && this.roadWorks.size < 3 + this.era * 2) this.growth.grow(need, this.siteScarcity);
  }

  updateEra() {
    let e = 0;
    for (let i = 0; i < ERA_POP.length; i++) if (this.population >= ERA_POP[i]) e = i;
    if (e > this.era) {
      this.era = e;
      this.events.emit('era', this.center.x, this.center.z, 1, `Nova era: ${ERAS[e]}`, { headline: `${ERAS[e].toUpperCase()}: a cidade atinge ${this.population.toLocaleString('pt-BR')} habitantes`, visual: 1 });
    }
  }

  newDistrictName(b: { x: number; z: number }): string {
    const F = this.fields;
    const elev = F.relElev[F.idx(b.x, b.z)];
    const wd = F.waterDist[F.idx(b.x, b.z)];
    const used = new Set(this.districts.map((d) => d.name));
    for (let i = 0; i < 20; i++) {
      let pre = this.rng.pick(DISTRICT_PREFIX);
      if (elev > 0.5) pre = this.rng.pick(['Alto', 'Morro', 'Mirante']);
      else if (wd < 120) pre = this.rng.pick(['Vila', 'Porto', 'Recanto']);
      const name = `${pre} ${this.rng.pick(DISTRICT_SUFFIX)}`;
      if (!used.has(name)) return name;
    }
    return 'Bairro ' + (this.districts.length + 1);
  }

  // ---------------- serialization ----------------
  initMessage(): WorldInit {
    const T = this.terrain;
    return {
      size: T.size, hres: T.hres, heights: T.heights.slice(), water: T.water.slice(), forest: T.forest.slice(), flood: T.flood.slice(),
      trees: T.trees.slice(), river: T.river.flatMap((p) => [p.x, p.z]), windDir: T.windDir, seaLevel: T.seaLevel, fieldRes: this.fields.G, params: this.params,
    };
  }

  collectDiff(): WorldDiff {
    const R = this.roads, B = this.buildings;
    const diff: WorldDiff = { type: 'diff' };
    if (R.dirtyNodes.size) { diff.nodes = [...R.dirtyNodes].map((id) => R.nodeView(R.nodes[id]) as NodeView); R.dirtyNodes.clear(); }
    if (R.dirtyEdges.size) { diff.edges = [...R.dirtyEdges].filter((id) => R.edges[id].alive).map((id) => R.edgeView(R.edges[id]) as EdgeView); R.dirtyEdges.clear(); }
    if (R.removedEdges.length) { diff.removedEdges = R.removedEdges; R.removedEdges = []; }
    if (B.dirty.size) {
      const out: BuildingView[] = [];
      for (const id of B.dirty) { const b = B.byId.get(id); if (b) out.push(B.view(b)); }
      diff.buildings = out;
      B.dirty.clear();
    }
    if (B.removed.length) { diff.removedBuildings = B.removed; B.removed = []; }
    if (B.treesRemoved.length) { diff.treesRemoved = B.treesRemoved; B.treesRemoved = []; }
    if (!this.railSent && !this.rail) { this.railSent = true; diff.rail = railViewsFromPath(this.railPath, this.terrain); }
    const ev = this.events.drain();
    if (ev.length) diff.events = ev;
    return diff;
  }
}

/** Rail polyline -> rendered segments, with gentle grades and bridges over water */
export function railViewsFromPath(path: P2[], T: Terrain): RailEdgeView[] {
  const ys = path.map((p) => Math.max(T.heightAt(p.x, p.z), 0));
  // smooth heights (rail needs gentle grades)
  for (let it = 0; it < 6; it++) for (let i = 1; i < ys.length - 1; i++) ys[i] = (ys[i - 1] + ys[i] * 2 + ys[i + 1]) / 4;
  const wet = path.map((p) => T.heightAt(p.x, p.z) < T.seaLevel + 0.5);
  const out: RailEdgeView[] = [];
  let id = 0;
  const seg = 8;
  for (let i = 0; i < path.length - 1; i += seg) {
    const pts: number[] = [];
    let bridge = false;
    for (let k = i; k <= Math.min(path.length - 1, i + seg); k++) {
      const near = wet[Math.max(0, k - 1)] || wet[k] || wet[Math.min(path.length - 1, k + 1)];
      if (near) bridge = true;
      pts.push(path[k].x, (near ? Math.max(ys[k], 6) : ys[k]) + 0.4, path[k].z);
    }
    out.push({ id: id++, pts, tracks: 1, progress: 1, bridge, elevated: false, metro: false, spur: false });
  }
  return out;
}
