import {
  MeshBuilder,
  SURF,
  finalizeAsset,
  type AssetBuildResult,
  type AssetDetail,
  type SurfMat,
  type Vec3,
} from './meshKit';

export type RailCarId = 'loco' | 'passenger' | 'container' | 'hopper' | 'tank' | 'metro';

/** Standard gauge half-width matching `src/render/railLayer.ts` (`r = ±0.75 m`). */
export const RAIL_GAUGE_HALF = 0.75;

/** Nominal slot lengths from `src/sim/rail.ts` (`CAR_LEN = [17, 20, 17, 15, 16, 19]`). */
export const RAIL_SLOT_LEN = [17, 20, 17, 15, 16, 19] as const;

export const RAIL_CAR_IDS: readonly RailCarId[] = [
  'loco',
  'passenger',
  'container',
  'hopper',
  'tank',
  'metro',
] as const;

export const RAIL_LOCO_PALETTE = [0xb8382c, 0x26548a, 0x2b6b46, 0xc98a22];
export const RAIL_PASSENGER_PALETTE = [0x285c94, 0x9e2f38, 0x257856, 0xc88224];
export const RAIL_CONTAINER_PALETTE = [0x2b6294, 0xb84a34, 0x2a7668, 0xc98c24, 0x45505e, 0x356e48];
export const RAIL_HOPPER_PALETTE = [0x7a543e, 0x4b5866, 0xa87a34, 0x3b634b];
export const RAIL_TANK_PALETTE = [0xc6cdd2, 0x363d46, 0xe4e8ec, 0x9c3e34];
export const RAIL_METRO_PALETTE = [0x2e8a62, 0xc0392b, 0x2663b0, 0xd9a01e];

export interface RailCarSpec {
  id: RailCarId;
  index: number;
  label: string;
  category: 'locomotive' | 'passenger' | 'freight' | 'metro';
  maxSlotLen: number;
  /** Structural underframe length (X span before couplers/bellows). */
  frameLen: number;
  /** Nominal body width (m). */
  width: number;
  /** Bogie center X offset (±bogieX). */
  bogieX: number;
  /** Wheel radius (m). */
  wheelRadius: number;
  /** Number of axles per bogie at high detail (2 or 3). */
  bogieAxlesHigh: 2 | 3;
  /** Whether the car has a paired night glow mesh. */
  hasGlow: boolean;
}

export interface RailCarPreset {
  id: RailCarId;
  index: number;
  label: string;
  category: RailCarSpec['category'];
  maxSlotLen: number;
  defaultColor: number;
  swatches: number[];
  hasGlow: boolean;
  spec: RailCarSpec;
}

// Shared railway surface finishes (avoid mirror-like glare on matte steel decks/roofs while keeping brushed stainless sides)
const SURF_DECK: SurfMat = { tint: 0, roughness: 0.80, metalness: 0.14 };
const SURF_STEEL_SATIN: SurfMat = { tint: 0, roughness: 0.56, metalness: 0.28 };
const SURF_ROOF_SATIN: SurfMat = { tint: 0, roughness: 0.64, metalness: 0.18 };
const SURF_PAINT_SATIN: SurfMat = { tint: 1, roughness: 0.72, metalness: 0.08 };
const SURF_PAINT_FIXED_SATIN: SurfMat = { tint: 0, roughness: 0.72, metalness: 0.08 };

// Shared railway palette constants
const WHITE = 0xffffff;
const PAINT_SHADE = 0xe6e9ee;
const FRAME_DARK = 0x272c33;
const FRAME_MID = 0x383f48;
const BOGIE_DARK = 0x22272e;
const BOGIE_STEEL = 0x454d58;
const WHEEL_TREAD = 0x9aa4b0;
const WHEEL_DISC = 0x525a66;
const WHEEL_HUB = 0x737d8a;
const STEEL_BRIGHT = 0xc6ced8;
const STEEL_MID = 0x7d8792;
const STEEL_DARK = 0x4c545e;
const ROOF_METAL = 0x5c646e;
const BODY_SILVER = 0xdbe1e8;
const METRO_SILVER = 0xe5eaf0;
const RUBBER_DARK = 0x1e2229;
const RUBBER_MID = 0x2e343e;
const GLASS_TRAIN = 0x2b455a;
const GLASS_METRO = 0x22384b;
const LENS_HEAD = 0xdce6f0;
const LENS_TAIL = 0x8f2424;
const SAFETY_YELLOW = 0xf0b82a;
const CONTAINER_ALT = 0xb44e38;
const CONTAINER_ALT_SHADE = 0x8d3a28;
const CARGO_ORE = 0x3b3530;
const CARGO_PEAK = 0x4e463f;

const GLOW_HEAD_WARM = 0xfff3d4;
const GLOW_HEAD_LED = 0xedf7ff;
const GLOW_TAIL_RED = 0xff2824;
const GLOW_WIN_WARM = 0xffdc9a;
const GLOW_DEST_AMBER = 0xffd268;

/** Exact wheel center Y so the lowest polygon vertex rests at Y = 0.000 across all segment counts. */
function wheelCenterY(radius: number, seg: number): number {
  let minS = 0;
  for (let i = 0; i < seg; i++) {
    const s = Math.sin((i / seg) * Math.PI * 2);
    if (s < minS) minS = s;
  }
  return -minS * radius;
}

/** Emit a plate facing +X (outward normal [+1, 0, 0]). */
function quadFrontX(
  b: MeshBuilder,
  x: number,
  y0: number,
  y1: number,
  cz: number,
  w: number,
  color: number,
  surf: SurfMat,
) {
  const hw = w * 0.5;
  b.quad(
    [x, y0, cz + hw],
    [x, y0, cz - hw],
    [x, y1, cz - hw],
    [x, y1, cz + hw],
    color,
    surf,
    [1, 0, 0],
  );
}

/** Emit a plate facing -X (outward normal [-1, 0, 0]). */
function quadRearX(
  b: MeshBuilder,
  x: number,
  y0: number,
  y1: number,
  cz: number,
  w: number,
  color: number,
  surf: SurfMat,
) {
  const hw = w * 0.5;
  b.quad(
    [x, y0, cz - hw],
    [x, y0, cz + hw],
    [x, y1, cz + hw],
    [x, y1, cz - hw],
    color,
    surf,
    [-1, 0, 0],
  );
}

/**
 * Steel flanged railway wheel oriented along Z (rolling along +X), centered on the exact rail gauge.
 * Polygon-fan caps minimize triangles while keeping the mesh crisp in close-ups.
 */
function addRailWheel(
  b: MeshBuilder,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  width: number,
  seg: number,
  outerSign: 1 | -1,
  includeInnerCap = true,
) {
  const hw = width * 0.5;
  const cosA: number[] = [];
  const sinA: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    cosA.push(Math.cos(a));
    sinA.push(Math.sin(a));
  }

  // Steel running tread cylinder (2 * seg tris)
  const ringNeg: Vec3[] = [];
  const ringPos: Vec3[] = [];
  for (let i = 0; i < seg; i++) {
    const px = cx + cosA[i] * radius;
    const py = cy + sinA[i] * radius;
    ringNeg.push([px, py, cz - hw]);
    ringPos.push([px, py, cz + hw]);
  }
  b.loft([ringNeg, ringPos], WHEEL_TREAD, SURF.metal, { capStart: false, capEnd: false });

  // Watertight polygon-fan side discs (seg - 2 tris per face instead of seg)
  const capDisc = (sign: 1 | -1, color: number) => {
    const z = cz + sign * hw;
    const nVec: Vec3 = [0, 0, sign];
    const p0: Vec3 = [cx + cosA[0] * radius, cy + sinA[0] * radius, z];
    for (let i = 1; i < seg - 1; i++) {
      const p1: Vec3 = [cx + cosA[i] * radius, cy + sinA[i] * radius, z];
      const p2: Vec3 = [cx + cosA[i + 1] * radius, cy + sinA[i + 1] * radius, z];
      if (sign > 0) b.tri(p0, p1, p2, color, SURF.metal, nVec);
      else b.tri(p0, p2, p1, color, SURF.metal, nVec);
    }
  };
  capDisc(outerSign, WHEEL_DISC);
  if (includeInnerCap) capDisc((-outerSign) as 1 | -1, BOGIE_DARK);
}

/** Compact full-width steel wheelset drum for low LOD (exact Y = 0 contact, spans exact rail gauge ±0.75 m). */
function addWheelsetLow(b: MeshBuilder, cx: number, cy: number, radius: number, seg = 6) {
  const zOut = RAIL_GAUGE_HALF + 0.08;
  const cosA: number[] = [];
  const sinA: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    cosA.push(Math.cos(a));
    sinA.push(Math.sin(a));
  }
  const ringNeg: Vec3[] = [];
  const ringPos: Vec3[] = [];
  for (let i = 0; i < seg; i++) {
    const px = cx + cosA[i] * radius;
    const py = cy + sinA[i] * radius;
    ringNeg.push([px, py, -zOut]);
    ringPos.push([px, py, zOut]);
  }
  b.loft([ringNeg, ringPos], WHEEL_TREAD, SURF.metal, { capStart: false, capEnd: false });
  for (const sign of [-1, 1] as const) {
    const z = sign * zOut;
    const nVec: Vec3 = [0, 0, sign];
    const p0: Vec3 = [cx + cosA[0] * radius, cy + sinA[0] * radius, z];
    for (let i = 1; i < seg - 1; i++) {
      const p1: Vec3 = [cx + cosA[i] * radius, cy + sinA[i] * radius, z];
      const p2: Vec3 = [cx + cosA[i + 1] * radius, cy + sinA[i + 1] * radius, z];
      if (sign > 0) b.tri(p0, p1, p2, WHEEL_DISC, SURF.metal, nVec);
      else b.tri(p0, p2, p1, WHEEL_DISC, SURF.metal, nVec);
    }
  }
}

/**
 * Structural railway bogie (truck): steel wheels seated on exact `±0.75 m` rail gauge (`minY = 0.000`),
 * sideframes, axle journal boxes, coil-spring suspension bolster connecting directly into the car chassis.
 */
