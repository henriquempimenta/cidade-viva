import * as THREE from 'three';
import {
  MeshBuilder,
  SURF,
  finalizeAsset,
  type AssetBuildResult,
  type AssetDetail,
  type SurfMat,
  type Vec3,
} from './meshKit';
import { PED_PART, PED_ZONE } from './pedMaterial';

export type PedId =
  | 'male-casual'
  | 'female-dress'
  | 'male-jacket'
  | 'female-casual'
  | 'robust-casual'
  | 'slender-sport'
  | 'worker'
  | 'funeral'
  | 'tourist'
  | 'cyclist';

export type PeopleAssetId = PedId | 'bike' | 'umbrella' | 'luggage';

export type HairStyle = 'short' | 'bob' | 'bun' | 'ponytail' | 'curls' | 'waves' | 'none';
export type HeadgearKind = 'none' | 'hardhat' | 'bike-helmet' | 'cap';
export type TopStyle = 'tshirt' | 'shirt' | 'jacket' | 'dress' | 'sport-jersey' | 'hi-vis-vest' | 'suit';
export type BottomStyle = 'pants' | 'shorts' | 'dress-hem';

export interface PedSpec {
  id: PedId;
  label: string;
  category: 'civilian' | 'service' | 'sport';
  /** Stature in meters (real adult 1.64..1.84m). */
  height: number;
  /** Loomis canon head units (typically 7.3..7.8). */
  headUnits: number;
  /** 0 = masculine frame, 1 = feminine frame. */
  sex: number;
  shoulderScale: number;
  waistScale: number;
  hipScale: number;
  chestDepth: number;
  limbThickness: number;
  hairStyle: HairStyle;
  headgear: HeadgearKind;
  topStyle: TopStyle;
  bottomStyle: BottomStyle;
  sleeveLength: 'short' | 'long';
  backpack?: boolean;
  /** Representative showcase colors (Workbench & fallback). */
  defaultTop: number;
  defaultBottom: number;
  defaultSkin: number;
  defaultHair: number;
  shoeColor: number;
  swatches: number[];
}

/** Realistic human & urban clothing palettes (no artificial neons). */
export const PED_SKIN_PALETTE = [
  0xf0c7ab, 0xe2b18f, 0xd49b76, 0xbf835e, 0xa16949, 0x7e4d34, 0x593624,
] as const;

export const PED_HAIR_PALETTE = [
  0x1c1715, 0x31231a, 0x4f3624, 0x785537, 0xb58c52, 0x8a3d24, 0x9aa0a6,
] as const;

export const PED_TOP_PALETTE = [
  0x2c5282, 0x8f3434, 0x3b6e52, 0xd9d2c5, 0x454d59, 0xb86b35,
  0x2f6d73, 0xa84c65, 0xc79938, 0x5b6b43, 0x62738c, 0x7d5c45,
  0x3f4c7a, 0x9e7b56,
] as const;

export const PED_BOTTOM_PALETTE = [
  0x2c3d59, 0x2a2d33, 0x9e8c70, 0x243044, 0x473d36, 0x4f565e, 0x444f3d, 0x1e2024,
] as const;

export const BIKE_COLORS = [
  0xb8322c, 0x2b5f9e, 0x2f6b4a, 0x2f343c, 0xd99b2a, 0xdfe4e8, 0x2a7a78, 0xc45c2b,
] as const;

export const UMBRELLA_COLORS = [
  0x24426b, 0x8f2832, 0x2e343d, 0x2a6648, 0xc78f24, 0x2b6e78, 0xa6332e, 0x4a5d82, 0x63386b,
] as const;

export const LUGGAGE_COLORS = [
  0x253e63, 0x7d2934, 0x3a404a, 0x2c686e, 0xa68e6d, 0x325943, 0x994c32,
] as const;

/** Shared right-hand umbrella attachment transform (matches shader `umbLift = 1` grip position). */
export const UMBRELLA_HAND_GRIP = {
  offset: [0.40, 1.22, 0.17] as Vec3,
  dir: [-0.34, 1.0, -0.17] as Vec3,
  gripY: 0.12,
};

/** Surface definitions tailored for human materials (skin, cloth, hair, leather, helmet). */
const PED_SURF = {
  clothTop:   { tint: 1, roughness: 0.86, metalness: 0.02 } as SurfMat,
  clothFix:   { tint: 0, roughness: 0.86, metalness: 0.02 } as SurfMat,
  skin:       { tint: 0, roughness: 0.66, metalness: 0.02 } as SurfMat,
  hair:       { tint: 0, roughness: 0.74, metalness: 0.04 } as SurfMat,
  shoe:       { tint: 0, roughness: 0.72, metalness: 0.05 } as SurfMat,
  helmet:     { tint: 0, roughness: 0.30, metalness: 0.15 } as SurfMat,
  reflective: { tint: 0, roughness: 0.22, metalness: 0.45 } as SurfMat,
  canopy:     { tint: 1, roughness: 0.62, metalness: 0.04 } as SurfMat,
  luggage:    { tint: 1, roughness: 0.42, metalness: 0.14 } as SurfMat,
} as const;

export const PED_PRESETS: PedSpec[] = [
  {
    id: 'male-casual',
    label: 'Pedestre Casual (M)',
    category: 'civilian',
    height: 1.77, headUnits: 7.5, sex: 0.05,
    shoulderScale: 1.04, waistScale: 0.98, hipScale: 0.98, chestDepth: 1.02, limbThickness: 1.02,
    hairStyle: 'short', headgear: 'none', topStyle: 'tshirt', bottomStyle: 'pants', sleeveLength: 'short',
    defaultTop: 0x2c5282, defaultBottom: 0x2c3d59, defaultSkin: 0xe2b18f, defaultHair: 0x31231a, shoeColor: 0x2b2f36,
    swatches: [0x2c5282, 0x8f3434, 0x3b6e52, 0xd9d2c5],
  },
  {
    id: 'female-dress',
    label: 'Pedestre Vestido (F)',
    category: 'civilian',
    height: 1.66, headUnits: 7.5, sex: 0.95,
    shoulderScale: 0.90, waistScale: 0.84, hipScale: 1.05, chestDepth: 0.96, limbThickness: 0.88,
    hairStyle: 'waves', headgear: 'none', topStyle: 'dress', bottomStyle: 'dress-hem', sleeveLength: 'short',
    defaultTop: 0xa84c65, defaultBottom: 0xa84c65, defaultSkin: 0xd49b76, defaultHair: 0x4f3624, shoeColor: 0x3d2e29,
    swatches: [0xa84c65, 0x2f6d73, 0xc79938, 0x3f4c7a],
  },
  {
    id: 'male-jacket',
    label: 'Pedestre Jaqueta (M)',
    category: 'civilian',
    height: 1.79, headUnits: 7.6, sex: 0.0,
    shoulderScale: 1.08, waistScale: 1.02, hipScale: 1.00, chestDepth: 1.08, limbThickness: 1.05,
    hairStyle: 'short', headgear: 'none', topStyle: 'jacket', bottomStyle: 'pants', sleeveLength: 'long',
    defaultTop: 0x454d59, defaultBottom: 0x473d36, defaultSkin: 0xf0c7ab, defaultHair: 0x1c1715, shoeColor: 0x2e231c,
    swatches: [0x454d59, 0x7d5c45, 0x2c5282, 0x3b6e52],
  },
  {
    id: 'female-casual',
    label: 'Pedestre Casual (F)',
    category: 'civilian',
    height: 1.67, headUnits: 7.5, sex: 0.92,
    shoulderScale: 0.91, waistScale: 0.86, hipScale: 1.03, chestDepth: 0.96, limbThickness: 0.89,
    hairStyle: 'bun', headgear: 'none', topStyle: 'shirt', bottomStyle: 'pants', sleeveLength: 'long',
    defaultTop: 0x2f6d73, defaultBottom: 0x2a2d33, defaultSkin: 0xbf835e, defaultHair: 0x1c1715, shoeColor: 0xd6d2ca,
    swatches: [0x2f6d73, 0xb86b35, 0xd9d2c5, 0x8f3434],
  },
  {
    id: 'robust-casual',
    label: 'Pedestre Robusto',
    category: 'civilian',
    height: 1.75, headUnits: 7.3, sex: 0.20,
    shoulderScale: 1.12, waistScale: 1.24, hipScale: 1.16, chestDepth: 1.22, limbThickness: 1.16,
    hairStyle: 'curls', headgear: 'none', topStyle: 'tshirt', bottomStyle: 'pants', sleeveLength: 'short',
    defaultTop: 0x5b6b43, defaultBottom: 0x4f565e, defaultSkin: 0xa16949, defaultHair: 0x1c1715, shoeColor: 0x2e2b29,
    swatches: [0x5b6b43, 0x8f3434, 0x62738c, 0xc79938],
  },
  {
    id: 'slender-sport',
    label: 'Pedestre Esportivo',
    category: 'sport',
    height: 1.81, headUnits: 7.75, sex: 0.65,
    shoulderScale: 0.96, waistScale: 0.84, hipScale: 0.92, chestDepth: 0.94, limbThickness: 0.90,
    hairStyle: 'ponytail', headgear: 'none', topStyle: 'sport-jersey', bottomStyle: 'shorts', sleeveLength: 'short',
    defaultTop: 0xb86b35, defaultBottom: 0x243044, defaultSkin: 0xd49b76, defaultHair: 0x785537, shoeColor: 0xd8dce2,
    swatches: [0xb86b35, 0x2c5282, 0x3b6e52, 0xa84c65],
  },
  {
    id: 'worker',
    label: 'Operário de Obra',
    category: 'service',
    height: 1.78, headUnits: 7.5, sex: 0.05,
    shoulderScale: 1.08, waistScale: 1.05, hipScale: 1.02, chestDepth: 1.06, limbThickness: 1.08,
    hairStyle: 'short', headgear: 'hardhat', topStyle: 'hi-vis-vest', bottomStyle: 'pants', sleeveLength: 'long',
    defaultTop: 0xe67319, defaultBottom: 0x2d3440, defaultSkin: 0xd49b76, defaultHair: 0x31231a, shoeColor: 0x593d24,
    swatches: [0xe67319, 0xd98a18, 0xc75e14, 0x99b825],
  },
  {
    id: 'funeral',
    label: 'Traje Formal / Luto',
    category: 'service',
    height: 1.76, headUnits: 7.5, sex: 0.15,
    shoulderScale: 1.04, waistScale: 0.98, hipScale: 0.98, chestDepth: 1.03, limbThickness: 1.00,
    hairStyle: 'short', headgear: 'none', topStyle: 'suit', bottomStyle: 'pants', sleeveLength: 'long',
    defaultTop: 0x1e2126, defaultBottom: 0x1b1d21, defaultSkin: 0xe2b18f, defaultHair: 0x9aa0a6, shoeColor: 0x141518,
    swatches: [0x1e2126, 0x262a33, 0x1c2430, 0x292524],
  },
  {
    id: 'tourist',
    label: 'Turista com Mochila',
    category: 'civilian',
    height: 1.72, headUnits: 7.5, sex: 0.45,
    shoulderScale: 0.98, waistScale: 0.96, hipScale: 1.00, chestDepth: 0.98, limbThickness: 0.96,
    hairStyle: 'bob', headgear: 'cap', topStyle: 'tshirt', bottomStyle: 'shorts', sleeveLength: 'short',
    backpack: true,
    defaultTop: 0xc79938, defaultBottom: 0x9e8c70, defaultSkin: 0xf0c7ab, defaultHair: 0x785537, shoeColor: 0xd4d0c8,
    swatches: [0xc79938, 0x2f6d73, 0xb86b35, 0x62738c],
  },
  {
    id: 'cyclist',
    label: 'Ciclista Urbano',
    category: 'sport',
    height: 1.76, headUnits: 7.6, sex: 0.25,
    shoulderScale: 1.02, waistScale: 0.90, hipScale: 0.94, chestDepth: 0.98, limbThickness: 0.98,
    hairStyle: 'short', headgear: 'bike-helmet', topStyle: 'sport-jersey', bottomStyle: 'shorts', sleeveLength: 'short',
    defaultTop: 0x2c6db8, defaultBottom: 0x1f242c, defaultSkin: 0xe2b18f, defaultHair: 0x31231a, shoeColor: 0x25282e,
    swatches: [0x2c6db8, 0xb83832, 0x337a52, 0xd49424],
  },
];

