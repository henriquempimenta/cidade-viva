import { KINDS } from '../shared/catalog';
import { LOT_SETBACK, RoadClass } from '../shared/constants';
import type { SimParams } from '../shared/params';
import type { RNG } from '../shared/rng';
import { clamp } from '../shared/rng';
import type { Candidate } from './buildings';
import type { Fields } from './fields';
import type { Occupancy } from './occupancy';
import type { RoadNetwork } from './roads';
import type { Terrain } from './terrain';

export const TERM_LABELS: Record<string, string> = {
  access: 'Acessibilidade', beauty: 'Paisagem / vista', air: 'Poluição do ar', noise: 'Ruído', crime: 'Criminalidade',
  services: 'Serviços públicos', parks: 'Parques próximos', transit: 'Transporte público', footfall: 'Fluxo de pessoas',
  resDensity: 'Clientes / moradores próximos', labor: 'Mão de obra próxima', highway: 'Acesso rodoviário', rail: 'Acesso ferroviário',
  landCost: 'Custo do terreno', connCost: 'Custo de conexão (via, água, energia)', nimby: 'Rejeição dos vizinhos',
  earthwork: 'Terraplanagem', flood: 'Risco de enchente', forest: 'Preservação ambiental', soil: 'Solo contaminado',
  water: 'Poluição da água', prestige: 'Prestígio do endereço', gap: 'Demanda não atendida', agglom: 'Aglomeração econômica',
  random: 'Fatores locais', avenue: 'Frente para via principal', waterfront: 'Proximidade da água', river: 'Acesso ao rio',
  coverageOverlap: 'Sobreposição com unidade existente', centrality: 'Centralidade', windy: 'Vento / altitude', jobsNear: 'Empregos próximos',
};

export interface SiteContext {
  terrain: Terrain; roads: RoadNetwork; occ: Occupancy; fields: Fields; rng: RNG; params: SimParams;
  center: { x: number; z: number };
  cityRadius: number;
}

/** Sample candidate lots along usable roads (and optionally off the network). */
export function sampleSites(ctx: SiteContext, w: number, d: number, n: number, opts: { offRoad?: boolean; nearX?: number; nearZ?: number; nearR?: number; maxSlope?: number; minCls?: number; allowHighway?: boolean; informal?: boolean } = {}): Candidate[] {
  const { roads, occ, terrain: T, rng } = ctx;
  const edges = roads.edges.filter((e) => e.alive && e.progress >= 1 && !e.bridge && !e.elevated && (opts.allowHighway || e.cls !== RoadClass.Highway) && (opts.minCls === undefined || e.cls >= opts.minCls));
  const near = opts.nearX !== undefined ? edges.filter((e) => {
    const a = roads.nodes[e.a];
    return Math.hypot(a.x - opts.nearX!, a.z - opts.nearZ!) < (opts.nearR ?? 400);
  }) : edges;
  const pool = near.length ? near : edges;
  const out: Candidate[] = [];
  if (!pool.length) return out;
  const tries = n * 4;
  for (let i = 0; i < tries && out.length < n; i++) {
    const off = opts.offRoad && rng.chance(0.45);
    if (!off) {
      const e = pool[Math.floor(rng.next() * pool.length)];
      const a = roads.nodes[e.a], b = roads.nodes[e.b];
      if (e.len < w + 8) continue;
      const margin = (w / 2 + 6) / e.len;
      if (margin >= 0.5) continue;
      const t = rng.range(margin, 1 - margin);
      const side = rng.chance(0.5) ? 1 : -1;
      const ux = (b.x - a.x) / e.len, uz = (b.z - a.z) / e.len;
      const nx = -uz * side, nz = ux * side;
      const setback = (e.cls === RoadClass.Highway ? 15 : LOT_SETBACK) + d / 2 + 0.5;
      const px = a.x + (b.x - a.x) * t + nx * setback, pz = a.z + (b.z - a.z) * t + nz * setback;
      const angle = Math.atan2(uz, ux);
      if (!valid(ctx, px, pz, angle, w, d, opts.maxSlope, opts.informal)) continue;
      out.push({ x: px, z: pz, angle, edge: e.id, t, side, access: t < 0.5 ? e.a : e.b, offDist: 0, total: 0, terms: {} });
    } else {
      // off-network site: random point not too far from the network, gets an access road
      const base = pool[Math.floor(rng.next() * pool.length)];
      const nb = roads.nodes[rng.chance(0.5) ? base.a : base.b];
      const r = rng.range(80, opts.informal ? 140 : 650);
      const th = rng.range(0, Math.PI * 2);
      const px = nb.x + Math.cos(th) * r, pz = nb.z + Math.sin(th) * r;
      const angle = rng.range(0, Math.PI);
      if (!valid(ctx, px, pz, angle, w, d, opts.maxSlope, opts.informal)) continue;
      const nearest = roads.nearestNode(px, pz, 900, (q) => q.edges.length < 4 && q.edges.some((id) => roads.edges[id].cls !== RoadClass.Highway || q.edges.length === 2));
      if (!nearest) continue;
      out.push({ x: px, z: pz, angle, edge: -1, t: 0, side: 0, access: nearest.id, offDist: Math.hypot(nearest.x - px, nearest.z - pz), total: 0, terms: {} });
    }
  }
  return out;
}