function addBogie(
  b: MeshBuilder,
  cx: number,
  cfg: {
    wheelRadius: number;
    axlesHigh: 2 | 3;
    chassisBotY: number;
    wheelbase2?: number;
    wheelbase3?: number;
  },
  detail: AssetDetail,
) {
  const r = cfg.wheelRadius;
  const nAxles: 2 | 3 = detail === 'high' ? cfg.axlesHigh : 2;
  const seg = detail === 'high' ? (nAxles === 3 ? 6 : 8) : 6;
  const cy = wheelCenterY(r, seg);
  const wb2 = cfg.wheelbase2 ?? 2.15;
  const wb3 = cfg.wheelbase3 ?? 3.50;
  const axleOffsets = nAxles === 3 ? [-wb3 * 0.5, 0, wb3 * 0.5] : [-wb2 * 0.5, wb2 * 0.5];
  const frameLen = (nAxles === 3 ? wb3 : wb2) + r * 1.45;

  if (detail === 'low') {
    for (const ax of axleOffsets) addWheelsetLow(b, cx + ax, cy, r, 6);
    const bBot = Math.max(0.28, cy - 0.08);
    b.box(cx, bBot, 0, frameLen, cfg.chassisBotY + 0.04 - bBot, 2.08, BOGIE_DARK, SURF.metal, { noBottom: true });
    return;
  }

  // Individual flanged steel wheels on exact ±0.75 m gauge
  const keepInner = detail === 'high';
  for (const ax of axleOffsets) {
    const wx = cx + ax;
    addRailWheel(b, wx, cy, RAIL_GAUGE_HALF, r, 0.14, seg, 1, keepInner);
    addRailWheel(b, wx, cy, -RAIL_GAUGE_HALF, r, 0.14, seg, -1, keepInner);
    // Steel axle bar connecting left & right wheels at high detail (omitted on 3-axle loco to keep budget crisp)
    if (detail === 'high' && nAxles === 2) {
      b.box(wx, cy - 0.075, 0, 0.15, 0.15, RAIL_GAUGE_HALF * 1.88, BOGIE_STEEL, SURF.metal, { noBottom: true });
    }
  }

  // Structural sideframes outside the wheels (z = ±0.96 m)
  const sfZ = RAIL_GAUGE_HALF + 0.21;
  const sfY0 = cy - 0.06;
  const sfH = Math.max(0.32, cfg.chassisBotY - sfY0 - 0.04);
  for (const sd of [-1, 1] as const) {
    b.box(cx, sfY0, sd * sfZ, frameLen, sfH, 0.16, BOGIE_DARK, SURF_DECK, { noBottom: detail !== 'high' });
  }

  // Central bolster & secondary suspension connecting bogie cleanly up into chassis (zero floating gap)
  const bolY0 = cy + 0.04;
  const bolH = Math.max(0.30, cfg.chassisBotY + 0.06 - bolY0);
  b.box(cx, bolY0, 0, nAxles === 3 ? 1.55 : 1.05, bolH, (sfZ + 0.10) * 2, FRAME_MID, SURF_DECK, { noBottom: true });

  // Detailed axle journal boxes & coil springs on outer sideframes (high detail)
  if (detail === 'high') {
    const zOuter = sfZ + 0.08;
    const zCap = sfZ + 0.15;
    for (const ax of axleOffsets) {
      const wx = cx + ax;
      const jy0 = cy - 0.11;
      const jy1 = cy + 0.13;
      const hx = 0.14;
      // Outer journal cap + front/back/top bevels mirrored across Z (only visible faces)
      b.quadMirroredZ([wx - hx, jy0, zCap], [wx + hx, jy0, zCap], [wx + hx, jy1, zCap], [wx - hx, jy1, zCap], WHEEL_HUB, SURF.metal);
      b.quadMirroredZ([wx - hx, jy1, zCap], [wx + hx, jy1, zCap], [wx + hx, jy1, zOuter], [wx - hx, jy1, zOuter], BOGIE_STEEL, SURF.metal);
    }
    // Spring cluster relief block at center of sideframe
    const sy0 = sfY0 + 0.03;
    const sy1 = Math.min(cfg.chassisBotY - 0.02, sy0 + 0.28);
    b.quadMirroredZ([cx - 0.28, sy0, zCap + 0.01], [cx + 0.28, sy0, zCap + 0.01], [cx + 0.28, sy1, zCap + 0.01], [cx - 0.28, sy1, zCap + 0.01], STEEL_MID, SURF.metal);
  }
}

/**
 * Heavy structural rail car underframe with end buffer beams and optional between-bogie underfloor equipment.
 */
function addChassis(
  b: MeshBuilder,
  xRear: number,
  xFront: number,
  yBot: number,
  yTop: number,
  halfW: number,
  opts: {
    color?: number;
    endSillColor?: number;
    underEquip?: { len: number; yBot: number; halfW: number; color?: number };
    noTop?: boolean;
  },
  detail: AssetDetail,
) {
  const len = xFront - xRear;
  const cx = (xRear + xFront) * 0.5;
  const col = opts.color ?? FRAME_DARK;
  b.box(cx, yBot, 0, len, yTop - yBot, halfW * 2, col, SURF_DECK);

  if (opts.endSillColor !== undefined && detail !== 'low') {
    const sy0 = yBot + 0.04;
    const sy1 = yTop - 0.04;
    quadFrontX(b, xFront + 0.008, sy0, sy1, 0, halfW * 1.92, opts.endSillColor, SURF.paintFixed);
    quadRearX(b, xRear - 0.008, sy0, sy1, 0, halfW * 1.92, opts.endSillColor, SURF.paintFixed);
  }

  if (opts.underEquip && detail !== 'low') {
    const eq = opts.underEquip;
    const eqCol = eq.color ?? FRAME_MID;
    if (detail === 'high') {
      // Chamfered underfloor tank/equipment module between the two bogies
      const hx = eq.len * 0.5;
      const hw = eq.halfW;
      const y0 = eq.yBot;
      const yMid = y0 + (yBot - y0) * 0.35;
      const ring = (x: number): Vec3[] => [
        [x, y0, hw * 0.78],
        [x, y0, -hw * 0.78],
        [x, yMid, -hw],
        [x, yBot + 0.03, -hw],
        [x, yBot + 0.03, hw],
        [x, yMid, hw],
      ];
      b.loft([ring(-hx), ring(hx)], eqCol, SURF_DECK, { capStart: true, capEnd: true });
    } else {
      b.box(0, eq.yBot, 0, eq.len, yBot + 0.03 - eq.yBot, eq.halfW * 2, eqCol, SURF_DECK, { noBottom: false });
    }
  }
}

/**
 * Central railway knuckle couplers at both ends + optional rubber inter-car gangway bellows (`sanfonas`).
 * Guarantees total car length stays strictly <= `CAR_LEN[type] - 0.35 m`.
 */
function addCouplers(
  b: MeshBuilder,
  xRear: number,
  xFront: number,
  yCenter: number,
  opts: {
    couplerReach?: number;
    gangwayRear?: { yBot: number; yTop: number; halfW: number; depth: number };
    gangwayFront?: { yBot: number; yTop: number; halfW: number; depth: number };
    frontCoupler?: boolean;
    rearCoupler?: boolean;
  },
  detail: AssetDetail,
) {
  const reach = opts.couplerReach ?? 0.38;
  const doFront = opts.frontCoupler ?? true;
  const doRear = opts.rearCoupler ?? true;

  const emitCoupler = (xEnd: number, sign: 1 | -1) => {
    if (detail === 'low') {
      // Compact coupler stub preserves exact visual length without eating low-LOD budget
      b.box(xEnd + sign * (reach * 0.48), yCenter - 0.09, 0, reach * 0.96, 0.18, 0.28, BOGIE_DARK, SURF.metal, { noBottom: true });
      return;
    }
    // Shank extending from draft pocket
    const shankLen = reach * 0.64;
    b.box(xEnd + sign * (shankLen * 0.5), yCenter - 0.075, 0, shankLen, 0.15, 0.18, BOGIE_STEEL, SURF.metal);
    // Wider knuckle head at tip
    const headLen = reach * 0.38;
    const headCx = xEnd + sign * (reach - headLen * 0.5);
    b.box(headCx, yCenter - 0.11, 0, headLen, 0.22, 0.32, BOGIE_DARK, SURF.metal);
  };

  if (doFront) emitCoupler(xFront, 1);
  if (doRear) emitCoupler(xRear, -1);

  const emitGangway = (xEnd: number, sign: 1 | -1, gw: { yBot: number; yTop: number; halfW: number; depth: number }) => {
    const cx = xEnd + sign * (gw.depth * 0.5);
    const h = gw.yTop - gw.yBot;
    b.box(cx, gw.yBot, 0, gw.depth, h, gw.halfW * 2, RUBBER_DARK, SURF.rubber);
    if (detail === 'high') {
      // Inner steel diaphragm frame + center pleat collar
      const xFace = xEnd + sign * (gw.depth + 0.008);
      if (sign > 0) quadFrontX(b, xFace, gw.yBot + 0.14, gw.yTop - 0.14, 0, gw.halfW * 1.48, FRAME_DARK, SURF.metal);
      else quadRearX(b, xFace, gw.yBot + 0.14, gw.yTop - 0.14, 0, gw.halfW * 1.48, FRAME_DARK, SURF.metal);
      b.box(cx, gw.yBot + 0.04, 0, gw.depth * 0.26, h - 0.08, gw.halfW * 2 + 0.06, RUBBER_MID, SURF.rubber, { noBottom: true });
    }
  };

  if (opts.gangwayRear) emitGangway(xRear, -1, opts.gangwayRear);
  if (opts.gangwayFront) emitGangway(xFront, 1, opts.gangwayFront);
}

/**
 * Evaluate half-width Z(y) of an 8-point domed railway coach profile so doors, windows, stripes & glow
 * hug the curved sidewall with strictly ordered positive offsets and zero Z-fighting.
 */
interface CoachProfile {
  ySkirt: number;
  yBelt: number;
  yEave: number;
  yCrown: number;
  yPeak: number;
  hwSkirt: number;
  hwBody: number;
  hwEave: number;
  hwCrown: number;
}

function makeCoachRing(x: number, p: CoachProfile, insetX = 0, scaleZ = 1): Vec3[] {
  const xx = x + insetX;
  const s = scaleZ;
  return [
    [xx, p.ySkirt, p.hwSkirt * s],
    [xx, p.ySkirt, -p.hwSkirt * s],
    [xx, p.yBelt, -p.hwBody * s],
    [xx, p.yEave, -p.hwEave * s],
    [xx, p.yCrown, -p.hwCrown * s],
    [xx, p.yPeak, 0],
    [xx, p.yCrown, p.hwCrown * s],
    [xx, p.yEave, p.hwEave * s],
    [xx, p.yBelt, p.hwBody * s],
  ];
}

function evalCoachHalfW(p: CoachProfile, y: number): number {
  if (y <= p.ySkirt) return p.hwSkirt;
  if (y <= p.yBelt) {
    const t = (y - p.ySkirt) / Math.max(1e-4, p.yBelt - p.ySkirt);
    return p.hwSkirt + (p.hwBody - p.hwSkirt) * t;
  }
  const t = Math.min(1, (y - p.yBelt) / Math.max(1e-4, p.yEave - p.yBelt));
  return p.hwBody + (p.hwEave - p.hwBody) * t;
}

/** Emit a side panel quad hugging the curved coach profile (mirrored across Z=0). */
function addCoachSideQuad(
  b: MeshBuilder,
  p: CoachProfile,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  zOff: number,
  color: number,
  surf: SurfMat,
) {
  const z0 = evalCoachHalfW(p, y0) + zOff;
  const z1 = evalCoachHalfW(p, y1) + zOff;
  b.quadMirroredZ([x0, y0, z0], [x1, y0, z0], [x1, y1, z1], [x0, y1, z1], color, surf);
}

/** Build a domed curved-roof railway coach shell (shared by `passenger` and `metro`). */
function buildCurvedCoachShell(
  b: MeshBuilder,
  p: CoachProfile,
  xRear: number,
  xFront: number,
  opts: {
    bodyColor: number;
    bodySurf: SurfMat;
    roofColor: number;
    roofSurf: SurfMat;
    skirtColor: number;
    capFront?: boolean;
    capRear?: boolean;
    endColor?: number;
  },
  detail: AssetDetail,
) {
  if (detail === 'low') {
    // 6-vertex low-poly arched coach cross section
    const ringLow = (x: number): Vec3[] => [
      [x, p.ySkirt, p.hwSkirt],
      [x, p.ySkirt, -p.hwSkirt],
      [x, p.yEave, -p.hwEave],
      [x, p.yPeak, -p.hwCrown * 0.72],
      [x, p.yPeak, p.hwCrown * 0.72],
      [x, p.yEave, p.hwEave],
    ];
    b.loft([ringLow(xRear), ringLow(xFront)], opts.bodyColor, opts.bodySurf, {
      capStart: opts.capRear ?? true,
      capEnd: opts.capFront ?? true,
      capStartColor: opts.endColor ?? opts.bodyColor,
      capEndColor: opts.endColor ?? opts.bodyColor,
      faceColors: (_seg, edge) => {
        if (edge === 0) return { color: FRAME_DARK, surf: SURF.metal };
        if (edge === 2 || edge === 3 || edge === 4) return { color: opts.roofColor, surf: opts.roofSurf };
        return null;
      },
    });
    return;
  }

  // Smooth 9-vertex domed barrel profile (skirt + sidewall + curved cantrail + arched roof peak)
  b.loft([makeCoachRing(xRear, p), makeCoachRing(xFront, p)], opts.bodyColor, opts.bodySurf, {
    capStart: opts.capRear ?? true,
    capEnd: opts.capFront ?? true,
    capStartColor: opts.endColor ?? opts.bodyColor,
    capEndColor: opts.endColor ?? opts.bodyColor,
    faceColors: (_seg, edge) => {
      if (edge === 0) return { color: FRAME_DARK, surf: SURF.metal };
      if (edge === 1 || edge === 8) return { color: opts.skirtColor, surf: SURF.metal };
      if (edge === 3 || edge === 4 || edge === 5 || edge === 6) return { color: opts.roofColor, surf: opts.roofSurf };
      return null;
    },
  });
}

