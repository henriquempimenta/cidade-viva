// Time model: agents move in "motion seconds" (real m/s). The calendar is compressed:
// one game day lasts DAY_SECONDS motion seconds (40 min at 1x, 24 s at 100x).
export const MOTION_DT = 0.5;
export const DAY_SECONDS = 2400;
export const HOUR_SECONDS = DAY_SECONDS / 24;
export const DAYS_PER_SEASON = 3;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * 4;
export const SEASONS = ['Primavera', 'Verão', 'Outono', 'Inverno'] as const;

export const MAX_VEHICLES = 1024; // initial storage only — grows on demand
export const MAX_PEDS = 2048; // initial storage only — grows on demand
export const MAX_CITIZENS = 4096; // initial storage only — grows on demand
export const MAX_TRAIN_CARS = 400;

export const FIELD_CELL = 25; // meters per heatmap cell
export const OCC_CELL = 4; // meters per occupancy cell

export const VEH_STRIDE = 9; // x,y,z,heading,type,gen,flags,line,citizen
export const PED_STRIDE = 7; // x,y,z,heading,gen,flags,citizen
export const TRAIN_STRIDE = 7; // x,y,z,heading,type,trainId,pitch

export enum VType {
  None = 0, Car, Taxi, Moto, Bus, SchoolBus, Truck, Van, Garbage, Ambulance, Police, Fire, TourBus, Construction, Hearse, Bike, Tow,
}
export const VTYPE_COUNT = 17;
export const VTYPE_LEN: Record<number, number> = {
  [VType.Car]: 4.4, [VType.Taxi]: 4.4, [VType.Moto]: 2.2, [VType.Bus]: 12, [VType.SchoolBus]: 10,
  [VType.Truck]: 10, [VType.Van]: 5.5, [VType.Garbage]: 8, [VType.Ambulance]: 6, [VType.Police]: 4.8,
  [VType.Fire]: 9, [VType.TourBus]: 12, [VType.Construction]: 8, [VType.Hearse]: 5.5, [VType.Bike]: 1.8, [VType.Tow]: 8.4,
};
export const VEH_FLAG_SIREN = 1, VEH_FLAG_YIELD = 2, VEH_FLAG_BRAKE = 4, VEH_FLAG_FULL = 8, VEH_FLAG_ELEVATED = 16, VEH_FLAG_HAZARD = 32;

export const PED_FLAG_TOURIST = 1, PED_FLAG_UMBRELLA = 2, PED_FLAG_LUGGAGE = 4, PED_FLAG_WORKER = 8, PED_FLAG_FOLLOW = 16, PED_FLAG_PHOTO = 32, PED_FLAG_FUNERAL = 64, PED_FLAG_WAITING = 128, PED_FLAG_FEMALE = 512, PED_FLAG_CHILD = 1024, PED_FLAG_ELDER = 2048;

export enum RoadClass { Dirt = 0, Local = 1, Collector = 2, Avenue = 3, Highway = 4 }
export const ROAD_NAMES = ['Estrada de terra', 'Rua local', 'Rua coletora', 'Avenida', 'Via expressa'];
export const ROAD_HALF_WIDTH = [3.2, 4, 5.5, 9, 10]; // half carriageway incl. median
/** posted speed limit per class (km/h) and the same in m/s */
export const ROAD_LIMIT_KMH = [30, 40, 50, 60, 90];
export const ROAD_SPEED = ROAD_LIMIT_KMH.map((k) => k / 3.6); // m/s
/** top speed each kind of vehicle may drive at regardless of the posted limit (m/s) */
export const MODE_CAP: Partial<Record<number, number>> = { [VType.Truck]: 80 / 3.6, [VType.Garbage]: 60 / 3.6, [VType.Construction]: 60 / 3.6, [VType.Tow]: 75 / 3.6, [VType.Bus]: 70 / 3.6, [VType.SchoolBus]: 60 / 3.6, [VType.TourBus]: 80 / 3.6 };
/** with siren: emergency vehicles may exceed the posted limit by this much (m/s), up to EMERGENCY_CAP */
export const EMERGENCY_EXCESS = 20 / 3.6, EMERGENCY_CAP = 100 / 3.6;
export const ROAD_LANES = [1, 1, 1, 2, 2]; // lanes per direction
export const LANE_WIDTH = 3.2;
export const LOT_SETBACK = 11; // lots start this far from centerline => avenues can widen in place

export const ERAS = ['Vila', 'Cidade pequena', 'Cidade média', 'Metrópole'] as const;
export const ERA_POP = [0, 600, 2600, 7000];
