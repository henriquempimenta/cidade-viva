import { segRectDist } from './geom';
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
import { Integrity } from './corruption';
import { Occupancy, OCC_RAIL } from './occupancy';
import { Market, RoadGrowth } from './planner';
import { borderPoint, chaikin, resample, simplify, terrainPath, type P2 } from './regional';
import { RoadNetwork, type REdge, angDiff as angDiffW } from './roads';
import { type SiteContext } from './siting';
import { Terrain } from './terrain';
import { Weather } from './weather';
import { Citizens, type Household } from './citizens';
import { Economy } from './economy';
import { Traffic, P_CITIZEN, P_CONSTRUCTION, P_FUNERAL, P_SERVICE } from './traffic';
import { Peds } from './peds';
import { Places } from './places';
import { carPlan, carPlanFromNode, carPlanToNode, doorOf, walkPoints, type CarPlan } from './trips';
import type { RNode } from './roads';
import { Utilities } from './utilities';
import { Services } from './services';
import { CityHall } from './cityhall';
import { RoadUpgrades } from './roadUpgrades';
import { Rail } from './rail';
import { Structures } from './structures';
import { Transit } from './transit';
import { Tourism } from './tourism';
import { Happenings } from './happenings';
import { PED_FLAG_WORKER, PED_FLAG_FUNERAL, VType, VEH_FLAG_SIREN } from '../shared/constants';

export interface District { id: number; name: string; x: number; z: number; founded: number }

