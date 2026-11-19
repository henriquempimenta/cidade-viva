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
};

export const RESTART_KEYS: (keyof SimParams)[] = ['seed', 'terrain', 'mapSize'];

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
    baseCrime: 1.6, policeEfficiency: 0.6, pollutionTolerance: 0.7, budgetMult: 0.7,
  },
  'Cidade sustentável planejada': {
    vocation: 'servicos', transitPriority: 0.95, gridGrowth: 0.9, pollutionTolerance: 0.1,
    envPreservation: 0.9, inequality: 0.2, initialEducation: 0.7, budgetMult: 1.4, baseCrime: 0.6,
  },
};
