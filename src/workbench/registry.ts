import { MeshBuilder, SURF, finalizeAsset, type AssetDetail } from '../render/meshKit';
import { VEHICLE_PRESETS, buildVehicle } from '../render/vehicleGeom';
import { RAIL_PRESETS, buildRailCar } from '../render/railGeom';
import {
  BIKE_COLORS,
  LUGGAGE_COLORS,
  PED_PRESETS,
  UMBRELLA_COLORS,
  buildBike,
  buildLuggage,
  buildPedestrian,
  buildUmbrella,
} from '../render/pedGeom';
import type { WorkbenchFamily, WorkbenchVariant } from './types';

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

/** Parametric Vehicles family (Pilot 1): 19 variants generated from vehicleGeom.ts. */
const vehiclesFamily: WorkbenchFamily = {
  id: 'vehicles',
  title: 'Veículos Paramétricos',
  description: 'Catálogo completo de 19 veículos (civis, serviços, emergência, guincho, ônibus, caminhões pesados e moto) gerados por vehicleGeom.ts.',
  triangleBudget: 620,
  heroVariants: ['sedan', 'hatch', 'suv', 'pickup', 'vintage', 'police', 'ambulance', 'bus', 'garbage', 'fire', 'tow', 'moto'],
  variants: () => VEHICLE_PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    category: p.category,
    defaultColor: p.defaultColor,
    swatches: p.swatches,
    build: (detail?: AssetDetail) => buildVehicle(p.id, detail),
  })),
};

/** Parametric People, Cyclists & Accessories family with 3-tier real-time LOD & GPU skeletal pose animation. */
const peopleFamily: WorkbenchFamily = {
  id: 'people',
  title: 'Pessoas, Ciclistas & Acessórios (LOD)',
  description: '10 arquétipos humanos paramétricos (cânone 7,5 cabeças, penteados, guarda-roupa, animação GPU Mesh2Motion) + bicicleta, guarda-chuva e mala em 3 níveis de LOD.',
  triangleBudget: 900,
  heroVariants: ['male-casual', 'female-dress', 'worker', 'tourist', 'cyclist', 'bike', 'umbrella', 'luggage'],
  lodCompareVariants: ['male-casual', 'female-dress', 'worker', 'cyclist', 'bike', 'umbrella'],
  lodHint: 'Distâncias na cidade: HIGH < 42m | MED 42–115m | LOW > 115m',
  variants: (): WorkbenchVariant[] => [
    ...PED_PRESETS.map((p): WorkbenchVariant => ({
      id: p.id,
      label: p.label,
      category: p.category,
      defaultColor: p.defaultTop,
      swatches: p.swatches,
      build: (detail?: AssetDetail) => buildPedestrian(p.id, detail),
      pedShowcase: {
        skinColor: p.defaultSkin,
        hairColor: p.defaultHair,
        bottomColor: p.defaultBottom,
        // Cyclist posed seated on bike; pedestrians shown in crisp mid-stride walk pose
        anim: p.id === 'cyclist' ? [0.55, 1.0, 2.0, 0.0] : [0.95, 0.85, 1.0, 0.0],
        companion: p.id === 'cyclist'
          ? { build: (detail?: AssetDetail) => buildBike(detail), color: BIKE_COLORS[0] }
          : undefined,
      },
    })),
    {
      id: 'bike',
      label: 'Bicicleta Urbana',
      category: 'accessory',
      defaultColor: BIKE_COLORS[0],
      swatches: [BIKE_COLORS[0], BIKE_COLORS[1], BIKE_COLORS[2], BIKE_COLORS[4]],
      build: (detail?: AssetDetail) => buildBike(detail),
      pedShowcase: {
        skinColor: 0xe2b18f,
        hairColor: 0x31231a,
        bottomColor: 0x2c3d59,
        anim: [0, 0, 0, 0],
      },
    },
    {
      id: 'umbrella',
      label: 'Guarda-Chuva',
      category: 'accessory',
      defaultColor: UMBRELLA_COLORS[0],
      swatches: [UMBRELLA_COLORS[0], UMBRELLA_COLORS[1], UMBRELLA_COLORS[3], UMBRELLA_COLORS[4]],
      build: (detail?: AssetDetail) => buildUmbrella(detail),
      pedShowcase: {
        skinColor: 0xe2b18f,
        hairColor: 0x31231a,
        bottomColor: 0x2c3d59,
        anim: [0, 0, 0, 0],
      },
    },
    {
      id: 'luggage',
      label: 'Mala de Rodinhas',
      category: 'accessory',
      defaultColor: LUGGAGE_COLORS[0],
      swatches: [LUGGAGE_COLORS[0], LUGGAGE_COLORS[1], LUGGAGE_COLORS[3], LUGGAGE_COLORS[4]],
      build: (detail?: AssetDetail) => buildLuggage(detail),
      pedShowcase: {
        skinColor: 0xe2b18f,
        hairColor: 0x31231a,
        bottomColor: 0x2c3d59,
        anim: [0, 0, 0, 0],
      },
    },
  ],
};

/** Parametric Railway Rolling Stock & Metro family (Frente 2): 6 car types with 3-tier real-time LOD. */
const railFamily: WorkbenchFamily = {
  id: 'rail',
  title: 'Material Rodante Ferroviário & Metrô (LOD)',
  description: '6 tipos de carros paramétricos (locomotiva, passageiros, porta-contêineres, hopper, tanque cilíndrico e metrô com pantógrafo) em bitola exata ±0,75 m e 3 níveis de LOD.',
  triangleBudget: 950,
  heroVariants: ['loco', 'passenger', 'container', 'hopper', 'tank', 'metro'],
  lodCompareVariants: ['loco', 'passenger', 'container', 'hopper', 'tank', 'metro'],
  lodHint: 'Distâncias na cidade: HIGH < 90m | MED 90–220m | LOW > 220m',
  variants: () => RAIL_PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    category: p.category,
    defaultColor: p.defaultColor,
    swatches: p.swatches,
    build: (detail?: AssetDetail) => buildRailCar(p.id, detail),
  })),
};

/** Central registry of all 3D asset families available in the Workbench. */
export const WORKBENCH_FAMILIES: WorkbenchFamily[] = [
  kitFamily,
  vehiclesFamily,
  peopleFamily,
  railFamily,
];

export function getFamily(id?: string | null): WorkbenchFamily {
  if (id) {
    const found = WORKBENCH_FAMILIES.find((f) => f.id === id);
    if (found) return found;
  }
  return WORKBENCH_FAMILIES[0];
}