// ============================================================================
// 0. HEAVY DIESEL-ELECTRIC LOCOMOTIVE (`loco`)
// ============================================================================
function buildLocomotive(spec: RailCarSpec, detail: AssetDetail): AssetBuildResult {
  const b = new MeshBuilder();
  const g = new MeshBuilder();

  const xRear = -spec.frameLen * 0.5; // -7.70
  const xFront = spec.frameLen * 0.5; // +7.70
  const frameBot = 0.86;
  const deckY = 1.22;
  const deckHW = spec.width * 0.5; // 1.52

  // 1. Heavy bogies (3-axle at high, 2-axle at med/low)
  addBogie(b, -spec.bogieX, { wheelRadius: spec.wheelRadius, axlesHigh: 3, chassisBotY: frameBot, wheelbase2: 2.35, wheelbase3: 3.40 }, detail);
  addBogie(b, spec.bogieX, { wheelRadius: spec.wheelRadius, axlesHigh: 3, chassisBotY: frameBot, wheelbase2: 2.35, wheelbase3: 3.40 }, detail);

  // 2. Heavy underframe + underslung central fuel tank + yellow safety end sills
  addChassis(
    b,
    xRear,
    xFront,
    frameBot,
    deckY,
    deckHW,
    {
      color: FRAME_DARK,
      endSillColor: SAFETY_YELLOW,
      underEquip: { len: 4.10, yBot: 0.34, halfW: 1.04, color: FRAME_MID },
    },
    detail,
  );

  // 3. Angled front cowcatcher / snowplow (+X) and rear pilot plate (-X)
  if (detail !== 'low') {
    const plowY0 = 0.18;
    const plowY1 = frameBot + 0.04;
    const pxBack = xFront - 0.14;
    const pxTip = xFront + 0.42;
    const pxSide = xFront + 0.06;
    const plowHW = 1.26;
    // V-angled snowplow left & right sloped faces (mirrored across Z) + center wedge
    b.quadMirroredZ(
      [pxSide, plowY0, plowHW],
      [pxTip, plowY0, 0],
      [pxSide + 0.16, plowY1, 0],
      [pxBack, plowY1, plowHW],
      FRAME_DARK,
      SURF.metal,
    );
    b.quadMirroredZ(
      [pxBack, plowY0, plowHW],
      [pxSide, plowY0, plowHW],
      [pxBack, plowY1, plowHW],
      [pxBack - 0.16, plowY1, plowHW],
      BOGIE_STEEL,
      SURF.metal,
    );
    // Yellow chevron hazard bar on front plow at high detail
    if (detail === 'high') {
      b.quadMirroredZ(
        [pxSide + 0.03, plowY0 + 0.16, plowHW * 0.84],
        [pxTip + 0.02, plowY0 + 0.16, 0.08],
        [pxTip - 0.05, plowY0 + 0.34, 0.08],
        [pxSide - 0.04, plowY0 + 0.34, plowHW * 0.84],
        SAFETY_YELLOW,
        SURF.paintFixed,
      );
    }
    // Rear pilot skirt
    b.box(xRear + 0.08, 0.30, 0, 0.24, frameBot - 0.28, 2.38, FRAME_DARK, SURF.metal);
  }

  // Couplers (total X span: -8.08 .. +8.10 -> L = 16.18 m <= 16.65)
  addCouplers(b, xRear, xFront, 0.96, { couplerReach: 0.40 }, detail);

  // 4. Short chamfered front nose (+X: 5.20 .. 7.22)
  const noseX0 = 5.10;
  const noseX1 = 7.16;
  const noseHW0 = 1.40;
  const noseHW1 = 1.18;
  const noseYTop0 = 2.66;
  const noseYTop1 = 2.42;
  const noseRing = (x: number, yT: number, hw: number): Vec3[] => [
    [x, deckY, hw],
    [x, deckY, -hw],
    [x, yT - 0.18, -hw],
    [x, yT, -(hw - 0.18)],
    [x, yT, hw - 0.18],
    [x, yT - 0.18, hw],
  ];
  b.loft([noseRing(noseX0, noseYTop0, noseHW0), noseRing(noseX1, noseYTop1, noseHW1)], WHITE, SURF.paint, {
    capStart: false,
    capEnd: true,
    // Anti-glare matte top finish on the sloped locomotive short nose (prevents specular blowout at night/sun)
    faceColors: (_s, e) => (e === 3 ? { color: PAINT_SHADE, surf: SURF_PAINT_SATIN } : null),
  });
  // Safety yellow nose wrap stripe
  if (detail !== 'low') {
    const sy0 = 1.48, sy1 = 1.72;
    quadFrontX(b, noseX1 + 0.012, sy0, sy1, 0, noseHW1 * 1.96, SAFETY_YELLOW, SURF.paintFixed);
    b.quadMirroredZ(
      [noseX0, sy0, noseHW0 + 0.012],
      [noseX1, sy0, noseHW1 + 0.012],
      [noseX1, sy1, noseHW1 + 0.012],
      [noseX0, sy1, noseHW0 + 0.012],
      SAFETY_YELLOW,
      SURF.paintFixed,
    );
  }

  // 5. Wide forward operator cab (2.75 .. 5.25, full body width 2.98 m, raked 2-pane panoramic windshield)
  const cabX0 = 2.72;
  const cabX1Bot = 5.24;
  const cabX1Top = 4.92;
  const cabHW = 1.49;
  const cabRoofHW = 1.24;
  const cabBelt = 2.64;
  const cabEave = 3.84;
  const cabPeak = 4.18;

  // Lower cab box (deck -> beltline)
  b.box((cabX0 + cabX1Bot) * 0.5, deckY, 0, cabX1Bot - cabX0, cabBelt - deckY, cabHW * 2, WHITE, SURF.paint, { noBottom: true });

  // Exact front ramp X/half-width evaluator for the `low` LOD cab taperBox (cabBelt -> cabPeak)
  const cabLowSurfAt = (y: number): { x: number; hw: number } => {
    const t = Math.max(0, Math.min(1, (y - cabBelt) / (cabPeak - cabBelt)));
    return {
      x: cabX1Bot + (cabX1Top - cabX1Bot) * t,
      hw: cabHW + (cabRoofHW - cabHW) * t,
    };
  };

  // Upper cab greenhouse with raked front windshield
  if (detail === 'low') {
    b.taperBox((cabX0 + cabX1Bot) * 0.5, cabBelt, 0, cabX1Bot - cabX0, cabHW * 2, cabX1Top - cabX0, cabRoofHW * 2, cabPeak - cabBelt, WHITE, SURF.paint, {
      oxTop: -0.16,
      topColor: ROOF_METAL,
      topSurf: SURF_ROOF_SATIN,
      noBottom: true,
    });
    // Simplified front windshield glass plate seated cleanly +0.025 m proud of the exact taperBox front ramp
    const wy0 = cabBelt + 0.14;
    const wy1 = cabEave - 0.08;
    const s0 = cabLowSurfAt(wy0);
    const s1 = cabLowSurfAt(wy1);
    b.quad(
      [s0.x + 0.025, wy0, s0.hw * 0.78],
      [s0.x + 0.025, wy0, -s0.hw * 0.78],
      [s1.x + 0.025, wy1, -s1.hw * 0.78],
      [s1.x + 0.025, wy1, s1.hw * 0.78],
      GLASS_TRAIN,
      SURF.glass,
    );
    b.quadMirroredZ([-7.00, 1.48, 1.072], [2.72, 1.48, 1.072], [2.72, 1.72, 1.072], [-7.00, 1.72, 1.072], SAFETY_YELLOW, SURF.paintFixed);
  } else {
    // Sculpted upper cab with flush raked windshield, side windows & beveled roof crown
    const cabRing = (xR: number, xF: number, y: number, hw: number): Vec3[] => [
      [xR, y, hw],
      [xF, y, hw],
      [xF, y, -hw],
      [xR, y, -hw],
    ];
    b.loft(
      [
        cabRing(cabX0, cabX1Bot, cabBelt, cabHW),
        cabRing(cabX0, cabX1Top, cabEave, cabHW - 0.06),
        cabRing(cabX0 + 0.10, cabX1Top - 0.12, cabPeak, cabRoofHW),
      ],
      WHITE,
      SURF.paint,
      {
        capStart: false,
        capEnd: true,
        capEndColor: ROOF_METAL,
        capEndSurf: SURF_ROOF_SATIN,
        faceColors: (seg, edge) => {
          if (seg === 1) return { color: ROOF_METAL, surf: SURF_ROOF_SATIN };
          void edge;
          return null;
        },
      },
    );

    // Panoramic 2-pane raked front windshield sitting cleanly proud (+0.015 along outward normal) of raked cab face
    const wsAt = (t: number): { x: number; y: number; hw: number } => ({
      x: cabX1Bot + (cabX1Top - cabX1Bot) * t + 0.016,
      y: cabBelt + (cabEave - cabBelt) * t,
      hw: cabHW - 0.06 * t,
    });
    const w0 = wsAt(0.10);
    const w1 = wsAt(0.84);
    // Left & right windshield glass panes separated by center painted mullion
    b.quad([w0.x, w0.y, w0.hw * 0.84], [w0.x, w0.y, 0.07], [w1.x, w1.y, 0.07], [w1.x, w1.y, w1.hw * 0.82], GLASS_TRAIN, SURF.glass);
    b.quad([w0.x, w0.y, -0.07], [w0.x, w0.y, -w0.hw * 0.84], [w1.x, w1.y, -w1.hw * 0.82], [w1.x, w1.y, -0.07], GLASS_TRAIN, SURF.glass);

    // Side cab windows (twin sliding panes per side)
    const sw0 = cabBelt + 0.14;
    const sw1 = cabEave - 0.16;
    const swZ0 = cabHW - 0.06 * 0.12 + 0.014;
    const swZ1 = cabHW - 0.06 * 0.86 + 0.014;
    b.quadMirroredZ([cabX0 + 0.34, sw0, swZ0], [cabX1Bot - 0.34, sw0, swZ0], [cabX1Top - 0.24, sw1, swZ1], [cabX0 + 0.34, sw1, swZ1], GLASS_TRAIN, SURF.glass);
    if (detail === 'high') {
      // Side window vertical mullion + cab roof horn/AC module
      b.quadMirroredZ([cabX0 + 1.15, sw0, swZ0 + 0.006], [cabX0 + 1.25, sw0, swZ0 + 0.006], [cabX0 + 1.25, sw1, swZ1 + 0.006], [cabX0 + 1.15, sw1, swZ1 + 0.006], RUBBER_DARK, SURF.rubber);
      // Numberboard visor box above windshield
      b.box(cabX1Top + 0.06, cabEave - 0.06, 0, 0.26, 0.26, 1.32, FRAME_DARK, SURF_DECK);
      // Cab roof AC unit + twin air horn
      b.box(cabX0 + 0.95, cabPeak - 0.02, 0, 1.05, 0.22, 1.18, STEEL_MID, SURF_ROOF_SATIN, { noBottom: true });
      b.box(cabX1Top - 0.35, cabPeak - 0.01, 0, 0.42, 0.18, 0.36, STEEL_BRIGHT, SURF_STEEL_SATIN, { noBottom: true });
    }
  }

  // 6. Narrow stepped long engine hood (-7.05 .. +2.78, width 2.12 m -> exposes real walkways!)
  const hoodX0 = -7.05;
  const hoodX1 = 2.78;
  const hoodHW = 1.06;
  const hoodTop = 3.84;
  const hoodRing = (x: number, hwTop: number): Vec3[] => [
    [x, deckY, hoodHW],
    [x, deckY, -hoodHW],
    [x, hoodTop - 0.26, -hoodHW],
    [x, hoodTop, -hwTop],
    [x, hoodTop, hwTop],
    [x, hoodTop - 0.26, hoodHW],
  ];

  if (detail === 'low') {
    b.loft([hoodRing(hoodX0, hoodHW - 0.14), hoodRing(hoodX1, hoodHW - 0.14)], WHITE, SURF.paint, {
      capStart: true,
      capEnd: false,
      faceColors: (_s, e) => (e === 3 ? { color: ROOF_METAL, surf: SURF_ROOF_SATIN } : null),
    });
  } else {
    // Stepped long hood with iconic flared GE/EMD rear radiator wings (-6.75 .. -3.30)
    b.loft(
      [
        hoodRing(hoodX0, hoodHW - 0.12),
        hoodRing(-6.60, hoodHW + 0.22),
        hoodRing(-3.45, hoodHW + 0.22),
        hoodRing(-3.05, hoodHW - 0.12),
        hoodRing(hoodX1, hoodHW - 0.12),
      ],
      WHITE,
      SURF.paint,
      {
        capStart: true,
        capEnd: false,
        faceColors: (_s, e) => (e === 3 ? { color: ROOF_METAL, surf: SURF_ROOF_SATIN } : null),
      },
    );

    // Safety yellow side livery stripe along long hood + cab lower wall
    const sy0 = 1.48, sy1 = 1.72;
    b.quadMirroredZ([hoodX0 + 0.04, sy0, hoodHW + 0.012], [cabX0 + 0.02, sy0, hoodHW + 0.012], [cabX0 + 0.02, sy1, hoodHW + 0.012], [hoodX0 + 0.04, sy1, hoodHW + 0.012], SAFETY_YELLOW, SURF.paintFixed);
    b.quadMirroredZ([cabX0 + 0.02, sy0, cabHW + 0.012], [cabX1Bot - 0.02, sy0, cabHW + 0.012], [cabX1Bot - 0.02, sy1, cabHW + 0.012], [cabX0 + 0.02, sy1, cabHW + 0.012], SAFETY_YELLOW, SURF.paintFixed);

    // Dark recessed radiator grilles under the rear radiator flare + engine louvers
    b.quadMirroredZ([-6.48, 2.74, hoodHW + 0.015], [-3.58, 2.74, hoodHW + 0.015], [-3.58, 3.52, hoodHW + 0.015], [-6.48, 3.52, hoodHW + 0.015], RUBBER_DARK, SURF.rubber);
    b.quadMirroredZ([-2.40, 2.65, hoodHW + 0.015], [1.80, 2.65, hoodHW + 0.015], [1.80, 3.35, hoodHW + 0.015], [-2.40, 3.35, hoodHW + 0.015], FRAME_MID, SURF_DECK);

    // Exhaust stack & dynamic brake fan housing on top of hood
    b.box(-0.55, hoodTop - 0.02, 0, 1.35, 0.34, 1.12, FRAME_DARK, SURF_DECK, { noBottom: true });
    b.box(-5.05, hoodTop - 0.02, 0, 2.55, 0.24, 1.82, STEEL_DARK, SURF_ROOF_SATIN, { noBottom: true });
  }

  // 7. Walkway safety handrails (`guarda-corpos`) along both exposed side walkways (high detail)
  if (detail === 'high') {
    const railZ = deckHW - 0.06;
    const railY = deckY + 0.96;
    const rearRailLen = cabX0 + 0.04 - (xRear + 0.18);
    const rearRailCx = (xRear + 0.18 + cabX0 + 0.04) * 0.5;
    const frontRailLen = xFront - 0.16 - (cabX1Bot - 0.04);
    const frontRailCx = (cabX1Bot - 0.04 + xFront - 0.16) * 0.5;
    for (const sd of [-1, 1] as const) {
      const z = sd * railZ;
      // Top horizontal rails (axis-aligned boxes = 10 tris vs 16 for strut)
      b.box(rearRailCx, railY - 0.025, z, rearRailLen, 0.055, 0.055, SAFETY_YELLOW, SURF.metal, { noBottom: true });
      b.box(frontRailCx, railY - 0.025, z, frontRailLen, 0.055, 0.055, SAFETY_YELLOW, SURF.metal, { noBottom: true });
      // Stanchions anchored directly into walkway deck
      for (const sx of [xRear + 0.22, -4.4, -1.2, 1.6, xFront - 0.18]) {
        b.box(sx, deckY - 0.02, z, 0.05, railY - deckY + 0.02, 0.05, FRAME_MID, SURF.metal, { noBottom: true });
      }
      // End cross-bars on front & rear platforms (gap in center for walkway)
      for (const ex of [xRear + 0.18, xFront - 0.18]) {
        const zMid = sd * (railZ + 0.48) * 0.5;
        b.box(ex, railY - 0.025, zMid, 0.055, 0.055, railZ - 0.48, SAFETY_YELLOW, SURF.metal, { noBottom: true });
      }
    }
  }

  // 8. Daytime lens housings + paired night glow mesh — anchored solidly onto the real nose/hood/cab surfaces!
  // Front twin ditch lights seated directly on the vertical front nose bulkhead (`noseX1 = 7.16`, below yellow stripe `1.48..1.72`)
  // Rear twin red marker lanterns seated directly on the vertical rear hood bulkhead (`hoodX0 = -7.05`, above yellow stripe)
  for (const sd of [-1, 1] as const) {
    if (detail === 'high') {
      quadFrontX(b, noseX1 + 0.008, 1.24, 1.46, sd * 0.76, 0.30, FRAME_DARK, SURF_DECK);
      quadRearX(b, hoodX0 - 0.008, 1.85, 2.11, sd * 0.72, 0.28, FRAME_DARK, SURF_DECK);
    }
    if (detail !== 'low') {
      quadFrontX(b, noseX1 + 0.014, 1.27, 1.43, sd * 0.76, 0.22, LENS_HEAD, SURF.glass);
      quadRearX(b, hoodX0 - 0.014, 1.88, 2.08, sd * 0.72, 0.20, LENS_TAIL, SURF.glass);
    }
    quadFrontX(g, noseX1 + 0.022, 1.27, 1.43, sd * 0.76, 0.22, GLOW_HEAD_WARM, SURF.matte);
    quadRearX(g, hoodX0 - 0.022, 1.88, 2.08, sd * 0.72, 0.20, GLOW_TAIL_RED, SURF.matte);
  }
  // Central nose headlight flush on `noseX1`
  if (detail !== 'low') {
    quadFrontX(b, noseX1 + 0.014, 1.94, 2.20, 0, 0.34, LENS_HEAD, SURF.glass);
  }
  quadFrontX(g, noseX1 + 0.022, 1.94, 2.20, 0, 0.34, GLOW_HEAD_WARM, SURF.matte);

  // Upper cab high-beam headlight aligned strictly to the real cab brow / visor face per LOD (zero floating!)
  if (detail === 'high') {
    // Visor box front face lies at `cabX1Top + 0.19` (`5.11`)
    quadFrontX(b, cabX1Top + 0.198, cabEave - 0.01, cabEave + 0.17, 0, 0.44, LENS_HEAD, SURF.glass);
    quadFrontX(g, cabX1Top + 0.208, cabEave - 0.01, cabEave + 0.17, 0, 0.44, GLOW_HEAD_WARM, SURF.matte);
  } else if (detail === 'med') {
    // Follow the exact upper cab bevel from `(cabX1Top, cabEave)` -> `(cabX1Top - 0.12, cabPeak)`
    const hy0 = cabEave + 0.01;
    const hy1 = cabEave + 0.19;
    const t0 = (hy0 - cabEave) / (cabPeak - cabEave);
    const t1 = (hy1 - cabEave) / (cabPeak - cabEave);
    const hx0 = cabX1Top - 0.12 * t0;
    const hx1 = cabX1Top - 0.12 * t1;
    b.quad([hx0 + 0.014, hy0, 0.22], [hx0 + 0.014, hy0, -0.22], [hx1 + 0.014, hy1, -0.22], [hx1 + 0.014, hy1, 0.22], LENS_HEAD, SURF.glass);
    g.quad([hx0 + 0.024, hy0, 0.22], [hx0 + 0.024, hy0, -0.22], [hx1 + 0.024, hy1, -0.22], [hx1 + 0.024, hy1, 0.22], GLOW_HEAD_WARM, SURF.matte);
  } else {
    // Follow the exact `low` LOD taperBox front face ramp with +0.024 m clearance
    const hy0 = cabEave + 0.02;
    const hy1 = cabEave + 0.20;
    const s0 = cabLowSurfAt(hy0);
    const s1 = cabLowSurfAt(hy1);
    g.quad([s0.x + 0.024, hy0, 0.22], [s0.x + 0.024, hy0, -0.22], [s1.x + 0.024, hy1, -0.22], [s1.x + 0.024, hy1, 0.22], GLOW_HEAD_WARM, SURF.matte);
  }

  return finalizeAsset(spec.id, spec.label, 'rail', b, g);
}

