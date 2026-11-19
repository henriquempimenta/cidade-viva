import { FIELD_NAMES, type FieldName, KINDS } from '../shared/catalog';
import { MAX_PEDS, MAX_VEHICLES, PED_STRIDE, ROAD_NAMES, VEH_STRIDE, TRAIN_STRIDE, MAX_TRAIN_CARS } from '../shared/constants';
import type { SimParams } from '../shared/params';
import type { Snapshot, Stats, WorldDiff } from '../shared/protocol';
import { TERM_LABELS } from './siting';
import type { World } from './world';

type Ext = World & {
  traffic?: { fillSnapshot(veh: Float32Array): number; count: number; max: number; virtualTrips: number; inspect(id: number): unknown };
  peds?: { fillSnapshot(ped: Float32Array, cam: { x: number; z: number; h: number }): number; count: number; max: number };
  trains?: { fillSnapshot(arr: Float32Array): number; count: number };
  signalsSnapshot?: () => Int32Array;
  crossingsSnapshot?: () => Uint8Array;
  statsExtra?: (s: Stats) => void;
  inspectCitizen?: (id: number) => unknown;
  inspectPed?: (slot: number) => unknown;
  inject?: (ev: string) => void;
  paramsChanged?: (keys: string[]) => void;
  outageGrid?: () => Uint8Array;
};

export function makeSnapshot(w: World, cam: { x: number; z: number; h: number }): Snapshot {
  const x = w as Ext;
  const veh = new Float32Array((x.traffic?.max ?? MAX_VEHICLES) * VEH_STRIDE);
  const ped = new Float32Array((x.peds?.max ?? MAX_PEDS) * PED_STRIDE);
  const train = new Float32Array(MAX_TRAIN_CARS * TRAIN_STRIDE);
  const vehCount = x.traffic ? x.traffic.fillSnapshot(veh) : 0;
  const pedCount = x.peds ? x.peds.fillSnapshot(ped, cam) : 0;
  const trainCount = x.trains ? x.trains.fillSnapshot(train) : 0;
  return {
    type: 'snap', t: w.t, dayFrac: w.dayFrac, veh, vehCount, ped, pedCount, train, trainCount,
    signals: x.signalsSnapshot ? x.signalsSnapshot() : new Int32Array(0),
    crossings: x.crossingsSnapshot ? x.crossingsSnapshot() : new Uint8Array(0),
    turbine: w.weather.wind,
    follow: (() => { const c = (w as unknown as { citizens?: { followed: number; position(i: number): { x: number; y: number; z: number; h: number; inside: boolean; building: number } | null } }).citizens; if (!c || c.followed < 0) return undefined; const p = c.position(c.followed); return p ? [p.x, p.y, p.z, p.h, p.inside ? 1 : 0, p.building] : undefined; })(),
  };
}

export function buildStats(w: World, speedActual: number): Stats {
  const x = w as Ext;
  let uc = 0;
  for (const b of w.buildings.list) if (b.state !== 'done') uc++;
  const s: Stats = {
    day: w.day, year: w.year, season: w.season, hour: w.hour, era: w.era,
    population: w.population, households: w.households, employed: 0, unemployed: 0, students: 0, jobs: 0, vacancies: 0,
    money: 0, income: 0, expenses: 0, debt: 0, gdp: 0, happiness: 0.6, crime: 0, emissions: 0,
    demand: { ...w.demand }, power: { supply: 0, demand: 0 }, water: { supply: 0, demand: 0 }, sewage: { cap: 0, prod: 0 },
    garbage: { cap: 0, prod: 0, stock: 0 }, tourists: 0, attractiveness: 0,
    vehicles: x.traffic?.count ?? 0, virtualTrips: x.traffic?.virtualTrips ?? 0, peds: x.peds?.count ?? 0, buses: 0, trains: x.trains?.count ?? 0,
    modal: { walk: 0, bike: 0, car: 0, bus: 0, rail: 0 },
    buildings: w.buildings.list.length, underConstruction: uc, speedActual,
    weather: w.weather.label(), temperature: w.weather.temperature, rain: w.weather.rain, fog: w.weather.fog, snow: w.weather.snow,
    inflation: 0, avgIncome: 0, education: 0,
  };
  x.statsExtra?.(s);
  return s;
}

export function fieldPayload(w: World, overlay: string | null): Partial<WorldDiff> {
  const out: Partial<WorldDiff> = {};
  const F = w.fields;
  if (overlay && (FIELD_NAMES as readonly string[]).includes(overlay)) {
    const data = F.f[overlay as FieldName].slice();
    let max = 0;
    for (let i = 0; i < data.length; i++) max = Math.max(max, data[i]);
    out.fields = { name: overlay, data, max };
  }
  if (overlay === 'od') out.od = (w as unknown as { transitSys?: { odPairs(): number[] } }).transitSys?.odPairs() ?? [];
  if (overlay === 'cargo') out.cargo = (w as unknown as { cargoFlows?: number[] }).cargoFlows ?? [];
  const sky = new Float32Array(F.G * F.G);
  for (const b of w.buildings.list) {
    const k = F.idx(b.x, b.z);
    const h = b.y + b.height * (b.state === 'done' ? 1 : Math.min(1, b.progress * 1.2)) + 20; // crane margin
    const r = Math.ceil(Math.max(b.w, b.d) / 2 / F.cell);
    const i0 = k % F.G, j0 = Math.floor(k / F.G);
    for (let j = j0 - r; j <= j0 + r; j++) for (let i = i0 - r; i <= i0 + r; i++) {
      if (i < 0 || j < 0 || i >= F.G || j >= F.G) continue;
      const kk = j * F.G + i;
      if (h > sky[kk]) sky[kk] = h;
    }
  }
  out.skyline = sky;
  const x = w as Ext;
  if (x.outageGrid) out.outage = x.outageGrid();
  return out;
}

