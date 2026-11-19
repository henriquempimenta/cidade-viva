import { KINDS, type KindDef } from '../shared/catalog';
import { DAY_SECONDS } from '../shared/constants';
import type { BuildState, BuildingView } from '../shared/protocol';
import { OCC_BUILD, OCC_FREE, OCC_RESERVED, type Occupancy } from './occupancy';
import type { Terrain } from './terrain';
import { COMPANY, LAST } from '../shared/names';
import type { RNG } from '../shared/rng';

export interface Candidate {
  x: number; z: number; angle: number;
  edge: number; t: number; side: number;
  access: number; // node for off-road sites
  offDist: number;
  total: number;
  terms: Record<string, number>;
  label?: string;
}

export interface Decision {
  actor: 'Mercado' | 'Prefeitura' | 'Autoconstrução';
  kind: string;
  day: number;
  motive: string;
  chosen: Candidate;
  alternatives: Candidate[];
  sampled: number;
}

export interface Building {
  id: number;
  kind: string;
  def: KindDef;
  level: number;
  wealth: number;
  x: number; z: number; y: number;
  angle: number; w: number; d: number;
  floors: number; height: number;
  era: number; seed: number;
  state: BuildState;
  progress: number;
  buildSecs: number;
  edge: number; edgeT: number; side: number;
  access: number;
  alive: boolean;
  abandoned: boolean;
  abandonedDays: number;
  /** years of neglect, 0..1 (1 = about to collapse) */
  decay: number;
  /** abandoned since (game day) */
  abandonedDay: number;
  /** occupied by squatters */
  squatted: boolean;
  /** public works frozen until this day (−1 = running) */
  stalledUntil: number;
  /** consecutive days without any household (residential) */
  emptyDays: number;
  fire: number;
  garbage: number;
  name: string;
  variant: number;
  heritage: boolean;
  builtDay: number;
  // occupancy
  hhCap: number;
  households: number[];
  jobCap: [number, number, number, number];
  workers: number[];
  students: number[];
  // economy
  profit: number; // EMA per day
  revenue: number; // accumulated today
  customers: number;
  badDays: number;
  stockIn: number; stockOut: number;
  // utilities
  powered: boolean; watered: boolean;
  decision: Decision | null;
  district: number;
  replaces: number; // building id this one replaces (redevelopment)
  pendingRebuild?: { kind: string; level: number; wealth: number; floors: number; decision: Decision | null; variant: number };
  visitors: number;
  lastViewSent: number;
  publicProject?: string;
}

const STAGES: [number, BuildState][] = [[0.08, 'site'], [0.22, 'foundation'], [0.72, 'structure'], [1.0001, 'facade']];

export function floorsFor(kind: string, level: number, rng: RNG, maxDensity: number): number {
  const def = KINDS[kind];
  const L = Math.min(level, maxDensity);
  if (kind === 'res') return [1, 1, 2, rng.int(4, 6), rng.int(8, 13), rng.int(16, 34)][L];
  if (kind === 'com') return [1, 1, 2, rng.int(3, 5), rng.int(6, 12), rng.int(12, 22)][L];
  if (kind === 'off') return [2, rng.int(2, 3), rng.int(4, 8), rng.int(10, 18), rng.int(20, 34), rng.int(34, 52)][L];
  if (kind === 'informal') return rng.chance(0.4) ? 2 : 1;
  return rng.int(def.floors[0], def.floors[1]);
}

export function floorHeight(kind: string): number {
  const cat = KINDS[kind].cat;
  if (cat === 'ind') return 6;
  if (cat === 'off') return 3.8;
  if (cat === 'informal') return 2.7;
  return 3.2;
}

export class Buildings {
  list: Building[] = [];
  byId = new Map<number, Building>();
  private nextId = 1;
  dirty = new Set<number>();
  removed: number[] = [];
  treesRemoved: number[] = [];
  underConstruction = new Set<number>();
  /** buildings currently being torn down (avoids scanning the whole city every step) */
  demolishing: Building[] = [];

  constructor(private occ: Occupancy, private terrain: Terrain, private rng: RNG) {}

  create(kind: string, c: Candidate, opts: { level?: number; wealth?: number; era: number; day: number; w: number; d: number; maxDensity: number; decision: Decision | null; instant?: boolean; floors?: number; variant?: number }): Building {
    const def = KINDS[kind];
    const level = opts.level ?? 1;
    const floors = opts.floors ?? floorsFor(kind, level, this.rng, opts.maxDensity);
    const id = this.nextId++;
    const y = this.footY(c.x, c.z, c.angle, opts.w, opts.d);
    const b: Building = {
      id, kind, def, level, wealth: opts.wealth ?? 1, x: c.x, z: c.z, y, angle: c.angle, w: opts.w, d: opts.d,
      floors, height: floors * floorHeight(kind) + (def.cat === 'ind' ? 2 : 0.6), era: opts.era, seed: this.rng.int(0, 1e9),
      state: opts.instant ? 'done' : 'site', progress: opts.instant ? 1 : 0,
      buildSecs: Math.max(0.15, def.buildDays * (0.6 + 0.12 * floors) ) * DAY_SECONDS * 0.5,
      edge: c.edge, edgeT: c.t, side: c.side, access: c.access, alive: true, abandoned: false, abandonedDays: 0, decay: 0, abandonedDay: -1, squatted: false, stalledUntil: -1, emptyDays: 0, fire: 0, garbage: 0,
      name: this.nameFor(kind), variant: opts.variant ?? 0, heritage: false, builtDay: opts.day,
      hhCap: 0, households: [], jobCap: [0, 0, 0, 0], workers: [], students: [],
      profit: 0, revenue: 0, customers: 0, badDays: 0, stockIn: 0, stockOut: 0,
      powered: true, watered: true, decision: opts.decision, district: 0, replaces: -1, visitors: 0, lastViewSent: 0,
    };
    this.computeCapacity(b);
    this.list.push(b);
    this.byId.set(id, b);
    this.occ.markRect(b.x, b.z, b.angle, b.w + 2, b.d + 2, OCC_BUILD, id);
    this.clearTrees(b);
    if (!opts.instant) this.underConstruction.add(id);
    this.dirty.add(id);
    return b;
  }