// ============================================================================
// 1. REGIONAL PASSENGER COACH (`passenger`)
// ============================================================================
function buildPassengerCoach(spec: RailCarSpec, detail: AssetDetail): AssetBuildResult {
  const b = new MeshBuilder();
  const g = new MeshBuilder();

  const xRear = -spec.frameLen * 0.5; // -9.20
  const xFront = spec.frameLen * 0.5; // +9.20
  const frameBot = 0.80;
  const skirtBot = 1.06;

  // 1. Two 2-axle passenger bogies
  addBogie(b, -spec.bogieX, { wheelRadius: spec.wheelRadius, axlesHigh: 2, chassisBotY: frameBot + 0.04, wheelbase2: 2.25 }, detail);
  addBogie(b, spec.bogieX, { wheelRadius: spec.wheelRadius, axlesHigh: 2, chassisBotY: frameBot + 0.04, wheelbase2: 2.25 }, detail);

  // 2. Underframe + underfloor battery/air-brake skirt pods between bogies
  addChassis(
    b,
    xRear,
    xFront,
    frameBot,
    skirtBot + 0.06,
    spec.width * 0.47,
    {
      color: FRAME_DARK,
      underEquip: { len: 7.40, yBot: 0.48, halfW: 1.18, color: FRAME_MID },
    },
    detail,
  );

  // 3. Curved barrel-roof coach body
  const profile: CoachProfile = {
    ySkirt: skirtBot,
    yBelt: 1.62,
    yEave: 3.44,
    yCrown: 3.84,
    yPeak: 3.98,
    hwSkirt: 1.42,
    hwBody: spec.width * 0.5, // 1.52
    hwEave: 1.48,
    hwCrown: 1.08,
  };
  buildCurvedCoachShell(
    b,
    profile,
    xRear,
    xFront,
    {
      bodyColor: BODY_SILVER,
      bodySurf: SURF_STEEL_SATIN,
      roofColor: ROOF_METAL,
      roofSurf: SURF_ROOF_SATIN,
      skirtColor: STEEL_DARK,
      endColor: STEEL_MID,
    },
    detail,
  );

  // 4. Paintable regional livery band (`aTint = 1`) along lower belt & upper cantrail (zero overlap with windows!)
  addCoachSideQuad(b, profile, xRear + 0.06, xFront - 0.06, 1.42, 2.02, 0.010, WHITE, SURF.paint);
  if (detail !== 'low') {
    addCoachSideQuad(b, profile, xRear + 0.06, xFront - 0.06, 3.16, 3.36, 0.010, PAINT_SHADE, SURF.paint);
  }

  // 5. Vestibule boarding doors at both ends + 7 panoramic passenger windows per side
  const doorXs = [xRear + 1.05, xFront - 1.05];
  if (detail !== 'low') {
    for (const dx of doorXs) {
      addCoachSideQuad(b, profile, dx - 0.56, dx + 0.56, 1.16, 3.24, 0.014, WHITE, SURF.paint);
      addCoachSideQuad(b, profile, dx - 0.34, dx + 0.34, 2.18, 3.04, 0.020, GLASS_TRAIN, SURF.glass);
    }
  }

  // Panoramic passenger windows between doors (`x = -6.9 .. +6.9`)
  const winY0 = 2.14;
  const winY1 = 3.06;
  if (detail === 'low') {
    // Continuous dark glass window band + warm night glow band
    addCoachSideQuad(b, profile, -7.40, 7.40, winY0, winY1, 0.014, GLASS_TRAIN, SURF.glass);
    addCoachSideQuad(g, profile, -7.25, 7.25, winY0 + 0.08, winY1 - 0.08, 0.024, GLOW_WIN_WARM, SURF.matte);
  } else {
    const numWins = detail === 'high' ? 7 : 5;
    const spanStart = -7.05;
    const spanEnd = 7.05;
    const pitch = (spanEnd - spanStart) / numWins;
    const wHalf = pitch * 0.40;
    for (let i = 0; i < numWins; i++) {
      const wx = spanStart + (i + 0.5) * pitch;
      addCoachSideQuad(b, profile, wx - wHalf, wx + wHalf, winY0, winY1, 0.015, GLASS_TRAIN, SURF.glass);
      // Warm glowing interior pane strictly inset inside window frame
      addCoachSideQuad(g, profile, wx - wHalf + 0.08, wx + wHalf - 0.08, winY0 + 0.07, winY1 - 0.07, 0.024, GLOW_WIN_WARM, SURF.matte);
    }
  }

  // 6. Roofline HVAC pods (streamlined chamfered units seated into arched roof)
  if (detail !== 'low') {
    for (const hx of [-4.2, 4.2]) {
      b.taperBox(hx, profile.yCrown - 0.02, 0, 2.90, 1.84, 2.45, 1.48, 0.34, STEEL_MID, SURF_ROOF_SATIN, {
        topColor: STEEL_BRIGHT,
        noBottom: true,
      });
    }
  }

  // 7. End gangway bellows (`sanfonas`) + knuckle couplers (`-9.58 .. +9.58 -> L = 19.16 m <= 19.65`)
  addCouplers(
    b,
    xRear,
    xFront,
    0.94,
    {
      couplerReach: 0.38,
      gangwayRear: { yBot: 1.16, yTop: 3.36, halfW: 0.58, depth: 0.28 },
      gangwayFront: { yBot: 1.16, yTop: 3.36, halfW: 0.58, depth: 0.28 },
    },
    detail,
  );

  // Subtle red rear end marker lights on -X bulkhead
  for (const sd of [-1, 1] as const) {
    quadRearX(g, xRear - 0.020, 1.68, 1.86, sd * 1.12, 0.18, GLOW_TAIL_RED, SURF.matte);
  }

  return finalizeAsset(spec.id, spec.label, 'rail', b, g);
}

