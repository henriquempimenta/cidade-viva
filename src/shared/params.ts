export type TerrainType = 'litoral' | 'vale' | 'serra' | 'planicie';
export type Vocation = 'industria' | 'servicos' | 'turismo' | 'agricultura';

export interface SimParams {
  // Mundo (restart required)
  seed: number;
  terrain: TerrainType;
  mapSize: number;
  // Clima
  raininess: number; // 0..1
  snow: boolean;
  // Demografia
  immigration: number; // 0..2 multiplier
  natality: number; // 0..2
  lifeExpectancy: number; // years
  inequality: number; // 0..1
  // Economia
  taxRate: number; // 0..0.3
  vocation: Vocation;
  energyCost: number; // 0.5..2
  // Planejamento
  budgetMult: number; // 0.5..2 - municipal budget multiplier
  transitPriority: number; // 0 (carro) .. 1 (transporte público)
  maxDensity: number; // 1..5 (max building level)
  pollutionTolerance: number; // 0..1
  envPreservation: number; // 0..1
  gridGrowth: number; // 0 orgânico .. 1 grade
  // Sociedade
  baseCrime: number; // 0..2
  policeEfficiency: number; // 0..2
  initialEducation: number; // 0..1
  corruption: number; // 0..1 propensão de base à corrupção
  transparency: number; // 0..1 imprensa, controle e transparência
  // Eventos
  disasterFreq: number; // 0..3
  festivalFreq: number; // 0..3
}

export const DEFAULT_PARAMS: SimParams = {
  seed: 1234,
  terrain: 'vale',
  mapSize: 2400,
  raininess: 0.35,
  snow: false,
  immigration: 1,
  natality: 1,
  lifeExpectancy: 76,
  inequality: 0.45,
  taxRate: 0.12,
  vocation: 'industria',
  energyCost: 1,
  budgetMult: 1,
  transitPriority: 0.5,
  maxDensity: 5,
  pollutionTolerance: 0.5,
  envPreservation: 0.4,
  gridGrowth: 0.45,
  baseCrime: 1,
  policeEfficiency: 1,
  initialEducation: 0.35,
  disasterFreq: 1,
  festivalFreq: 1,
  corruption: 0.35,
  transparency: 0.5,
};

export const RESTART_KEYS: (keyof SimParams)[] = ['seed', 'terrain', 'mapSize'];

export const TERRAINS: readonly TerrainType[] = ['litoral', 'vale', 'serra', 'planicie'];
export const VOCATIONS: readonly Vocation[] = ['industria', 'servicos', 'turismo', 'agricultura'];
export const MAX_WARMUP_DAYS = 120;

const NUM_BOUNDS: Record<string, [number, number, boolean?]> = {
  seed: [1, 999999999, true],
  mapSize: [1200, 4800, true],
  raininess: [0, 1],
  immigration: [0, 2.5],
  natality: [0, 2.5],
  lifeExpectancy: [50, 95, true],
  inequality: [0, 1],
  taxRate: [0, 0.3],
  energyCost: [0.5, 2],
  budgetMult: [0.3, 2.5],
  transitPriority: [0, 1],
  maxDensity: [1, 5, true],
  pollutionTolerance: [0, 1],
  envPreservation: [0, 1],
  gridGrowth: [0, 1],
  baseCrime: [0, 2],
  policeEfficiency: [0, 2],
  initialEducation: [0, 1],
  corruption: [0, 1],
  transparency: [0, 1],
  disasterFreq: [0, 3],
  festivalFreq: [0, 3],
};

/** Validate and clamp arbitrary/URL parameter input onto safe, finite simulation bounds. */
export function sanitizeParams(raw: Partial<Record<keyof SimParams, unknown>> | Record<string, unknown>, base: SimParams = DEFAULT_PARAMS): SimParams {
  const out: SimParams = { ...base };
  const rec = out as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!(k in out) || v === undefined || v === null) continue;
    if (k === 'terrain') {
      if (typeof v === 'string' && (TERRAINS as readonly string[]).includes(v)) out.terrain = v as TerrainType;
      continue;
    }
    if (k === 'vocation') {
      if (typeof v === 'string' && (VOCATIONS as readonly string[]).includes(v)) out.vocation = v as Vocation;
      continue;
    }
    if (k === 'snow') {
      if (typeof v === 'boolean') out.snow = v;
      else if (v === '1' || v === 'true') out.snow = true;
      else if (v === '0' || v === 'false') out.snow = false;
      continue;
    }
    const b = NUM_BOUNDS[k];
    if (!b) continue;
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n)) continue;
    const clamped = Math.max(b[0], Math.min(b[1], n));
    rec[k] = b[2] ? Math.round(clamped) : clamped;
  }
  return out;
}

/** Validate and cap initial warm-up days so malformed URLs cannot freeze worker startup. */
export function sanitizeWarmup(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_WARMUP_DAYS, Math.round(n)));
}

export const PRESETS: Record<string, Partial<SimParams>> = {
  'Cidade industrial': {
    vocation: 'industria', pollutionTolerance: 0.9, envPreservation: 0.1, transitPriority: 0.3,
    initialEducation: 0.2, taxRate: 0.1, inequality: 0.6,
  },
  'Balneário turístico': {
    terrain: 'litoral', vocation: 'turismo', pollutionTolerance: 0.2, envPreservation: 0.7,
    maxDensity: 4, initialEducation: 0.45,
  },
  'Metrópole caótica': {
    immigration: 2, maxDensity: 5, transitPriority: 0.1, gridGrowth: 0.1, inequality: 0.85,
    baseCrime: 1.6, policeEfficiency: 0.6, pollutionTolerance: 0.7, budgetMult: 0.7, corruption: 0.75, transparency: 0.2,
  },
  'Cidade sustentável planejada': {
    vocation: 'servicos', transitPriority: 0.95, gridGrowth: 0.9, pollutionTolerance: 0.1,
    envPreservation: 0.9, inequality: 0.2, initialEducation: 0.7, budgetMult: 1.4, baseCrime: 0.6, corruption: 0.1, transparency: 0.9,
  },
};