  computeCapacity(b: Building) {
    const def = b.def;
    const L = b.level;
    if (def.cat === 'res') b.hhCap = L <= 1 ? 1 : L === 2 ? 2 : Math.round(b.floors * (L === 3 ? 2 : L === 4 ? 3 : 4) * Math.max(0.6, (b.w * b.d) / 400));
    else if (def.cat === 'informal') b.hhCap = 1;
    else if (b.kind === 'hotel') b.hhCap = b.floors * 4;
    else if (b.kind === 'hostel') b.hhCap = b.floors * 3;
    else if (b.kind === 'com') b.hhCap = L >= 2 ? Math.max(0, b.floors - 1) : 0; // apartments above shops
    else b.hhCap = 0;
    if (def.jobs) {
      const area = (b.w * b.d) / ((def.w[0] + def.w[1]) * (def.d[0] + def.d[1]) / 4);
      const mult = def.cat === 'com' || def.cat === 'off' ? Math.max(1, b.floors * 0.8) * Math.max(0.6, area) : Math.max(0.7, area);
      b.jobCap = def.jobs.map((j) => Math.round(j * mult)) as [number, number, number, number];
    }
  }

  footY(x: number, z: number, a: number, w: number, d: number): number {
    const ca = Math.cos(a), sa = Math.sin(a);
    let mx = -Infinity;
    for (const [u, v] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, 0]]) {
      const px = x + ca * u * w - sa * v * d, pz = z + sa * u * w + ca * v * d;
      mx = Math.max(mx, this.terrain.heightAt(px, pz));
    }
    return Math.max(mx, 0.3);
  }

  clearTrees(b: { x: number; z: number; angle: number; w: number; d: number }) {
    const T = this.terrain.trees;
    const r = Math.hypot(b.w, b.d) / 2 + 3;
    const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
    // trees are stored in a regular-ish grid scan; brute force with bbox prefilter via sorted arrays would be nicer
    for (let i = 0, n = T.length / 5; i < n; i++) {
      if (!this.terrain.treeAlive[i]) continue;
      const dx = T[i * 5] - b.x, dz = T[i * 5 + 2] - b.z;
      if (Math.abs(dx) > r || Math.abs(dz) > r) continue;
      const u = dx * ca + dz * sa, v = -dx * sa + dz * ca;
      if (Math.abs(u) < b.w / 2 + 2 && Math.abs(v) < b.d / 2 + 2) {
        this.terrain.treeAlive[i] = 0;
        this.treesRemoved.push(i);
      }
    }
  }

  nameFor(kind: string): string {
    const def = KINDS[kind];
    const co = this.rng.pick(COMPANY);
    switch (def.cat) {
      case 'res': return 'Residencial ' + co;
      case 'informal': return 'Moradia de ' + this.rng.pick(LAST);
      case 'com': return (kind === 'hotel' ? 'Hotel ' : kind === 'restaurant' ? 'Restaurante ' : kind === 'mall' ? 'Shopping ' : 'Comércio ') + co;
      case 'off': return (kind === 'techPark' ? 'Tech ' : 'Escritório ') + co;
      case 'ind': return def.label + ' ' + co;
      default: return def.label + ' ' + co;
    }
  }

  advance(b: Building, dt: number): boolean {
    if (b.state === 'done') return false;
    if (b.state === 'demolishing') {
      b.progress += dt / (DAY_SECONDS * 0.12);
      if (b.progress >= 1) { this.remove(b); return true; }
      return false;
    }
    const before = b.state;
    b.progress = Math.min(1, b.progress + dt / b.buildSecs);
    for (const [th, st] of STAGES) if (b.progress < th) { b.state = st; break; }
    if (b.progress >= 1) { b.state = 'done'; this.underConstruction.delete(b.id); }
    if (b.state !== before || this.rng.next() < 0.15) this.dirty.add(b.id);
    return b.state !== before;
  }

  demolish(b: Building) {
    if (b.state === 'demolishing') return;
    b.state = 'demolishing';
    b.progress = 0;
    this.demolishing.push(b);
    this.underConstruction.delete(b.id);
    this.dirty.add(b.id);
  }

  remove(b: Building) {
    b.alive = false;
    this.byId.delete(b.id);
    const i = this.list.indexOf(b);
    if (i >= 0) this.list.splice(i, 1);
    this.occ.markRect(b.x, b.z, b.angle, b.w + 2, b.d + 2, OCC_FREE);
    this.underConstruction.delete(b.id);
    this.dirty.delete(b.id);
    this.removed.push(b.id);
  }

  reserve(x: number, z: number, a: number, w: number, d: number) {
    this.occ.markRect(x, z, a, w, d, OCC_RESERVED);
  }

  view(b: Building): BuildingView {
    return {
      id: b.id, kind: b.kind, level: b.level, wealth: b.wealth, x: b.x, z: b.z, y: b.y, angle: b.angle, w: b.w, d: b.d,
      floors: b.floors, height: b.height, era: b.era, seed: b.seed, state: b.state, progress: b.progress,
      abandoned: b.abandoned, decay: Math.floor(b.decay * 4) / 4, stalled: b.stalledUntil >= 0, squatted: b.squatted, fire: b.fire, name: b.name, variant: b.variant, heritage: b.heritage, garbage: b.garbage,
    };
  }
}