function valid(ctx: SiteContext, x: number, z: number, angle: number, w: number, d: number, maxSlope = 0.16, informal = false): boolean {
  const { occ, terrain: T } = ctx;
  if (!T.inside(x, z, Math.max(w, d) / 2 + 20)) return false;
  if (!occ.rectFree(x, z, angle, w + 2, d + 2)) return false;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  let mn = Infinity, mx = -Infinity;
  for (const [u, v] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, 0]]) {
    const h = T.heightAt(x + ca * u * w - sa * v * d, z + sa * u * w + ca * v * d);
    if (h < T.seaLevel + 0.6) return false;
    mn = Math.min(mn, h); mx = Math.max(mx, h);
  }
  const slope = (mx - mn) / Math.max(w, d);
  return slope < (informal ? 0.45 : maxSlope);
}

export type Profile = Record<string, number>;

/** Weights of each term for each type of building. These are preferences, not placement rules. */
export function profileFor(kind: string, wealth: number, p: SimParams): Profile {
  const def = KINDS[kind];
  const tol = p.pollutionTolerance;
  const env = p.envPreservation;
  const base: Profile = { random: 0.08, forest: -0.9 * env, earthwork: -0.8, connCost: -1, soil: -0.3 };
  switch (def.cat) {
    case 'res':
      if (wealth === 0) return { ...base, access: 0.7, transit: 0.5 + 0.4 * p.transitPriority, jobsNear: 0.5, landCost: -1.6, air: -0.35, noise: -0.2, crime: -0.25, services: 0.3, flood: -0.4 };
      if (wealth === 1) return { ...base, access: 0.6, beauty: 0.55, air: -1.2, noise: -0.7, crime: -0.9, services: 0.5, parks: 0.4, transit: 0.35 + 0.3 * p.transitPriority, landCost: -0.6, flood: -0.9, water: -0.6, jobsNear: 0.25 };
      return { ...base, beauty: 1.6, prestige: 0.8, air: -2.2, noise: -1.3, crime: -1.6, services: 0.45, parks: 0.6, access: 0.25, landCost: -0.15, flood: -1.5, water: -1.2, earthwork: -0.25 };
    case 'informal':
      return { random: 0.12, landCost: -2.6, jobsNear: 0.9, access: 0.4, flood: -0.15, earthwork: 0, forest: -0.2 * env };
    case 'com':
      if (kind === 'hotel' || kind === 'hostel') return { ...base, tourism: 1.6, beauty: 0.6, access: 0.6, transit: 0.4, landCost: kind === 'hotel' ? -0.3 : -0.9, crime: -0.6, air: -0.5 } as Profile;
      return { ...base, footfall: 1.4, resDensity: 0.7, avenue: 0.6, access: 0.5, transit: 0.3, landCost: -0.55, crime: -0.3, agglom: 0.25 };
    case 'off':
      if (kind === 'techPark') return { ...base, access: 0.8, beauty: 0.4, services: 0.6, transit: 0.6, landCost: -0.4, air: -0.7, crime: -0.6, agglom: 0.6 };
      return { ...base, access: 1.2, transit: 0.6 + 0.3 * p.transitPriority, prestige: 0.5, agglom: 0.6, landCost: -0.45, crime: -0.4, avenue: 0.3 };
    case 'ind':
      if (kind === 'farm') return { ...base, landCost: -2.2, river: 0.3, earthwork: -1.4, centrality: -0.6, forest: -1.2 * env };
      if (kind === 'mine') return { ...base, landCost: -1.2, windy: 0.9, highway: 0.5, rail: 0.6, nimby: -(1.3 - tol) };
      return { ...base, landCost: -1.3, highway: 0.9, rail: 0.7, labor: 0.5, agglom: 0.35, nimby: -(1.3 - tol), river: def.waterPol > 0.3 ? 0.2 : 0 };
    default:
      return { ...base, gap: 1.6, access: 0.5, landCost: -0.6, nimby: def.undesir > 0 ? -(1.4 - 0.6 * tol) : 0, coverageOverlap: -1.2 };
  }
}

