import { describe, expect, it } from 'vitest';
import type { AssetDetail } from '../src/render/meshKit';
import {
  RAIL_CAR_IDS,
  RAIL_GAUGE_HALF,
  RAIL_PRESETS,
  RAIL_SLOT_LEN,
  buildRailCar,
} from '../src/render/railGeom';
import { getFamily, WORKBENCH_FAMILIES } from '../src/workbench/registry';

const DETAILS: AssetDetail[] = ['high', 'med', 'low'];
const BUDGETS: Record<AssetDetail, number> = {
  high: 950,
  med: 450,
  low: 200,
};

describe('railGeom parametric rolling stock & metro generator', () => {
  it('registers all 6 rail car presets in exact 0..5 sim order and in WORKBENCH_FAMILIES', () => {
    expect(RAIL_PRESETS).toHaveLength(6);
    expect(RAIL_CAR_IDS).toEqual(['loco', 'passenger', 'container', 'hopper', 'tank', 'metro']);
    expect(RAIL_GAUGE_HALF).toBe(0.75);

    for (let idx = 0; idx < RAIL_PRESETS.length; idx++) {
      expect(RAIL_PRESETS[idx].index).toBe(idx);
      expect(RAIL_PRESETS[idx].maxSlotLen).toBe(RAIL_SLOT_LEN[idx]);
      // Numeric index lookup must match string ID lookup
      const byIdx = buildRailCar(idx, 'high');
      const byId = buildRailCar(RAIL_PRESETS[idx].id, 'high');
      expect(byIdx.meta.triangles).toBe(byId.meta.triangles);
      expect(byIdx.meta.id).toBe(RAIL_PRESETS[idx].id);
    }

    expect(WORKBENCH_FAMILIES.some((f) => f.id === 'rail')).toBe(true);
    const fam = getFamily('rail');
    expect(fam.id).toBe('rail');
    expect(fam.variants()).toHaveLength(6);
    expect(fam.heroVariants).toHaveLength(6);
    expect(fam.lodCompareVariants).toHaveLength(6);
  });

  for (const preset of RAIL_PRESETS) {
    describe(`preset [${preset.index}]: ${preset.id}`, () => {
      it('satisfies rail gauge contact, slot length clearance, proportions, strict LOD budgets, hygiene, aTint, and glow', () => {
        const triCounts: Record<AssetDetail, number> = { high: 0, med: 0, low: 0 };

        for (const detail of DETAILS) {
          const res = buildRailCar(preset.id, detail);
          const { meta, body, glow } = res;
          triCounts[detail] = meta.triangles;

          // Triangle budgets
          expect(meta.triangles, `${preset.id} (${detail}) > 50 tris`).toBeGreaterThan(50);
          expect(
            meta.triangles,
            `${preset.id} (${detail}) ${meta.triangles} <= ${BUDGETS[detail]}`,
          ).toBeLessThanOrEqual(BUDGETS[detail]);

          // Exact railhead contact at Y = 0
          expect(meta.minY, `${preset.id} (${detail}) minY >= -0.02`).toBeGreaterThanOrEqual(-0.02);
          expect(meta.minY, `${preset.id} (${detail}) minY <= 0.03`).toBeLessThanOrEqual(0.03);

          // Length strictly <= CAR_LEN[idx] - 0.30 (zero inter-car overlap in consists)
          const maxAllowedLen = RAIL_SLOT_LEN[preset.index] - 0.30;
          expect(meta.size[0], `${preset.id} (${detail}) length ${meta.size[0]} <= ${maxAllowedLen}`).toBeLessThanOrEqual(maxAllowedLen);
          expect(meta.size[0], `${preset.id} (${detail}) length > ${RAIL_SLOT_LEN[preset.index] - 1.6}`).toBeGreaterThan(RAIL_SLOT_LEN[preset.index] - 1.6);

          // Plausible railway gauge envelope: height 3.4..5.2 m, width 2.6..3.3 m
          expect(meta.size[1], `${preset.id} (${detail}) height`).toBeGreaterThanOrEqual(3.4);
          expect(meta.size[1], `${preset.id} (${detail}) height`).toBeLessThanOrEqual(5.2);
          expect(meta.size[2], `${preset.id} (${detail}) width`).toBeGreaterThanOrEqual(2.6);
          expect(meta.size[2], `${preset.id} (${detail}) width`).toBeLessThanOrEqual(3.3);

          // Symmetry around Z = 0
          body.computeBoundingBox();
          const bb = body.boundingBox!;
          expect(Math.abs(bb.min.z + bb.max.z), `${preset.id} (${detail}) Z symmetry`).toBeLessThan(0.08);

          // Finite positions & unit normals (zero NaN/Infinity)
          const pos = body.getAttribute('position');
          const nor = body.getAttribute('normal');
          const tint = body.getAttribute('aTint');
          const mat = body.getAttribute('aMat');
          expect(nor.count).toBe(pos.count);
          expect(tint.count).toBe(pos.count);
          expect(mat.count).toBe(pos.count);

          let paintedVerts = 0;
          let fixedVerts = 0;
          let gaugeContactVerts = 0;

          for (let i = 0; i < pos.count; i++) {
            const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
            expect(Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pz), `${preset.id} (${detail}) finite pos`).toBe(true);

            const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
            expect(Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz), `${preset.id} (${detail}) finite nor`).toBe(true);
            expect(Math.hypot(nx, ny, nz), `${preset.id} (${detail}) unit normal`).toBeCloseTo(1, 2);

            if (tint.getX(i) > 0.5) paintedVerts++;
            else fixedVerts++;

            // Verify wheels actually touch railheads near z = ±0.75 m
            if (py < 0.05 && Math.abs(Math.abs(pz) - RAIL_GAUGE_HALF) <= 0.12) {
              gaugeContactVerts++;
            }
          }

          expect(paintedVerts, `${preset.id} (${detail}) paintable aTint=1 verts`).toBeGreaterThan(0);
          expect(fixedVerts, `${preset.id} (${detail}) fixed aTint=0 verts`).toBeGreaterThan(0);
          expect(gaugeContactVerts, `${preset.id} (${detail}) rail wheel gauge contact verts near ±0.75 m`).toBeGreaterThan(0);

          // Illuminated presets (`loco`, `passenger`, `metro`) must have valid finite glow meshes
          if (preset.hasGlow) {
            expect(glow, `${preset.id} (${detail}) glow mesh`).toBeDefined();
            expect(meta.glowTriangles, `${preset.id} (${detail}) glowTriangles > 0`).toBeGreaterThan(0);
            const gPos = glow!.getAttribute('position');
            for (let i = 0; i < gPos.count; i++) {
              expect(
                Number.isFinite(gPos.getX(i)) && Number.isFinite(gPos.getY(i)) && Number.isFinite(gPos.getZ(i)),
                `${preset.id} (${detail}) finite glow pos`,
              ).toBe(true);
            }
          } else {
            expect(glow, `${preset.id} (${detail}) no freight glow`).toBeUndefined();
          }
        }

        // Strict LOD reduction: low < med < high
        expect(triCounts.low, `${preset.id} low (${triCounts.low}) < med (${triCounts.med})`).toBeLessThan(triCounts.med);
        expect(triCounts.med, `${preset.id} med (${triCounts.med}) < high (${triCounts.high})`).toBeLessThan(triCounts.high);
      });
    });
  }
});
