import { describe, expect, it } from 'vitest';
import type { AssetDetail } from '../src/render/meshKit';
import {
  VEHICLE_PRESETS,
  VTYPE_DEFAULT_PRESETS,
  buildVehicle,
  type VehicleId,
} from '../src/render/vehicleGeom';
import { VTYPE_LEN, VType } from '../src/shared/constants';
import { VEHICLE_MESH_LEN } from '../src/shared/vehiclePresets';
import { getFamily } from '../src/workbench/registry';

const HEAVY_IDS = new Set<VehicleId>([
  'bus',
  'schoolbus',
  'tourbus',
  'truck',
  'garbage',
  'construction',
  'fire',
  'tow',
]);

const DETAILS: AssetDetail[] = ['high', 'med', 'low'];

describe('vehicleGeom parametric generator', () => {
  it('registers all 19 vehicle presets and maps every motorized VType (including Tow)', () => {
    expect(VEHICLE_PRESETS).toHaveLength(19);
    const ids = new Set(VEHICLE_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(19);

    const family = getFamily('vehicles');
    expect(family.id).toBe('vehicles');
    expect(family.variants()).toHaveLength(19);

    const motorized: VType[] = [
      VType.Car, VType.Taxi, VType.Moto, VType.Bus, VType.SchoolBus,
      VType.Truck, VType.Van, VType.Garbage, VType.Ambulance, VType.Police,
      VType.Fire, VType.TourBus, VType.Construction, VType.Hearse, VType.Tow,
    ];
    for (const vt of motorized) {
      const list = VTYPE_DEFAULT_PRESETS[vt];
      expect(list && list.length).toBeGreaterThan(0);
    }
    const towBuilt = buildVehicle('tow', 'high');
    towBuilt.body.computeBoundingBox();
    const tbb = towBuilt.body.boundingBox!;
    const towExtent = 2 * Math.max(Math.abs(tbb.min.x), Math.abs(tbb.max.x));
    expect(VEHICLE_MESH_LEN.tow).toBeGreaterThanOrEqual(towExtent - 0.001);
  });

  for (const preset of VEHICLE_PRESETS) {
    describe(`preset: ${preset.id}`, () => {
      it('satisfies triangle budget, LOD reduction, ground contact, dimensions, normals, aTint, and glow', () => {
        const maxBudget = preset.id === 'moto' ? 460 : HEAVY_IDS.has(preset.id) ? 620 : 480;
        const triCounts: Record<AssetDetail, number> = { high: 0, med: 0, low: 0 };

        for (const detail of DETAILS) {
          const res = buildVehicle(preset.id, detail);
          const { meta, body, glow } = res;
          triCounts[detail] = meta.triangles;

          // Triangle budget
          expect(meta.triangles, `${preset.id} (${detail}) triangles`).toBeGreaterThan(100);
          expect(meta.triangles, `${preset.id} (${detail}) triangles <= ${maxBudget}`).toBeLessThanOrEqual(maxBudget);

          // Ground contact at Y = 0
          expect(meta.minY, `${preset.id} (${detail}) minY`).toBeGreaterThanOrEqual(-0.01);
          expect(meta.minY, `${preset.id} (${detail}) minY`).toBeLessThanOrEqual(0.01);

          // Length coherent with VTYPE_LEN (allow compact hatch/pickup variation around Car 4.4m)
          const refLen = VTYPE_LEN[preset.vtype];
          const tol = preset.vtype === VType.Car ? 0.85 : 0.70;
          expect(Math.abs(meta.size[0] - refLen), `${preset.id} length ${meta.size[0]} vs ${refLen}`).toBeLessThanOrEqual(tol);

          // Symmetry around Z = 0
          body.computeBoundingBox();
          const bb = body.boundingBox!;
          expect(Math.abs(bb.min.z + bb.max.z), `${preset.id} Z symmetry`).toBeLessThan(0.08);

          // Finite unit normals
          const nor = body.getAttribute('normal');
          expect(nor.count).toBe(body.getAttribute('position').count);
          for (let i = 0; i < nor.count; i++) {
            const nx = nor.getX(i);
            const ny = nor.getY(i);
            const nz = nor.getZ(i);
            expect(Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz)).toBe(true);
            const len = Math.hypot(nx, ny, nz);
            expect(len).toBeCloseTo(1, 2);
          }

          // Both paintable (aTint=1) and fixed (aTint=0) vertices present
          const tint = body.getAttribute('aTint');
          let painted = 0;
          let fixed = 0;
          for (let i = 0; i < tint.count; i++) {
            if (tint.getX(i) > 0.5) painted++;
            else fixed++;
          }
          expect(painted, `${preset.id} (${detail}) painted verts`).toBeGreaterThan(0);
          expect(fixed, `${preset.id} (${detail}) fixed verts`).toBeGreaterThan(0);

          // Glow geometry present with finite vertices
          expect(glow, `${preset.id} (${detail}) glow geometry`).toBeDefined();
          expect(meta.glowTriangles).toBeGreaterThan(0);
        }

        // LOD monotonicity and meaningful low-detail reduction
        expect(triCounts.low).toBeLessThanOrEqual(triCounts.med);
        expect(triCounts.med).toBeLessThanOrEqual(triCounts.high);
        expect(triCounts.low, `${preset.id} low LOD reduction`).toBeLessThanOrEqual(Math.round(triCounts.high * 0.72));
        if (preset.id === 'moto') {
          expect(triCounts.low, 'moto low LOD < 260 tris').toBeLessThan(260);
        }
      });
    });
  }
});
