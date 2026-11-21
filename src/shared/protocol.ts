import type { SimParams } from './params';

export type BuildState = 'site' | 'foundation' | 'structure' | 'facade' | 'done' | 'demolishing';

export interface BuildingView {
  id: number;
  kind: string;
  level: number; // 1..5 for zoned
  wealth: number; // 0 low .. 2 high
  x: number; z: number; y: number;
  angle: number;
  w: number; d: number;
  floors: number;
  height: number;
  era: number;
  seed: number;
  state: BuildState;
  progress: number; // 0..1 overall construction or demolition progress
  abandoned: boolean;
  decay?: number; // 0..1 in quarter steps (neglect)
  stalled?: boolean; // public works frozen (corruption)
  squatted?: boolean;
  fire: number; // 0 none, >0 intensity
  name: string;
  variant: number; // e.g. industry/souvenir conversion, loft
  heritage: boolean;
  garbage: number;
}

export interface NodeView { id: number; x: number; z: number; y: number; control: number; deg: number; radius: number; interchange: boolean }
// control: 0 none, 1 stop/priority, 2 signal, 3 roundabout, 4 smart signal

export interface EdgeView {
  id: number; a: number; b: number;
  cls: number;
  lanes: number; // per direction
  oneway: number; // 0 two-way, 1 a->b only
  bridge: boolean;
  tunnel: boolean;
  elevated: boolean;
  /** grade-separated bypass: ramp length (−1 = hill bore) */
  deck?: number;
  /** street with a central trench under it (draw surface lanes on the sides only) */
  hole?: number;
  busLane: boolean;
  progress: number; // construction 0..1 (1 = done)
  upgrading: boolean;
  pts: number[]; // polyline [x,y,z,...] sampled along terrain
  name: string;
}

export interface RailEdgeView { id: number; pts: number[]; tracks: number; progress: number; bridge: boolean; elevated: boolean; metro: boolean; spur: boolean }
export interface RailStationView { id: number; x: number; z: number; y: number; angle: number; len: number; kind: 'pass' | 'freight' | 'metro'; name: string }
export interface TransitLineView { id: number; kind: 'bus' | 'brt' | 'rail' | 'metro' | 'freight'; color: string; name: string; pts: number[]; stops: number[]; stopPoses?: number[]; riders: number; vehicles: number }
export interface PowerLineView { id: number; pts: number[]; progress: number }
export interface CrossingView { x: number; z: number; y: number; angle: number; closed: boolean; separated: boolean; /** road dips under the track (trincheira) */ under?: boolean; /** road half width, rail heading, rail top height */ hw?: number; rail?: number; ry?: number }

export interface WorldInit {
  size: number;
  hres: number; // heightmap resolution (vertices per side)
  heights: Float32Array;
  water: Uint8Array; // per heightmap vertex: 1 water
  forest: Float32Array;
  flood: Uint8Array;
  trees: Float32Array; // x,y,z,scale,type
  river: number[]; // polyline x,z
  windDir: number; // radians, direction wind blows TOWARD
  seaLevel: number;
  fieldRes: number;
  params: SimParams;
}

export interface SimEvent {
  id: number;
  type: string;
  t: number; // sim time (s)
  day: number;
  x: number; z: number;
  mag: number; // 0..1 magnitude
  text: string;
  headline?: string; // chronicle headline
  entity?: { kind: 'vehicle' | 'ped' | 'building' | 'train' | 'citizen' | 'edge'; id: number; gen?: number };
  ref?: number; // building/edge id for narrative continuity
  visual?: number; // 0..1 visual quality hint
}

export interface Stats {
  day: number; year: number; season: number; hour: number;
  era: number;
  population: number; households: number; employed: number; unemployed: number; students: number;
  jobs: number; vacancies: number;
  money: number; income: number; expenses: number; debt: number;
  gdp: number; happiness: number; crime: number; emissions: number;
  demand: { res: number; com: number; ind: number; off: number };
  power: { supply: number; demand: number }; water: { supply: number; demand: number };
  sewage: { cap: number; prod: number }; garbage: { cap: number; prod: number; stock: number };
  tourists: number; attractiveness: number;
  vehicles: number; virtualTrips: number; peds: number; buses: number; trains: number;
  modal: { walk: number; bike: number; car: number; bus: number; rail: number };
  buildings: number; underConstruction: number;
  speedActual: number;
  weather: string; temperature: number; rain: number; fog: number; snow: number;
  inflation: number; avgIncome: number; education: number;
  hall?: HallReport;
  /** threads working on the simulation (sim + routing pool) and frames that waited on routing */
  threads?: number; stalls?: number;
}

/** City hall & city services dashboard (Prefeitura tab) */
export interface HallReport {
  breakdown: { taxes: number; tariffs: number; transfers: number; tourism: number; upkeep: number; roads: number; staff: number; transit: number; interest: number };
  ledger: { day: number; text: string; value: number }[];
  works: { id: number; name: string; kind: string; cost: number; progress: number; motive: string; road?: boolean }[];
  networks: { key: string; label: string; served: number; demand: number; pending: number }[];
  lines: { id: number; name: string; color: string; kind: string; fleet: number; riders: number; waiting: number; stops: number }[];
  market: { homeless: number; vacant: number; abandoned: number; demolishing: number; pending: number; rent: number };
  lastCycle?: { day: number; chosen: string[]; rejected: string[] };
  integrity?: { index: number; trust: number; mayor: string; mayorTitle: string; since: number; nextElection: number; diverted: number; divertedYear: number; stalled: number; derelict: number; squatted: number; avgAbandonYears: number; investigations: number; collapses: number };
}

export interface Snapshot {
  type: 'snap';
  t: number;
  dayFrac: number;
  veh: Float32Array; vehCount: number;
  ped: Float32Array; pedCount: number;
  train: Float32Array; trainCount: number;
  signals: Int32Array; // pairs nodeId, phase(0..3)
  crossings: Uint8Array;
  turbine: number;
  follow?: number[]; // x,y,z,heading,inside,building of the followed citizen
}

export interface WorldDiff {
  type: 'diff';
  nodes?: NodeView[];
  edges?: EdgeView[];
  removedEdges?: number[];
  removedNodes?: number[];
  buildings?: BuildingView[];
  removedBuildings?: number[];
  treesRemoved?: number[];
  rail?: RailEdgeView[];
  stations?: RailStationView[];
  lines?: TransitLineView[];
  removedLines?: number[];
  powerLines?: PowerLineView[];
  crossings?: CrossingView[];
  floodLevel?: number;
  dikes?: number[][];
  events?: SimEvent[];
  stats?: Stats;
  fields?: { name: string; data: Float32Array; max: number };
  outage?: Uint8Array; // per field cell: 1 = no power
  skyline?: Float32Array; // per field cell: max building height
  heights?: Float32Array; // terrain updated (dikes)
  od?: number[]; // x1,z1,x2,z2,weight
  cargo?: number[];
}

export type ToWorker =
  | { type: 'init'; params: SimParams; warmup?: number }
  | { type: 'speed'; speed: number }
  | { type: 'params'; params: Partial<SimParams> }
  | { type: 'inject'; event: string }
  | { type: 'overlay'; field: string | null }
  | { type: 'camera'; x: number; z: number; h: number }
  | { type: 'inspect'; kind: 'building' | 'citizen' | 'edge' | 'vehicle' | 'ped' | 'node'; id: number; reqId: number }
  | { type: 'follow'; citizen: number };

export type FromWorker =
  | { type: 'init'; world: WorldInit }
  | Snapshot
  | WorldDiff
  | { type: 'inspect'; reqId: number; data: unknown };