// ============================================================================
// 2. CONTAINER FLATCAR (`container`)
// ============================================================================
function addISOContainer(
  b: MeshBuilder,
  cx: number,
  yBot: number,
  len: number,
  height: number,
  width: number,
  color: number,
  surf: SurfMat,
  detail: AssetDetail,
) {
  const hw = width * 0.5;
  const hl = len * 0.5;
  // Main box hull
  b.box(cx, yBot, 0, len, height, width, color, surf);

  if (detail === 'low') return;

  // Heavy structural corner posts & top/bottom longitudinal rails
  const postCol = surf.tint > 0.5 ? PAINT_SHADE : STEEL_DARK;
  const postSurf = surf.tint > 0.5 ? surf : SURF.metal;
  for (const sx of [-1, 1] as const) {
    const px = cx + sx * (hl - 0.11);
    b.box(px, yBot, 0, 0.24, height + 0.03, width + 0.04, postCol, postSurf, { noBottom: true });
  }

  // Real 3D side corrugations (`nervuras`) at high detail (crisp raised trapezoidal ribs)
  if (detail === 'high') {
    const ribCount = 6;
    const ribSpan = len - 0.90;
    const ribY0 = yBot + 0.18;
    const ribY1 = yBot + height - 0.18;
    const ribOut = hw + 0.055;
    const ribBase = hw + 0.004;
    const ribShade = surf.tint > 0.5 ? PAINT_SHADE : CONTAINER_ALT_SHADE;
    for (let i = 0; i < ribCount; i++) {
      const rx = cx - ribSpan * 0.5 + (i + 0.5) * (ribSpan / ribCount);
      const rw = 0.22;
      const rt = 0.12;
      // 3-face raised corrugation pleat mirrored across Z (left bevel, outer crest, right bevel)
      b.quadMirroredZ([rx - rw, ribY0, ribBase], [rx - rt, ribY0, ribOut], [rx - rt, ribY1, ribOut], [rx - rw, ribY1, ribBase], ribShade, surf);
      b.quadMirroredZ([rx - rt, ribY0, ribOut], [rx + rt, ribY0, ribOut], [rx + rt, ribY1, ribOut], [rx - rt, ribY1, ribOut], color, surf);
      b.quadMirroredZ([rx + rt, ribY0, ribOut], [rx + rw, ribY0, ribBase], [rx + rw, ribY1, ribBase], [rx + rt, ribY1, ribOut], ribShade, surf);
    }
    // End cargo door vertical locking rods on the outer end face
    const endSign = cx >= 0 ? 1 : -1;
    const xDoor = cx + endSign * (hl + 0.015);
    for (const rz of [-0.45, 0.45]) {
      if (endSign > 0) quadFrontX(b, xDoor, yBot + 0.22, yBot + height - 0.22, rz, 0.07, STEEL_BRIGHT, SURF.metal);
      else quadRearX(b, xDoor, yBot + 0.22, yBot + height - 0.22, rz, 0.07, STEEL_BRIGHT, SURF.metal);
    }
  }
}

function buildContainerFlatcar(spec: RailCarSpec, detail: AssetDetail): AssetBuildResult {
  const b = new MeshBuilder();

  const xRear = -spec.frameLen * 0.5; // -7.70
  const xFront = spec.frameLen * 0.5; // +7.70
  const frameBot = 0.80;
  const deckY = 1.14;
  const deckHW = spec.width * 0.5; // 1.43

  // 1. Two 2-axle freight bogies
  addBogie(b, -spec.bogieX, { wheelRadius: spec.wheelRadius, axlesHigh: 2, chassisBotY: frameBot + 0.02, wheelbase2: 2.10 }, detail);
  addBogie(b, spec.bogieX, { wheelRadius: spec.wheelRadius, axlesHigh: 2, chassisBotY: frameBot + 0.02, wheelbase2: 2.10 }, detail);

  // 2. Structural flatcar platform with depressed center fishbelly sill & safety end sills
  addChassis(
    b,
    xRear,
    xFront,
    frameBot,
    deckY,
    deckHW,
    {
      color: FRAME_DARK,
      endSillColor: SAFETY_YELLOW,
      underEquip: { len: 6.40, yBot: 0.54, halfW: 0.92, color: FRAME_MID },
    },
    detail,
  );

  // Raised twist-lock corner bolster sills & end brake wheel / handrail
  if (detail !== 'low') {
    for (const bx of [-6.32, -0.18, 0.18, 6.32]) {
      b.box(bx, deckY - 0.01, 0, 0.22, 0.08, 2.54, STEEL_DARK, SURF.metal, { noBottom: true });
    }
  }
  if (detail === 'high') {
    // End safety handrail & brake stand at -X platform
    const rx = xRear + 0.22;
    b.strut([rx, deckY, -1.12], [rx, deckY + 0.92, -1.12], 0.05, 0.05, STEEL_MID, SURF.metal);
    b.strut([rx, deckY, 1.12], [rx, deckY + 0.92, 1.12], 0.05, 0.05, STEEL_MID, SURF.metal);
    b.strut([rx, deckY + 0.92, -1.12], [rx, deckY + 0.92, 1.12], 0.05, 0.05, SAFETY_YELLOW, SURF.metal);
  }

  // 3. Two 20-ft ISO Containers (6.14 m × 2.56 m × 2.48 m each, 0.36 m center gap)
  // Satin industrial paint finish prevents harsh roof glare while keeping corrugated side contrast crisp
  const contY0 = detail !== 'low' ? deckY + 0.06 : deckY;
  addISOContainer(b, 3.25, contY0, 6.14, 2.56, 2.48, WHITE, SURF_PAINT_SATIN, detail);
  addISOContainer(b, -3.25, contY0, 6.14, 2.56, 2.48, CONTAINER_ALT, SURF_PAINT_FIXED_SATIN, detail);

  // 4. Knuckle couplers (`-8.08 .. +8.08 -> L = 16.16 m <= 16.65`)
  addCouplers(b, xRear, xFront, 0.94, { couplerReach: 0.38 }, detail);

  return finalizeAsset(spec.id, spec.label, 'rail', b, null);
}

