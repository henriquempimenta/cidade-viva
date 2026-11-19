// Catalog of everything that can be built. Numbers are tuning knobs, NOT placement rules:
// placement is always decided by the utility functions in sim/planner.ts.

export type Cat =
  | 'res' | 'com' | 'off' | 'ind' | 'informal'
  | 'power' | 'water' | 'sewage' | 'garbage'
  | 'health' | 'education' | 'police' | 'fire' | 'deathcare'
  | 'park' | 'culture' | 'transport' | 'landmark' | 'misc';

export const FIELD_NAMES = [
  'landValue', 'airPollution', 'waterPollution', 'soilPollution', 'noise', 'crime', 'accessibility',
  'beauty', 'tourism', 'cov_health', 'cov_education', 'cov_police', 'cov_fire', 'cov_parks', 'cov_culture',
  'happiness', 'resDensity', 'jobDensity', 'transit', 'railAccess', 'highwayAccess', 'footfall', 'complaint',
  'power', 'waterSupply', 'garbage', 'elevation', 'congestion',
] as const;
export type FieldName = (typeof FIELD_NAMES)[number];
export const FIELD_INDEX: Record<FieldName, number> = Object.fromEntries(FIELD_NAMES.map((n, i) => [n, i])) as Record<FieldName, number>;

export const FIELD_LABELS: Partial<Record<FieldName, string>> = {
  landValue: 'Valor do solo', airPollution: 'Poluição do ar', waterPollution: 'Poluição da água',
  soilPollution: 'Poluição do solo', noise: 'Ruído', crime: 'Criminalidade', accessibility: 'Acessibilidade',
  beauty: 'Beleza / paisagem', tourism: 'Atratividade turística', cov_health: 'Cobertura de saúde',
  cov_education: 'Cobertura de educação', cov_police: 'Cobertura policial', cov_fire: 'Cobertura de bombeiros',
  cov_parks: 'Parques', cov_culture: 'Cultura e lazer', happiness: 'Felicidade', resDensity: 'Densidade residencial',
  jobDensity: 'Densidade de empregos', transit: 'Acesso a transporte público', railAccess: 'Acesso ferroviário',
  highwayAccess: 'Acesso rodoviário', footfall: 'Fluxo de pedestres', complaint: 'Potencial de reclamação',
  power: 'Energia', waterSupply: 'Água', garbage: 'Lixo acumulado', elevation: 'Altitude', congestion: 'Congestionamento',
};

export interface ServiceDef { type: 'health' | 'education' | 'police' | 'fire' | 'parks' | 'culture'; radius: number; capacity: number }

export interface KindDef {
  label: string;
  cat: Cat;
  w: [number, number];
  d: [number, number];
  floors: [number, number];
  jobs?: [number, number, number, number]; // by education level 0..3
  residents?: number; // households capacity at level 1
  cost: number;
  maint: number; // per day
  buildDays: number;
  undesir: number; // NIMBY weight
  air: number; soil: number; noise: number; waterPol: number;
  power: number; // consumption (MW-ish); negative = generation
  waterUse: number; // negative = supply
  sewageCap?: number; garbageCap?: number;
  service?: ServiceDef;
  eraMin: number;
  tourism: number;
  beauty: number; // effect on neighborhood beauty
  offRoad?: boolean; // may be placed away from the road network (gets an access road)
  public?: boolean;
}

const D = (o: Partial<KindDef> & Pick<KindDef, 'label' | 'cat'>): KindDef => ({
  w: [14, 18], d: [14, 20], floors: [1, 1], cost: 50, maint: 0, buildDays: 1, undesir: 0,
  air: 0, soil: 0, noise: 0, waterPol: 0, power: 0.2, waterUse: 0.2, eraMin: 0, tourism: 0, beauty: 0, ...o,
});