export const CIVILIAN_PED_IDS: PedId[] = [
  'male-casual',
  'female-dress',
  'male-jacket',
  'female-casual',
  'robust-casual',
  'slender-sport',
];

const PED_SPEC_MAP = new Map<PedId, PedSpec>(PED_PRESETS.map((p) => [p.id, p]));

export function getPedSpec(id: PedId): PedSpec {
  const s = PED_SPEC_MAP.get(id);
  if (!s) throw new Error(`Unknown PedId: ${id}`);
  return s;
}

/**
 * Extended MeshBuilder emitting per-vertex color zone (`aZone`), articulated limb ID (`aPart`),
 * and dual joint pivots (`aPivot`, `aPivot2`) alongside standard MeshBuilder attributes.
 */
export class PedMeshBuilder extends MeshBuilder {
  zones: number[] = [];
  parts: number[] = [];
  pivots: number[] = [];
  pivots2: number[] = [];

  private curZone: number = PED_ZONE.FIXED;
  private curPart: number = PED_PART.STATIC;
  private curPivot: Vec3 = [0, 0, 0];
  private curPivot2: Vec3 = [0, 0, 0];

  setZone(zone: number) {
    this.curZone = zone;
  }

  setPart(part: number, pivot: Vec3, pivot2?: Vec3) {
    this.curPart = part;
    this.curPivot = pivot;
    this.curPivot2 = pivot2 ?? pivot;
  }

  protected override onPushVertex() {
    this.zones.push(this.curZone);
    this.parts.push(this.curPart);
    this.pivots.push(this.curPivot[0], this.curPivot[1], this.curPivot[2]);
    this.pivots2.push(this.curPivot2[0], this.curPivot2[1], this.curPivot2[2]);
  }

  /** Build a horizontal elliptical/anatomical cross-section ring at height y (angle 0 = +X front). */
  ellipticRing(
    cx: number,
    y: number,
    cz: number,
    rx: number,
    rz: number,
    seg: number,
    opts: { frontScale?: number; backScale?: number; squareness?: number; phase?: number; yWave?: (angle: number) => number } = {},
  ): Vec3[] {
    const fS = opts.frontScale ?? 1.0;
    const bS = opts.backScale ?? 1.0;
    const sq = opts.squareness ?? 0.0;
    const ph = opts.phase ?? 0.0;
    const ring: Vec3[] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2 + ph;
      let ca = Math.cos(a);
      let sa = Math.sin(a);
      if (sq > 0) {
        // Superellipse blend for subtle squaring on shoulders/shoes/chest
        const exp = 1 - sq * 0.35;
        ca = Math.sign(ca) * Math.pow(Math.abs(ca), exp);
        sa = Math.sign(sa) * Math.pow(Math.abs(sa), exp);
      }
      const rxEff = ca >= 0 ? rx * fS : rx * bS;
      const dy = opts.yWave ? opts.yWave(a) : 0;
      ring.push([cx + ca * rxEff, y + dy, cz + sa * rz]);
    }
    return ring;
  }

  /**
   * Compact loft with optional per-segment shade/zone/surface overrides and lean triangle caps (N-2 tris/cap).
   */
  sculptLoft(
    rings: Vec3[][],
    baseColor: number,
    surf: SurfMat,
    opts: {
      capStart?: boolean;
      capEnd?: boolean;
      capColor?: number;
      capSurf?: SurfMat;
      ringShades?: number[];
      segOverride?: (segIdx: number) => { zone?: number; color?: number; surf?: SurfMat; shade?: number } | null;
      faceOverride?: (segIdx: number, edgeIdx: number) => { zone?: number; color?: number; surf?: SurfMat; shade?: number } | null;
    } = {},
  ) {
    if (rings.length < 2) return;
    const n = rings[0].length;
    if (n < 3) return;

    let cx = 0, cy = 0, cz = 0, cnt = 0;
    for (const r of rings) for (const p of r) { cx += p[0]; cy += p[1]; cz += p[2]; cnt++; }
    cx /= cnt; cy /= cnt; cz /= cnt;

    let vote = 0;
    for (let s = 0; s < rings.length - 1; s++) {
      const r0 = rings[s], r1 = rings[s + 1];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = r0[i], b = r0[j], c = r1[j];
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const mx = (a[0] + b[0] + c[0] + r1[i][0]) * 0.25 - cx;
        const my = (a[1] + b[1] + c[1] + r1[i][1]) * 0.25 - cy;
        const mz = (a[2] + b[2] + c[2] + r1[i][2]) * 0.25 - cz;
        vote += nx * mx + ny * my + nz * mz;
      }
    }
    const flip = vote < 0;
    const savedZone = this.curZone;
    const baseC = new THREE.Color(baseColor);
    const tmpC = new THREE.Color();

    for (let s = 0; s < rings.length - 1; s++) {
      const r0 = rings[s], r1 = rings[s + 1];
      const sOv = opts.segOverride?.(s);
      const rShade = opts.ringShades
        ? (opts.ringShades[s] + opts.ringShades[s + 1]) * 0.5
        : 1.0;

      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const fOv = opts.faceOverride?.(s, i);
        const zone = fOv?.zone ?? sOv?.zone ?? savedZone;
        const colHex = fOv?.color ?? sOv?.color;
        const fSurf = fOv?.surf ?? sOv?.surf ?? surf;
        const shade = (fOv?.shade ?? sOv?.shade ?? 1.0) * rShade;
        if (colHex !== undefined) tmpC.setHex(colHex).multiplyScalar(shade);
        else tmpC.copy(baseC).multiplyScalar(shade);

        this.curZone = zone;
        const effSurf: SurfMat = zone === PED_ZONE.PRIMARY ? { ...fSurf, tint: 1 } : { ...fSurf, tint: 0 };
        if (!flip) this.quad(r0[i], r0[j], r1[j], r1[i], tmpC, effSurf);
        else this.quad(r0[j], r0[i], r1[i], r1[j], tmpC, effSurf);
      }
    }

    const fanCap = (ring: Vec3[], shade: number, zone: number, colHex: number | undefined, capSurf: SurfMat) => {
      this.curZone = zone;
      const effSurf: SurfMat = zone === PED_ZONE.PRIMARY ? { ...capSurf, tint: 1 } : { ...capSurf, tint: 0 };
      if (colHex !== undefined) tmpC.setHex(colHex).multiplyScalar(shade);
      else tmpC.copy(baseC).multiplyScalar(shade);

      // Verify fan normal points away from global centroid
      let rx = 0, ry = 0, rz = 0;
      for (const p of ring) { rx += p[0]; ry += p[1]; rz += p[2]; }
      rx /= n; ry /= n; rz /= n;
      const a = ring[0], b = ring[1], c = ring[2];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const dot = nx * (rx - cx) + ny * (ry - cy) + nz * (rz - cz);
      const rev = dot < 0;
      for (let i = 1; i < n - 1; i++) {
        if (!rev) this.tri(ring[0], ring[i], ring[i + 1], tmpC, effSurf);
        else this.tri(ring[0], ring[i + 1], ring[i], tmpC, effSurf);
      }
    };

    if (opts.capStart !== false) {
      const ov = opts.segOverride?.(0);
      fanCap(rings[0], opts.ringShades?.[0] ?? 0.92, ov?.zone ?? savedZone, opts.capColor ?? ov?.color, opts.capSurf ?? ov?.surf ?? surf);
    }
    if (opts.capEnd !== false) {
      const last = rings.length - 2;
      const ov = opts.segOverride?.(last);
      fanCap(rings[rings.length - 1], opts.ringShades?.[rings.length - 1] ?? 1.0, ov?.zone ?? savedZone, opts.capColor ?? ov?.color, opts.capSurf ?? ov?.surf ?? surf);
    }
    this.curZone = savedZone;
  }

  /** Round-section structural tube connecting p0 -> p1 (for bicycle frames, umbrella ribs/handles). */
  tube(p0: Vec3, p1: Vec3, r0: number, r1: number, seg: number, color: number, surf: SurfMat, caps = true) {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) return;
    const fx = dx / len, fy = dy / len, fz = dz / len;
    const ux0 = Math.abs(fy) < 0.9 ? 0 : 1, uy0 = Math.abs(fy) < 0.9 ? 1 : 0, uz0 = 0;
    let rx = fy * uz0 - fz * uy0, ry = fz * ux0 - fx * uz0, rz = fx * uy0 - fy * ux0;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const vx = ry * fz - rz * fy, vy = rz * fx - rx * fz, vz = rx * fy - ry * fx;

    const ringA: Vec3[] = [];
    const ringB: Vec3[] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      ringA.push([
        p0[0] + (rx * ca + vx * sa) * r0,
        p0[1] + (ry * ca + vy * sa) * r0,
        p0[2] + (rz * ca + vz * sa) * r0,
      ]);
      ringB.push([
        p1[0] + (rx * ca + vx * sa) * r1,
        p1[1] + (ry * ca + vy * sa) * r1,
        p1[2] + (rz * ca + vz * sa) * r1,
      ]);
    }
    this.sculptLoft([ringA, ringB], color, surf, { capStart: caps, capEnd: caps });
  }

  override toGeometry(): THREE.BufferGeometry {
    // Keep aTint synchronized with aZone === 1 for compatibility with base AssetMaterial & tests
    const n = this.zones.length;
    const pedMeta = new Float32Array(n * 4);
    const pivot4 = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      this.tint[i] = this.zones[i] === PED_ZONE.PRIMARY ? 1 : 0;
      pedMeta[i * 4] = this.mat[i * 2];
      pedMeta[i * 4 + 1] = this.mat[i * 2 + 1];
      pedMeta[i * 4 + 2] = this.zones[i];
      pedMeta[i * 4 + 3] = this.parts[i];
      pivot4[i * 4] = this.pivots[i * 3];
      pivot4[i * 4 + 1] = this.pivots[i * 3 + 1];
      pivot4[i * 4 + 2] = this.pivots[i * 3 + 2];
      pivot4[i * 4 + 3] = this.pivots2[i * 3 + 1];
    }
    const g = super.toGeometry();
    // Packed shader attributes only (eliminates redundant unpacked GPU buffers & keeps WebGL attributes <= 14)
    g.setAttribute('aPedMeta', new THREE.Float32BufferAttribute(pedMeta, 4));
    g.setAttribute('aPivot4', new THREE.Float32BufferAttribute(pivot4, 4));
    return g;
  }
}