// Optional subsystems (attached in later stages)
export interface RailLike { splatAccess(F: Fields, rail: Float32Array, transit: Float32Array): void; splatNoise?(F: Fields, noise: Float32Array): void }
export interface TransitLike { splatCoverage(F: Fields, transit: Float32Array): void }
export interface UtilitiesLike { riverInput(arr: Float32Array): void }
export interface TourismLike { pressure: number }
export interface TransitAPI {
  transitOption(from: Building, to: Building, len: number): { mode: number; time: number; fare: number } | null;
  board(i: number, from: Building, to: Building, opt: { mode: number; time: number; fare: number }): boolean;
  describe(i: number): string;
  position(i: number): { x: number; y: number; z: number; h: number; inside: boolean; building: number } | null;
}
export interface TourismAPI { decideTourist(i: number, here: Building, hour: number): void }

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
  transit2: TransitAPI | null = null;
  tourism2: TourismAPI | null = null;
  citizens!: Citizens;
  utils!: Utilities;
  services!: Services;
  cityHall!: CityHall;
  integrity!: Integrity;
  upgrades!: RoadUpgrades;
  structures!: Structures;
  rail2!: Rail;
  trainsSys!: Rail;
  trains!: Rail;
  transitSys!: Transit;
  crossingsSnapshot?: () => Uint8Array;
  cargoFlows: number[] = [];
  tourismSys!: Tourism;
  happen!: Happenings;
  festivalDays = 0;
  floodVictims = 0;
  inject = (ev: string) => this.happen.inject(ev);
  lastUpgrade!: Map<number, unknown>;
  transitAPI: { ridersOn(edge: number): number } | null = null;
  buildBypass?: () => void;
  transitCost?: () => number;
  tourismTax?: () => number;
  extraProjects?: () => unknown[];
  outageGrid?: () => Uint8Array;
  economy!: Economy;
  traffic!: Traffic;
  peds!: Peds;
  places = new Places();
  cam = { x: 0, z: 0, h: 300 };
  gameDay = -1;
  epidemic = 0;
  budget = { money: 6000, debt: 0, income: 0, expenses: 0 };

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
    this.attachAgents();
  }

  // ---------------- clock ----------------
  get dayFrac() { return (this.t % DAY_SECONDS) / DAY_SECONDS; }
  get hour() { return this.dayFrac * 24; }
  get year() { return Math.floor(this.day / DAYS_PER_YEAR) + 1; }
  get season() { return Math.floor((this.day % DAYS_PER_YEAR) / DAYS_PER_SEASON); }
  dateLabel() { return `Ano ${this.year} · ${SEASONS[this.season]}`; }

  siteCtx(): SiteContext {
    return { terrain: this.terrain, roads: this.roads, occ: this.occ, fields: this.fields, rng: this.rng, params: this.params, center: this.center, cityRadius: this.cityRadius, bribe: this.integrity ? (x, z) => this.integrity.bribe(x, z) : undefined };
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

  private attachAgents() {
    this.citizens = new Citizens(this);
    this.economy = new Economy(this);
    this.traffic = new Traffic(this.roads);
    this.roads.footprintCheck = (ax, az, bx, bz, hw, ta, tb) => {
      const len = Math.hypot(bx - ax, bz - az);
      if (len <= ta + tb) return false;
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      const x0 = ax + ux * ta, z0 = az + uz * ta, x1 = bx - ux * tb, z1 = bz - uz * tb;
      const r = this.occ.segRect(x0, z0, x1, z1, hw + 8);
      for (const id of this.occ.ownersInRect(r.cx, r.cz, r.angle, r.w + 16, r.d)) {
        const b = this.buildings.byId.get(id);
        if (!b || !b.alive) continue;
        if (segRectDist(x0 - b.x, z0 - b.z, x1 - b.x, z1 - b.z, Math.cos(b.angle), Math.sin(b.angle), b.w / 2, b.d / 2) < hw) return true;
      }
      return false;
    };
    this.roads.onSplit = (o, e1, e2, t) => {
      this.traffic.splitEdge(o, e1, e2, t);
      for (const l of this.transitSys?.lines ?? []) {
        if (!l.edges.has(o.id)) continue;
        l.path = l.path.flatMap((de) => de >> 1 !== o.id ? [de] : (de & 1) === 0 ? [e1.id * 2, e2.id * 2] : [e2.id * 2 + 1, e1.id * 2 + 1]);
        l.edges = new Set(l.path.map((d) => d >> 1));
      }
    };
    this.peds = new Peds(this.terrain);
    this.hasCitizens = true;
    this.utils = new Utilities(this);
    this.utilities = this.utils;
    this.outageGrid = this.utils.outageGrid;
    this.services = new Services(this);
    this.cityHall = new CityHall(this);
    this.integrity = new Integrity(this);
    this.upgrades = new RoadUpgrades(this);
    this.structures = new Structures(this);
    this.lastUpgrade = this.upgrades.decisions;
    this.buildBypass = () => this.bypass();
    this.transitSys = new Transit(this);
    this.rail2 = new Rail(this);
    this.trainsSys = this.trains = this.rail2;
    this.rail = this.rail2;
    this.transit = this.transitSys;
    this.transitAPI = this.transitSys;
    const T = this.transitSys;
    this.transit2 = {
      transitOption: (a, b, len) => T.transitOption(a, b, len),
      board: (i, a, b, opt) => T.board(i, a, b, opt as never),
      describe: (i) => T.describe(i),
      position: (i) => T.position(i),
    };
    this.traffic.onStop = T.onBusNode;
    this.crossingsSnapshot = this.rail2.crossingsSnapshot;
    this.tourismSys = new Tourism(this);
    this.tourism = this.tourismSys;
    this.tourism2 = this.tourismSys;
    this.tourismTax = () => this.tourismSys.taxToday;
    this.happen = new Happenings(this);
    this.extraProjects = () => [...this.rail2.projects(), ...this.happen.projects()];
    this.transitCost = () => T.cost() - T.fares();
    this.serviceArrived = (slot) => this.services.arrived(slot);
    this.places.rebuild(this.buildings.list);
    this.traffic.onArrive = (slot) => this.vehicleArrived(slot);
    this.traffic.onStuck = (slot) => this.vehicleStuck(slot);
    this.peds.onArrive = (slot) => {
      const c = this.peds.citizen[slot];
      if (c < 0 || this.citizens.slot[c] !== slot) return;
      if (this.transitSys?.pedArrived(c)) return;
      this.citizens.arrive(c);
    };
    // the founding families
    for (const b of this.buildings.list) {
      b.households.length = 0;
      if (b.hhCap > 0) for (let k = 0; k < b.hhCap; k++) this.citizens.createFamily(b, b.wealth, { fromVillage: true });
    }
    for (let i = 0; i < this.citizens.max; i++) if (this.citizens.alive[i]) this.economy.seekJobSoon(i);
    this.economy.hourly();
    this.updateDemand();
  }

  /** a direction or connectivity change: re-plan vehicles and lines that would otherwise drive against the traffic */
  replanAfterTopology(): [number, number, number] {
    const [rp, dropped] = this.traffic.revalidate();
    const lines = this.transitSys.revalidateLines();
    return [rp, dropped, lines];
  }

  vehicleArrived(slot: number) {
    const T = this.traffic;
    const kind = T.pKind[slot], id = T.pId[slot];
    if (kind === P_CITIZEN) { if (this.citizens.slot[id] === slot) this.citizens.arrive(id); return; }
    if (kind === 3 /* P_BUS */) { this.transitSys.busArrived(slot); return; }
    this.serviceArrived?.(slot);
  }
  vehicleStuck(slot: number) {
    const T = this.traffic;
    if (T.pKind[slot] === P_CITIZEN) {
      const id = T.pId[slot];
      if (this.citizens.slot[id] === slot) this.citizens.virtualArrive(id, T.remainingTime(slot));
    } else if (T.pKind[slot] === 3) this.transitSys.busArrived(slot);
    else this.serviceArrived?.(slot);
  }
  serviceArrived: ((slot: number) => void) | null = null;

  carPlan(a: Building, b: Building): CarPlan | null { return carPlan(this.roads, a, b); }
  entryNode(): number {
    const hp = this.highwayPath;
    if (!hp.length) return -1;
    const p = this.rng.chance(0.5) ? hp[0] : hp[hp.length - 1];
    return this.roads.nearestNode(p.x, p.z, 50)?.id ?? -1;
  }
  exitNode(): number { return this.entryNode(); }
  hasUniversity() { return this.buildings.list.some((b) => b.kind === 'university' && b.state === 'done'); }
  statsEdu = 1;
  computeEdu(): number {
    const C = this.citizens;
    let edu = 0, n = 0;
    for (let i = 0; i < C.max; i += 3) if (C.alive[i] && C.age[i] >= 18 && !C.tourist[i]) { edu += C.edu[i]; n++; }
    return n ? edu / n : 1;
  }
  avgHappiness(): number {
    const C = this.citizens;
    let s = 0, n = 0;
    for (let i = 0; i < C.max; i += 3) if (C.alive[i] && !C.tourist[i]) { s += C.happiness[i]; n++; }
    return n ? s / n : 0.6;
  }
  beachOk(): boolean {
    return this.terrain.type === 'litoral' || this.fields.riverPol.length > 0 && this.places.has('park');
  }
  beachPlace(here: Building): Building | null {
    const F = this.fields;
    let best: Building | null = null, bs = -Infinity;
    for (const cat of ['park', 'eat'] as const) for (const b of this.places.lists.get(cat) ?? []) {
      const wd = F.waterDist[F.idx(b.x, b.z)];
      if (wd > 220) continue;
      const s = -Math.hypot(b.x - here.x, b.z - here.z) / 1000 - F.sample('waterPollution', b.x, b.z) * 2 + this.rng.next();
      if (s > bs) { bs = s; best = b; }
    }
    return best;
  }
  lodAllowsVehicle(x: number, z: number): boolean {
    const n = this.traffic.count;
    if (n < 1800) return true;
    const d = Math.hypot(x - this.cam.x, z - this.cam.z);
    return d < Math.max(600, this.cam.h * 3) || n < 2600 && this.rng.chance(0.4);
  }

  /** junction control: may a vehicle coming from edge e (direction dir) enter the node now? */
  nodeAllow = (n: RNode, e: REdge, dir: number, distToStop: number, waited = 0): boolean => {
    const deg = n.edges.length;
    if (deg < 3) return true;
    if (n.interchange) {
      let major = 0;
      for (const id of n.edges) major = Math.max(major, this.roads.edges[id].cls);
      if (e.cls === major) return true; // passes over the viaduct
      return n.inJunction < 2 || waited > 5;
    }
    if (n.control === 2 || n.control === 4) {
      if (!n.phases.length) this.computePhases(n);
      const ph = n.phases[Math.floor(n.phase / 2) % n.phases.length];
      const green = ph.includes(e.id);
      if (!green) return false;
      if (n.phase % 2 === 1) return distToStop < 10; // yellow
      return true;
    }
    if (n.control === 3) return n.inJunction < 4 || waited > 12;
    if (n.control === 1) {
      let major = 0;
      for (const id of n.edges) major = Math.max(major, this.roads.edges[id].cls);
      return e.cls < major ? n.inJunction === 0 || waited > 9 : n.inJunction < 3;
    }
    return n.inJunction < 2 || waited > 6;
  };

  computePhases(n: RNode) {
    const R = this.roads;
    const inc = n.edges.map((id) => R.edges[id]).filter((e) => e.alive);
    if (!inc.length) { n.phases = [[]]; return; }
    const a0 = R.angleOf(inc[0], n.id);
    const A: number[] = [], B: number[] = [];
    for (const e of inc) {
      const d = angDiffW(R.angleOf(e, n.id), a0);
      (d < Math.PI / 4 || d > (3 * Math.PI) / 4 ? A : B).push(e.id);
    }
    n.phases = B.length ? [A, B] : [A];
    n.phase = 0; n.phaseT = 0;
  }

  private signalNodes: RNode[] = [];
  private signalVer = -1;
  stepSignals(dt: number) {
    if (this.signalVer !== this.roads.topoVer) {
      this.signalVer = this.roads.topoVer;
      this.signalNodes = this.roads.nodes.filter((n) => n.alive && (n.control === 2 || n.control === 4));
      for (const n of this.signalNodes) this.computePhases(n);
    }
    for (const n of this.signalNodes) {
      n.phaseT += dt;
      const yellow = n.phase % 2 === 1;
      let green = 20;
      if (n.control === 4) {
        // smart signal: green proportional to queues of the current group
        const grp = n.phases[Math.floor(n.phase / 2) % n.phases.length];
        let q = 0, qo = 0;
        for (const id of n.edges) { const e = this.roads.edges[id]; const s = e.stopped[0] + e.stopped[1]; if (grp.includes(id)) q += s; else qo += s; }
        green = Math.max(8, Math.min(40, 14 + (q - qo) * 2.5));
      }
      if (n.phaseT > (yellow ? 3 : green)) { n.phaseT = 0; n.phase = (n.phase + 1) % (n.phases.length * 2); }
    }
  }
  signalsSnapshot = (): Int32Array => {
    const out: number[] = [];
    for (const n of this.signalNodes) {
      const sorted = [...n.edges].filter((id) => this.roads.edges[id].alive && this.roads.edges[id].progress >= 1).sort((a, b) => a - b);
      const grp = n.phases[Math.floor(n.phase / 2) % n.phases.length] ?? [];
      let mask = 0;
      sorted.forEach((id, k) => { if (grp.includes(id)) mask |= 1 << k; });
      if (n.phase % 2 === 1) mask |= 1 << 16;
      out.push(n.id, mask);
    }
    return new Int32Array(out);
  };

  /** funeral cortege: hearse + family cars from home to the cemetery */
  funeral(home: Building, name: string, h: Household | undefined) {
    const cem = this.buildings.list.find((b) => (b.kind === 'cemetery' || b.kind === 'crematorium') && b.state === 'done');
    let plan: CarPlan | null = null;
    if (cem) plan = carPlan(this.roads, home, cem);
    else { const ex = this.exitNode(); if (ex >= 0) plan = carPlanToNode(this.roads, home, ex); }
    this.deathsUnserved += cem ? 0 : 1;
    if (!plan || this.traffic.capacityLeft < 20) return;
    const slot = this.traffic.spawn(VType.Hearse, plan.path, plan.startS, plan.destS, { kind: P_FUNERAL, id: -1, aux: 0 }, home.id, cem?.id ?? -1);
    for (let k = 0; k < 2 && h && h.car; k++) {
      const s2 = this.traffic.spawn(VType.Car, plan.path, Math.max(0, plan.startS - 8 * (k + 1)), plan.destS, { kind: P_FUNERAL, id: -1, aux: 0 }, home.id, cem?.id ?? -1);
      void s2;
    }
    if (slot >= 0) this.events.emit('funeral', home.x, home.z, 0.4, `Cortejo fúnebre de ${name}${cem ? ' segue para o ' + cem.name : ' deixa a cidade rumo ao cemitério regional'}`, { entity: { kind: 'vehicle', id: slot, gen: this.traffic.gen[slot] }, visual: 0.7 });
  }
  deathsUnserved = 0;
  lastBridgeDay = -10;
  private sentFlood = 0;

  /** ring road / bypass: a new road around the built-up area, linking the highway before and after the city */
  bypass() {
    const R = this.roads, T = this.terrain, F = this.fields;
    const hp = this.highwayPath;
    const near = (p: P2) => Math.hypot(p.x - this.center.x, p.z - this.center.z);
    const R0 = this.cityRadius * 1.35 + 150;
    let i0 = -1, i1 = -1;
    for (let i = 0; i < hp.length; i++) { if (near(hp[i]) < R0) { if (i0 < 0) i0 = Math.max(0, i - 1); i1 = Math.min(hp.length - 1, i + 1); } }
    if (i0 < 0 || i1 - i0 < 3) return;
    const a = R.nearestNode(hp[i0].x, hp[i0].z, 60), b = R.nearestNode(hp[i1].x, hp[i1].z, 60);
    if (!a || !b) return;
    const path = terrainPath(T, { x: a.x, z: a.z }, { x: b.x, z: b.z }, { slopeW: 50, waterW: 12, cell: 25, avoid: (x, z) => { const k = F.idx(x, z); return (F.f.resDensity[k] + F.f.jobDensity[k]) > 0.2 ? 40 : 0; } });
    const pts = resample(simplify(path, 20), 95);
    let prev = a.id, ok = 0;
    for (let i = 1; i < pts.length; i++) {
      const plan = R.planSegment(prev, pts[i].x, pts[i].z, RoadClass.Avenue, { allowBridge: true, maxBridge: 260, maxGrade: 0.12 });
      if (!plan.ok) continue;
      const e = R.applyPlan(plan, { progress: 0, day: this.day, name: 'Anel Viário' });
      e.lanes = 2;
      this.onRoadStarted(e, 'Contorno rodoviário');
      prev = plan.toNode >= 0 ? plan.toNode : e.b;
      ok++;
    }
    if (ok) this.events.emit('road_upgrade', this.center.x, this.center.z, 1, 'Começam as obras do Anel Viário para desviar o tráfego de passagem', { headline: 'Anel Viário vai tirar caminhões do centro', visual: 1 });
  }
  diffHook: ((d: WorldDiff) => void) | null = null;

  /** a bridge when the near bank runs out of land */
  bridgeProject = (): unknown => {
    if (this.era < 1 || this.siteScarcity < 0.4 || this.roadWorks.size > 4 || this.day - this.lastBridgeDay < 5) return null;
    if (this.roads.edges.some((e) => e.bridge && e.progress < 1)) return null;
    const T = this.terrain;
    const cands = this.roads.nodes.filter((n) => n.alive && !n.deck && n.edges.length > 0 && n.edges.length < 4 && T.distToRiver(n.x, n.z) < 220 && Math.hypot(n.x - this.center.x, n.z - this.center.z) < this.cityRadius + 300);
    for (let k = 0; k < 25 && cands.length; k++) {
      const n = cands[Math.floor(this.rng.next() * cands.length)];
      const ri = T.riverIndex(n.x, n.z);
      const rp = T.river[ri];
      const dx = rp.x - n.x, dz = rp.z - n.z, l = Math.hypot(dx, dz) || 1;
      const reach = l + this.rng.range(90, 170);
      const bx = n.x + (dx / l) * reach, bz = n.z + (dz / l) * reach;
      if (T.heightAt(bx, bz) < 1) continue;
      const plan = this.roads.planSegment(n.id, bx, bz, RoadClass.Collector, { allowBridge: true, maxBridge: this.era >= 2 ? 300 : 200, maxGrade: 0.14 });
      if (!plan.ok || plan.waterLen < 10) continue;
      const signature = this.era >= 2 && plan.len > 160 && this.budget.money > 9000;
      const cost = plan.len * (signature ? 30 : 12) + plan.waterLen * 20;
      return {
        kind: 'bridge', label: signature ? 'Ponte estaiada' : 'Ponte', motive: `Falta de lotes nesta margem; ${Math.round(plan.waterLen)} m sobre o rio`, benefit: 20 + this.siteScarcity * 15, cost,
        run: () => {
          this.lastBridgeDay = this.day;
          const e = this.roads.applyPlan(plan, { progress: 0, day: this.day, name: signature ? 'Ponte Estaiada ' + this.rng.pick(['do Rio', 'da Integração', 'Nova Era', 'dos Ipês']) : undefined });
          this.onRoadStarted(e, 'Expansão para a outra margem');
          if (signature) this.events.emit('landmark', (plan.ax + plan.bx) / 2, (plan.az + plan.bz) / 2, 1, `Começa a construção da ${e.name}, nova obra-símbolo`, { headline: `Cidade ganhará a ${e.name}`, entity: { kind: 'edge', id: e.id }, visual: 1 });
          return true;
        },
      };
    }
    return null;
  };

  statsExtra = (s: import('../shared/protocol').Stats) => {
    const E = this.economy, C = this.citizens;
    s.employed = E.employed; s.unemployed = E.unemployed; s.students = E.students; s.jobs = E.jobsTotal; s.vacancies = E.vacancies;
    s.gdp = E.gdp; s.avgIncome = E.avgIncome; s.inflation = (E.priceIndex - 1) * 100;
    s.happiness = this.avgHappiness();
    let edu = 0, n = 0;
    for (let i = 0; i < C.max; i += 2) if (C.alive[i] && C.age[i] >= 18 && !C.tourist[i]) { edu += C.edu[i]; n++; }
    s.education = n ? edu / n : 0;
    const tot = C.modeCount.reduce((a, b) => a + b, 0) || 1;
    s.modal = { walk: C.modeCount[0] / tot, bike: C.modeCount[1] / tot, car: C.modeCount[2] / tot, bus: C.modeCount[3] / tot, rail: C.modeCount[4] / tot };
    s.money = this.budget.money; s.debt = this.budget.debt; s.income = this.budget.income; s.expenses = this.budget.expenses;
    const U = this.utils;
    s.power = { ...U.power }; s.water = { ...U.water }; s.sewage = { ...U.sewage }; s.garbage = { ...U.garbage };
    s.crime = this.services.avgCrime;
    let em = 0; for (let k = 0; k < this.fields.f.airPollution.length; k++) em += this.fields.f.airPollution[k];
    s.emissions = em;
    s.tourists = this.tourismSys.count; s.attractiveness = this.tourismSys.attractiveness;
    s.buses = this.transitSys.lines.reduce((a, l) => a + l.vehicles.size, 0);
    s.virtualTrips = 0;
    for (let i = 0; i < C.max; i++) if (C.alive[i] && C.state[i] === 4) s.virtualTrips++;
    s.hall = this.hallReport();
    s.hall.integrity = this.integrity.report();
    this.statsHook?.(s);
  };

  /** dashboard for the Prefeitura tab: where the money goes, what is being built, how the networks cope */
  hallReport(): import('../shared/protocol').HallReport {
    const H = this.cityHall, U = this.utils, F = this.fields.f;
    const works: import('../shared/protocol').HallReport['works'] = [];
    for (const id of this.buildings.underConstruction) {
      const b = this.buildings.byId.get(id);
      if (!b || !b.def.public) continue;
      works.push({ id: b.id, name: b.name, kind: b.kind, cost: b.def.cost ?? 0, progress: b.progress, motive: b.decision?.motive ?? '' });
    }
    for (const [id, rw] of this.roadWorks) {
      const e = this.roads.edges[id];
      if (!e?.alive || rw.kind !== 'upgrade') continue;
      works.push({ id, name: e.name, kind: 'road', cost: Math.round(e.len * 6), progress: e.workP, motive: rw.motive, road: true });
    }
    // coverage = share of residents inside the service's reach
    const cover = (name: 'cov_health' | 'cov_education' | 'cov_police' | 'cov_fire') => {
      const c = F[name], r = F.resDensity;
      let tot = 0, ok = 0;
      for (let k = 0; k < r.length; k++) { if (r[k] <= 0.01) continue; tot += r[k]; ok += r[k] * Math.min(1, c[k]); }
      return tot > 0 ? ok / tot : 0;
    };
    const pendingOf = (kinds: string[]) => works.filter((wk) => kinds.includes(wk.kind)).length;
    const pop = Math.max(1, this.population);
    const networks = [
      { key: 'power', label: 'Energia', served: Math.min(U.power.supply, U.power.demand), demand: U.power.demand, pending: pendingOf(['dieselGen', 'thermalPlant', 'hydroPlant', 'windFarm', 'solarFarm', 'nuclearPlant']) },
      { key: 'water', label: 'Água', served: Math.min(U.water.supply, U.water.demand), demand: U.water.demand, pending: pendingOf(['well', 'waterPump', 'waterTreatment', 'waterTower']) },
      { key: 'sewage', label: 'Esgoto tratado', served: Math.min(U.sewage.cap, U.sewage.prod), demand: U.sewage.prod, pending: pendingOf(['sewagePlant']) },
      { key: 'garbage', label: 'Coleta de lixo', served: Math.min(U.garbage.cap, U.garbage.prod), demand: U.garbage.prod, pending: pendingOf(['dump', 'landfill', 'recycling', 'incinerator']) },
      { key: 'health', label: 'Saúde', served: cover('cov_health') * pop, demand: pop, pending: pendingOf(['clinic', 'hospital']) },
      { key: 'education', label: 'Educação', served: cover('cov_education') * pop, demand: pop, pending: pendingOf(['daycare', 'school', 'highSchool', 'university', 'library']) },
      { key: 'police', label: 'Policiamento', served: cover('cov_police') * pop, demand: pop, pending: pendingOf(['police']) },
      { key: 'fire', label: 'Bombeiros', served: cover('cov_fire') * pop, demand: pop, pending: pendingOf(['fire']) },
    ];
    const lines = this.transitSys.lines.map((l) => {
      let waiting = 0;
      for (const q of l.waiting.values()) waiting += q.length;
      return { id: l.id, name: l.name, color: l.color, kind: l.kind, fleet: l.kind === 'bus' || l.kind === 'brt' ? l.vehicles.size : l.fleet, riders: l.ridersYday, waiting, stops: l.stops.length };
    });
    let vacant = 0, abandoned = 0, rentSum = 0, rentN = 0;
    for (const b of this.buildings.list) {
      if (b.state !== 'done') continue;
      if (b.abandoned) abandoned++;
      else if ((b.def.cat === 'res' || b.def.cat === 'informal') && b.households.length < b.hhCap) vacant += b.hhCap - b.households.length;
      if (b.def.cat === 'res' && b.households.length && rentN < 400) { rentSum += 8 + this.fields.sample('landValue', b.x, b.z) * 40 * (1 + b.level * 0.3); rentN++; }
    }
    const E = this.economy;
    const last = H.log[H.log.length - 1];
    return {
      breakdown: { ...H.breakdown }, ledger: H.ledger.slice(0, 12), works: works.slice(0, 12), networks, lines,
      market: { homeless: E.homelessDemand.reduce((a, b) => a + b, 0), vacant, abandoned, demolishing: this.buildings.demolishing.length, pending: E.pending.length, rent: rentN ? (rentSum / rentN) * E.priceIndex : 0 },
      lastCycle: last ? { day: last.day, chosen: last.chosen.slice(0, 6), rejected: last.rejected.slice(0, 6) } : undefined,
    };
  }
  statsHook: ((s: import('../shared/protocol').Stats) => void) | null = null;
  inspectCitizen = (id: number) => this.citizens.inspect(id);
  inspectPed = (slot: number) => { const c = this.peds.citizen[slot]; return c >= 0 ? this.citizens.inspect(c) : null; };
  buildingOccupants = (id: number) => {
    const C = this.citizens;
    const out: { id: number; name: string; role: string }[] = [];
    const b = this.buildings.byId.get(id);
    if (!b) return out;
    for (const hid of b.households) { const h = C.households.get(hid); if (h) for (const m of h.members) out.push({ id: m, name: C.name(m), role: C.tourist[m] ? 'hóspede' : 'morador' }); if (out.length > 30) break; }
    for (const x of b.workers.slice(0, 15)) out.push({ id: x, name: C.name(x), role: 'trabalha aqui' });
    for (const x of b.students.slice(0, 10)) out.push({ id: x, name: C.name(x), role: 'estuda aqui' });
    return out;
  };

  /** construction logistics: trucks and workers going to the sites */
  private constructionLogistics() {
    for (const id of this.buildings.underConstruction) {
      const b = this.buildings.byId.get(id);
      if (!b || b.state === 'done') continue;
      if (this.rng.next() > 0.5) continue;
      const near = this.roads.nodesNear(b.x, b.z, 700).filter((n) => n.edges.length && this.roads.edges[n.edges[0]].progress >= 1);
      if (!near.length) continue;
      const from = near[Math.floor(this.rng.next() * near.length)];
      const plan = carPlanFromNode(this.roads, from.id, b);
      if (!plan) continue;
      if (this.traffic.capacityLeft > 200) this.traffic.spawn(VType.Construction, plan.path, plan.startS, plan.destS, { kind: P_CONSTRUCTION, id: b.id, aux: 0 });
      if (this.peds.capacityLeft > 300) {
        const pts = walkPoints(this.roads, plan, { x: from.x, z: from.z }, doorOf(this.roads, b));
        const n = 1 + Math.floor(this.rng.next() * 3);
        for (let k = 0; k < n; k++) this.peds.spawn(pts, -1, this.rng.range(1.2, 1.5), PED_FLAG_WORKER, 0.13);
      }
    }
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
    if (!this.hasCitizens) { b.households.length = 0; return; }
    for (const hid of [...b.households]) {
      const h = this.citizens.households.get(hid);
      if (!h) continue;
      this.citizens.moveHousehold(h, -1);
      for (const m of h.members) this.citizens.addBio(m, `Foi despejad${this.citizens.sex[m] ? 'a' : 'o'}: ${b.name} será demolido`);
      this.economy.wantsToMove(h, 'despejo por demolição');
    }
    b.households.length = 0;
    for (const x of [...b.workers]) this.economy.leaveJob(x);
    for (const x of [...b.students]) { this.economy.leaveSchool(x); this.economy.findSchool(x); }
  }

  onRoadStarted(e: REdge, motive: string) {
    this.roadWorks.set(e.id, { motive, speed: 0.45 + this.rng.next() * 0.2, kind: 'new' });
    if (e.deck !== undefined && e.deckTot !== undefined) { this.roadWorks.get(e.id)!.speed = 0.55; return; } // structures announce themselves
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
    this.roads.stepRouting();
    this.stepSignals(dt);
    this.traffic.rain = this.weather.rain;
    this.peds.rain = this.weather.rain;
    this.rail2.step(dt);
    this.traffic.step(dt, this.nodeAllow);
    this.peds.step(dt);
    this.citizens.step(dt);
    // construction progress
    for (const id of [...this.buildings.underConstruction]) {
      const b = this.buildings.byId.get(id);
      if (!b) { this.buildings.underConstruction.delete(id); continue; }
      const before = b.state;
      if (b.def.public && this.integrity.frozen(b)) continue; // stalled public works
      this.buildings.advance(b, dt * (this.weather.rain > 0.6 ? 0.6 : 1));
      if (b.state !== before && b.state === 'done') this.onBuildingCompleted(b);
    }
    const dem = this.buildings.demolishing;
    if (dem.length) {
      for (const b of dem.slice()) {
        if (b.alive && b.state === 'demolishing') this.buildings.advance(b, dt);
        if (!b.alive && b.pendingRebuild) this.startRebuild(b);
      }
      this.buildings.demolishing = this.buildings.demolishing.filter((b) => b.alive && b.state === 'demolishing');
    }
    // road works
    for (const [id, w] of this.roadWorks) {
      const e = this.roads.edges[id];
      if (!e.alive) { this.roadWorks.delete(id); continue; }
      const rate = (w.speed * dt) / Math.max(30, e.deckTot ?? e.len) * (e.bridge ? 0.35 : e.deck !== undefined ? (e.tunnel ? 0.018 : 0.035) : 1) * (w.kind === 'upgrade' ? 0.8 : 1);
      if (w.kind === 'upgrade') e.workP = Math.min(1, e.workP + rate); else e.progress = Math.min(1, e.progress + rate);
      this.roads.dirtyEdges.add(id);
      if ((w.kind === 'upgrade' ? e.workP : e.progress) >= 1) {
        this.roadWorks.delete(id);
        if (w.kind === 'upgrade') this.finishUpgrade(e);
        else {
          this.roads.topoVer++;
          const a = this.roads.nodes[e.a], b = this.roads.nodes[e.b];
          if (e.deck !== undefined && (e.deckS0 ?? 0) > 0) continue; // a structure is announced once
          if (e.deck !== undefined) { this.events.emit('road_done', (a.x + b.x) / 2, (a.z + b.z) / 2, 0.9, `Inaugurado o ${e.name}`, { ref: e.id, entity: { kind: 'edge', id: e.id }, headline: `${e.name} é aberto ao tráfego`, visual: 1 }); continue; }
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
    this.structures.hourly();
    this.roads.hourTick();
    updateFields(this);
    this.economy.hourly();
    this.utils.hourly();
    this.services.hourly();
    this.transitSys.hourly();
    this.happen.hourly();
    this.integrity.hourly();
    this.rail2.cargoHourly();
    if (this.hourIdx % 12 === 6) this.cityHall.cycle();
    this.updateDemand();
    this.runMarket();
    this.constructionLogistics();
    this.updateEra();
    this.cityRadius = this.computeRadius();
  }

  daily() {
    this.roads.dayTick();
    this.citizens.daily();
    this.economy.daily();
    this.utils.daily();
    this.services.daily();
    this.transitSys.daily();
    this.tourismSys.daily();
    this.happen.daily();
    this.cityHall.daily();
    this.statsEdu = this.computeEdu();
    this.integrity.daily();
    this.rail2.daily();
    if (this.era >= 1) this.upgrades.daily();
    this.structures.hillTunnel();
    if (this.day % 2 === 0) this.growth.closeLoops(2);
  }

  computeRadius(): number {
    let s = 0, n = 0;
    for (const b of this.buildings.list) { s += Math.hypot(b.x - this.center.x, b.z - this.center.z); n++; }
    return Math.max(150, n ? (s / n) * 1.7 : 150);
  }

  // ---------------- demand & market (stage 1: synthetic) ----------------
  updateDemand() {
    let hh = 0;
    for (const b of this.buildings.list) hh += b.households.length;
    this.households = hh;
    let pop = 0;
    const C = this.citizens;
    for (let i = 0; i < C.max; i++) if (C.alive[i] && !C.tourist[i]) pop++;
    this.population = pop;
  }

  runMarket() {
    const active = this.buildings.underConstruction.size;
    const maxSites = 6 + Math.floor(this.population / 120);
    let budget = Math.max(0, maxSites - active);
    this.siteScarcity *= 0.6;
    const d = this.demand;
    const tries: [string, number, number][] = [];
    if (d.res > 0) {
      const n = Math.ceil(d.res / 5);
      const hd = this.economy.homelessDemand;
      const tot = hd[0] + hd[1] + hd[2] + 0.001;
      for (let i = 0; i < n; i++) {
        const r = this.rng.next() * tot;
        const wealth = r < hd[0] ? 0 : r < hd[0] + hd[1] ? 1 : 2;
        // the poorest who find nothing affordable build informally
        if (wealth === 0 && hd[0] > 25 && this.rng.chance(0.35 * this.params.inequality + 0.05)) tries.push(['informal', 0, d.res]);
        else tries.push(['res', wealth, d.res]);
      }
    }
    if (d.com > 0) tries.push(['com', 1, d.com]);
    if (d.ind > 0) {
      const v = this.params.vocation;
      const pool = v === 'agricultura' || this.era === 0 ? ['farm', 'farm', 'foodPlant', 'warehouse'] : ['factory', 'warehouse', 'foodPlant', 'farm'];
      if (this.era >= 1) pool.push('factory', 'steelMill');
      tries.push([this.rng.pick(pool), 1, d.ind]);
    }
    if (this.tourismSys?.hotelDemand > 0 && this.rng.chance(0.5)) tries.push([this.rng.chance(0.65) ? 'hotel' : 'hostel', 1, 10]);
    if (this.tourismSys?.started && this.rng.chance(0.15)) tries.push(['restaurant', 1, 8]);
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
    if (this.rail2?.dirtyViews) { this.rail2.dirtyViews = false; diff.rail = this.rail2.railViews(); }
    if (this.rail2?.crossingsDirty) { this.rail2.crossingsDirty = false; diff.crossings = this.rail2.crossingViews(); }
    const st = this.rail2?.stationViews(); if (st?.length) diff.stations = st;
    const lv = this.transitSys?.views(); if (lv?.length) diff.lines = lv;
    if (this.happen) {
      if (Math.abs(this.happen.floodLevel - this.sentFlood) > 0.1) { this.sentFlood = this.happen.floodLevel; diff.floodLevel = this.happen.floodLevel; }
      if (this.happen.dikesDirty) { this.happen.dikesDirty = false; diff.dikes = this.happen.dikes; diff.heights = this.terrain.heights.slice(); }
    }
    if (this.utils?.dirtyLines.size) { diff.powerLines = [...this.utils.dirtyLines].map((id) => ({ ...this.utils.powerLines[id] })); this.utils.dirtyLines.clear(); }
    this.diffHook?.(diff);
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
