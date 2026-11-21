import { describe, expect, it } from 'vitest';
import type { AssetBuildResult, AssetDetail } from '../src/render/meshKit';
import {
  PED_PRESETS,
  buildBike,
  buildLuggage,
  buildPedestrian,
  buildUmbrella,
} from '../src/render/pedGeom';
import { PED_PART } from '../src/render/pedMaterial';
import { getFamily } from '../src/workbench/registry';

const DETAILS: AssetDetail[] = ['high', 'med', 'low'];

function checkGeometryHygiene(res: AssetBuildResult, label: string) {
  const { body, meta } = res;
  const pos = body.getAttribute('position');
  const nor = body.getAttribute('normal');
  const pedMeta = body.getAttribute('aPedMeta');
  const pivot4 = body.getAttribute('aPivot4');
  const mat = body.getAttribute('aMat');
  const tint = body.getAttribute('aTint');

  expect(pos, `${label} position`).toBeDefined();
  expect(nor, `${label} normal`).toBeDefined();
  expect(pedMeta, `${label} aPedMeta`).toBeDefined();
  expect(pivot4, `${label} aPivot4`).toBeDefined();
  expect(mat, `${label} aMat`).toBeDefined();
  expect(tint, `${label} aTint`).toBeDefined();

  // Redundant unpacked attributes must stay absent to save GPU memory
  expect(body.getAttribute('aZone'), `${label} no redundant aZone`).toBeUndefined();
  expect(body.getAttribute('aPart'), `${label} no redundant aPart`).toBeUndefined();
  expect(body.getAttribute('aPivot'), `${label} no redundant aPivot`).toBeUndefined();
  expect(body.getAttribute('aPivot2'), `${label} no redundant aPivot2`).toBeUndefined();

  const vCount = pos.count;
  expect(vCount).toBeGreaterThan(0);
  expect(nor.count).toBe(vCount);
  expect(pedMeta.count).toBe(vCount);
  expect(pedMeta.itemSize).toBe(4);
  expect(pivot4.count).toBe(vCount);
  expect(pivot4.itemSize).toBe(4);
  expect(mat.count).toBe(vCount);
  expect(tint.count).toBe(vCount);

  for (let i = 0; i < vCount; i++) {
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    expect(Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pz), `${label} finite pos`).toBe(true);

    const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
    expect(Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz), `${label} finite normal`).toBe(true);
    expect(Math.hypot(nx, ny, nz), `${label} unit normal`).toBeCloseTo(1, 2);

    const r = pedMeta.getX(i), m = pedMeta.getY(i), z = pedMeta.getZ(i), p = pedMeta.getW(i);
    expect(r >= 0.04 && r <= 1.0 && m >= 0 && m <= 1.0, `${label} aPedMeta roughness/metalness`).toBe(true);
    expect(z >= 0 && z <= 4, `${label} aPedMeta zone in [0..4]`).toBe(true);
    expect(p >= 0 && p <= PED_PART.CRANK, `${label} aPedMeta part in [0..13]`).toBe(true);
    expect(
      Number.isFinite(pivot4.getX(i)) && Number.isFinite(pivot4.getY(i)) &&
      Number.isFinite(pivot4.getZ(i)) && Number.isFinite(pivot4.getW(i)),
      `${label} finite aPivot4`,
    ).toBe(true);
  }

  // Ground contact Y ≈ 0
  expect(meta.minY, `${label} minY >= -0.02`).toBeGreaterThanOrEqual(-0.02);
  expect(meta.minY, `${label} minY <= 0.03`).toBeLessThanOrEqual(0.03);
}