/** Shade white (neutral multiplier for zone-tinted vertices). */
function grayHex(s: number): number {
  const v = Math.max(0, Math.min(255, Math.round(s * 255)));
  return (v << 16) | (v << 8) | v;
}

// =============================================================================
// 1. PARAMETRIC PEDESTRIAN & CYCLIST GENERATOR
// =============================================================================

export function buildPedestrian(id: PedId, detail: AssetDetail = 'high'): AssetBuildResult {
  const spec = getPedSpec(id);
  const b = new PedMeshBuilder();
  const H = spec.height;
  const HU = H / spec.headUnits;
  const s = H / 1.76; // normalized stature ratio
  const fem = spec.sex;

  // Anatomical landmark heights (Loomis 7.5-head canon, Y=0 ground contact)
  const soleY = 0.0;
  const ankleY = 0.056 * H;
  const calfY = 0.185 * H;
  const kneeY = 0.270 * H;
  const midThighY = 0.375 * H;
  const crotchY = 0.472 * H;
  const hipPivotY = 0.502 * H;
  const waistY = 0.618 * H;
  const chestY = 0.735 * H;
  const shoulderY = 0.812 * H;
  const neckBaseY = 0.840 * H;
  const chinY = H - HU;
  const headCenterY = chinY + HU * 0.50;
  const elbowY = 0.638 * H;
  const wristY = 0.512 * H;
  const handTipY = 0.440 * H;

  // Anatomical widths (Z = lateral half-width, X = front-back half-depth)
  const hipHalfZ = (0.090 + 0.010 * fem) * s * Math.sqrt(spec.hipScale);
  const pelvisZ = (0.162 + 0.016 * fem) * s * spec.hipScale;
  const pelvisX = 0.106 * s * spec.chestDepth;
  const waistZ = (0.145 - 0.020 * fem) * s * spec.waistScale;
  const waistX = 0.096 * s * spec.waistScale;
  const chestZ = (0.182 - 0.018 * fem) * s * spec.shoulderScale;
  const chestX = (0.114 + 0.010 * fem) * s * spec.chestDepth;
  const shoulderZ = (0.206 - 0.022 * fem) * s * spec.shoulderScale;
  const shoulderX = 0.088 * s * spec.chestDepth;
  const collarZ = 0.072 * s;
  const collarX = 0.068 * s;

  // Nest upper arm cleanly at deltoid edge (deltoid cap bevels inward to blend seamlessly without chest poke-through)
  const armZ = shoulderZ - 0.002 * s;
  const thighR = 0.076 * s * spec.limbThickness;
  const kneeR = 0.054 * s * spec.limbThickness;
  const calfR = 0.056 * s * spec.limbThickness;
  const ankleR = 0.040 * s * spec.limbThickness;
  const armR = 0.046 * s * spec.limbThickness;
  const foreR = 0.036 * s * spec.limbThickness;

  const hipPivot: Vec3 = [0, hipPivotY, 0];
  const neckPivot: Vec3 = [0, neckBaseY, 0];

  const isHi = detail === 'high';
  const isMed = detail === 'med';
  const torsoSeg = isHi ? 8 : isMed ? 6 : 4;
  const limbSeg = isHi ? 6 : isMed ? 5 : 4;
  const headSeg = isHi ? 8 : isMed ? 6 : 4;
  const lowPhase = Math.PI * 0.25;

  // ---- A. TORSO, PELVIS, DRESS / JACKET / SUIT / VEST ----
  b.setPart(PED_PART.TORSO, hipPivot);
  b.setZone(PED_ZONE.PRIMARY);

  const isDress = spec.topStyle === 'dress';
  const isJacket = spec.topStyle === 'jacket';
  const isSuit = spec.topStyle === 'suit';
  const isVest = spec.topStyle === 'hi-vis-vest';
  const isSport = spec.topStyle === 'sport-jersey';

  if (isDress) {
    // Sculpted midi dress: generously flared A-line hem above knee so striding thighs never poke through
    const hemY = kneeY + 0.085 * H;
    const dressRings: Vec3[][] = isHi
      ? [
          b.ellipticRing(0.006 * s, hemY, 0, pelvisX * 1.78, pelvisZ * 1.46, torsoSeg),
          b.ellipticRing(0.002 * s, crotchY - 0.01 * H, 0, pelvisX * 1.44, pelvisZ * 1.24, torsoSeg),
          b.ellipticRing(-0.005, hipPivotY + 0.01 * H, 0, pelvisX * 1.14, pelvisZ * 1.08, torsoSeg),
          b.ellipticRing(-0.004, waistY, 0, waistX * 1.02, waistZ * 1.02, torsoSeg),
          b.ellipticRing(0.010, chestY, 0, chestX * 1.06, chestZ * 1.00, torsoSeg, { frontScale: 1.14, backScale: 0.94 }),
          b.ellipticRing(0.0, shoulderY, 0, shoulderX * 0.95, shoulderZ * 0.92, torsoSeg, { squareness: 0.14 }),
          b.ellipticRing(0.0, neckBaseY - 0.008 * H, 0, collarX * 1.05, collarZ * 1.12, torsoSeg),
        ]
      : isMed
        ? [
            b.ellipticRing(0.006 * s, hemY, 0, pelvisX * 1.74, pelvisZ * 1.44, torsoSeg),
            b.ellipticRing(-0.004, hipPivotY, 0, pelvisX * 1.16, pelvisZ * 1.08, torsoSeg),
            b.ellipticRing(-0.004, waistY, 0, waistX * 1.02, waistZ * 1.02, torsoSeg),
            b.ellipticRing(0.008, chestY, 0, chestX * 1.05, chestZ * 1.00, torsoSeg, { frontScale: 1.12 }),
            b.ellipticRing(0.0, shoulderY, 0, shoulderX * 0.94, shoulderZ * 0.91, torsoSeg),
            b.ellipticRing(0.0, neckBaseY - 0.006 * H, 0, collarX * 1.06, collarZ * 1.12, torsoSeg),
          ]
        : [
            b.ellipticRing(0.004 * s, hemY, 0, pelvisX * 1.82, pelvisZ * 1.48, torsoSeg, { phase: lowPhase }),
            b.ellipticRing(-0.004, waistY, 0, waistX * 1.08, waistZ * 1.08, torsoSeg, { phase: lowPhase }),
            b.ellipticRing(0.002, neckBaseY - 0.006 * H, 0, shoulderX * 0.88, shoulderZ * 0.84, torsoSeg, { phase: lowPhase }),
          ];
    const shades = dressRings.map((_, idx) => 0.88 + 0.14 * (idx / (dressRings.length - 1)));
    b.sculptLoft(dressRings, 0xffffff, PED_SURF.clothTop, { ringShades: shades, capStart: true, capEnd: !isMed });
  } else {
    // Two-piece torso: pelvis/bottom band -> waist -> ribcage/chest -> shoulders -> trapezius/collar
    const torsoRings: Vec3[][] = isHi
      ? [
          b.ellipticRing(-0.006, crotchY, 0, pelvisX * 0.96, pelvisZ * 0.96, torsoSeg),
          b.ellipticRing(-0.008, hipPivotY + 0.025 * H, 0, pelvisX * 1.04, pelvisZ * 1.03, torsoSeg),
          b.ellipticRing(-0.005, waistY, 0, waistX * (isJacket || isSuit ? 1.08 : 1.0), waistZ * (isJacket || isSuit ? 1.06 : 1.0), torsoSeg),
          b.ellipticRing(0.008, chestY, 0, chestX * (isJacket || isSuit ? 1.07 : 1.02), chestZ * (isJacket || isSuit ? 1.05 : 1.0), torsoSeg, { frontScale: 1.10, backScale: 0.95 }),
          b.ellipticRing(0.0, shoulderY, 0, shoulderX * (isJacket || isSuit ? 1.04 : 0.99), shoulderZ * (isJacket || isSuit ? 1.01 : 0.96), torsoSeg, { squareness: 0.15 }),
          b.ellipticRing(0.0, neckBaseY - 0.004 * H, 0, collarX * 1.06, collarZ * 1.10, torsoSeg),
        ]
      : isMed
        ? [
            b.ellipticRing(-0.006, crotchY, 0, pelvisX * 0.96, pelvisZ * 0.96, torsoSeg),
            b.ellipticRing(-0.005, waistY, 0, waistX * 1.02, waistZ * 1.02, torsoSeg),
            b.ellipticRing(0.006, chestY, 0, chestX * 1.02, chestZ * 1.01, torsoSeg, { frontScale: 1.08 }),
            b.ellipticRing(0.0, shoulderY, 0, shoulderX * 0.98, shoulderZ * 0.96, torsoSeg),
            b.ellipticRing(0.0, neckBaseY - 0.005 * H, 0, collarX * 1.06, collarZ * 1.12, torsoSeg),
          ]
        : [
            b.ellipticRing(-0.005, crotchY, 0, pelvisX * 1.08, pelvisZ * 1.06, torsoSeg, { phase: lowPhase }),
            b.ellipticRing(-0.003, waistY, 0, waistX * 1.10, waistZ * 1.08, torsoSeg, { phase: lowPhase }),
            b.ellipticRing(0.003, neckBaseY - 0.005 * H, 0, shoulderX * 0.94, shoulderZ * 0.88, torsoSeg, { phase: lowPhase }),
          ];

    const shades = torsoRings.map((_, idx) => 0.86 + 0.16 * (idx / (torsoRings.length - 1)));
    b.sculptLoft(torsoRings, 0xffffff, PED_SURF.clothTop, {
      ringShades: shades,
      capStart: !isMed,
      capEnd: !isMed,
      segOverride: (segIdx) => {
        // Lower pelvis band matches pants/shorts (ZONE_BOTTOM) unless jacket/suit hangs over hip
        if (segIdx === 0 && !isJacket && !isSuit) {
          return { zone: PED_ZONE.BOTTOM, surf: PED_SURF.clothFix };
        }
        return null;
      },
    });

    // Waist belt detail (high only)
    if (isHi && !isSport && !isVest) {
      b.setZone(PED_ZONE.FIXED);
      const beltY = isJacket || isSuit ? waistY - 0.015 * H : hipPivotY + 0.032 * H;
      const bRing0 = b.ellipticRing(-0.006, beltY - 0.014 * s, 0, waistX * 1.045, waistZ * 1.045, torsoSeg);
      const bRing1 = b.ellipticRing(-0.006, beltY + 0.014 * s, 0, waistX * 1.045, waistZ * 1.045, torsoSeg);
      b.sculptLoft([bRing0, bRing1], 0x262220, PED_SURF.shoe, { capStart: false, capEnd: false });
    }

    // Open jacket inner shirt front panel (tucked flush against sloped chest contour)
    if (isJacket && detail !== 'low') {
      b.setZone(PED_ZONE.FIXED);
      const xWaist = -0.005 + waistX * 1.08 + 0.005 * s;
      const xChest = 0.008 + chestX * 1.07 * 1.10 + 0.005 * s;
      const xTop = shoulderX * 1.04 + 0.009 * s;
      const hw = 0.044 * s;
      const d = 0.009 * s;
      const jRing = (x: number, y: number, w: number): Vec3[] => [
        [x - d, y, w], [x, y, w], [x, y, -w], [x - d, y, -w],
      ];
      b.sculptLoft(
        [jRing(xWaist, waistY - 0.01 * H, hw * 0.82), jRing(xChest, chestY, hw), jRing(xTop, shoulderY - 0.015 * H, hw * 1.00)],
        0xe2dfd8,
        PED_SURF.clothFix,
        { capStart: true, capEnd: true },
      );
    }

    // Formal suit: crisp white V-shirt + dark tie (+X front chest, proud of chest slope)
    if (isSuit && detail !== 'low') {
      b.setZone(PED_ZONE.FIXED);
      const xChest = 0.008 + chestX * 1.07 * 1.10 + 0.014 * s;
      const xTop = shoulderX * 1.06 + 0.010 * s;
      const sRing = (x: number, y: number, w: number): Vec3[] => [
        [x - 0.014 * s, y, w], [x, y, w], [x, y, -w], [x - 0.014 * s, y, -w],
      ];
      b.sculptLoft(
        [sRing(xChest - 0.005 * s, chestY - 0.04 * H, 0.022 * s), sRing(xTop, shoulderY + 0.005 * H, 0.056 * s)],
        0xf2f2ef,
        PED_SURF.clothFix,
        { capStart: true, capEnd: true },
      );
      if (isHi) {
        b.box(xChest + 0.006 * s, chestY - 0.04 * H, 0, 0.012 * s, shoulderY - chestY + 0.04 * H, 0.024 * s, 0x16181c, PED_SURF.clothFix);
      }
    }

    // High-vis worker vest: silver-white reflective horizontal stripes matched to torso centerline
    if (isVest) {
      b.setZone(PED_ZONE.FIXED);
      const rBand = (cx: number, y: number, rx: number, rz: number) => {
        const rr0 = b.ellipticRing(cx, y - 0.017 * s, 0, rx * 1.10, rz * 1.08, torsoSeg, { frontScale: 1.08, backScale: 1.04 });
        const rr1 = b.ellipticRing(cx, y + 0.017 * s, 0, rx * 1.10, rz * 1.08, torsoSeg, { frontScale: 1.08, backScale: 1.04 });
        b.sculptLoft([rr0, rr1], 0xe8eff5, PED_SURF.reflective, { capStart: false, capEnd: false });
      };
      rBand(-0.005, waistY + 0.01 * H, waistX, waistZ);
      if (detail !== 'low') rBand(0.008, chestY - 0.015 * H, chestX * 1.04, chestZ);
    }

    // Sport jersey subtle chest stripe (high/med)
    if (isSport && isHi) {
      b.setZone(PED_ZONE.FIXED);
      const rr0 = b.ellipticRing(0.008, chestY - 0.022 * s, 0, chestX * 1.08, chestZ * 1.04, torsoSeg, { frontScale: 1.11 });
      const rr1 = b.ellipticRing(0.008, chestY + 0.022 * s, 0, chestX * 1.08, chestZ * 1.04, torsoSeg, { frontScale: 1.11 });
      b.sculptLoft([rr0, rr1], 0xeef2f5, PED_SURF.clothFix, { capStart: false, capEnd: false });
    }
  }

  // Tourist 3D backpack mounted cleanly on upper/mid back (-X) with over-shoulder straps
  if (spec.backpack) {
    b.setZone(PED_ZONE.FIXED);
    const packX = -(chestX + 0.075 * s);
    const packY0 = waistY - 0.01 * H;
    const packH = 0.22 * H;
    const packW = 0.25 * s;
    const packD = 0.14 * s;
    if (isHi) {
      b.bevelBox(packX, packY0, 0, packD, packH, packW, 0.03 * s, 0x3b6054, PED_SURF.clothFix);
      // Lower front pocket on the back of the pack
      b.box(packX - packD * 0.48, packY0 + 0.03 * s, 0, 0.04 * s, packH * 0.40, packW * 0.78, 0x2c473e, PED_SURF.clothFix);
      // Straps routed cleanly OVER the shoulder top and down proud of the chest contour
      const frontStrapX = 0.008 + chestX * 1.12 + 0.010 * s;
      for (const sz of [-1, 1]) {
        const zStr = sz * 0.108 * s;
        b.strut([packX + packD * 0.42, shoulderY + 0.005 * s, zStr], [0.025 * s, shoulderY + 0.022 * s, zStr], 0.030 * s, 0.014 * s, 0x24332d, PED_SURF.clothFix);
        b.strut([0.025 * s, shoulderY + 0.022 * s, zStr], [frontStrapX, chestY - 0.02 * H, zStr * 1.04], 0.030 * s, 0.014 * s, 0x24332d, PED_SURF.clothFix);
      }
    } else {
      b.taperBox(packX, packY0, 0, packD, packW, packD * 0.85, packW * 0.88, packH, 0x3b6054, PED_SURF.clothFix);
    }
  }

  // ---- B. NECK, SCULPTED HEAD, FACE & HAIRSTYLE / HEADGEAR ----
  // Pass hipPivot as pivot2 so cyclist mode derives exact stature-proportional hipBaseY from aPivot4.w
  b.setPart(PED_PART.HEAD, neckPivot, hipPivot);

  // Neck
  if (detail !== 'low') {
    b.setZone(PED_ZONE.SKIN);
    const nSeg = isHi ? 6 : 5;
    const nR = 0.049 * s * (1 - 0.08 * fem);
    b.sculptLoft(
      [
        b.ellipticRing(0.0, neckBaseY - 0.018 * H, 0, nR * 1.12, nR * 1.12, nSeg),
        b.ellipticRing(0.005 * s, chinY + 0.015 * H, 0, nR * 0.95, nR * 0.94, nSeg),
      ],
      0xffffff,
      PED_SURF.skin,
      { capStart: false, capEnd: false, ringShades: [0.88, 0.96] },
    );
  }

  // Sculpted Loomis head (+X forward)
  b.setZone(PED_ZONE.SKIN);
  const headX = 0.012 * s;
  const headW = HU * (0.37 - 0.02 * fem); // half-width along Z
  const headD = HU * 0.44;                // half-depth along X
  const headRings: Vec3[][] = isHi
    ? [
        b.ellipticRing(headX + HU * 0.08, chinY, 0, headD * 0.48, headW * 0.56, headSeg, { frontScale: 1.15, backScale: 0.72 }),
        b.ellipticRing(headX + HU * 0.04, chinY + HU * 0.24, 0, headD * 0.86, headW * 0.88, headSeg, { frontScale: 1.08, backScale: 0.88 }),
        b.ellipticRing(headX, chinY + HU * 0.50, 0, headD * 0.98, headW * 1.00, headSeg, { frontScale: 1.02, backScale: 1.00 }),
        b.ellipticRing(headX - HU * 0.02, chinY + HU * 0.76, 0, headD * 0.96, headW * 0.97, headSeg, { frontScale: 0.98, backScale: 1.04 }),
        b.ellipticRing(headX - HU * 0.03, chinY + HU * 0.93, 0, headD * 0.64, headW * 0.66, headSeg),
        b.ellipticRing(headX - HU * 0.03, H, 0, headD * 0.24, headW * 0.26, headSeg),
      ]
    : isMed
      ? [
          b.ellipticRing(headX + HU * 0.05, chinY, 0, headD * 0.56, headW * 0.62, headSeg),
          b.ellipticRing(headX, chinY + HU * 0.52, 0, headD * 0.98, headW * 0.98, headSeg),
          b.ellipticRing(headX - HU * 0.02, H, 0, headD * 0.40, headW * 0.42, headSeg),
        ]
      : [
          // Compensate 1/sqrt(2) on 4-sided ring via 45deg phase + fuller radii so LOW head reads naturally
          b.ellipticRing(headX + HU * 0.02, neckBaseY - 0.012 * H, 0, headD * 0.84, headW * 0.88, headSeg, { phase: lowPhase }),
          b.ellipticRing(headX - HU * 0.01, H, 0, headD * 1.14, headW * 1.16, headSeg, { phase: lowPhase }),
        ];
  const headShades = headRings.map((_, idx) => 0.90 + 0.12 * (idx / (headRings.length - 1)));
  b.sculptLoft(headRings, 0xffffff, PED_SURF.skin, { ringShades: headShades, capStart: isHi, capEnd: true });

  // Facial features in high & med (nose, eyes, eyebrows, ears)
  if (isHi || isMed) {
    const eyeY = chinY + HU * 0.50;
    const faceFrontX = headX + headD * 0.96;

    // Subtle sculpted nose pointing +X
    b.setZone(PED_ZONE.SKIN);
    b.taperBox(faceFrontX, chinY + HU * 0.34, 0, 0.028 * s, 0.026 * s, 0.012 * s, 0.016 * s, HU * 0.17, grayHex(0.95), PED_SURF.skin);

    // Stylized low-poly eyes (dark irises)
    b.setZone(PED_ZONE.FIXED);
    const eyeZ = headW * 0.42;
    for (const sz of [-1, 1]) {
      b.box(faceFrontX - 0.008 * s, eyeY - 0.010 * s, sz * eyeZ, 0.014 * s, 0.018 * s, 0.026 * s, 0x221d1a, PED_SURF.shoe);
    }

    if (isHi) {
      // Eyebrows (hair zone)
      b.setZone(PED_ZONE.HAIR);
      for (const sz of [-1, 1]) {
        b.box(faceFrontX - 0.004 * s, eyeY + 0.017 * s, sz * eyeZ, 0.014 * s, 0.010 * s, 0.034 * s, grayHex(0.90), PED_SURF.hair);
      }
      // Subtle ears on ±Z
      b.setZone(PED_ZONE.SKIN);
      for (const sz of [-1, 1]) {
        b.box(headX - 0.012 * s, eyeY - 0.030 * s, sz * (headW * 0.98), 0.022 * s, 0.044 * s, 0.014 * s, grayHex(0.92), PED_SURF.skin);
      }
    }
  }

  // ---- C. HAIRSTYLE OR HEADGEAR ----
  if (spec.headgear === 'hardhat') {
    b.setZone(PED_ZONE.FIXED);
    const helmSeg = isHi ? 8 : isMed ? 6 : 4;
    const brimY = chinY + HU * 0.68;
    const helmR = headD * 1.15;
    const helmW = headW * 1.18;
    // Hard hat dome
    const hhRings = detail === 'low'
      ? [
          b.ellipticRing(headX, brimY, 0, helmR * 1.18, helmW * 1.20, helmSeg, { phase: lowPhase }),
          b.ellipticRing(headX - 0.008 * s, H + 0.045 * s, 0, helmR * 0.72, helmW * 0.74, helmSeg, { phase: lowPhase }),
        ]
      : [
          b.ellipticRing(headX, brimY, 0, helmR, helmW, helmSeg),
          b.ellipticRing(headX - 0.005 * s, brimY + HU * 0.24, 0, helmR * 0.94, helmW * 0.94, helmSeg),
          b.ellipticRing(headX - 0.008 * s, H + 0.045 * s, 0, helmR * 0.42, helmW * 0.44, helmSeg),
        ];
    b.sculptLoft(
      hhRings,
      0xf2be1a,
      PED_SURF.helmet,
      { capStart: isHi, capEnd: true, ringShades: detail === 'low' ? [0.94, 1.04] : [0.92, 1.0, 1.04] },
    );
    // Front visor peak pointing +X
    if (detail !== 'low') {
      b.taperBox(headX + helmR * 0.85, brimY - 0.006 * s, 0, 0.075 * s, helmW * 1.45, 0.065 * s, helmW * 1.10, 0.016 * s, 0xdea912, PED_SURF.helmet);
    }
    if (isHi) {
      // Top safety rib ridge
      b.box(headX, H + 0.032 * s, 0, helmR * 1.25, 0.024 * s, 0.032 * s, 0xf7ca36, PED_SURF.helmet);
    }
  } else if (spec.headgear === 'bike-helmet') {
    b.setZone(PED_ZONE.FIXED);
    const helmSeg = isHi ? 8 : isMed ? 6 : 4;
    const brimY = chinY + HU * 0.66;
    const helmD = headD * 1.24;
    const helmW = headW * 1.16;
    // Aerodynamic elongated cycling helmet (tapered tail toward -X, sleek visor toward +X)
    const bhRings = detail === 'low'
      ? [
          b.ellipticRing(headX - 0.015 * s, brimY, 0, helmD * 1.16, helmW * 1.18, helmSeg, { frontScale: 1.04, backScale: 1.18, phase: lowPhase }),
          b.ellipticRing(headX - 0.010 * s, H + 0.042 * s, 0, helmD * 0.72, helmW * 0.74, helmSeg, { phase: lowPhase }),
        ]
      : [
          b.ellipticRing(headX - 0.015 * s, brimY, 0, helmD, helmW, helmSeg, { frontScale: 1.04, backScale: 1.18 }),
          b.ellipticRing(headX - 0.012 * s, brimY + HU * 0.22, 0, helmD * 0.92, helmW * 0.92, helmSeg, { frontScale: 0.96, backScale: 1.10 }),
          b.ellipticRing(headX - 0.010 * s, H + 0.042 * s, 0, helmD * 0.46, helmW * 0.48, helmSeg),
        ];
    b.sculptLoft(
      bhRings,
      0xe6ebf0,
      PED_SURF.helmet,
      { capStart: isHi, capEnd: true, ringShades: detail === 'low' ? [0.94, 1.04] : [0.92, 1.0, 1.04] },
    );
    // Dark racing stripe & front visor
    if (detail !== 'low') {
      b.taperBox(headX + helmD * 0.88, brimY - 0.008 * s, 0, 0.065 * s, helmW * 1.25, 0.052 * s, helmW * 0.90, 0.014 * s, 0x22262e, SURF.rubber);
    }
    if (isHi) {
      b.box(headX - 0.01 * s, H + 0.025 * s, 0, helmD * 1.25, 0.022 * s, 0.030 * s, 0x2c6db8, PED_SURF.helmet);
    }
  } else {
    // 3D Sculpted Hairstyles (inspired by humano_parametrico.html addHair)
    b.setZone(PED_ZONE.HAIR);
    const hSeg = isHi ? 8 : isMed ? 6 : 4;
    const hairBaseY = chinY + HU * 0.62;
    const bulk = spec.hairStyle === 'curls' ? 1.22 : spec.hairStyle === 'waves' || spec.hairStyle === 'bob' ? 1.14 : 1.08;
    const hD = headD * bulk;
    const hW = headW * bulk;
    const isCurls = spec.hairStyle === 'curls';
    // Organic undulating hairline for curly hair (removes straight flat horizontal brow edge)
    const curlWave = isCurls
      ? (a: number) => 0.018 * s * Math.cos(a) + 0.009 * s * Math.cos(a * 4)
      : undefined;

    // Hair crown cap (slightly shifted toward -X to leave forehead/face clear)
    const capRings = detail === 'low'
      ? [
          b.ellipticRing(headX - 0.018 * s, hairBaseY, 0, hD * 1.16, hW * 1.18, hSeg, { frontScale: 0.88, backScale: 1.08, phase: lowPhase }),
          b.ellipticRing(headX - 0.015 * s, H + (isCurls ? 0.046 : 0.026) * s, 0, hD * 0.84, hW * 0.86, hSeg, { phase: lowPhase }),
        ]
      : [
          b.ellipticRing(headX - 0.018 * s, hairBaseY, 0, hD * 0.96, hW * 1.02, hSeg, { frontScale: isCurls ? 0.80 : 0.84, backScale: 1.08, yWave: curlWave }),
          b.ellipticRing(headX - 0.012 * s, chinY + HU * 0.84, 0, hD * 0.98, hW * 1.00, hSeg, { frontScale: 0.95, backScale: 1.06 }),
          b.ellipticRing(headX - 0.015 * s, H + (isCurls ? 0.046 : 0.026) * s, 0, hD * 0.50, hW * 0.54, hSeg),
        ];
    if (spec.headgear !== 'cap' || detail !== 'low') {
      b.sculptLoft(
        capRings,
        0xffffff,
        PED_SURF.hair,
        { capStart: isHi, capEnd: true, ringShades: detail === 'low' ? [0.92, 1.04] : [0.88, 1.0, 1.06] },
      );
    }

    // Style-specific 3D sculptural additions (skip secondary tufts in low LOD to stay <= 130 tris)
    if (spec.hairStyle === 'short' && isHi) {
      // Structured front fringe/quiff
      b.taperBox(headX + hD * 0.52, chinY + HU * 0.78, 0, 0.055 * s, hW * 1.35, 0.045 * s, hW * 1.10, 0.042 * s, grayHex(1.04), PED_SURF.hair);
    } else if (spec.hairStyle === 'bun' && detail !== 'low') {
      // Elevated sculptural top-back bun
      const bunSeg = isHi ? 6 : 4;
      const bunX = headX - hD * 0.72;
      const bunY = H + 0.015 * s;
      b.sculptLoft(
        [
          b.ellipticRing(bunX, bunY - 0.032 * s, 0, 0.044 * s, 0.044 * s, bunSeg),
          b.ellipticRing(bunX - 0.012 * s, bunY + 0.015 * s, 0, 0.058 * s, 0.058 * s, bunSeg),
          b.ellipticRing(bunX - 0.012 * s, bunY + 0.062 * s, 0, 0.026 * s, 0.026 * s, bunSeg),
        ],
        0xffffff,
        PED_SURF.hair,
        { capStart: true, capEnd: true, ringShades: [0.86, 1.0, 1.06] },
      );
    } else if (spec.hairStyle === 'ponytail' && detail !== 'low') {
      // Sweeping rear ponytail (-X)
      const ptSeg = isHi ? 5 : 4;
      b.sculptLoft(
        [
          b.ellipticRing(headX - hD * 0.92, chinY + HU * 0.68, 0, 0.030 * s, 0.030 * s, ptSeg),
          b.ellipticRing(headX - hD * 1.28, chinY + HU * 0.44, 0, 0.042 * s, 0.038 * s, ptSeg),
          b.ellipticRing(headX - hD * 1.38, chinY + HU * 0.08, 0, 0.022 * s, 0.020 * s, ptSeg),
        ],
        0xffffff,
        PED_SURF.hair,
        { capStart: true, capEnd: true, ringShades: [0.92, 1.0, 0.86] },
      );
    } else if ((spec.hairStyle === 'waves' || (spec.hairStyle === 'bob' && spec.headgear !== 'cap')) && detail !== 'low') {
      // Flowing back/side hair curtain framing neck/shoulders
      const dropY = spec.hairStyle === 'waves' ? shoulderY - 0.02 * H : chinY + HU * 0.04;
      const backX = headX - hD * 0.42;
      const curSeg = isHi ? 6 : 4;
      b.sculptLoft(
        [
          b.ellipticRing(backX - 0.01 * s, dropY, 0, hD * 0.62, hW * 1.18, curSeg),
          b.ellipticRing(backX, chinY + HU * 0.36, 0, hD * 0.66, hW * 1.08, curSeg),
          b.ellipticRing(backX + 0.008 * s, hairBaseY + 0.02 * s, 0, hD * 0.66, hW * 1.02, curSeg),
        ],
        0xffffff,
        PED_SURF.hair,
        { capStart: true, capEnd: false, ringShades: [0.84, 0.96, 1.02] },
      );
    } else if (spec.hairStyle === 'curls' && isHi) {
      // Rounded curly dome halo volume with soft undulating lower margin (no straight forehead shelf)
      b.sculptLoft(
        [
          b.ellipticRing(headX - 0.016 * s, chinY + HU * 0.69, 0, hD * 1.02, hW * 1.06, 6, { frontScale: 0.84, yWave: curlWave }),
          b.ellipticRing(headX - 0.014 * s, chinY + HU * 0.91, 0, hD * 0.94, hW * 0.96, 6),
          b.ellipticRing(headX - 0.014 * s, H + 0.052 * s, 0, hD * 0.42, hW * 0.46, 6),
        ],
        0xffffff,
        PED_SURF.hair,
        { capStart: false, capEnd: true, ringShades: [0.90, 1.0, 1.06] },
      );
    }

    // Tourist sun cap over hair
    if (spec.headgear === 'cap') {
      b.setZone(PED_ZONE.FIXED);
      const capY = chinY + HU * 0.72;
      const cSeg = isHi ? 6 : 4;
      const cMul = detail === 'low' ? 1.18 : 1.0;
      const cPh = detail === 'low' ? lowPhase : 0.0;
      b.sculptLoft(
        [
          b.ellipticRing(headX - 0.005 * s, capY, 0, headD * 1.12 * cMul, headW * 1.12 * cMul, cSeg, { phase: cPh }),
          b.ellipticRing(headX - 0.008 * s, H + 0.032 * s, 0, headD * 0.52 * cMul, headW * 0.54 * cMul, cSeg, { phase: cPh }),
        ],
        0xd9ceb8,
        PED_SURF.clothFix,
        { capStart: false, capEnd: true },
      );
      // Forward cap brim pointing +X
      if (detail !== 'low') {
        b.taperBox(headX + headD * 1.05, capY - 0.006 * s, 0, 0.088 * s, headW * 1.40, 0.072 * s, headW * 1.02, 0.013 * s, 0xc7ba9f, PED_SURF.clothFix);
      }
    }
  }

  // ---- D. LEFT & RIGHT LEGS (THIGHS, SHINS, SCULPTED SHOES AT Y = 0) ----
  const legSides: { sign: -1 | 1; thighPart: number; shinPart: number }[] = [
    { sign: -1, thighPart: PED_PART.THIGH_L, shinPart: PED_PART.SHIN_L },
    { sign: 1, thighPart: PED_PART.THIGH_R, shinPart: PED_PART.SHIN_R },
  ];

  const isShorts = spec.bottomStyle === 'shorts';
  const isDressHem = spec.bottomStyle === 'dress-hem';

  for (const leg of legSides) {
    const lz = leg.sign * hipHalfZ;
    const legHipPivot: Vec3 = [0, hipPivotY, lz];
    const legKneePivot: Vec3 = [0, kneeY, lz];

    // 1. Thigh
    b.setPart(leg.thighPart, legHipPivot, legKneePivot);
    const thighZone = isDressHem ? PED_ZONE.SKIN : PED_ZONE.BOTTOM;
    const thighSurf = isDressHem ? PED_SURF.skin : PED_SURF.clothFix;
    b.setZone(thighZone);

    if (isHi) {
      const shortsHemY = kneeY + 0.055 * H;
      const thighRings = isShorts
        ? [
            b.ellipticRing(0, kneeY - 0.01 * s, lz, kneeR, kneeR * 0.94, limbSeg),
            b.ellipticRing(0.003 * s, shortsHemY, lz, thighR * 0.90, thighR * 0.86, limbSeg),
            b.ellipticRing(0, hipPivotY + 0.015 * s, lz, thighR * 1.08, thighR * 1.02, limbSeg),
          ]
        : [
            b.ellipticRing(0, kneeY - 0.01 * s, lz, kneeR * 1.04, kneeR * 1.00, limbSeg),
            b.ellipticRing(0.004 * s, midThighY, lz, thighR * 0.96, thighR * 0.92, limbSeg),
            b.ellipticRing(0, hipPivotY + 0.015 * s, lz, thighR * 1.08, thighR * 1.02, limbSeg),
          ];
      b.sculptLoft(thighRings, 0xffffff, thighSurf, {
        capStart: false,
        capEnd: true,
        ringShades: [0.90, 0.96, 0.94],
        segOverride: isShorts ? (si) => (si === 0 ? { zone: PED_ZONE.SKIN, surf: PED_SURF.skin } : null) : undefined,
      });
    } else {
      const thighRings = [
        b.ellipticRing(0, kneeY - 0.008 * s, lz, kneeR * 1.02, kneeR * 0.98, limbSeg),
        b.ellipticRing(0, hipPivotY + 0.012 * s, lz, thighR * 1.06, thighR * 1.00, limbSeg),
      ];
      b.sculptLoft(thighRings, 0xffffff, thighSurf, { capStart: false, capEnd: false, ringShades: [0.90, 0.96] });
    }

    // 2. Shin + Calf
    b.setPart(leg.shinPart, legHipPivot, legKneePivot);
    const shinBare = isShorts || isDressHem;
    b.setZone(shinBare ? PED_ZONE.SKIN : PED_ZONE.BOTTOM);
    const shinSurf = shinBare ? PED_SURF.skin : PED_SURF.clothFix;
    const pantCuffY = ankleY + 0.012 * s;

    if (isHi) {
      b.sculptLoft(
        [
          b.ellipticRing(0, pantCuffY, lz, ankleR * (shinBare ? 0.95 : 1.18), ankleR * (shinBare ? 0.92 : 1.14), limbSeg),
          b.ellipticRing(-0.008 * s, calfY, lz, calfR * (shinBare ? 1.02 : 1.08), calfR * 0.96, limbSeg),
          b.ellipticRing(0.002 * s, kneeY + 0.012 * s, lz, kneeR * 1.02, kneeR * 0.98, limbSeg),
        ],
        0xffffff,
        shinSurf,
        { capStart: false, capEnd: false, ringShades: [0.88, 0.98, 0.94] },
      );
    } else {
      b.sculptLoft(
        [
          b.ellipticRing(0, pantCuffY, lz, ankleR * (shinBare ? 0.96 : 1.16), ankleR * (shinBare ? 0.94 : 1.12), limbSeg),
          b.ellipticRing(0, kneeY + 0.010 * s, lz, kneeR * 1.02, kneeR * 0.98, limbSeg),
        ],
        0xffffff,
        shinSurf,
        { capStart: false, capEnd: false, ringShades: [0.88, 0.95] },
      );
    }

    // 3. Sculpted Shoe seated flush on Y = 0.00 (toe pointing +X)
    b.setZone(PED_ZONE.FIXED);
    const shoeW = 0.088 * s * (1 - 0.08 * fem);
    const shoeLen = 0.235 * s * (1 - 0.08 * fem);
    const heelX = -0.055 * s;
    const soleH = 0.020 * s;
    const upperH = ankleY + 0.016 * s;

    if (isHi) {
      // Flat rubber sole touching Y = 0.00
      b.taperBox(heelX + shoeLen * 0.50, soleY, lz, shoeLen, shoeW, shoeLen * 0.96, shoeW * 0.96, soleH, 0x1e2024, SURF.rubber);
      // Sculpted shoe upper (ankle collar -> instep -> rounded toe box pointing +X)
      const toeX = heelX + shoeLen;
      const shoeRings: Vec3[][] = [
        [
          [heelX, soleH, lz + shoeW * 0.44], [heelX, soleH, lz - shoeW * 0.44],
          [heelX + 0.01 * s, upperH, lz - shoeW * 0.40], [heelX + 0.01 * s, upperH, lz + shoeW * 0.40],
        ],
        [
          [heelX + shoeLen * 0.44, soleH, lz + shoeW * 0.48], [heelX + shoeLen * 0.44, soleH, lz - shoeW * 0.48],
          [heelX + shoeLen * 0.46, upperH * 0.92, lz - shoeW * 0.40], [heelX + shoeLen * 0.46, upperH * 0.92, lz + shoeW * 0.40],
        ],
        [
          [heelX + shoeLen * 0.78, soleH, lz + shoeW * 0.44], [heelX + shoeLen * 0.78, soleH, lz - shoeW * 0.44],
          [heelX + shoeLen * 0.76, soleH + 0.036 * s, lz - shoeW * 0.34], [heelX + shoeLen * 0.76, soleH + 0.036 * s, lz + shoeW * 0.34],
        ],
        [
          [toeX, soleH, lz + shoeW * 0.26], [toeX, soleH, lz - shoeW * 0.26],
          [toeX - 0.008 * s, soleH + 0.020 * s, lz - shoeW * 0.22], [toeX - 0.008 * s, soleH + 0.020 * s, lz + shoeW * 0.22],
        ],
      ];
      b.sculptLoft(shoeRings, spec.shoeColor, PED_SURF.shoe, { capStart: true, capEnd: true, ringShades: [0.90, 1.0, 1.02, 0.96] });
    } else if (isMed) {
      b.taperBox(heelX + shoeLen * 0.50, soleY, lz, shoeLen, shoeW, shoeLen * 0.72, shoeW * 0.84, upperH, spec.shoeColor, PED_SURF.shoe, { oxTop: -0.028 * s, noBottom: true });
    } else {
      // Low LOD compact shoe touching Y=0.00 (noBottom saves 2 tris/shoe while keeping minY = 0.00)
      b.box(heelX + shoeLen * 0.48, soleY, lz, shoeLen * 0.95, upperH, shoeW * 0.96, spec.shoeColor, PED_SURF.shoe, { noBottom: true });
    }
  }

  // ---- E. LEFT & RIGHT ARMS (UPPER ARM WITH SLEEVE + FOREARM + SCULPTED HAND) ----
  const armSides: { sign: -1 | 1; upperPart: number; forePart: number }[] = [
    { sign: -1, upperPart: PED_PART.ARM_L, forePart: PED_PART.FOREARM_L },
    { sign: 1, upperPart: PED_PART.ARM_R, forePart: PED_PART.FOREARM_R },
  ];

  const longSleeve = spec.sleeveLength === 'long';
  const sleeveZone = isVest ? PED_ZONE.FIXED : PED_ZONE.PRIMARY;
  const sleeveColor = isVest ? 0x2d333d : 0xffffff;
  const sleeveSurf = isVest ? PED_SURF.clothFix : PED_SURF.clothTop;
  const armSeg = isHi ? 6 : isMed ? 5 : 4;

  for (const arm of armSides) {
    const shZ = arm.sign * armZ;
    const elZ = shZ;
    const shPivot: Vec3 = [0, shoulderY, shZ];
    const elPivot: Vec3 = [0, elbowY, elZ];

    if (detail === 'low') {
      // Low LOD: 1-segment tapered full arm; pivot2.y = -1 signals single-segment reach for cyclist shader
      b.setPart(arm.upperPart, shPivot, [0, -1, 0]);
      b.setZone(sleeveZone);
      b.sculptLoft(
        [
          b.ellipticRing(0.010 * s, handTipY, elZ, 0.032 * s, 0.025 * s, armSeg, { phase: lowPhase }),
          b.ellipticRing(0, shoulderY + 0.006 * s, shZ, armR * 1.14, armR * 1.06, armSeg, { phase: lowPhase }),
        ],
        sleeveColor,
        sleeveSurf,
        { capStart: true, capEnd: true, ringShades: [0.92, 1.0] },
      );
      continue;
    }

    // 1. Upper Arm (Rounded deltoid shoulder cap -> Sleeve Cuff -> Elbow)
    b.setPart(arm.upperPart, shPivot, elPivot);
    b.setZone(sleeveZone);

    if (isHi) {
      const cuffY = longSleeve ? elbowY + 0.02 * s : (shoulderY + elbowY) * 0.52;
      const capZ = shZ - arm.sign * 0.022 * s;
      b.sculptLoft(
        [
          b.ellipticRing(0, elbowY - 0.006 * s, elZ, foreR * 1.06, foreR * 1.02, armSeg),
          b.ellipticRing(0, cuffY, (shZ + elZ) * 0.5, armR * (longSleeve ? 1.02 : 0.94), armR * (longSleeve ? 0.98 : 0.92), armSeg),
          b.ellipticRing(0, shoulderY - 0.004 * s, shZ, armR * 1.08, armR * 1.02, armSeg),
          b.ellipticRing(0, shoulderY + 0.018 * s, capZ, armR * 0.64, armR * 0.60, armSeg),
        ],
        sleeveColor,
        sleeveSurf,
        {
          capStart: false,
          capEnd: true,
          ringShades: [0.92, 0.98, 1.01, 1.04],
          segOverride: !longSleeve
            ? (si) => (si === 0 ? { zone: PED_ZONE.SKIN, color: 0xffffff, surf: PED_SURF.skin } : null)
            : undefined,
        },
      );
    } else {
      const capZ = shZ - arm.sign * 0.018 * s;
      b.sculptLoft(
        [
          b.ellipticRing(0, elbowY - 0.005 * s, elZ, foreR * 1.06, foreR * 1.02, armSeg),
          b.ellipticRing(0, shoulderY - 0.002 * s, shZ, armR * 1.06, armR * 1.00, armSeg),
          b.ellipticRing(0, shoulderY + 0.015 * s, capZ, armR * 0.66, armR * 0.62, armSeg),
        ],
        sleeveColor,
        sleeveSurf,
        { capStart: false, capEnd: false, ringShades: [0.92, 0.99, 1.02] },
      );
    }

    // 2. Forearm + Hand (Elbow -> Wrist -> Hand)
    b.setPart(arm.forePart, shPivot, elPivot);
    const foreZone = longSleeve ? sleeveZone : PED_ZONE.SKIN;
    const foreColor = longSleeve ? sleeveColor : 0xffffff;
    const foreSurf = longSleeve ? sleeveSurf : PED_SURF.skin;
    b.setZone(foreZone);

    if (isHi) {
      b.sculptLoft(
        [
          b.ellipticRing(0.012 * s, handTipY, elZ, 0.028 * s, 0.016 * s, armSeg),
          b.ellipticRing(0.008 * s, wristY, elZ, 0.032 * s, 0.025 * s, armSeg),
          b.ellipticRing(0.0, elbowY + 0.008 * s, elZ, foreR * 1.04, foreR * 1.00, armSeg),
        ],
        foreColor,
        foreSurf,
        {
          capStart: true,
          capEnd: false,
          ringShades: [0.94, 0.98, 0.94],
          segOverride: (si) => (si === 0 ? { zone: PED_ZONE.SKIN, color: 0xffffff, surf: PED_SURF.skin } : null),
        },
      );
    } else {
      b.sculptLoft(
        [
          b.ellipticRing(0.010 * s, handTipY, elZ, 0.028 * s, 0.020 * s, armSeg),
          b.ellipticRing(0.0, elbowY + 0.008 * s, elZ, foreR * 1.04, foreR * 1.00, armSeg),
        ],
        foreColor,
        foreSurf,
        { capStart: true, capEnd: false, ringShades: [0.94, 0.96] },
      );
    }
  }

  // Keep reference to headCenterY for potential future checks
  void headCenterY;
  return finalizeAsset(spec.id, spec.label, 'people', b);
}