/** Compute the utility decomposition of a candidate site. */
export function evaluate(ctx: SiteContext, c: Candidate, kind: string, prof: Profile, w: number, d: number, extra?: (c: Candidate) => Record<string, number>): Candidate {
  const { fields: F, terrain: T, roads } = ctx;
  const def = KINDS[kind];
  const x = c.x, z = c.z;
  const raw: Record<string, number> = {};
  const r = Math.max(30, Math.hypot(w, d) / 2);
  const need = (k: string) => prof[k] !== undefined && prof[k] !== 0;
  if (need('access')) raw.access = F.avg('accessibility', x, z, r);
  if (need('beauty')) raw.beauty = F.avg('beauty', x, z, r * 1.5);
  if (need('air')) raw.air = F.avg('airPollution', x, z, r);
  if (need('noise')) raw.noise = F.avg('noise', x, z, r);
  if (need('crime')) raw.crime = F.avg('crime', x, z, r * 2);
  if (need('services')) raw.services = (F.sample('cov_health', x, z) + F.sample('cov_education', x, z) + F.sample('cov_police', x, z)) / 3;
  if (need('parks')) raw.parks = F.sample('cov_parks', x, z);
  if (need('transit')) raw.transit = F.sample('transit', x, z);
  if (need('footfall')) raw.footfall = F.avg('footfall', x, z, 60);
  if (need('resDensity')) raw.resDensity = clamp(F.avg('resDensity', x, z, 250) / 6, 0, 1.5);
  if (need('labor')) raw.labor = clamp(F.avg('resDensity', x, z, 900) / 3, 0, 1.5);
  if (need('jobsNear')) raw.jobsNear = clamp(F.avg('jobDensity', x, z, 600) / 8, 0, 1.5);
  if (need('highway')) raw.highway = F.sample('highwayAccess', x, z);
  if (need('rail')) raw.rail = F.sample('railAccess', x, z);
  if (need('agglom')) raw.agglom = clamp(F.avg('jobDensity', x, z, 200) / 15, 0, 1.2);
  if (need('tourism')) raw.tourism = F.avg('tourism', x, z, 150);
  const lv = F.avg('landValue', x, z, r);
  if (need('landCost')) raw.landCost = lv * Math.sqrt((w * d) / 300);
  if (need('prestige')) raw.prestige = lv;
  if (need('soil')) raw.soil = F.avg('soilPollution', x, z, r);
  if (need('water')) raw.water = F.avg('waterPollution', x, z, 120);
  if (need('flood')) raw.flood = T.isFlood(x, z) ? 1 : 0;
  if (need('forest')) raw.forest = T.sample(T.forest, x, z);
  if (need('earthwork')) raw.earthwork = clamp(T.slopeAt(x, z) * 4, 0, 2);
  if (need('connCost')) raw.connCost = c.offDist / 600 + (1 - clamp(F.sample('power', x, z), 0, 1)) * 0.15 + (1 - clamp(F.sample('waterSupply', x, z), 0, 1)) * 0.15;
  if (need('avenue')) raw.avenue = c.edge >= 0 ? Math.max(0, roads.edges[c.edge].cls - 1) / 2 : 0;
  if (need('river')) raw.river = Math.max(0, 1 - T.distToRiver(x, z) / 500);
  if (need('centrality')) raw.centrality = Math.max(0, 1 - Math.hypot(x - ctx.center.x, z - ctx.center.z) / (ctx.cityRadius + 300));
  if (need('windy')) raw.windy = clamp(F.relElev[F.idx(x, z)] * 1.5 + T.slopeAt(x, z), 0, 1.5);
  if (need('nimby')) raw.nimby = nimby(ctx, x, z, def.undesir, def.air);
  if (need('random')) raw.random = ctx.rng.next();
  if (extra) Object.assign(raw, extra(c));
  let total = 0;
  const terms: Record<string, number> = {};
  for (const k in prof) {
    const wgt = prof[k];
    if (!wgt || raw[k] === undefined) continue;
    const v = wgt * raw[k];
    terms[k] = v;
    total += v;
  }
  c.total = total;
  c.terms = terms;
  return c;
}

/** NIMBY: complaints of residents nearby (weighted by land value), and along the downwind plume for emitters. */
export function nimby(ctx: SiteContext, x: number, z: number, undesir: number, air: number): number {
  const F = ctx.fields;
  let s = F.sum('complaint', x, z, 380) / 40;
  if (air > 0) {
    const wd = ctx.terrain.windDir;
    const cx = Math.cos(wd), cz = Math.sin(wd);
    for (const [dist, wgt] of [[200, 0.7], [420, 0.5], [700, 0.3]]) s += (F.sum('complaint', x + cx * dist, z + cz * dist, 200) / 40) * wgt * Math.min(2, air);
  }
  return s * Math.max(0.3, undesir);
}

export function topAlternatives(cands: Candidate[], chosen: Candidate, n: number): Candidate[] {
  const others = cands.filter((c) => c !== chosen).sort((a, b) => b.total - a.total);
  const out = others.slice(0, n);
  // include a couple of clearly-losing alternatives to show what was avoided
  if (others.length > n + 2) out.push(others[others.length - 1], others[Math.floor((others.length + n) / 2)]);
  return out.map((c) => ({ ...c, terms: { ...c.terms } }));
}