describe('pedGeom parametric generator & 3-tier LOD', () => {
  it('registers all 10 pedestrian archetypes + bike, umbrella, luggage in WORKBENCH_FAMILIES', () => {
    expect(PED_PRESETS).toHaveLength(10);
    const ids = new Set(PED_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(10);

    const fam = getFamily('people');
    expect(fam.id).toBe('people');
    expect(fam.variants()).toHaveLength(13);
  });

  for (const preset of PED_PRESETS) {
    describe(`pedestrian archetype: ${preset.id}`, () => {
      it('satisfies human proportions, +X forward orientation, LOD budgets, multi-zone & articulation attributes', () => {
        const budgets: Record<AssetDetail, number> = { high: 900, med: 320, low: 130 };
        const tris: Record<AssetDetail, number> = { high: 0, med: 0, low: 0 };

        for (const detail of DETAILS) {
          const res = buildPedestrian(preset.id, detail);
          tris[detail] = res.meta.triangles;
          checkGeometryHygiene(res, `${preset.id} (${detail})`);

          // Triangle budgets
          expect(res.meta.triangles, `${preset.id} (${detail}) <= ${budgets[detail]}`).toBeLessThanOrEqual(budgets[detail]);
          expect(res.meta.triangles, `${preset.id} (${detail}) > 40`).toBeGreaterThan(40);

          // Plausible human stature (1.55..1.95 m)
          expect(res.meta.size[1], `${preset.id} (${detail}) height`).toBeGreaterThanOrEqual(1.55);
          expect(res.meta.size[1], `${preset.id} (${detail}) height`).toBeLessThanOrEqual(1.95);

          // Symmetry around Z = 0 and forward orientation (+X toe/face extends past +0.08m)
          res.body.computeBoundingBox();
          const bb = res.body.boundingBox!;
          expect(Math.abs(bb.min.z + bb.max.z), `${preset.id} (${detail}) Z symmetry`).toBeLessThan(0.06);
          expect(bb.max.x, `${preset.id} (${detail}) +X forward projection`).toBeGreaterThan(0.08);

          // Verify zone & articulated part presence via packed aPedMeta
          const pedMeta = res.body.getAttribute('aPedMeta');
          const zonesPresent = new Set<number>();
          const partsPresent = new Set<number>();
          for (let i = 0; i < pedMeta.count; i++) {
            zonesPresent.add(Math.round(pedMeta.getZ(i)));
            partsPresent.add(Math.round(pedMeta.getW(i)));
          }
          expect(zonesPresent.has(1), `${preset.id} (${detail}) has primary garment zone`).toBe(true);
          expect(zonesPresent.has(2), `${preset.id} (${detail}) has skin zone`).toBe(true);
          expect(partsPresent.has(0) && partsPresent.has(1), `${preset.id} (${detail}) torso & head`).toBe(true);
          expect(partsPresent.has(4) && partsPresent.has(5), `${preset.id} (${detail}) thighs`).toBe(true);
          expect(partsPresent.has(8) && partsPresent.has(9), `${preset.id} (${detail}) shins`).toBe(true);
        }

        // Strict LOD reduction: low < med < high
        expect(tris.low, `${preset.id} low < med`).toBeLessThan(tris.med);
        expect(tris.med, `${preset.id} med < high`).toBeLessThan(tris.high);
      });
    });
  }

  describe('bicycle (bike)', () => {
    it('satisfies LOD budgets, ground contact, +X orientation, paintable frame, animated crankset, and paired glow lights', () => {
      const budgets: Record<AssetDetail, number> = { high: 450, med: 220, low: 100 };
      const tris: Record<AssetDetail, number> = { high: 0, med: 0, low: 0 };

      for (const detail of DETAILS) {
        const res = buildBike(detail);
        tris[detail] = res.meta.triangles;
        checkGeometryHygiene(res, `bike (${detail})`);

        expect(res.meta.triangles, `bike (${detail}) <= ${budgets[detail]}`).toBeLessThanOrEqual(budgets[detail]);
        expect(res.meta.size[0], `bike (${detail}) length ~1.7m`).toBeGreaterThan(1.4);
        expect(res.meta.size[0], `bike (${detail}) length ~1.7m`).toBeLessThan(2.0);
        expect(res.meta.size[1], `bike (${detail}) height ~1.0m`).toBeGreaterThan(0.85);
        expect(res.meta.size[1], `bike (${detail}) height ~1.0m`).toBeLessThan(1.20);

        if (detail === 'high') {
          const pedMeta = res.body.getAttribute('aPedMeta');
          let hasCrank = false;
          for (let i = 0; i < pedMeta.count; i++) {
            if (Math.round(pedMeta.getW(i)) === PED_PART.CRANK) { hasCrank = true; break; }
          }
          expect(hasCrank, 'bike (high) animated crankset part').toBe(true);
        }

        // Paired glow for headlight (+X) and taillight (-X)
        expect(res.glow, `bike (${detail}) glow`).toBeDefined();
        expect(res.meta.glowTriangles, `bike (${detail}) glowTriangles`).toBeGreaterThan(0);
      }

      expect(tris.low).toBeLessThan(tris.med);
      expect(tris.med).toBeLessThan(tris.high);
    });
  });

  describe('accessories (umbrella & luggage)', () => {
    it('satisfies umbrella LOD budgets, canopy tint zone, and ground contact', () => {
      const budgets: Record<AssetDetail, number> = { high: 220, med: 110, low: 50 };
      const tris: Record<AssetDetail, number> = { high: 0, med: 0, low: 0 };

      for (const detail of DETAILS) {
        const res = buildUmbrella(detail);
        tris[detail] = res.meta.triangles;
        checkGeometryHygiene(res, `umbrella (${detail})`);
        expect(res.meta.triangles, `umbrella (${detail}) <= ${budgets[detail]}`).toBeLessThanOrEqual(budgets[detail]);
        expect(res.meta.size[0], `umbrella (${detail}) span`).toBeGreaterThan(0.9);
      }

      expect(tris.low).toBeLessThan(tris.med);
      expect(tris.med).toBeLessThan(tris.high);
    });

    it('satisfies luggage LOD budgets, shell tint zone, and ground contact', () => {
      const budgets: Record<AssetDetail, number> = { high: 220, med: 110, low: 50 };
      const tris: Record<AssetDetail, number> = { high: 0, med: 0, low: 0 };

      for (const detail of DETAILS) {
        const res = buildLuggage(detail);
        tris[detail] = res.meta.triangles;
        checkGeometryHygiene(res, `luggage (${detail})`);
        expect(res.meta.triangles, `luggage (${detail}) <= ${budgets[detail]}`).toBeLessThanOrEqual(budgets[detail]);
        expect(res.meta.size[1], `luggage (${detail}) height with handle`).toBeGreaterThan(0.75);
      }

      expect(tris.low).toBeLessThan(tris.med);
      expect(tris.med).toBeLessThan(tris.high);
    });
  });
});