// =============================================================================
// 2. PARAMETRIC BICYCLE GENERATOR (ALIGNED WITH CYCLIST PRESET)
// =============================================================================

export function buildBike(detail: AssetDetail = 'high'): AssetBuildResult {
  const b = new PedMeshBuilder();
  const glow = new PedMeshBuilder();

  const isHi = detail === 'high';
  const isMed = detail === 'med';

  const wheelR = 0.34;
  const frontX = 0.54;
  const rearX = -0.52;
  const bbPos: Vec3 = [0.04, 0.32, 0];
  const seatCluster: Vec3 = [-0.18, 0.78, 0];
  const saddleTop: Vec3 = [-0.20, 0.90, 0];
  const headBot: Vec3 = [0.40, 0.68, 0];
  const headTop: Vec3 = [0.36, 0.86, 0];
  const stemTop: Vec3 = [0.45, 0.98, 0];

  // ---- A. WHEELS (FRONT & REAR, TOUCHING Y = 0.00) ----
  const buildBikeWheel = (cx: number, part: number) => {
    b.setPart(part, [cx, wheelR, 0]);
    b.setZone(PED_ZONE.FIXED);
    const seg = isHi ? 8 : 6;
    const tireW = 0.044;
    const innerR = wheelR - 0.048;
    const rimR = innerR - 0.022;
    const hubR = 0.032;

    if (isHi) {
      // Sculpted hollow tire + alloy rim ring + spokes
      const cosA: number[] = [], sinA: number[] = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2 - Math.PI * 0.5;
        cosA.push(Math.cos(a)); sinA.push(Math.sin(a));
      }
      const hw = tireW * 0.5;
      const rw = tireW * 0.34;
      const outNeg: Vec3[] = [], outPos: Vec3[] = [];
      const inNeg: Vec3[] = [], inPos: Vec3[] = [];
      for (let i = 0; i < seg; i++) {
        outNeg.push([cx + cosA[i] * wheelR, wheelR + sinA[i] * wheelR, -hw]);
        outPos.push([cx + cosA[i] * wheelR, wheelR + sinA[i] * wheelR, hw]);
        inNeg.push([cx + cosA[i] * innerR, wheelR + sinA[i] * innerR, -rw]);
        inPos.push([cx + cosA[i] * innerR, wheelR + sinA[i] * innerR, rw]);
      }
      // Tire tread + sidewalls
      b.sculptLoft([outNeg, outPos], 0x1c1e22, SURF.rubber, { capStart: false, capEnd: false });
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        b.quad(inPos[i], outPos[i], outPos[j], inPos[j], 0x22252a, SURF.rubber);
        b.quad(inNeg[j], outNeg[j], outNeg[i], inNeg[i], 0x22252a, SURF.rubber);
      }
      // Alloy inner rim band
      const rimNeg: Vec3[] = [], rimPos: Vec3[] = [];
      for (let i = 0; i < seg; i++) {
        rimNeg.push([cx + cosA[i] * rimR, wheelR + sinA[i] * rimR, -rw]);
        rimPos.push([cx + cosA[i] * rimR, wheelR + sinA[i] * rimR, rw]);
      }
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        b.quad(rimPos[i], inPos[i], inPos[j], rimPos[j], 0xc4ccd4, SURF.metal);
        b.quad(rimNeg[j], inNeg[j], inNeg[i], rimNeg[i], 0xc4ccd4, SURF.metal);
      }
      // Hub
      b.cylinder(cx, wheelR, 0, hubR, hubR, 0.085, 5, 'z', 0x7b838c, SURF.metal);

      // 3 crossed slender metal spokes
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI;
        const rSpk = rimR + 0.005;
        const dx = Math.cos(a) * rSpk;
        const dy = Math.sin(a) * rSpk;
        b.tube([cx - dx, wheelR - dy, 0], [cx + dx, wheelR + dy, 0], 0.005, 0.005, 3, 0xbcc4cc, SURF.metal, false);
      }
    } else if (isMed) {
      // Med LOD: crisp tire ring + recessed alloy rim disc (52 tris/wheel)
      const cosA: number[] = [], sinA: number[] = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2 - Math.PI * 0.5;
        cosA.push(Math.cos(a)); sinA.push(Math.sin(a));
      }
      const hw = tireW * 0.5;
      const rw = tireW * 0.30;
      const outNeg: Vec3[] = [], outPos: Vec3[] = [];
      const inNeg: Vec3[] = [], inPos: Vec3[] = [];
      for (let i = 0; i < seg; i++) {
        outNeg.push([cx + cosA[i] * wheelR, wheelR + sinA[i] * wheelR, -hw]);
        outPos.push([cx + cosA[i] * wheelR, wheelR + sinA[i] * wheelR, hw]);
        inNeg.push([cx + cosA[i] * innerR, wheelR + sinA[i] * innerR, -rw]);
        inPos.push([cx + cosA[i] * innerR, wheelR + sinA[i] * innerR, rw]);
      }
      b.sculptLoft([outNeg, outPos], 0x1c1e22, SURF.rubber, { capStart: false, capEnd: false });
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        b.quad(inPos[i], outPos[i], outPos[j], inPos[j], 0x22252a, SURF.rubber);
        b.quad(inNeg[j], outNeg[j], outNeg[i], inNeg[i], 0x22252a, SURF.rubber);
      }
      // Subtle translucent/metallic hub+spokes bar
      b.tube([cx - innerR, wheelR, 0], [cx + innerR, wheelR, 0], 0.006, 0.006, 3, 0xbcc4cc, SURF.metal, false);
      b.tube([cx, wheelR - innerR, 0], [cx, wheelR + innerR, 0], 0.006, 0.006, 3, 0xbcc4cc, SURF.metal, false);
    } else {
      // Low LOD hexagonal wheel (bottom aligned to Y = 0.00): dark rubber tread + lighter alloy center disc
      const hw = tireW * 0.5;
      const ringA: Vec3[] = [], ringB: Vec3[] = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2 - Math.PI * 0.5;
        ringA.push([cx + Math.cos(a) * wheelR, wheelR + Math.sin(a) * wheelR, -hw]);
        ringB.push([cx + Math.cos(a) * wheelR, wheelR + Math.sin(a) * wheelR, hw]);
      }
      b.sculptLoft([ringA, ringB], 0x1c1e22, SURF.rubber, {
        capStart: true,
        capEnd: true,
        capColor: 0x9aa4b0,
        capSurf: SURF.metal,
      });
    }
  };

  buildBikeWheel(frontX, PED_PART.WHEEL_F);
  buildBikeWheel(rearX, PED_PART.WHEEL_R);

  // ---- B. DIAMOND TUBULAR FRAME (aZone = 1 PAINTABLE) ----
  b.setPart(PED_PART.STATIC, [0, 0, 0]);
  b.setZone(PED_ZONE.PRIMARY);
  const tSeg = isHi ? 4 : 3;
  const rMain = 0.019;
  const rStay = 0.012;

  // Main diamond: top tube, down tube, seat tube, head tube (head tube merged in low to stay <= 100 tris)
  b.tube(seatCluster, headTop, rMain * 0.95, rMain * 0.95, tSeg, 0xffffff, SURF.paint, false);
  b.tube(bbPos, headBot, rMain * 1.08, rMain * 1.05, tSeg, 0xffffff, SURF.paint, false);
  b.tube(bbPos, seatCluster, rMain, rMain, tSeg, 0xffffff, SURF.paint, false);
  if (detail !== 'low') {
    b.tube(headBot, headTop, rMain * 1.15, rMain * 1.15, tSeg, 0xffffff, SURF.paint, isHi);
  }

  if (isHi) {
    // Twin chainstays, twin seatstays, twin fork blades
    for (const sz of [-1, 1]) {
      b.tube([bbPos[0], bbPos[1], sz * 0.022], [rearX, wheelR, sz * 0.052], rStay, rStay * 0.85, 3, 0xffffff, SURF.paint, false);
      b.tube([seatCluster[0], seatCluster[1], sz * 0.018], [rearX, wheelR, sz * 0.052], rStay * 0.9, rStay * 0.8, 3, 0xffffff, SURF.paint, false);
      b.tube([headBot[0], headBot[1], sz * 0.022], [frontX, wheelR, sz * 0.050], rStay * 1.1, rStay * 0.9, 3, 0xffffff, SURF.paint, false);
    }
  } else {
    // Single centered stays & fork for med/low
    b.tube(bbPos, [rearX, wheelR, 0], rStay * 1.2, rStay, 3, 0xffffff, SURF.paint, false);
    if (isMed) b.tube(seatCluster, [rearX, wheelR, 0], rStay * 1.1, rStay, 3, 0xffffff, SURF.paint, false);
    b.tube(headBot, [frontX, wheelR, 0], rStay * 1.3, rStay, 3, 0xffffff, SURF.paint, false);
  }

  // ---- C. SEATPOST, SADDLE, HANDLEBARS, CRANKSET & LIGHTS ----
  b.setZone(PED_ZONE.FIXED);

  // Seatpost & sculpted saddle (saddle top at (-0.20, 0.90, 0))
  b.tube(seatCluster, [saddleTop[0], saddleTop[1] - 0.02, 0], 0.013, 0.013, tSeg, 0x9aa3ad, SURF.metal, false);
  b.taperBox(saddleTop[0] + 0.01, saddleTop[1] - 0.042, 0, 0.25, 0.135, 0.21, 0.085, 0.044, 0x1e2024, SURF.rubber, { oxTop: 0.025, noBottom: !isHi });

  // Stem & curved handlebars with rubber grips at (+0.46, 0.99, ±0.25)
  b.tube(headTop, stemTop, 0.015, 0.015, tSeg, 0x9aa3ad, SURF.metal, false);
  if (isHi) {
    b.tube([stemTop[0], stemTop[1], -0.17], [stemTop[0], stemTop[1], 0.17], 0.012, 0.012, 4, 0xb4bcc6, SURF.metal, false);
    for (const sz of [-1, 1]) {
      b.tube([stemTop[0], stemTop[1], sz * 0.16], [stemTop[0] + 0.01, stemTop[1] + 0.01, sz * 0.27], 0.017, 0.017, 4, 0x1c1e22, SURF.rubber, true);
    }
  } else {
    b.tube([stemTop[0], stemTop[1], -0.25], [stemTop[0], stemTop[1], 0.25], 0.015, 0.015, 3, 0x2a2e35, SURF.metal, false);
  }

  // Animated crankset & pedals (PART_CRANK = 13, pivoted at bbPos, exact lockstep with cyclist 2-bone IK feet!)
  if (isHi || isMed) {
    b.setPart(PED_PART.CRANK, bbPos);
    b.cylinder(bbPos[0], bbPos[1], 0.042, 0.085, 0.085, 0.016, isHi ? 6 : 5, 'z', 0x525a64, SURF.metal);
    if (isHi) {
      // Left crank (-Z) at rest angle 0 (+X, radius 0.13); right crank (+Z) at rest angle PI (-X, radius 0.13)
      b.tube([bbPos[0], bbPos[1], -0.055], [bbPos[0] + 0.13, bbPos[1], -0.095], 0.010, 0.009, 3, 0x8e96a0, SURF.metal, false);
      b.tube([bbPos[0], bbPos[1], 0.055], [bbPos[0] - 0.13, bbPos[1], 0.095], 0.010, 0.009, 3, 0x8e96a0, SURF.metal, false);
      b.box(bbPos[0] + 0.13, bbPos[1] - 0.012, -0.115, 0.085, 0.022, 0.068, 0x1c1e22, SURF.rubber, { noBottom: true });
      b.box(bbPos[0] - 0.13, bbPos[1] - 0.012, 0.115, 0.085, 0.022, 0.068, 0x1c1e22, SURF.rubber, { noBottom: true });
    }
    b.setPart(PED_PART.STATIC, [0, 0, 0]);
  }

  // Headlight & taillight housings (high only) + paired glow emissives
  if (isHi) {
    b.box(0.45, 0.91, 0, 0.055, 0.045, 0.045, 0x252a32, SURF.metal, { noBottom: true });
    b.box(-0.31, 0.85, 0, 0.035, 0.035, 0.042, 0x252a32, SURF.rubber, { noBottom: true });
  }

  glow.setPart(PED_PART.STATIC, [0, 0, 0]);
  glow.setZone(PED_ZONE.FIXED);
  // White front headlight (+X)
  glow.box(0.486, 0.914, 0, 0.024, 0.036, 0.038, 0xfff3cc, SURF.matte);
  // Red rear taillight (-X)
  glow.box(-0.334, 0.854, 0, 0.022, 0.028, 0.036, 0xff2828, SURF.matte);

  return finalizeAsset('bike', 'Bicicleta Urbana', 'people', b, glow);
}