export const KINDS: Record<string, KindDef> = {
  // --- Zoned (market) ---
  res: D({ label: 'Residência', cat: 'res', w: [12, 18], d: [14, 22], residents: 1, cost: 40, buildDays: 0.6, power: 0.15, waterUse: 0.2 }),
  informal: D({ label: 'Moradia informal', cat: 'informal', w: [7, 10], d: [7, 10], residents: 1, cost: 4, buildDays: 0.3, power: 0.08, waterUse: 0.1, beauty: -0.2 }),
  com: D({ label: 'Comércio', cat: 'com', w: [14, 22], d: [16, 24], jobs: [3, 2, 0, 0], cost: 70, buildDays: 0.8, noise: 0.15, power: 0.3 }),
  off: D({ label: 'Escritório', cat: 'off', w: [18, 26], d: [18, 26], jobs: [0, 3, 6, 2], cost: 140, buildDays: 1.4, power: 0.4, eraMin: 1 }),
  hotel: D({ label: 'Hotel', cat: 'com', w: [20, 28], d: [20, 28], floors: [3, 12], jobs: [6, 6, 2, 0], cost: 260, buildDays: 2, power: 0.5, tourism: 0.2 }),
  hostel: D({ label: 'Hostel', cat: 'com', w: [14, 18], d: [14, 20], floors: [2, 4], jobs: [3, 2, 0, 0], cost: 80, buildDays: 1, power: 0.2 }),
  restaurant: D({ label: 'Restaurante', cat: 'com', w: [12, 16], d: [14, 18], jobs: [5, 2, 0, 0], cost: 60, buildDays: 0.6, power: 0.2 }),
  souvenir: D({ label: 'Loja turística', cat: 'com', w: [12, 16], d: [12, 16], jobs: [3, 1, 0, 0], cost: 50, buildDays: 0.5 }),
  farm: D({ label: 'Fazenda', cat: 'ind', w: [70, 110], d: [70, 110], jobs: [8, 1, 0, 0], cost: 60, buildDays: 1, offRoad: true, soil: 0.05, power: 0.1, waterUse: 0.4 }),
  foodPlant: D({ label: 'Indústria de alimentos', cat: 'ind', w: [36, 50], d: [36, 50], floors: [1, 2], jobs: [24, 10, 2, 0], cost: 300, buildDays: 2, air: 0.5, noise: 0.5, soil: 0.2, waterPol: 0.4, power: 1.2, undesir: 0.4 }),
  factory: D({ label: 'Fábrica', cat: 'ind', w: [40, 60], d: [40, 60], floors: [1, 2], jobs: [34, 14, 2, 0], cost: 420, buildDays: 2.4, air: 1.2, noise: 0.8, soil: 0.5, waterPol: 0.6, power: 2, undesir: 0.7 }),
  steelMill: D({ label: 'Siderúrgica', cat: 'ind', w: [60, 80], d: [50, 70], floors: [2, 3], jobs: [50, 18, 4, 0], cost: 900, buildDays: 3.5, air: 2.4, noise: 1.2, soil: 0.9, waterPol: 0.9, power: 4, undesir: 1, eraMin: 1 }),
  warehouse: D({ label: 'Armazém logístico', cat: 'ind', w: [40, 60], d: [30, 46], jobs: [18, 6, 1, 0], cost: 200, buildDays: 1.2, noise: 0.5, air: 0.15, power: 0.5, undesir: 0.3 }),
  mine: D({ label: 'Mina', cat: 'ind', w: [60, 80], d: [60, 80], jobs: [30, 6, 1, 0], cost: 500, buildDays: 2, offRoad: true, air: 0.8, soil: 1.2, noise: 1, power: 1.5, undesir: 0.9 }),
  techPark: D({ label: 'Empresa de tecnologia', cat: 'off', w: [34, 50], d: [30, 44], floors: [2, 5], jobs: [2, 6, 22, 10], cost: 700, buildDays: 2.5, power: 1, eraMin: 2, beauty: 0.1 }),

  // --- Utilities ---
  well: D({ label: 'Poço artesiano', cat: 'water', w: [8, 8], d: [8, 8], cost: 20, waterUse: -40, power: 0.05, public: true, buildDays: 0.3 }),
  dieselGen: D({ label: 'Gerador a diesel', cat: 'power', w: [12, 12], d: [12, 12], jobs: [1, 0, 0, 0], cost: 40, power: -60, air: 0.8, noise: 0.8, undesir: 0.5, public: true, buildDays: 0.3, maint: 2 }),
  thermalPlant: D({ label: 'Termelétrica', cat: 'power', w: [60, 70], d: [50, 60], floors: [2, 3], jobs: [10, 14, 4, 0], cost: 1800, maint: 18, buildDays: 4, power: -900, air: 3, noise: 1, soil: 0.3, undesir: 1, public: true, eraMin: 1, offRoad: true }),
  hydroPlant: D({ label: 'Hidrelétrica', cat: 'power', w: [40, 50], d: [30, 40], jobs: [4, 8, 4, 0], cost: 4200, maint: 14, buildDays: 6, power: -1600, public: true, eraMin: 2, tourism: 0.1 }),
  windFarm: D({ label: 'Parque eólico', cat: 'power', w: [90, 120], d: [90, 120], jobs: [1, 3, 1, 0], cost: 2600, maint: 8, buildDays: 3, power: -650, noise: 0.4, undesir: 0.3, public: true, eraMin: 2, offRoad: true }),
  solarFarm: D({ label: 'Usina solar', cat: 'power', w: [80, 110], d: [70, 90], jobs: [1, 2, 1, 0], cost: 2400, maint: 6, buildDays: 2.5, power: -600, public: true, eraMin: 2, offRoad: true }),
  nuclearPlant: D({ label: 'Usina nuclear', cat: 'power', w: [90, 110], d: [80, 100], floors: [3, 4], jobs: [10, 20, 20, 6], cost: 9000, maint: 40, buildDays: 8, power: -5000, undesir: 1.6, public: true, eraMin: 3, offRoad: true }),
  waterPump: D({ label: 'Captação de água', cat: 'water', w: [18, 18], d: [18, 18], jobs: [2, 2, 0, 0], cost: 220, maint: 3, buildDays: 1, waterUse: -500, power: 2, public: true }),
  waterTreatment: D({ label: 'Estação de tratamento de água', cat: 'water', w: [50, 60], d: [40, 50], jobs: [6, 8, 2, 0], cost: 1400, maint: 10, buildDays: 3, waterUse: -2600, power: 6, public: true, eraMin: 1 }),
  waterTower: D({ label: 'Reservatório elevado', cat: 'water', w: [12, 12], d: [12, 12], cost: 160, maint: 1, buildDays: 1, waterUse: -150, public: true }),
  sewagePlant: D({ label: 'Estação de tratamento de esgoto', cat: 'sewage', w: [50, 60], d: [40, 50], jobs: [6, 6, 2, 0], cost: 1300, maint: 10, buildDays: 3, sewageCap: 2500, power: 5, undesir: 0.8, air: 0.2, public: true }),
  dump: D({ label: 'Lixão', cat: 'garbage', w: [70, 90], d: [70, 90], jobs: [6, 0, 0, 0], cost: 80, maint: 2, buildDays: 0.6, garbageCap: 400, soil: 1.5, air: 0.6, waterPol: 0.5, undesir: 1.5, beauty: -1, public: true, offRoad: true }),
  landfill: D({ label: 'Aterro sanitário', cat: 'garbage', w: [80, 100], d: [80, 100], jobs: [10, 2, 0, 0], cost: 900, maint: 6, buildDays: 2.5, garbageCap: 1400, soil: 0.4, air: 0.2, undesir: 1.1, public: true, eraMin: 1, offRoad: true }),
  recycling: D({ label: 'Central de reciclagem', cat: 'garbage', w: [44, 54], d: [36, 46], jobs: [16, 4, 1, 0], cost: 1100, maint: 8, buildDays: 2, garbageCap: 1200, noise: 0.4, undesir: 0.5, public: true, eraMin: 2 }),
  incinerator: D({ label: 'Incinerador', cat: 'garbage', w: [44, 50], d: [40, 46], floors: [2, 3], jobs: [8, 6, 1, 0], cost: 1600, maint: 12, buildDays: 3, garbageCap: 2500, air: 1.4, undesir: 1.2, public: true, eraMin: 2 }),

  // --- Services ---
  clinic: D({ label: 'Posto de saúde', cat: 'health', w: [16, 20], d: [16, 22], jobs: [2, 3, 3, 0], cost: 180, maint: 3, buildDays: 1, public: true, service: { type: 'health', radius: 600, capacity: 800 } }),
  hospital: D({ label: 'Hospital', cat: 'health', w: [44, 56], d: [40, 50], floors: [4, 8], jobs: [10, 20, 30, 10], cost: 1600, maint: 16, buildDays: 4, public: true, eraMin: 1, service: { type: 'health', radius: 1500, capacity: 5000 } }),
  daycare: D({ label: 'Creche', cat: 'education', w: [16, 20], d: [16, 20], jobs: [2, 4, 1, 0], cost: 120, maint: 2, buildDays: 0.8, public: true, service: { type: 'education', radius: 500, capacity: 120 } }),
  school: D({ label: 'Escola', cat: 'education', w: [28, 36], d: [28, 36], floors: [1, 2], jobs: [3, 6, 8, 0], cost: 380, maint: 5, buildDays: 1.6, public: true, service: { type: 'education', radius: 800, capacity: 500 } }),
  highSchool: D({ label: 'Escola de ensino médio', cat: 'education', w: [36, 44], d: [32, 40], floors: [2, 3], jobs: [3, 6, 12, 1], cost: 700, maint: 8, buildDays: 2.2, public: true, eraMin: 1, service: { type: 'education', radius: 1200, capacity: 800 } }),
  university: D({ label: 'Universidade', cat: 'education', w: [70, 90], d: [60, 80], floors: [3, 5], jobs: [8, 14, 30, 20], cost: 2600, maint: 24, buildDays: 5, public: true, eraMin: 2, tourism: 0.1, offRoad: true, service: { type: 'education', radius: 2500, capacity: 2500 } }),
  library: D({ label: 'Biblioteca', cat: 'education', w: [20, 26], d: [20, 26], floors: [2, 2], jobs: [1, 4, 2, 0], cost: 260, maint: 3, buildDays: 1.2, public: true, eraMin: 1, service: { type: 'culture', radius: 900, capacity: 900 } }),
  police: D({ label: 'Delegacia', cat: 'police', w: [20, 26], d: [20, 26], floors: [2, 2], jobs: [2, 10, 3, 0], cost: 320, maint: 6, buildDays: 1.2, public: true, service: { type: 'police', radius: 800, capacity: 3000 } }),
  prison: D({ label: 'Presídio', cat: 'police', w: [70, 80], d: [70, 80], floors: [2, 3], jobs: [6, 20, 2, 0], cost: 1800, maint: 14, buildDays: 3, undesir: 1.6, public: true, eraMin: 2, offRoad: true }),
  fire: D({ label: 'Corpo de bombeiros', cat: 'fire', w: [22, 26], d: [22, 28], floors: [2, 2], jobs: [2, 10, 1, 0], cost: 300, maint: 6, buildDays: 1.2, public: true, service: { type: 'fire', radius: 900, capacity: 4000 } }),
  cemetery: D({ label: 'Cemitério', cat: 'deathcare', w: [50, 70], d: [50, 70], jobs: [3, 0, 0, 0], cost: 160, maint: 2, buildDays: 1, undesir: 0.9, public: true, offRoad: true }),
  crematorium: D({ label: 'Crematório', cat: 'deathcare', w: [24, 30], d: [24, 30], jobs: [3, 2, 0, 0], cost: 600, maint: 4, buildDays: 1.6, undesir: 0.8, air: 0.3, public: true, eraMin: 2 }),
  park: D({ label: 'Parque', cat: 'park', w: [40, 70], d: [40, 70], jobs: [2, 0, 0, 0], cost: 160, maint: 2, buildDays: 1, beauty: 1.2, public: true, service: { type: 'parks', radius: 500, capacity: 4000 } }),
  plaza: D({ label: 'Praça', cat: 'park', w: [24, 32], d: [24, 32], cost: 60, maint: 1, buildDays: 0.6, beauty: 0.6, public: true, service: { type: 'parks', radius: 350, capacity: 2000 } }),
  sportsCenter: D({ label: 'Academia / ginásio', cat: 'park', w: [26, 32], d: [26, 34], floors: [1, 2], jobs: [3, 3, 1, 0], cost: 280, maint: 3, buildDays: 1.2, public: true, eraMin: 1, service: { type: 'parks', radius: 700, capacity: 1500 } }),
  church: D({ label: 'Igreja', cat: 'culture', w: [16, 22], d: [24, 30], jobs: [1, 1, 0, 0], cost: 120, maint: 1, buildDays: 1.2, beauty: 0.3, public: true, tourism: 0.05, service: { type: 'culture', radius: 700, capacity: 1500 } }),
  cinema: D({ label: 'Cinema', cat: 'culture', w: [26, 32], d: [30, 36], floors: [2, 2], jobs: [6, 3, 0, 0], cost: 420, maint: 3, buildDays: 1.5, public: true, eraMin: 1, service: { type: 'culture', radius: 1200, capacity: 3000 } }),
  theater: D({ label: 'Teatro', cat: 'culture', w: [28, 36], d: [34, 42], floors: [2, 3], jobs: [4, 6, 3, 0], cost: 900, maint: 6, buildDays: 2.4, public: true, eraMin: 2, tourism: 0.25, beauty: 0.3, service: { type: 'culture', radius: 1800, capacity: 4000 } }),
  museum: D({ label: 'Museu', cat: 'culture', w: [34, 44], d: [30, 40], floors: [2, 3], jobs: [2, 6, 6, 1], cost: 1200, maint: 7, buildDays: 3, public: true, eraMin: 2, tourism: 0.5, beauty: 0.4, service: { type: 'culture', radius: 2000, capacity: 5000 } }),
  mall: D({ label: 'Shopping center', cat: 'com', w: [70, 90], d: [60, 80], floors: [2, 3], jobs: [40, 20, 4, 0], cost: 1400, buildDays: 3, power: 2, noise: 0.5, eraMin: 2, service: { type: 'culture', radius: 1500, capacity: 4000 } }),
  stadium: D({ label: 'Estádio', cat: 'culture', w: [110, 130], d: [90, 110], jobs: [10, 6, 2, 0], cost: 3600, maint: 12, buildDays: 6, noise: 1.2, public: true, eraMin: 2, tourism: 0.4, offRoad: true, service: { type: 'culture', radius: 3000, capacity: 9000 } }),
  postOffice: D({ label: 'Correios', cat: 'misc', w: [18, 22], d: [18, 22], jobs: [3, 4, 1, 0], cost: 160, maint: 2, buildDays: 0.8, public: true, eraMin: 1 }),
  busDepot: D({ label: 'Garagem de ônibus', cat: 'transport', w: [40, 50], d: [30, 40], jobs: [6, 10, 1, 0], cost: 400, maint: 4, buildDays: 1.4, noise: 0.5, undesir: 0.3, public: true }),
  railStation: D({ label: 'Estação ferroviária', cat: 'transport', w: [60, 70], d: [22, 26], floors: [1, 2], jobs: [4, 6, 2, 0], cost: 900, maint: 6, buildDays: 2.5, public: true, tourism: 0.1 }),
  freightTerminal: D({ label: 'Terminal de cargas', cat: 'transport', w: [90, 110], d: [40, 50], jobs: [14, 8, 2, 0], cost: 1100, maint: 6, buildDays: 2.5, noise: 1, undesir: 0.6, public: true }),
  metroStation: D({ label: 'Estação de metrô', cat: 'transport', w: [16, 20], d: [16, 20], jobs: [2, 3, 0, 0], cost: 1200, maint: 6, buildDays: 2.5, public: true, eraMin: 3 }),
  airport: D({ label: 'Aeroporto', cat: 'transport', w: [380, 420], d: [130, 160], jobs: [40, 60, 30, 6], cost: 12000, maint: 50, buildDays: 8, noise: 3, undesir: 1.4, public: true, eraMin: 3, offRoad: true, tourism: 0.3 }),
  port: D({ label: 'Porto de cargas', cat: 'transport', w: [110, 140], d: [60, 80], jobs: [40, 20, 4, 0], cost: 5000, maint: 20, buildDays: 6, noise: 1.5, air: 0.8, waterPol: 0.5, undesir: 1, public: true, eraMin: 2 }),

  // --- Landmarks ---
  landmarkTower: D({ label: 'Torre mirante', cat: 'landmark', w: [26, 30], d: [26, 30], floors: [40, 50], jobs: [4, 6, 2, 0], cost: 6000, maint: 10, buildDays: 7, public: true, eraMin: 2, tourism: 1, beauty: 0.8 }),
  cathedral: D({ label: 'Catedral moderna', cat: 'landmark', w: [44, 52], d: [60, 70], jobs: [2, 2, 0, 0], cost: 4500, maint: 6, buildDays: 7, public: true, eraMin: 2, tourism: 0.9, beauty: 1 }),
  monument: D({ label: 'Monumento', cat: 'landmark', w: [30, 36], d: [30, 36], cost: 1500, maint: 2, buildDays: 2.5, public: true, eraMin: 1, tourism: 0.5, beauty: 1 }),
};

export const ZONED_CATS: Cat[] = ['res', 'com', 'off', 'ind', 'informal'];

export const KIND_ICON: Partial<Record<Cat, string>> = {
  res: '🏠', com: '🛒', off: '🏢', ind: '🏭', informal: '🛖', power: '⚡', water: '💧', sewage: '🚰', garbage: '🗑️',
  health: '🏥', education: '🎓', police: '🚓', fire: '🚒', deathcare: '⚰️', park: '🌳', culture: '🎭',
  transport: '🚉', landmark: '🗼', misc: '📮',
};
