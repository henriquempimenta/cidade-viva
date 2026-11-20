import { describe, expect, it } from 'vitest';
import { MeshBuilder, SURF, finalizeAsset } from '../src/render/meshKit';

describe('meshKit parametric sculpting primitives', () => {
  it('builds outward-wound loft geometry with aTint and aMat attributes', () => {
    const b = new MeshBuilder();
    const ring = (x: number, y0: number, y1: number, hw: number): [number, number, number][] => [
      [x, y0, hw], [x, y0, -hw], [x, y1, -hw], [x, y1, hw],
    ];
    b.loft([ring(-1, 0, 1, 0.5), ring(1, 0, 1, 0.5)], 0xffffff, SURF.paint);
    const out = finalizeAsset('test-loft', 'Test Loft', 'test', b);
    expect(out.meta.triangles).toBe(16); // 4 side quads (8 tris) + 2 end caps (8 tris)
    expect(out.meta.minY).toBeCloseTo(0, 3);
    expect(out.meta.size).toEqual([2, 1, 1]);
    expect(out.body.getAttribute('aTint').count).toBe(b.vertexCount);
    expect(out.body.getAttribute('aMat').itemSize).toBe(2);

    // Every normal must point outward relative to box center (0, 0.5, 0)
    const pos = out.body.getAttribute('position');
    const nor = out.body.getAttribute('normal');
    for (let i = 0; i < pos.count; i += 3) {
      const mx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
      const my = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3 - 0.5;
      const mz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
      const dot = nor.getX(i) * mx + nor.getY(i) * my + nor.getZ(i) * mz;
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('keeps fixed-color surfaces untinted while painting SURF.paint', () => {
    const b = new MeshBuilder();
    b.box(0, 0, 0, 2, 1, 1, 0xffffff, SURF.paint);
    b.wheel(0, 0.4, 0.6, 0.4, 0.2, 8);
    const g = b.toGeometry();
    const tint = g.getAttribute('aTint');
    let painted = 0, fixed = 0;
    for (let i = 0; i < tint.count; i++) {
      if (tint.getX(i) > 0.5) painted++;
      else fixed++;
    }
    expect(painted).toBeGreaterThan(0);
    expect(fixed).toBeGreaterThan(0);
  });

  it('supports hierarchical transforms and strut/bevelBox primitives with finite normals', () => {
    const b = new MeshBuilder();
    b.pushTransform(1, 0.2, 0, Math.PI / 2);
    b.bevelBox(0, 0, 0, 2, 1, 1, 0.15, 0xaaaaaa, SURF.metal);
    b.strut([-0.5, 1, -0.4], [0.5, 1.8, 0.4], 0.08, 0.08, 0x222222, SURF.rubber);
    b.popTransform();
    const g = b.toGeometry();
    const nor = g.getAttribute('normal');
    for (let i = 0; i < nor.count; i++) {
      const len = Math.hypot(nor.getX(i), nor.getY(i), nor.getZ(i));
      expect(len).toBeCloseTo(1, 3);
    }
  });
});