// =============================================================================
// 3. PARAMETRIC SCALLOPED UMBRELLA GENERATOR (INSPIRED BY createUmbrella)
// =============================================================================

export function buildUmbrella(detail: AssetDetail = 'high'): AssetBuildResult {
  const b = new PedMeshBuilder();
  b.setPart(PED_PART.STATIC, [0, 0, 0]);

  const isHi = detail === 'high';
  const isMed = detail === 'med';

  const sectors = isHi ? 12 : isMed ? 8 : 6;
  const canopyRadius = 0.56;
  const topY = 0.96;
  const depth = 0.19;

  // ---- A. SCALLOPED PARABOLIC CANOPY (aZone = 1, DOUBLE-SIDED SOLID SHELL) ----
  b.setZone(PED_ZONE.PRIMARY);
  const rings = isHi ? [0.0, 0.50, 1.0] : isMed ? [0.0, 0.55, 1.0] : [0.0, 1.0];
  const rimPts: Vec3[][] = [];

  for (let rIdx = 0; rIdx < rings.length; rIdx++) {
    const u = rings[rIdx];
    const ring: Vec3[] = [];
    for (let i = 0; i < sectors; i++) {
      const theta = (i / sectors) * Math.PI * 2;
      const y = topY - depth * u * u;
      const rad = canopyRadius * u;
      ring.push([Math.cos(theta) * rad, y, Math.sin(theta) * rad]);
    }
    rimPts.push(ring);
  }

  // Emit outer (top) and inner (underside) canopy faces with alternating panel tones
  const apex: Vec3 = [0, topY, 0];
  const apexUnder: Vec3 = [0, topY - 0.008, 0];
  const underOffset = (p: Vec3): Vec3 => [p[0] * 0.992, p[1] - 0.008, p[2] * 0.992];

  for (let i = 0; i < sectors; i++) {
    const j = (i + 1) % sectors;
    const panelShade = i % 2 === 0 ? 1.0 : 0.90;
    const topCol = grayHex(panelShade);
    const botCol = grayHex(panelShade * 0.78);

    // First ring around apex
    const p1a = rimPts[1][i];
    const p1b = rimPts[1][j];
    // Top face (normal points +Y outward: apex -> p1b -> p1a)
    b.tri(apex, p1b, p1a, topCol, PED_SURF.canopy);
    // Underside face (normal points -Y inward)
    b.tri(apexUnder, underOffset(p1a), underOffset(p1b), botCol, PED_SURF.canopy);

    // Outer ring(s) with scalloped edge droop on rib tips in high/med
    for (let r = 1; r < rings.length - 1; r++) {
      const a = rimPts[r][i];
      const d = rimPts[r][j];
      const c = rimPts[r + 1][i];
      const e = rimPts[r + 1][j];

      if (isHi && r === rings.length - 2) {
        // Scalloped midpoint slightly lifted & pulled inward between two ribs
        const midTheta = ((i + 0.5) / sectors) * Math.PI * 2;
        const midRad = canopyRadius * 0.965;
        const midPt: Vec3 = [Math.cos(midTheta) * midRad, topY - depth + 0.022, Math.sin(midTheta) * midRad];
        b.tri(a, d, midPt, topCol, PED_SURF.canopy);
        b.tri(a, midPt, c, topCol, PED_SURF.canopy);
        b.tri(d, e, midPt, topCol, PED_SURF.canopy);
        // Underside
        const ua = underOffset(a), ud = underOffset(d), uc = underOffset(c), ue = underOffset(e), um = underOffset(midPt);
        b.tri(ua, um, ud, botCol, PED_SURF.canopy);
        b.tri(ua, uc, um, botCol, PED_SURF.canopy);
        b.tri(ud, um, ue, botCol, PED_SURF.canopy);
      } else {
        b.quad(a, d, e, c, topCol, PED_SURF.canopy);
        b.quad(underOffset(d), underOffset(a), underOffset(c), underOffset(e), botCol, PED_SURF.canopy);
      }
    }
  }

  // ---- B. METAL SHAFT, FINIAL TIP, INTERNAL RIBS & J-HOOK HANDLE (minY = 0.00) ----
  b.setZone(PED_ZONE.FIXED);

  // Main shaft + finial tip
  b.tube([0, 0.055, 0], [0, topY + 0.045, 0], 0.0085, 0.0065, isHi ? 5 : 4, 0x9aa6b2, SURF.metal, true);

  if (isHi) {
    // Runner collar & 6 internal ribs/stretchers
    b.cylinder(0, 0.74, 0, 0.017, 0.017, 0.028, 5, 'y', 0x313944, SURF.metal);
    for (let i = 0; i < 6; i++) {
      const theta = (i / 6) * Math.PI * 2;
      const midPt: Vec3 = [Math.cos(theta) * canopyRadius * 0.56, topY - depth * 0.36 - 0.01, Math.sin(theta) * canopyRadius * 0.56];
      b.tube([0, 0.74, 0], midPt, 0.004, 0.004, 3, 0x86929e, SURF.metal, false);
    }
  }

  // Curved J-hook handle touching Y = 0.00 (curving toward -X)
  if (isHi || isMed) {
    const hPts: Vec3[] = [
      [0, 0.15, 0],
      [0, 0.055, 0],
      [-0.018, 0.014, 0],
      [-0.052, 0.014, 0],
      [-0.068, 0.055, 0],
    ];
    for (let k = 0; k < hPts.length - 1; k++) {
      b.tube(hPts[k], hPts[k + 1], 0.014, 0.014, 4, 0x1e2228, SURF.rubber, k === 0 || k === hPts.length - 2);
    }
  } else {
    b.box(0, 0.0, 0, 0.032, 0.14, 0.032, 0x1e2228, SURF.rubber);
  }

  return finalizeAsset('umbrella', 'Guarda-Chuva', 'people', b);
}