// ============================================================================
// 3. BULK HOPPER CAR (`hopper`)
// ============================================================================
function buildHopperCar(spec: RailCarSpec, detail: AssetDetail): AssetBuildResult {
  const b = new MeshBuilder();

  const xRear = -spec.frameLen * 0.5; // -6.75
  const xFront = spec.frameLen * 0.5; // +6.75
  const frameBot = 0.80;
  const deckY = 1.12;
  const hwTop = spec.width * 0.5; // 1.51

  // 1. Two 2-axle freight bogies
  addBogie(b, -spec.bogieX, { wheelRadius: spec.wheelRadius, axlesHigh: 2, chassisBotY: frameBot + 0.02, wheelbase2: 2.05 }, detail);
  addBogie(b, spec.bogieX, { wheelRadius: spec.wheelRadius, axlesHigh: 2, chassisBotY: frameBot + 0.02, wheelbase2: 2.05 }, detail);

  // 2. End frames & continuous center sill
  addChassis(
    b,
    xRear,
    xFront,
    frameBot,
    deckY,
    1.36,
    { color: FRAME_DARK, endSillColor: SAFETY_YELLOW },
    detail,
  );

  // 3. Sculpted chamfered hopper body (`tremonha`) tapering cleanly into lower discharge bays
  const yRim = 3.74;
  const ySlope = 2.04;
  const hwBot = 0.88;

  if (detail === 'low') {
    // Clean sloped-end trapezoidal hopper body
    b.taperBox(0, deckY, 0, 9.60, hwBot * 2.2, 12.60, hwTop * 2, yRim - deckY, WHITE, SURF.paint, {
      topColor: CARGO_ORE,
      topSurf: SURF.matte,
      noBottom: false,
    });
    // Low-poly bulk cargo ridge on top
    b.taperBox(0, yRim - 0.02, 0, 11.4, hwTop * 1.65, 8.6, hwTop * 0.65, 0.30, CARGO_PEAK, SURF.matte, { noBottom: true });
  } else {
    // True multi-station chamfered hopper bin (end slope sheets + sloped side chutes)
    const hopRing = (x: number, yBot: number, hwB: number, yMid: number, hwM: number): Vec3[] => [
      [x, yBot, hwB],
      [x, yBot, -hwB],
      [x, yMid, -hwM],
      [x, yRim, -hwTop],
      [x, yRim, hwTop],
      [x, yMid, hwM],
    ];
    b.loft(
      [
        hopRing(-6.22, ySlope + 0.42, hwTop * 0.92, ySlope + 0.68, hwTop),
        hopRing(-4.15, deckY + 0.02, hwBot, ySlope, hwTop),
        hopRing(4.15, deckY + 0.02, hwBot, ySlope, hwTop),
        hopRing(6.22, ySlope + 0.42, hwTop * 0.92, ySlope + 0.68, hwTop),
      ],
      WHITE,
      SURF.paint,
      {
        capStart: true,
        capEnd: true,
        faceColors: (_s, e) => {
          if (e === 0) return { color: FRAME_DARK, surf: SURF.metal };
          if (e === 1 || e === 5) return { color: PAINT_SHADE, surf: SURF.paint };
          if (e === 3) return { color: CARGO_ORE, surf: SURF.matte };
          return null;
        },
      },
    );

    // End structural corner posts connecting sloped hopper ends down to end platforms (leaves authentic open under-slope void!)
    for (const sx of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        b.box(sx * 5.95, deckY, sz * 1.12, 0.22, ySlope + 0.56 - deckY, 0.22, FRAME_DARK, SURF_DECK, { noBottom: true });
      }
    }

    // Twin tapered bottom discharge chutes (`bocas de descarga`) between bogies dropping to y = 0.48 m
    for (const cx of [-1.75, 1.75]) {
      b.taperBox(cx, 0.48, 0, 1.35, 1.05, 2.75, hwBot * 2.1, deckY + 0.06 - 0.48, FRAME_MID, SURF_DECK);
    }

    // Reinforced top chord collar around the hopper rim
    b.box(0, yRim - 0.06, 0, 12.64, 0.14, hwTop * 2 + 0.10, STEEL_DARK, SURF_DECK, { noBottom: true });

    // External vertical structural stiffening ribs (`nervuras`) hugging wall + lower slope
    const ribCount = detail === 'high' ? 7 : 4;
    const ribSpan = 8.40;
    for (let i = 0; i < ribCount; i++) {
      const rx = -ribSpan * 0.5 + (i / (ribCount - 1)) * ribSpan;
      const rw = 0.09;
      const zIn = hwTop - 0.02;
      const zOut = hwTop + 0.085;
      // Vertical upper rib (front, back, outer face mirrored across Z)
      b.quadMirroredZ([rx - rw, ySlope, zOut], [rx + rw, ySlope, zOut], [rx + rw, yRim, zOut], [rx - rw, yRim, zOut], PAINT_SHADE, SURF.paint);
      b.quadMirroredZ([rx + rw, ySlope, zOut], [rx + rw, ySlope, zIn], [rx + rw, yRim, zIn], [rx + rw, yRim, zOut], FRAME_MID, SURF.metal);
      b.quadMirroredZ([rx - rw, ySlope, zIn], [rx - rw, ySlope, zOut], [rx - rw, yRim, zOut], [rx - rw, yRim, zIn], FRAME_MID, SURF.metal);
    }

    // Sculpted 3D faceted bulk cargo mound (double-peaked aggregate heap rising above rim)
    for (const mx of [-2.75, 2.75]) {
      b.taperBox(mx, yRim + 0.02, 0, 5.80, hwTop * 1.72, 2.60, hwTop * 0.58, 0.34, CARGO_PEAK, SURF.matte, {
        topColor: CARGO_ORE,
        noBottom: true,
      });
    }

    // End access ladders at both ends (high detail)
    if (detail === 'high') {
      for (const sx of [-1, 1] as const) {
        const lx = sx * 6.32;
        for (const lz of [0.82, 1.18]) {
          b.strut([lx, deckY, lz], [lx, yRim + 0.04, lz], 0.045, 0.045, STEEL_MID, SURF.metal);
        }
        for (let r = 0; r < 5; r++) {
          const ry = deckY + 0.35 + r * 0.50;
          b.strut([lx, ry, 0.82], [lx, ry, 1.18], 0.035, 0.035, STEEL_BRIGHT, SURF.metal);
        }
      }
    }
  }

  // 4. Knuckle couplers (`-7.13 .. +7.13 -> L = 14.26 m <= 14.65`)
  addCouplers(b, xRear, xFront, 0.94, { couplerReach: 0.38 }, detail);

  return finalizeAsset(spec.id, spec.label, 'rail', b, null);
}

// ============================================================================
// 4. CYLINDRICAL TANK CAR (`tank`)
// ============================================================================
function buildTankCar(spec: RailCarSpec, detail: AssetDetail): AssetBuildResult {
  const b = new MeshBuilder();

  const xRear = -spec.frameLen * 0.5; // -7.25
  const xFront = spec.frameLen * 0.5; // +7.25
  const frameBot = 0.80;
  const deckY = 1.08;

  // 1. Two 2-axle freight bogies
  addBogie(b, -spec.bogieX, { wheelRadius: spec.wheelRadius, axlesHigh: 2, chassisBotY: frameBot + 0.02, wheelbase2: 2.10 }, detail);
  addBogie(b, spec.bogieX, { wheelRadius: spec.wheelRadius, axlesHigh: 2, chassisBotY: frameBot + 0.02, wheelbase2: 2.10 }, detail);

  // 2. Center sill, end bolster platforms & central side-ladder landing platform (matte weathered steel deck)
  if (detail === 'low') {
    b.box(0, frameBot, 0, spec.frameLen, deckY - frameBot, 2.58, FRAME_DARK, SURF_DECK, { noBottom: true });
  } else if (detail === 'med') {
    b.box(0, frameBot, 0, spec.frameLen, deckY - frameBot, 2.66, FRAME_DARK, SURF_DECK, { noBottom: true });
  } else {
    b.box(0, frameBot, 0, spec.frameLen, deckY - frameBot, 0.94, FRAME_DARK, SURF_DECK, { noBottom: true });
    for (const sx of [-1, 1] as const) {
      b.box(sx * (xFront - 1.15), frameBot, 0, 2.30, deckY - frameBot, 2.74, FRAME_DARK, SURF_DECK, { noBottom: true });
    }
    // Solid central cross-platform welded to the center sill directly supporting both side ladder bases (z = ±1.44 inside ±1.48)
    b.box(0, frameBot + 0.08, 0, 1.24, deckY - (frameBot + 0.08), 2.96, FRAME_DARK, SURF_DECK);
  }
  if (detail !== 'low') {
    quadFrontX(b, xFront + 0.008, frameBot + 0.04, deckY - 0.04, 0, 2.66, SAFETY_YELLOW, SURF.paintFixed);
    quadRearX(b, xRear - 0.008, frameBot + 0.04, deckY - 0.04, 0, 2.66, SAFETY_YELLOW, SURF.paintFixed);
  }

  // 3. Heavy steel saddle cradles (`berços metálicos`) connecting tank barrel solidly to bogie bolsters
  const tankCy = 2.44;
  const tankR = 1.36; // bottom at 1.08 m, top at 3.80 m, diameter 2.72 m
  if (detail !== 'low') {
    for (const sx of [-1, 1] as const) {
      const cx = sx * spec.bogieX;
      b.taperBox(cx, deckY - 0.02, 0, 1.35, 2.52, 1.15, 2.18, 0.72, FRAME_MID, SURF_DECK, { noBottom: true });
    }
  }

  // 4. TRUE CYLINDRICAL TANK with dished hemispherical end caps (12-seg high, 8-seg med, 6-seg low)
  const seg = detail === 'high' ? 12 : detail === 'med' ? 8 : 6;
  const circRing = (x: number, r: number): Vec3[] => {
    const pts: Vec3[] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pts.push([x, tankCy + Math.sin(a) * r, Math.cos(a) * r]);
    }
    return pts;
  };

  if (detail === 'low') {
    b.loft(
      [
        circRing(-6.80, tankR * 0.48),
        circRing(-6.05, tankR),
        circRing(6.05, tankR),
        circRing(6.80, tankR * 0.48),
      ],
      WHITE,
      SURF.paint,
      { capStart: true, capEnd: true },
    );
  } else {
    // Smooth 2-step dished domes at both ends + cylindrical barrel
    b.loft(
      [
        circRing(-6.94, tankR * 0.34),
        circRing(-6.64, tankR * 0.74),
        circRing(-6.12, tankR),
        circRing(6.12, tankR),
        circRing(6.64, tankR * 0.74),
        circRing(6.94, tankR * 0.34),
      ],
      WHITE,
      SURF.paint,
      { capStart: true, capEnd: true },
    );

    // Structural steel clamping bands (`cintas`) hugging the cylinder over the saddle cradles (+0.035 m radial offset)
    const bandXs = [-4.95, 4.95];
    const bandR = tankR + 0.035;
    for (const bx of bandXs) {
      b.loft([circRing(bx - 0.12, bandR), circRing(bx + 0.12, bandR)], STEEL_DARK, SURF.metal, {
        capStart: false,
        capEnd: false,
      });
    }
  }

  // 5. Top expansion dome / manway hatch & pressure valve
  if (detail === 'low') {
    b.box(0, tankCy + tankR - 0.04, 0, 1.05, 0.42, 1.05, STEEL_DARK, SURF.metal, { noBottom: true });
  } else {
    const domeSeg = detail === 'high' ? 8 : 6;
    b.cylinder(0, tankCy + tankR + 0.14, 0, 0.58, 0.52, 0.44, domeSeg, 'y', STEEL_DARK, SURF.metal, { capStart: false, capEnd: true });
  }
  if (detail === 'high') {
    // Manway top valve & protective roll-bar housing
    b.box(0.44, tankCy + tankR + 0.28, 0, 0.36, 0.22, 0.36, SAFETY_YELLOW, SURF.paintFixed, { noBottom: true });
    // Top catwalk grating running along upper crown around dome
    const cwY = tankCy + tankR + 0.06;
    b.box(0, cwY, 0, 4.40, 0.07, 1.38, STEEL_MID, SURF_DECK, { noBottom: true });
    // Catwalk side handrails (compact axis-aligned steel rails)
    for (const sd of [-1, 1] as const) {
      const z = sd * 0.66;
      b.box(0, cwY + 0.42, z, 4.20, 0.045, 0.045, STEEL_BRIGHT, SURF.metal, { noBottom: true });
      for (const sx of [-2.05, 0, 2.05]) {
        b.box(sx, cwY + 0.04, z, 0.045, 0.40, 0.045, STEEL_DARK, SURF.metal, { noBottom: true });
      }
    }
    // Side access ladder climbing from the solid central platform (`deckY`, `z = ±1.44`) up to the top catwalk
    const zBot = tankR + 0.08;
    const zTop = 0.68;
    const yBend = tankCy + 0.35;
    for (const lx of [-0.22, 0.22]) {
      b.box(lx, deckY - 0.02, zBot, 0.045, yBend - (deckY - 0.02), 0.045, STEEL_MID, SURF.metal, { noBottom: true });
      b.box(lx, deckY - 0.02, -zBot, 0.045, yBend - (deckY - 0.02), 0.045, STEEL_MID, SURF.metal, { noBottom: true });
    }
    // Upper angled ladder stiles hugging cylinder shoulder up to catwalk
    b.quadMirroredZ([-0.24, yBend - 0.01, zBot], [-0.19, yBend - 0.01, zBot], [-0.19, cwY + 0.04, zTop], [-0.24, cwY + 0.04, zTop], STEEL_MID, SURF.metal);
    b.quadMirroredZ([0.19, yBend - 0.01, zBot], [0.24, yBend - 0.01, zBot], [0.24, cwY + 0.04, zTop], [0.19, cwY + 0.04, zTop], STEEL_MID, SURF.metal);
    // Lower vertical ladder rungs + upper angled ladder rungs connecting smoothly to the top catwalk
    for (const ry of [1.45, 1.95, 2.45]) {
      b.quadMirroredZ([-0.22, ry, zBot + 0.02], [0.22, ry, zBot + 0.02], [0.22, ry + 0.04, zBot + 0.02], [-0.22, ry + 0.04, zBot + 0.02], STEEL_BRIGHT, SURF.metal);
    }
    for (const tRung of [0.34, 0.68]) {
      const ry = yBend + (cwY + 0.04 - yBend) * tRung;
      const rz = zBot + (zTop - zBot) * tRung + 0.02;
      b.quadMirroredZ([-0.22, ry, rz], [0.22, ry, rz], [0.22, ry + 0.04, rz - 0.02], [-0.22, ry + 0.04, rz - 0.02], STEEL_BRIGHT, SURF.metal);
    }
    // End platform safety handrails
    for (const sx of [-1, 1] as const) {
      const ex = sx * (xFront - 0.16);
      b.box(ex, deckY, -1.24, 0.045, 0.90, 0.045, STEEL_MID, SURF.metal, { noBottom: true });
      b.box(ex, deckY, 1.24, 0.045, 0.90, 0.045, STEEL_MID, SURF.metal, { noBottom: true });
      b.box(ex, deckY + 0.88, 0, 0.045, 0.045, 2.52, SAFETY_YELLOW, SURF.metal, { noBottom: true });
    }
  } else if (detail === 'med') {
    b.box(0, tankCy + tankR + 0.04, 0, 3.60, 0.07, 1.24, STEEL_MID, SURF.metal, { noBottom: true });
  }

  // 6. Knuckle couplers (`-7.63 .. +7.63 -> L = 15.26 m <= 15.65`)
  addCouplers(b, xRear, xFront, 0.94, { couplerReach: 0.38 }, detail);

  return finalizeAsset(spec.id, spec.label, 'rail', b, null);
}

