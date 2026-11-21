import { VType, VTYPE_LEN } from './constants';

export type VehicleId =
  | 'sedan'
  | 'hatch'
  | 'suv'
  | 'pickup'
  | 'vintage'
  | 'taxi'
  | 'police'
  | 'hearse'
  | 'van'
  | 'ambulance'
  | 'bus'
  | 'schoolbus'
  | 'tourbus'
  | 'truck'
  | 'garbage'
  | 'construction'
  | 'fire'
  | 'moto';

/**
 * Exact physical lengths (m) guaranteed >= 2 * max(|minX|, |maxX|) of each 3D mesh
 * built by src/render/vehicleGeom.ts, eliminating physics-vs-mesh overhang mismatches.
 */
export const VEHICLE_MESH_LEN: Record<VehicleId, number> = {
  sedan: 4.64,
  hatch: 4.22,
  suv: 4.86,
  pickup: 5.25,
  vintage: 4.76,
  taxi: 4.64,
  police: 5.08,
  hearse: 5.66,
  van: 5.65,
  ambulance: 6.16,
  bus: 12.0,
  schoolbus: 10.05,
  tourbus: 12.0,
  truck: 10.0,
  garbage: 8.4,
  construction: 8.4,
  fire: 9.26,
  moto: 2.2,
};

const MODERN_CAR_POOL: VehicleId[] = [
  'sedan', 'sedan', 'sedan', 'sedan',
  'hatch', 'hatch', 'hatch',
  'suv', 'suv',
  'pickup', 'pickup',
];

const ERA0_CAR_POOL: VehicleId[] = [
  'vintage', 'vintage', 'vintage',
  'vintage', 'vintage', 'vintage',
  'pickup', 'sedan',
];

const DIRECT_VTYPE_ID: Partial<Record<VType, VehicleId>> = {
  [VType.Taxi]: 'taxi',
  [VType.Moto]: 'moto',
  [VType.Bus]: 'bus',
  [VType.SchoolBus]: 'schoolbus',
  [VType.Truck]: 'truck',
  [VType.Van]: 'van',
  [VType.Garbage]: 'garbage',
  [VType.Ambulance]: 'ambulance',
  [VType.Police]: 'police',
  [VType.Fire]: 'fire',
  [VType.TourBus]: 'tourbus',
  [VType.Construction]: 'construction',
  [VType.Hearse]: 'hearse',
};

/** Single deterministic preset picker shared identically by Traffic (sim) and AgentsLayer (render). */
export function pickVehiclePreset(type: VType, slot: number, gen: number, era: number): VehicleId | null {
  if (type === VType.Car) {
    const hash = ((slot * 7 + gen * 13) >>> 0);
    const pool = era === 0 ? ERA0_CAR_POOL : MODERN_CAR_POOL;
    return pool[hash % pool.length];
  }
  return DIRECT_VTYPE_ID[type] ?? null;
}

/** Real physical length for a vehicle slot/generation/era, always >= its rendered 3D mesh extent. */
export function vehiclePhysicalLen(type: VType, slot: number, gen: number, era: number): number {
  const id = pickVehiclePreset(type, slot, gen, era);
  if (!id) return VTYPE_LEN[type] ?? 4.5;
  // If spawned in Era 0 and era later advances to >= 1 while still active, cover both pools' length
  if (type === VType.Car && era === 0) {
    const modernId = pickVehiclePreset(type, slot, gen, 1);
    return Math.max(VEHICLE_MESH_LEN[id], modernId ? VEHICLE_MESH_LEN[modernId] : 0);
  }
  return VEHICLE_MESH_LEN[id];
}