// =============================================================================
// 4. PARAMETRIC ROLLING LUGGAGE GENERATOR (minY = 0.00)
// =============================================================================

export function buildLuggage(detail: AssetDetail = 'high'): AssetBuildResult {
  const b = new PedMeshBuilder();
  b.setPart(PED_PART.STATIC, [0, 0, 0]);

  const isHi = detail === 'high';
  const isMed = detail === 'med';

  const sx = 0.25; // thickness along X (rolling direction)
  const sy = 0.54; // shell height
  const sz = 0.39; // width along Z
  const wheelH = 0.052;

  // ---- A. HARD-SHELL BODY (aZone = 1 PAINTABLE) ----
  b.setZone(PED_ZONE.PRIMARY);
  if (isHi) {
    b.bevelBox(0, wheelH, 0, sx, sy, sz, 0.038, 0xffffff, PED_SURF.luggage);
    // Molded horizontal grip ribs on ±X faces
    for (const ry of [wheelH + 0.14, wheelH + 0.27, wheelH + 0.40]) {
      b.box(0, ry - 0.012, 0, sx + 0.014, 0.022, sz * 0.78, grayHex(0.92), PED_SURF.luggage);
    }
  } else if (isMed) {
    b.taperBox(0, wheelH, 0, sx, sz, sx * 0.94, sz * 0.96, sy, 0xffffff, PED_SURF.luggage);
  } else {
    b.box(0, wheelH, 0, sx, sy, sz, 0xffffff, PED_SURF.luggage);
  }

  // ---- B. ZIPPER TRIM, TELESCOPING METAL HANDLE & CASTER WHEELS (minY = 0.00) ----
  b.setZone(PED_ZONE.FIXED);
  if (isHi || isMed) {
    // Center seam/zipper dark band
    b.box(0, wheelH + 0.015, 0, 0.022, sy - 0.02, sz + 0.010, 0x1e2228, SURF.rubber);
  }

  // Dual telescoping handle rails + top grip
  const handleTopY = wheelH + sy + 0.34;
  if (isHi || isMed) {
    for (const hz of [-0.075, 0.075]) {
      b.tube([0, wheelH + sy - 0.02, hz], [0, handleTopY - 0.015, hz], 0.010, 0.010, 4, 0xaab3bd, SURF.metal, false);
    }
    b.box(0, handleTopY - 0.026, 0, 0.030, 0.032, 0.19, 0x1e2228, SURF.rubber);
  } else {
    b.box(0, wheelH + sy, 0, 0.026, 0.32, 0.15, 0x8e96a0, SURF.metal);
  }

  // Caster wheels resting cleanly at Y = 0.00
  if (isHi) {
    for (const wx of [-sx * 0.32, sx * 0.32]) {
      for (const wz of [-sz * 0.36, sz * 0.36]) {
        b.cylinder(wx, wheelH * 0.5, wz, wheelH * 0.5, wheelH * 0.5, 0.028, 5, 'z', 0x1a1c20, SURF.rubber);
      }
    }
  } else {
    for (const wz of [-sz * 0.34, sz * 0.34]) {
      b.box(0, 0.0, wz, sx * 0.72, wheelH, 0.055, 0x1a1c20, SURF.rubber);
    }
  }

  return finalizeAsset('luggage', 'Mala de Rodinhas', 'people', b);
}

/** Build any asset in the `people` family (pedestrians, cyclist, bike, umbrella, luggage). */
export function buildPeopleAsset(id: PeopleAssetId, detail: AssetDetail = 'high'): AssetBuildResult {
  if (id === 'bike') return buildBike(detail);
  if (id === 'umbrella') return buildUmbrella(detail);
  if (id === 'luggage') return buildLuggage(detail);
  return buildPedestrian(id, detail);
}
