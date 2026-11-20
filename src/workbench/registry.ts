import { MeshBuilder, SURF, finalizeAsset, type AssetDetail } from '../render/meshKit';
import type { WorkbenchFamily } from './types';

/** Built-in calibration/self-test family verifying meshKit primitives, aTint, aMat, and glow alignment. */
const kitFamily: WorkbenchFamily = {
  id: 'kit',
  title: 'Kit Base (Calibração)',
  description: 'Peça de calibração verificando loft, chanfro, rodas, aTint (lataria vs vidro/pneu/metal) e emissivos.',
  triangleBudget: 400,
  variants: () => [
    {
      id: 'calibration-pod',
      label: 'Protótipo de Calibração (Loft + Rodas + Glow)',
      category: 'calibration',
      defaultColor: 0xc93b32,
      swatches: [0xc93b32, 0x2a66b0, 0x2f8f5b, 0xf2c230],
      build: (_detail?: AssetDetail) => {
        const b = new MeshBuilder();
        const g = new MeshBuilder();
        const W = 0xffffff;
        const ring = (x: number, y0: number, y1: number, w0: number, w1: number): [number, number, number][] => [
          [x, y0, w0], [x, y0, -w0], [x, y1, -w1], [x, y1, w1],
        ];
        b.loft([
          ring(-2.0, 0.34, 0.92, 0.80, 0.72),
          ring(-1.1, 0.30, 1.05, 0.88, 0.82),
          ring(1.2, 0.30, 0.96, 0.88, 0.80),
          ring(2.1, 0.36, 0.72, 0.76, 0.64),
        ], W, SURF.paint);
        b.taperBox(-0.15, 0.96, 0, 2.0, 1.50, 1.25, 1.22, 0.50, 0x3b5972, SURF.glass, { oxTop: -0.1, topColor: W, topSurf: SURF.paint });
        for (const x of [-1.25, 1.25]) for (const z of [-0.82, 0.82]) b.wheel(x, 0.36, z, 0.36, 0.24, 8);
        g.box(2.11, 0.56, 0.52, 0.05, 0.14, 0.28, 0xfff2cc, SURF.matte);
        g.box(2.11, 0.56, -0.52, 0.05, 0.14, 0.28, 0xfff2cc, SURF.matte);
        g.box(-2.01, 0.64, 0.54, 0.05, 0.12, 0.26, 0xff2626, SURF.matte);
        g.box(-2.01, 0.64, -0.54, 0.05, 0.12, 0.26, 0xff2626, SURF.matte);
        return finalizeAsset('calibration-pod', 'Protótipo de Calibração', 'kit', b, g);
      },
    },
  ],
};

/** Central registry of all 3D asset families available in the Workbench. */
export const WORKBENCH_FAMILIES: WorkbenchFamily[] = [
  kitFamily,
];

export function getFamily(id?: string | null): WorkbenchFamily {
  if (id) {
    const found = WORKBENCH_FAMILIES.find((f) => f.id === id);
    if (found) return found;
  }
  return WORKBENCH_FAMILIES[0];
}