// ============================================================================
// 5. URBAN METRO TRAIN (`metro`)
// ============================================================================
/** 3D articulated roof pantograph (`pantógrafo`) built from real structural struts + carbon collector bow. */
function addPantograph(b: MeshBuilder, cx: number, roofY: number, detail: AssetDetail) {
  const baseY = roofY + 0.08;
  const kneeY = roofY + 0.44;
  const topY = roofY + 0.84;

  if (detail === 'low') {
    // Slim articulated collector mast + contact bow (20 tris total)
    b.box(cx, roofY - 0.02, 0, 0.16, topY - roofY, 0.14, STEEL_MID, SURF.metal, { noBottom: true });
    b.box(cx, topY - 0.04, 0, 0.18, 0.07, 1.56, RUBBER_DARK, SURF.metal, { noBottom: true });
    return;
  }

  // Base insulator frame
  b.box(cx, roofY - 0.02, 0, 1.10, 0.10, 1.15, STEEL_DARK, SURF.metal, { noBottom: true });

  // Lower main arm rising rearward-upward to articulated knee
  const xBase = cx + 0.32;
  const xKnee = cx - 0.58;
  const xTop = cx + 0.18;
  b.strut([xBase, baseY, 0], [xKnee, kneeY, 0], 0.075, 0.075, STEEL_BRIGHT, SURF.metal);
  if (detail === 'med') {
    b.strut([xKnee, kneeY, 0], [xTop, topY - 0.04, 0], 0.07, 0.07, STEEL_BRIGHT, SURF.metal);
    b.box(xTop, topY - 0.03, 0, 0.24, 0.06, 1.48, RUBBER_DARK, SURF.metal, { noBottom: true });
    return;
  }

  // Upper twin V-arms rising forward-upward from knee to collector head (high detail)
  b.strut([xKnee, kneeY, -0.06], [xTop, topY - 0.04, -0.34], 0.055, 0.055, STEEL_BRIGHT, SURF.metal);
  b.strut([xKnee, kneeY, 0.06], [xTop, topY - 0.04, 0.34], 0.055, 0.055, STEEL_BRIGHT, SURF.metal);
  // Twin carbon collector contact strips (`arco coletor`) with turned-down horns
  b.box(xTop, topY - 0.03, 0, 0.24, 0.06, 1.48, RUBBER_DARK, SURF.metal);
  b.strut([xBase - 0.24, baseY + 0.02, 0], [xKnee + 0.06, kneeY - 0.06, 0], 0.038, 0.038, STEEL_MID, SURF.metal);
  for (const sd of [-1, 1] as const) {
    b.strut([xTop, topY, sd * 0.72], [xTop, topY - 0.12, sd * 0.94], 0.045, 0.045, STEEL_BRIGHT, SURF.metal);
  }
}

function buildMetroCar(spec: RailCarSpec, detail: AssetDetail): AssetBuildResult {
  const b = new MeshBuilder();
  const g = new MeshBuilder();

  // Rear straight body ends at -8.70; aerodynamic cab nose runs from +7.40 -> +9.06
  const xRear = -8.70;
  const xCabStart = 7.42;
  const xNoseTip = 9.08;
  const frameBot = 0.78;
  const skirtBot = 0.98;

  // 1. Two 2-axle metro bogies
  addBogie(b, -spec.bogieX, { wheelRadius: spec.wheelRadius, axlesHigh: 2, chassisBotY: frameBot + 0.04, wheelbase2: 2.15 }, detail);
  addBogie(b, spec.bogieX, { wheelRadius: spec.wheelRadius, axlesHigh: 2, chassisBotY: frameBot + 0.04, wheelbase2: 2.15 }, detail);

  // 2. Underframe + sleek shrouded metro side equipment skirt between bogies
  addChassis(
    b,
    xRear,
    xNoseTip - 0.26,
    frameBot,
    skirtBot + 0.06,
    spec.width * 0.46,
    {
      color: FRAME_DARK,
      underEquip: { len: 7.20, yBot: 0.46, halfW: 1.24, color: FRAME_MID },
    },
    detail,
  );

  // 3. Main curved metro body (-8.70 .. +7.42)
  const profile: CoachProfile = {
    ySkirt: skirtBot,
    yBelt: 1.56,
    yEave: 3.36,
    yCrown: 3.74,
    yPeak: 3.86,
    hwSkirt: 1.44,
    hwBody: spec.width * 0.5, // 1.51
    hwEave: 1.44,
    hwCrown: 1.06,
  };
  buildCurvedCoachShell(
    b,
    profile,
    xRear,
    xCabStart,
    {
      bodyColor: METRO_SILVER,
      bodySurf: SURF_STEEL_SATIN,
      roofColor: ROOF_METAL,
      roofSurf: SURF_ROOF_SATIN,
      skirtColor: STEEL_DARK,
      capFront: false,
      capRear: true,
      endColor: STEEL_MID,
    },
    detail,
  );

  // 4. Aerodynamic sloped metro cab nose (+7.42 -> +9.08) seamlessly stitched to the body ring!
  if (detail === 'low') {
    const noseRear: Vec3[] = [
      [xCabStart, profile.ySkirt, profile.hwSkirt],
      [xCabStart, profile.ySkirt, -profile.hwSkirt],
      [xCabStart, profile.yEave, -profile.hwEave],
      [xCabStart, profile.yPeak, -profile.hwCrown * 0.72],
      [xCabStart, profile.yPeak, profile.hwCrown * 0.72],
      [xCabStart, profile.yEave, profile.hwEave],
    ];
    const noseFront: Vec3[] = [
      [xNoseTip, profile.ySkirt + 0.08, profile.hwSkirt * 0.74],
      [xNoseTip, profile.ySkirt + 0.08, -profile.hwSkirt * 0.74],
      [xNoseTip - 0.62, profile.yEave - 0.10, -profile.hwEave * 0.74],
      [xNoseTip - 0.88, profile.yPeak - 0.08, -profile.hwCrown * 0.56],
      [xNoseTip - 0.88, profile.yPeak - 0.08, profile.hwCrown * 0.56],
      [xNoseTip - 0.62, profile.yEave - 0.10, profile.hwEave * 0.74],
    ];
    b.loft([noseRear, noseFront], METRO_SILVER, SURF_STEEL_SATIN, {
      capStart: false,
      capEnd: true,
      capEndColor: GLASS_METRO,
      capEndSurf: SURF.glass,
      faceColors: (_s, e) => (e === 0 ? { color: FRAME_DARK, surf: SURF_DECK } : e >= 2 && e <= 4 ? { color: ROOF_METAL, surf: SURF_ROOF_SATIN } : null),
    });
  } else {
    // 2-stage aerodynamic nose: lower bumper skirt pitches forward, upper panoramic cab windshield sweeps back cleanly
    const noseMid: Vec3[] = [
      [xNoseTip - 0.36, profile.ySkirt + 0.04, profile.hwSkirt * 0.88],
      [xNoseTip - 0.36, profile.ySkirt + 0.04, -profile.hwSkirt * 0.88],
      [xNoseTip - 0.12, profile.yBelt + 0.22, -profile.hwBody * 0.88],
      [xNoseTip - 0.52, profile.yEave - 0.06, -profile.hwEave * 0.82],
      [xNoseTip - 0.72, profile.yCrown - 0.04, -profile.hwCrown * 0.74],
      [xNoseTip - 0.78, profile.yPeak - 0.04, 0],
      [xNoseTip - 0.72, profile.yCrown - 0.04, profile.hwCrown * 0.74],
      [xNoseTip - 0.52, profile.yEave - 0.06, profile.hwEave * 0.82],
      [xNoseTip - 0.12, profile.yBelt + 0.22, profile.hwBody * 0.88],
    ];
    const noseTipRing: Vec3[] = [
      [xNoseTip - 0.06, profile.ySkirt + 0.10, profile.hwSkirt * 0.68],
      [xNoseTip - 0.06, profile.ySkirt + 0.10, -profile.hwSkirt * 0.68],
      [xNoseTip, profile.yBelt + 0.28, -profile.hwBody * 0.68],
      [xNoseTip - 0.44, profile.yEave - 0.10, -profile.hwEave * 0.64],
      [xNoseTip - 0.62, profile.yCrown - 0.08, -profile.hwCrown * 0.54],
      [xNoseTip - 0.66, profile.yPeak - 0.08, 0],
      [xNoseTip - 0.62, profile.yCrown - 0.08, profile.hwCrown * 0.54],
      [xNoseTip - 0.44, profile.yEave - 0.10, profile.hwEave * 0.64],
      [xNoseTip, profile.yBelt + 0.28, profile.hwBody * 0.68],
    ];
    const noseRings = detail === 'high'
      ? [makeCoachRing(xCabStart, profile), noseMid, noseTipRing]
      : [makeCoachRing(xCabStart, profile), noseTipRing];
    b.loft(noseRings, METRO_SILVER, SURF_STEEL_SATIN, {
      capStart: false,
      capEnd: true,
      capEndColor: RUBBER_DARK,
      capEndSurf: SURF.rubber,
      faceColors: (_s, e) => {
        if (e === 0) return { color: FRAME_DARK, surf: SURF_DECK };
        if (e === 1 || e === 8) return { color: STEEL_DARK, surf: SURF_DECK };
        if (e >= 3 && e <= 6) return { color: ROOF_METAL, surf: SURF_ROOF_SATIN };
        return null;
      },
    });

    // Sleek dark panoramic front windshield panel following exact raked front slope (proud +0.018 m along X)
    const wsX0 = xNoseTip - 0.01;
    const wsX1 = xNoseTip - 0.42;
    const wsY0 = profile.yBelt + 0.34;
    const wsY1 = profile.yEave - 0.18;
    b.quad(
      [wsX0, wsY0, 0.94],
      [wsX0, wsY0, -0.94],
      [wsX1, wsY1, -0.84],
      [wsX1, wsY1, 0.84],
      GLASS_METRO,
      SURF.glass,
    );
    // Side cab driver window hugging the exact tapered aerodynamic nose wall (+0.015 m along true outward normal)
    const noseRingA = makeCoachRing(xCabStart, profile);
    const noseRingB = detail === 'high' ? noseMid : noseTipRing;
    const noseSidePt = (u: number, v: number, outOff: number): Vec3 => {
      const a0 = noseRingA[8], a1 = noseRingA[7]; // +Z belt & eave at xCabStart
      const b0 = noseRingB[8], b1 = noseRingB[7]; // +Z belt & eave at noseMid / noseTipRing
      const p0x = a0[0] + (b0[0] - a0[0]) * u;
      const p0y = a0[1] + (b0[1] - a0[1]) * u;
      const p0z = a0[2] + (b0[2] - a0[2]) * u;
      const p1x = a1[0] + (b1[0] - a1[0]) * u;
      const p1y = a1[1] + (b1[1] - a1[1]) * u;
      const p1z = a1[2] + (b1[2] - a1[2]) * u;
      const tx = b0[0] - a0[0], tz = b0[2] - a0[2];
      const nLen = Math.hypot(tx, tz) || 1;
      const nx = -tz / nLen, nz = tx / nLen;
      return [
        p0x + (p1x - p0x) * v + nx * outOff,
        p0y + (p1y - p0y) * v,
        p0z + (p1z - p0z) * v + nz * outOff,
      ];
    };
    b.quadMirroredZ(
      noseSidePt(0.08, 0.22, 0.015),
      noseSidePt(0.64, 0.22, 0.015),
      noseSidePt(0.64, 0.80, 0.015),
      noseSidePt(0.08, 0.80, 0.015),
      GLASS_METRO,
      SURF.glass,
    );
    // Lower front line-color nose apron stripe (`SURF.paint`, aTint = 1)
    b.quad(
      [xNoseTip - 0.02, profile.ySkirt + 0.20, 0.96],
      [xNoseTip - 0.02, profile.ySkirt + 0.20, -0.96],
      [xNoseTip + 0.01, profile.yBelt + 0.22, -0.98],
      [xNoseTip + 0.01, profile.yBelt + 0.22, 0.98],
      WHITE,
      SURF.paint,
    );
  }

  // 5. Bold Metro Line livery band (`SURF.paint`, aTint = 1 — dynamically tinted by the real Metro Line color!)
  addCoachSideQuad(b, profile, xRear + 0.05, xCabStart, 1.32, 1.94, 0.010, WHITE, SURF.paint);
  if (detail !== 'low') {
    addCoachSideQuad(b, profile, xRear + 0.05, xCabStart, 3.12, 3.30, 0.010, WHITE, SURF.paint);
  }

  // 6. 3 wide pairs of sliding passenger doors + large panoramic metro windows
  const doorXs = [-5.40, -0.50, 4.40];
  const winRanges: [number, number][] = [
    [-8.15, -6.30],
    [-4.50, -1.40],
    [0.40, 3.50],
    [5.30, 7.05],
  ];
  const winY0 = 2.04;
  const winY1 = 3.04;

  if (detail === 'low') {
    addCoachSideQuad(b, profile, -8.10, 7.05, winY0, winY1, 0.014, GLASS_METRO, SURF.glass);
    addCoachSideQuad(g, profile, -7.95, 6.95, winY0 + 0.08, winY1 - 0.08, 0.024, GLOW_WIN_WARM, SURF.matte);
  } else if (detail === 'med') {
    // Clean continuous panoramic glass strip + 3 contrasting door frames at medium distance
    addCoachSideQuad(b, profile, -8.15, 7.05, winY0, winY1, 0.015, GLASS_METRO, SURF.glass);
    addCoachSideQuad(g, profile, -8.00, 6.95, winY0 + 0.08, winY1 - 0.08, 0.024, GLOW_WIN_WARM, SURF.matte);
    for (const dx of doorXs) {
      addCoachSideQuad(b, profile, dx - 0.78, dx + 0.78, 1.08, winY0 - 0.02, 0.013, BODY_SILVER, SURF.metal);
    }
  } else {
    for (const dx of doorXs) {
      // Metallic brushed door leaf pair
      addCoachSideQuad(b, profile, dx - 0.78, dx + 0.78, 1.08, 3.16, 0.013, BODY_SILVER, SURF.metal);
      // Center seam + twin tall door windows + night glow
      addCoachSideQuad(b, profile, dx - 0.03, dx + 0.03, 1.12, 3.14, 0.017, RUBBER_DARK, SURF.rubber);
      for (const s of [-1, 1] as const) {
        const d0 = dx + s * 0.39 - 0.26;
        const d1 = dx + s * 0.39 + 0.26;
        addCoachSideQuad(b, profile, d0, d1, 2.06, 3.00, 0.018, GLASS_METRO, SURF.glass);
        addCoachSideQuad(g, profile, d0 + 0.05, d1 - 0.05, 2.12, 2.94, 0.026, GLOW_WIN_WARM, SURF.matte);
      }
    }
    for (const [x0, x1] of winRanges) {
      addCoachSideQuad(b, profile, x0, x1, winY0, winY1, 0.015, GLASS_METRO, SURF.glass);
      addCoachSideQuad(g, profile, x0 + 0.09, x1 - 0.09, winY0 + 0.08, winY1 - 0.08, 0.024, GLOW_WIN_WARM, SURF.matte);
    }
  }

  // 7. Streamlined roof HVAC shrouds + 3D articulated pantograph
  if (detail !== 'low') {
    for (const hx of [-6.2, 2.1]) {
      b.taperBox(hx, profile.yCrown - 0.02, 0, 3.40, 1.92, 2.95, 1.56, 0.32, STEEL_MID, SURF_ROOF_SATIN, {
        topColor: METRO_SILVER,
        noBottom: true,
      });
    }
  }
  addPantograph(b, -2.55, profile.yPeak, detail);

  // 8. Rear gangway bellows (`sanfona`) + front/rear couplers (`-9.10 .. +9.18 -> L = 18.28 m <= 18.65`)
  addCouplers(
    b,
    xRear,
    xNoseTip - 0.24,
    0.92,
    {
      couplerReach: 0.38,
      gangwayRear: detail !== 'low' ? { yBot: 1.12, yTop: 3.30, halfW: 0.62, depth: 0.26 } : undefined,
    },
    detail,
  );

  // 9. Daytime LED headlight/taillight lenses + paired night glow mesh
  for (const sd of [-1, 1] as const) {
    if (detail !== 'low') {
      quadFrontX(b, xNoseTip + 0.016, 1.48, 1.66, sd * 0.72, 0.36, LENS_HEAD, SURF.glass);
      quadRearX(b, xRear - 0.014, 1.52, 1.72, sd * 1.10, 0.24, LENS_TAIL, SURF.glass);
    }
    quadFrontX(g, xNoseTip + 0.026, 1.48, 1.66, sd * 0.72, 0.36, GLOW_HEAD_LED, SURF.matte);
    quadRearX(g, xRear - 0.022, 1.52, 1.72, sd * 1.10, 0.24, GLOW_TAIL_RED, SURF.matte);
  }
  // Illuminated route/line LED destination sign above front windshield
  if (detail !== 'low') {
    quadFrontX(b, xNoseTip - 0.45, profile.yEave - 0.14, profile.yEave + 0.02, 0, 0.84, RUBBER_DARK, SURF.rubber);
    quadFrontX(g, xNoseTip - 0.435, profile.yEave - 0.13, profile.yEave + 0.01, 0, 0.80, GLOW_DEST_AMBER, SURF.matte);
  }

  return finalizeAsset(spec.id, spec.label, 'rail', b, g);
}