export function applyParams(w: World, p: Partial<SimParams>) {
  Object.assign(w.params, p);
  (w as Ext).paramsChanged?.(Object.keys(p));
  w.events.emit('param', w.center.x, w.center.z, 0.1, `Parâmetro alterado: ${Object.keys(p).join(', ')}`);
}

export function injectEvent(w: World, ev: string) {
  (w as Ext).inject?.(ev);
}

export function inspect(w: World, kind: string, id: number): unknown {
  const x = w as Ext;
  if (kind === 'building') {
    const b = w.buildings.byId.get(id);
    if (!b) return null;
    const dec = b.decision;
    const terms = (c: { terms: Record<string, number> }) => Object.entries(c.terms).map(([k, v]) => ({ key: k, label: TERM_LABELS[k] ?? k, value: v })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    return {
      id: b.id, name: b.name, kind: b.kind, label: KINDS[b.kind].label, cat: b.def.cat, level: b.level, wealth: b.wealth, floors: b.floors,
      state: b.state, progress: b.progress, district: w.districts[b.district]?.name ?? '', builtDay: b.builtDay, abandoned: b.abandoned,
      decay: b.decay, squatted: b.squatted, stalled: b.stalledUntil >= 0, stalledUntil: b.stalledUntil, abandonedYears: b.abandoned ? (w.day - b.abandonedDay) / 12 : 0, corruption: w.fields.sample('corruption', b.x, b.z),
      households: b.households.length, hhCap: b.hhCap, workers: b.workers.length, jobs: b.jobCap.reduce((a, c) => a + c, 0), students: b.students.length,
      profit: b.profit, powered: b.powered, watered: b.watered, heritage: b.heritage, garbage: b.garbage, visitors: b.visitors,
      x: b.x, z: b.z, y: b.y, height: b.height,
      fields: {
        landValue: w.fields.sample('landValue', b.x, b.z), air: w.fields.sample('airPollution', b.x, b.z), noise: w.fields.sample('noise', b.x, b.z),
        crime: w.fields.sample('crime', b.x, b.z), beauty: w.fields.sample('beauty', b.x, b.z), access: w.fields.sample('accessibility', b.x, b.z),
      },
      decision: dec ? {
        actor: dec.actor, motive: dec.motive, day: dec.day, sampled: dec.sampled, total: dec.chosen.total,
        terms: terms(dec.chosen),
        alternatives: dec.alternatives.map((a) => ({ x: a.x, z: a.z, total: a.total, terms: terms(a), district: w.districtName(a.x, a.z) })),
      } : null,
      occupants: (x as unknown as { buildingOccupants?: (id: number) => unknown }).buildingOccupants?.(b.id) ?? null,
    };
  }
  if (kind === 'edge') {
    const e = w.roads.edges[id];
    if (!e) return null;
    const od: Record<string, number> = {};
    const pairs: { ox: number; oz: number; dx: number; dz: number }[] = [];
    for (let i = 0; i < e.odLog.length; i += 2) {
      const o = w.buildings.byId.get(e.odLog[i]), d = w.buildings.byId.get(e.odLog[i + 1]);
      const on = o ? w.districtName(o.x, o.z) : 'Fora da cidade', dn = d ? w.districtName(d.x, d.z) : 'Fora da cidade';
      const k = `${on} → ${dn}`;
      od[k] = (od[k] ?? 0) + 1;
      if (o && d && pairs.length < 60) pairs.push({ ox: o.x, oz: o.z, dx: d.x, dz: d.z });
    }
    return {
      id: e.id, name: e.name, cls: ROAD_NAMES[e.cls], lanes: e.lanes, oneway: e.oneway, len: e.len,
      volume: e.volume, capacity: w.roads.capacity(e), vc: Math.max(e.volume[0], e.volume[1]) / w.roads.capacity(e),
      history: e.vcHistory, congestedDays: e.congestedDays, busLane: e.busLane, upgrading: e.upgrading,
      od: Object.entries(od).sort((a, b) => b[1] - a[1]).slice(0, 8), pairs,
      noise: (() => {
        const m = e.sndMean;
        if (!m) return null;
        const power = m[0] + m[1] + m[2];
        const bins = Math.max(1, e.len / 55);
        return { light: m[0], moto: m[1], heavy: m[2], power, index: Math.min(1, Math.log1p((power / bins) * 0.93) * 0.37), speed: m[4] > 0.02 ? m[3] / m[4] : 0, samples: m[4] };
      })(),
      mid: (() => { const p = e.pts, k = Math.floor(p.length / 6) * 3; return { x: p[k], y: p[k + 1], z: p[k + 2], hx: p[Math.min(p.length - 3, k + 3)] - p[k], hz: p[Math.min(p.length - 1, k + 5)] - p[k + 2] }; })(),
      upgrade: (w as unknown as { lastUpgrade?: Map<number, unknown> }).lastUpgrade?.get(e.id) ?? null,
    };
  }
  if (kind === 'citizen') return x.inspectCitizen?.(id) ?? null;
  if (kind === 'ped') return x.inspectPed?.(id) ?? null;
  if (kind === 'vehicle') return x.traffic?.inspect(id) ?? null;
  return null;
}