// ============================================================================
// PRESET CATALOG (exact 1:1 mapping with `src/sim/rail.ts` car types 0..5)
// ============================================================================
export const RAIL_PRESETS: RailCarPreset[] = [
  {
    id: 'loco',
    index: 0,
    label: 'Locomotiva Diesel-Elétrica',
    category: 'locomotive',
    maxSlotLen: RAIL_SLOT_LEN[0],
    defaultColor: RAIL_LOCO_PALETTE[0],
    swatches: RAIL_LOCO_PALETTE,
    hasGlow: true,
    spec: {
      id: 'loco',
      index: 0,
      label: 'Locomotiva Diesel-Elétrica',
      category: 'locomotive',
      maxSlotLen: RAIL_SLOT_LEN[0],
      frameLen: 15.40,
      width: 3.04,
      bogieX: 4.75,
      wheelRadius: 0.48,
      bogieAxlesHigh: 3,
      hasGlow: true,
    },
  },
  {
    id: 'passenger',
    index: 1,
    label: 'Carro de Passageiros Regional',
    category: 'passenger',
    maxSlotLen: RAIL_SLOT_LEN[1],
    defaultColor: RAIL_PASSENGER_PALETTE[0],
    swatches: RAIL_PASSENGER_PALETTE,
    hasGlow: true,
    spec: {
      id: 'passenger',
      index: 1,
      label: 'Carro de Passageiros Regional',
      category: 'passenger',
      maxSlotLen: RAIL_SLOT_LEN[1],
      frameLen: 18.40,
      width: 3.04,
      bogieX: 6.35,
      wheelRadius: 0.42,
      bogieAxlesHigh: 2,
      hasGlow: true,
    },
  },
  {
    id: 'container',
    index: 2,
    label: 'Vagão Porta-Contêineres',
    category: 'freight',
    maxSlotLen: RAIL_SLOT_LEN[2],
    defaultColor: RAIL_CONTAINER_PALETTE[0],
    swatches: RAIL_CONTAINER_PALETTE.slice(0, 4),
    hasGlow: false,
    spec: {
      id: 'container',
      index: 2,
      label: 'Vagão Porta-Contêineres',
      category: 'freight',
      maxSlotLen: RAIL_SLOT_LEN[2],
      frameLen: 15.40,
      width: 2.86,
      bogieX: 5.35,
      wheelRadius: 0.45,
      bogieAxlesHigh: 2,
      hasGlow: false,
    },
  },
  {
    id: 'hopper',
    index: 3,
    label: 'Vagão Graneleiro (Hopper)',
    category: 'freight',
    maxSlotLen: RAIL_SLOT_LEN[3],
    defaultColor: RAIL_HOPPER_PALETTE[0],
    swatches: RAIL_HOPPER_PALETTE,
    hasGlow: false,
    spec: {
      id: 'hopper',
      index: 3,
      label: 'Vagão Graneleiro (Hopper)',
      category: 'freight',
      maxSlotLen: RAIL_SLOT_LEN[3],
      frameLen: 13.50,
      width: 3.02,
      bogieX: 4.55,
      wheelRadius: 0.45,
      bogieAxlesHigh: 2,
      hasGlow: false,
    },
  },
  {
    id: 'tank',
    index: 4,
    label: 'Vagão-Tanque Cilíndrico',
    category: 'freight',
    maxSlotLen: RAIL_SLOT_LEN[4],
    defaultColor: RAIL_TANK_PALETTE[0],
    swatches: RAIL_TANK_PALETTE,
    hasGlow: false,
    spec: {
      id: 'tank',
      index: 4,
      label: 'Vagão-Tanque Cilíndrico',
      category: 'freight',
      maxSlotLen: RAIL_SLOT_LEN[4],
      frameLen: 14.50,
      width: 2.96,
      bogieX: 4.95,
      wheelRadius: 0.45,
      bogieAxlesHigh: 2,
      hasGlow: false,
    },
  },
  {
    id: 'metro',
    index: 5,
    label: 'Trem de Metrô Urbano',
    category: 'metro',
    maxSlotLen: RAIL_SLOT_LEN[5],
    defaultColor: RAIL_METRO_PALETTE[0],
    swatches: RAIL_METRO_PALETTE,
    hasGlow: true,
    spec: {
      id: 'metro',
      index: 5,
      label: 'Trem de Metrô Urbano',
      category: 'metro',
      maxSlotLen: RAIL_SLOT_LEN[5],
      frameLen: 17.80,
      width: 3.02,
      bogieX: 5.95,
      wheelRadius: 0.42,
      bogieAxlesHigh: 2,
      hasGlow: true,
    },
  },
];

const PRESET_BY_ID = new Map<RailCarId, RailCarPreset>(RAIL_PRESETS.map((p) => [p.id, p]));

/** Build any of the 6 parametric rail car types by ID or numeric index (0..5) at the requested LOD. */
export function buildRailCar(idOrIndex: RailCarId | number, detail: AssetDetail = 'high'): AssetBuildResult {
  const preset = typeof idOrIndex === 'number'
    ? RAIL_PRESETS[idOrIndex]
    : PRESET_BY_ID.get(idOrIndex);
  if (!preset) {
    throw new Error(`Unknown rail car preset: ${String(idOrIndex)}`);
  }
  switch (preset.id) {
    case 'loco': return buildLocomotive(preset.spec, detail);
    case 'passenger': return buildPassengerCoach(preset.spec, detail);
    case 'container': return buildContainerFlatcar(preset.spec, detail);
    case 'hopper': return buildHopperCar(preset.spec, detail);
    case 'tank': return buildTankCar(preset.spec, detail);
    case 'metro': return buildMetroCar(preset.spec, detail);
  }
}
