import {
  MeshBuilder,
  SURF,
  finalizeAsset,
  type AssetBuildResult,
  type AssetDetail,
  type SurfMat,
  type Vec3,
} from './meshKit';
import { VType } from '../shared/constants';

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

export type BodyKind =
  | 'sedan'
  | 'hatch'
  | 'suv'
  | 'pickup'
  | 'vintage'
  | 'van'
  | 'ambulance'
  | 'bus'
  | 'schoolbus'
  | 'tourbus'
  | 'cargo'
  | 'garbage'
  | 'dump'
  | 'fire';

export type RoofAccessory =
  | 'taxi'
  | 'lightbar-rb'
  | 'lightbar-rw'
  | 'beacon'
  | 'rack'
  | 'ac'
  | 'ladder'
  | 'tour-deck';

export type LiveryKind =
  | 'none'
  | 'taxi-stripe'
  | 'police-doors'
  | 'ambulance-cross'
  | 'bus-stripe'
  | 'school-rails'
  | 'fire-stripe'
  | 'vintage-chrome'
  | 'hearse-landau'
  | 'tour-stripe';

export interface VehicleSpec {
  kind: 'four-wheeler';
  id: VehicleId;
  label: string;
  bodyKind: BodyKind;
  length: number;
  width: number;
  groundClearance: number;
  beltY: number;
  roofY: number;
  wheelRadius: number;
  wheelWidth: number;
  /** Longitudinal axle positions (X coordinates in meters, centered near 0). */
  axles: number[];
  /** Hood length from front bumper to base of windshield. */
  hoodLen: number;
  /** Vertical drop of the front nose relative to beltY. */
  noseDrop: number;
  /** Rear deck / trunk length behind greenhouse (0 for hatch/van/bus). */
  trunkLen: number;
  /** Greenhouse top inward slope along X (front windshield rake). */
  windshieldRake: number;
  /** Greenhouse top inward slope along X (rear glass rake). */
  rearRake: number;
  /** Side tumblehome inward taper from beltline to roof (per side). */
  tumblehome: number;
  /** Relative longitudinal positions (0=rear, 1=front) of interior side pillars. */
  pillarPositions: number[];
  /** Declarative roof accessories (composable list). */
  roofAccessories: RoofAccessory[];
  /** Declarative side livery trim. */
  livery: LiveryKind;

  // --- Declarative orthogonal visual traits (no hidden bodyKind/livery side effects) ---
  /** Lower rocker dark rubber cladding (SUV / pickup). */
  darkCladding?: boolean;
  /** Chrome bumpers & classic trim. */
  chromeBumpers?: boolean;
  /** Front pushbar/bullbar. */
  pushBar?: boolean;
  /** Fixed two-tone roof color (aTint = 0, e.g. police white roof). */
  twoToneRoofColor?: number;
  /** Split center windshield mullion (vintage / schoolbus). */
  splitWindshield?: boolean;
  /** Subtle rear quarter tailfins (vintage). */
  tailfins?: boolean;
  /** Wider formal C/D pillar (SUV / hearse). */
  wideCPillar?: boolean;
  /** Warm tungsten headlight hue (vintage). */
  warmHeadlights?: boolean;
  /** Rear top emergency flashers or warning strobe. */
  rearFlashers?: 'red-pair' | 'amber-strobe';
  /** Exposed chassis fuel tanks between axles (heavy trucks). */
  fuelTanks?: boolean;
  /** Glass tint color. */
  glassColor?: number;
  /** Whether interior B/C pillars are dark rubber trim instead of body paint. */
  blackoutPillars?: boolean;
  /** Wheel rim style overrides. */
  rimColor?: number;
  hubColor?: number;
  rimRatio?: number;
}

export interface MotoSpec {
  kind: 'moto';
  id: VehicleId;
  label: string;
  length: number;
  wheelRadius: number;
  wheelWidth: number;
  wheelbase: number;
  seatHeight: number;
  tankHeight: number;
  handlebarWidth: number;
}

export type AnyVehicleSpec = VehicleSpec | MotoSpec;

export interface VehiclePreset {
  id: VehicleId;
  label: string;
  category: string;
  vtype: VType;
  defaultColor: number;
  swatches: number[];
  spec: AnyVehicleSpec;
}

const WHITE = 0xffffff;
const PAINT_SHADE = 0xe6e8ec;
const DARK_UNDER = 0x1a1d23;
const RUBBER_DARK = 0x22262e;
const RUBBER_MID = 0x2e343e;
const CHROME = 0xd6dce4;
const STEEL = 0xaeb6c2;
const STEEL_DARK = 0x565e6a;
const GLASS_STD = 0x456680;
const GLASS_DARK = 0x385369;
const GLOW_HEAD = 0xfff3d4;
const GLOW_HEAD_WARM = 0xffe4aa;
const GLOW_TAIL = 0xff2824;
const GLOW_AMBER = 0xffaa1d;
const GLOW_BLUE = 0x2a88ff;
const GLOW_WHITE = 0xffffff;

interface HullStation {
  x: number;
  yBot: number;
  yMid: number;
  yTop: number;
  hwBot: number;
  hwMid: number;
  hwTop: number;
}

interface SideWallProfile {
  yBot: number;
  yMid: number;
  yTop: number;
  hwBot: number;
  hwMid: number;
  hwTop: number;
}

interface GreenhouseCfg {
  xRearBot: number;
  xFrontBot: number;
  xRearTop: number;
  xFrontTop: number;
  yBot: number;
  yTop: number;
  hwBot: number;
  hwTop: number;
  pillarPositions: number[];
  pillarWidth?: number;
  aPillarWidth?: number;
  cPillarWidth?: number;
  roofRailH?: number;
  roofCrownH?: number;
  glassColor?: number;
  midPillarSurf?: SurfMat;
  midPillarColor?: number;
  pillarSurf?: SurfMat;
  pillarColor?: number;
  roofSurf?: SurfMat;
  roofColor?: number;
  rearGlass?: boolean;
  rearSmallWindow?: boolean;
  frontSplitPillar?: boolean;
}

interface RoofMountCtx {
  roofTopY: number;
  crownH: number;
  xRearRoof: number;
  xFrontRoof: number;
  hwRoof: number;
  /** Optional fire-truck ladder mount targets spanning apparatus -> cab. */
  ladderBaseY?: number;
  ladderRearX?: number;
  ladderFrontX?: number;
  cabRoofY?: number;
  cabRearX?: number;
}

function wheelSegs(detail: AssetDetail, isMoto = false): number {
  if (isMoto) return detail === 'high' ? 10 : detail === 'med' ? 8 : 6;
  return detail === 'high' ? 8 : 6;
}

/** Compute exact wheel center Y so the lowest vertex of an N-gon wheel rests exactly at Y = 0. */
function wheelCenterY(radius: number, seg: number): number {
  let minS = 0;
  for (let i = 0; i < seg; i++) {
    const s = Math.sin((i / seg) * Math.PI * 2);
    if (s < minS) minS = s;
  }
  return -minS * radius;
}

/** Evaluate hull half-width z(y) along a 2-segment side profile so arches & decals hug the real surface. */
function evalSideHalfWidth(p: SideWallProfile, y: number): number {
  if (y <= p.yBot) return p.hwBot;
  if (y <= p.yMid) {
    const t = (y - p.yBot) / Math.max(1e-4, p.yMid - p.yBot);
    return p.hwBot + (p.hwMid - p.hwBot) * t;
  }
  const t = Math.min(1, (y - p.yMid) / Math.max(1e-4, p.yTop - p.yMid));
  return p.hwMid + (p.hwTop - p.hwMid) * t;
}

/** Emit a single flat plate facing +X (outward normal [+1,0,0]). */
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

/** Emit a single flat plate facing -X (outward normal [-1,0,0]). */
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

/** Emit a chamfered wrap-around bumper bar (+X or -X); simplifies cleanly at low LOD. */
function addBumper(
  b: MeshBuilder,
  signX: 1 | -1,
  xFace: number,
  y0: number,
  h: number,
  halfW: number,
  color: number,
  surf: SurfMat,
  detail: AssetDetail,
) {
  if (detail === 'low') {
    if (signX > 0) quadFrontX(b, xFace + 0.025, y0, y0 + h, 0, halfW * 1.94, color, surf);
    else quadRearX(b, xFace - 0.025, y0, y0 + h, 0, halfW * 1.94, color, surf);
    return;
  }
  const depth = 0.095;
  const xBack = xFace - signX * 0.03;
  const xFront = xFace + signX * depth;
  const xCorner = xFace + signX * (depth * 0.52);
  const hwMain = halfW * 0.84;
  const hwWrap = halfW * 1.01;
  const y1 = y0 + h;

  // Center front/rear bumper face + top ledge
  if (signX > 0) {
    b.quad([xFront, y0, hwMain], [xFront, y0, -hwMain], [xFront, y1, -hwMain], [xFront, y1, hwMain], color, surf);
    b.quad([xBack, y1, hwMain], [xFront, y1, hwMain], [xFront, y1, -hwMain], [xBack, y1, -hwMain], color, surf, [0, 1, 0]);
  } else {
    b.quad([xFront, y0, -hwMain], [xFront, y0, hwMain], [xFront, y1, hwMain], [xFront, y1, -hwMain], color, surf);
    b.quad([xFront, y1, hwMain], [xBack, y1, hwMain], [xBack, y1, -hwMain], [xFront, y1, -hwMain], color, surf, [0, 1, 0]);
  }

  // Chamfered wrap-around corner + side return (mirrored across Z)
  if (signX > 0) {
    b.quadMirroredZ([xCorner, y0, hwWrap], [xFront, y0, hwMain], [xFront, y1, hwMain], [xCorner, y1, hwWrap], color, surf);
    b.quadMirroredZ([xBack, y0, hwWrap], [xCorner, y0, hwWrap], [xCorner, y1, hwWrap], [xBack, y1, hwWrap], color, surf);
  } else {
    b.quadMirroredZ([xFront, y0, hwMain], [xCorner, y0, hwWrap], [xCorner, y1, hwWrap], [xFront, y1, hwMain], color, surf);
    b.quadMirroredZ([xCorner, y0, hwWrap], [xBack, y0, hwWrap], [xBack, y1, hwWrap], [xCorner, y1, hwWrap], color, surf);
  }
}

/**
 * Loft a 6-vertex automotive cross-section hull along X:
 * [bottom+Z, bottom-Z, rocker-Z, belt-Z, belt+Z, rocker+Z]
 * Automatically assigns dark underbody, shaded/cladded lower rocker, and bright paint sides/deck.
 */
function buildSculptedHull(
  b: MeshBuilder,
  stations: HullStation[],
  opts: {
    color?: number;
    surf?: SurfMat;
    rockerSurf?: SurfMat;
    rockerColor?: number;
    topColor?: number;
    topSurf?: SurfMat;
    capStart?: boolean;
    capEnd?: boolean;
    capStartColor?: number;
    capEndColor?: number;
    capStartSurf?: SurfMat;
    capEndSurf?: SurfMat;
  } = {},
) {
  const baseColor = opts.color ?? WHITE;
  const baseSurf = opts.surf ?? SURF.paint;
  const rockerSurf = opts.rockerSurf ?? baseSurf;
  const rockerColor = opts.rockerColor ?? (baseSurf.tint > 0.5 ? PAINT_SHADE : baseColor);

  const rings: Vec3[][] = stations.map((s) => [
    [s.x, s.yBot, s.hwBot],
    [s.x, s.yBot, -s.hwBot],
    [s.x, s.yMid, -s.hwMid],
    [s.x, s.yTop, -s.hwTop],
    [s.x, s.yTop, s.hwTop],
    [s.x, s.yMid, s.hwMid],
  ]);

  b.loft(rings, baseColor, baseSurf, {
    capStart: opts.capStart ?? true,
    capEnd: opts.capEnd ?? true,
    capStartColor: opts.capStartColor ?? baseColor,
    capEndColor: opts.capEndColor ?? baseColor,
    capStartSurf: opts.capStartSurf ?? baseSurf,
    capEndSurf: opts.capEndSurf ?? baseSurf,
    faceColors: (_segIdx, edgeIdx) => {
      if (edgeIdx === 0) return { color: DARK_UNDER, surf: SURF.rubber };
      if (edgeIdx === 1 || edgeIdx === 5) return { color: rockerColor, surf: rockerSurf };
      if (edgeIdx === 3 && (opts.topColor !== undefined || opts.topSurf !== undefined)) {
        return { color: opts.topColor ?? baseColor, surf: opts.topSurf ?? baseSurf };
      }
      return null;
    },
  });
}

/**
 * Watertight tapered greenhouse with flush A/B/C/D pillars, painted roof rail,
 * angled front/rear windshields, and softly crowned roof (zero Z-fighting).
 */
function buildFramedGreenhouse(b: MeshBuilder, cfg: GreenhouseCfg, detail: AssetDetail) {
  const {
    xRearBot,
    xFrontBot,
    xRearTop,
    xFrontTop,
    yBot,
    yTop,
    hwBot,
    hwTop,
    pillarPositions,
  } = cfg;

  const h = yTop - yBot;
  const sideLen = Math.max(0.2, xFrontBot - xRearBot);
  const aW = cfg.aPillarWidth ?? 0.13;
  const cW = cfg.cPillarWidth ?? 0.19;
  const mW = cfg.pillarWidth ?? 0.11;
  const railH = Math.min(cfg.roofRailH ?? 0.065, h * 0.22);
  const crownH = detail === 'low' ? 0 : (cfg.roofCrownH ?? 0.045);
  const vRail = 1 - railH / h;

  const glassC = cfg.glassColor ?? GLASS_STD;
  const pColor = cfg.pillarColor ?? WHITE;
  const pSurf = cfg.pillarSurf ?? SURF.paint;
  const mColor = cfg.midPillarColor ?? pColor;
  const mSurf = cfg.midPillarSurf ?? pSurf;
  const rColor = cfg.roofColor ?? pColor;
  const rSurf = cfg.roofSurf ?? pSurf;

  const yAt = (v: number) => yBot + h * v;
  const hwAt = (v: number) => hwBot + (hwTop - hwBot) * v;
  const xRAt = (v: number) => xRearBot + (xRearTop - xRearBot) * v;
  const xFAt = (v: number) => xFrontBot + (xFrontTop - xFrontBot) * v;

  const sidePt = (u: number, v: number): Vec3 => [
    xRAt(v) + (xFAt(v) - xRAt(v)) * u,
    yAt(v),
    hwAt(v),
  ];

  // Partition side wall [0..1] into alternating pillar & glass spans
  const uC = Math.min(0.24, cW / sideLen);
  const uA = Math.min(0.20, aW / sideLen);
  const uM = Math.min(0.10, mW / sideLen);

  interface Span { u0: number; u1: number; color: number; surf: SurfMat }
  const spans: Span[] = [];
  let cursor = 0;

  spans.push({ u0: 0, u1: uC, color: pColor, surf: pSurf });
  cursor = uC;

  // Low LOD keeps major bus pillars (every other) and drops fine car interior B/C pillars
  const activePillars = detail === 'low'
    ? (pillarPositions.length >= 4 ? pillarPositions.filter((_, idx) => idx % 2 === 1) : [])
    : [...pillarPositions].sort((a, b2) => a - b2);

  for (const p of activePillars) {
    const p0 = Math.max(cursor + 0.02, p - uM * 0.5);
    const p1 = Math.min(1 - uA - 0.02, p + uM * 0.5);
    if (p1 > p0 + 0.005) {
      spans.push({ u0: cursor, u1: p0, color: glassC, surf: SURF.glass });
      spans.push({ u0: p0, u1: p1, color: mColor, surf: mSurf });
      cursor = p1;
    }
  }

  if (1 - uA > cursor + 0.01) {
    spans.push({ u0: cursor, u1: 1 - uA, color: glassC, surf: SURF.glass });
  }
  spans.push({ u0: 1 - uA, u1: 1, color: pColor, surf: pSurf });

  for (const sp of spans) {
    b.quadMirroredZ(
      sidePt(sp.u0, 0),
      sidePt(sp.u1, 0),
      sidePt(sp.u1, vRail),
      sidePt(sp.u0, vRail),
      sp.color,
      sp.surf,
    );
  }
  b.quadMirroredZ(
    sidePt(0, vRail),
    sidePt(1, vRail),
    sidePt(1, 1),
    sidePt(0, 1),
    rColor,
    rSurf,
  );

  // Front windshield (+X outward: +Z -> -Z at bottom)
  const fPt = (s: number, v: number): Vec3 => [xFAt(v), yAt(v), s * hwAt(v)];
  const fPillar = Math.min(0.15, aW / (hwBot * 2));
  const fInner = 1 - fPillar * 2;
  b.quad(fPt(1, 0), fPt(fInner, 0), fPt(fInner, vRail), fPt(1, vRail), pColor, pSurf);
  b.quad(fPt(-fInner, 0), fPt(-1, 0), fPt(-1, vRail), fPt(-fInner, vRail), pColor, pSurf);
  if (cfg.frontSplitPillar && detail !== 'low') {
    const mid = 0.04;
    b.quad(fPt(fInner, 0), fPt(mid, 0), fPt(mid, vRail), fPt(fInner, vRail), glassC, SURF.glass);
    b.quad(fPt(mid, 0), fPt(-mid, 0), fPt(-mid, vRail), fPt(mid, vRail), pColor, pSurf);
    b.quad(fPt(-mid, 0), fPt(-fInner, 0), fPt(-fInner, vRail), fPt(-mid, vRail), glassC, SURF.glass);
  } else {
    b.quad(fPt(fInner, 0), fPt(-fInner, 0), fPt(-fInner, vRail), fPt(fInner, vRail), glassC, SURF.glass);
  }
  b.quad(fPt(1, vRail), fPt(-1, vRail), fPt(-1, 1), fPt(1, 1), rColor, rSurf);

  // Rear face (-X outward: -Z -> +Z at bottom)
  const rPt = (s: number, v: number): Vec3 => [xRAt(v), yAt(v), s * hwAt(v)];
  if (cfg.rearGlass === false) {
    b.quad(rPt(-1, 0), rPt(1, 0), rPt(1, 1), rPt(-1, 1), pColor, pSurf);
  } else if (cfg.rearSmallWindow && detail !== 'low') {
    const ri = 0.62;
    const vb = 0.24;
    b.quad(rPt(-1, 0), rPt(1, 0), rPt(1, vb), rPt(-1, vb), pColor, pSurf);
    b.quad(rPt(-1, vb), rPt(-ri, vb), rPt(-ri, vRail), rPt(-1, vRail), pColor, pSurf);
    b.quad(rPt(-ri, vb), rPt(ri, vb), rPt(ri, vRail), rPt(-ri, vRail), glassC, SURF.glass);
    b.quad(rPt(ri, vb), rPt(1, vb), rPt(1, vRail), rPt(ri, vRail), pColor, pSurf);
    b.quad(rPt(-1, vRail), rPt(1, vRail), rPt(1, 1), rPt(-1, 1), rColor, rSurf);
  } else {
    const rPillar = Math.min(0.18, cW / (hwBot * 2));
    const rInner = 1 - rPillar * 2;
    b.quad(rPt(-1, 0), rPt(-rInner, 0), rPt(-rInner, vRail), rPt(-1, vRail), pColor, pSurf);
    b.quad(rPt(-rInner, 0), rPt(rInner, 0), rPt(rInner, vRail), rPt(-rInner, vRail), glassC, SURF.glass);
    b.quad(rPt(rInner, 0), rPt(1, 0), rPt(1, vRail), rPt(rInner, vRail), pColor, pSurf);
    b.quad(rPt(-1, vRail), rPt(1, vRail), rPt(1, 1), rPt(-1, 1), rColor, rSurf);
  }

  // Crowned / beveled roof
  if (crownH > 0.005) {
    const cX = Math.min(0.12, (xFrontTop - xRearTop) * 0.14);
    const cZ = Math.min(0.10, hwTop * 0.16);
    const yC = yTop + crownH;
    const b0: Vec3 = [xRearTop, yTop, hwTop];
    const b1: Vec3 = [xFrontTop, yTop, hwTop];
    const b2: Vec3 = [xFrontTop, yTop, -hwTop];
    const b3: Vec3 = [xRearTop, yTop, -hwTop];
    const t0: Vec3 = [xRearTop + cX, yC, hwTop - cZ];
    const t1: Vec3 = [xFrontTop - cX, yC, hwTop - cZ];
    const t2: Vec3 = [xFrontTop - cX, yC, -(hwTop - cZ)];
    const t3: Vec3 = [xRearTop + cX, yC, -(hwTop - cZ)];
    b.quad(b0, b1, t1, t0, rColor, rSurf);
    b.quad(b2, b3, t3, t2, rColor, rSurf);
    b.quad(b1, b2, t2, t1, rColor, rSurf);
    b.quad(b3, b0, t0, t3, rColor, rSurf);
    b.quad(t0, t1, t2, t3, rColor, rSurf, [0, 1, 0]);
  } else {
    b.quad(
      [xRearTop, yTop, hwTop],
      [xFrontTop, yTop, hwTop],
      [xFrontTop, yTop, -hwTop],
      [xRearTop, yTop, -hwTop],
      rColor,
      rSurf,
      [0, 1, 0],
    );
  }
}

/** Add all vehicle wheels touching Y = 0 exactly across all LOD levels. */
function addWheels(b: MeshBuilder, spec: VehicleSpec, detail: AssetDetail) {
  const seg = wheelSegs(detail, false);
  const cy = wheelCenterY(spec.wheelRadius, seg);
  const halfW = spec.width * 0.5;
  const zWheel = halfW - spec.wheelWidth * 0.42;
  const rimColor = spec.rimColor ?? 0xc8cfd8;
  const hubColor = spec.hubColor ?? 0x4b525e;
  const rimRatio = spec.rimRatio ?? 0.58;

  for (const ax of spec.axles) {
    for (const s of [-1, 1] as const) {
      b.wheel(ax, cy, s * zWheel, spec.wheelRadius, spec.wheelWidth, seg, {
        rimColor,
        hubColor,
        rimRatio,
        outerSign: s,
      });
    }
  }
}

/**
 * Flush sculpted 3D wheel arches + dark rubber wheel-well backing hugging the true hull slope z(y).
 * Inner arch crest sits slightly proud around the tire opening, outer rim returns cleanly INTO the hull
 * so zero floating gap can ever appear from any viewing angle.
 */
function addWheelArches(
  b: MeshBuilder,
  spec: VehicleSpec,
  detail: AssetDetail,
  wall: SideWallProfile,
  opts: { axles?: number[]; flareLip?: boolean } = {},
) {
  if (detail === 'low') return;
  const r = spec.wheelRadius;
  const rWellIn = r * 0.62;
  const rIn = r + 0.032;
  const rOut = r + 0.088;
  const cy = wheelCenterY(r, wheelSegs(detail, false));
  const archYMax = wall.yTop - 0.04;
  const surf = spec.darkCladding ? SURF.rubber : SURF.paint;
  const col = spec.darkCladding ? RUBBER_MID : PAINT_SHADE;
  const doFlare = (opts.flareLip ?? true) && detail === 'high';
  const axles = opts.axles ?? spec.axles;
  const angles = [Math.PI * 0.92, Math.PI * 0.65, Math.PI * 0.35, Math.PI * 0.08];

  for (const ax of axles) {
    for (let i = 0; i < angles.length - 1; i++) {
      const a0 = angles[i];
      const a1 = angles[i + 1];
      const c0 = Math.cos(a0), s0 = Math.sin(a0);
      const c1 = Math.cos(a1), s1 = Math.sin(a1);

      const y0w = Math.max(wall.yBot + 0.02, Math.min(archYMax, cy + s0 * rWellIn));
      const y1w = Math.max(wall.yBot + 0.02, Math.min(archYMax, cy + s1 * rWellIn));
      const y0i = Math.min(archYMax, cy + s0 * rIn);
      const y1i = Math.min(archYMax, cy + s1 * rIn);

      const z0w = evalSideHalfWidth(wall, y0w) + 0.005;
      const z1w = evalSideHalfWidth(wall, y1w) + 0.005;
      const z0i = evalSideHalfWidth(wall, y0i) + 0.006;
      const z1i = evalSideHalfWidth(wall, y1i) + 0.006;

      // Dark wheel-well backing sitting flush along the hull behind the tire
      b.quadMirroredZ(
        [ax + c0 * rWellIn, y0w, z0w],
        [ax + c1 * rWellIn, y1w, z1w],
        [ax + c1 * rIn, y1i, z1i],
        [ax + c0 * rIn, y0i, z0i],
        DARK_UNDER,
        SURF.rubber,
      );

      // Closed 3D beveled fender lip (crest proud +0.022m, outer edge tucked -0.008m into hull)
      if (doFlare) {
        const y0o = Math.min(archYMax + 0.025, cy + s0 * rOut);
        const y1o = Math.min(archYMax + 0.025, cy + s1 * rOut);
        const z0Crest = evalSideHalfWidth(wall, y0i) + 0.022;
        const z1Crest = evalSideHalfWidth(wall, y1i) + 0.022;
        const z0Hull = evalSideHalfWidth(wall, y0o) - 0.008;
        const z1Hull = evalSideHalfWidth(wall, y1o) - 0.008;
        b.quadMirroredZ(
          [ax + c0 * rIn, y0i, z0Crest],
          [ax + c1 * rIn, y1i, z1Crest],
          [ax + c1 * rOut, y1o, z1Hull],
          [ax + c0 * rOut, y0o, z0Hull],
          col,
          surf,
        );
      }
    }
  }
}

/** Add paired 3D side mirrors without wasted hidden inner faces (omitted at low LOD). */
function addSideMirrors(b: MeshBuilder, x: number, y: number, halfW: number, scale = 1, detail: AssetDetail = 'high') {
  if (detail === 'low') return;
  const hx = 0.045 * scale;
  const sy = 0.085 * scale;
  const sz = 0.14 * scale;
  const zIn = halfW - 0.015;
  const zOut = halfW + sz;
  b.quadMirroredZ([x - hx, y, zOut], [x + hx, y, zOut], [x + hx, y + sy, zOut], [x - hx, y + sy, zOut], RUBBER_DARK, SURF.rubber);
  b.quadMirroredZ([x + hx, y, zOut], [x + hx, y, zIn], [x + hx, y + sy, zIn], [x + hx, y + sy, zOut], RUBBER_DARK, SURF.rubber);
  b.quadMirroredZ([x - hx, y, zIn], [x - hx, y, zOut], [x - hx, y + sy, zOut], [x - hx, y + sy, zIn], RUBBER_DARK, SURF.rubber);
  b.quadMirroredZ([x - hx, y + sy, zOut], [x + hx, y + sy, zOut], [x + hx, y + sy, zIn], [x - hx, y + sy, zIn], RUBBER_MID, SURF.rubber);
}

/** Front chamfered bumper, grille, headlight bezels, and flush glow lenses (+X face). */
function addFrontFascia(
  b: MeshBuilder,
  g: MeshBuilder,
  detail: AssetDetail,
  opts: {
    xFront: number;
    yBot: number;
    yLight: number;
    halfW: number;
    bumperH: number;
    grilleH: number;
    grilleW: number;
    lightW: number;
    lightH: number;
    lightZ: number;
    chrome?: boolean;
    pushBar?: boolean;
    warmLights?: boolean;
  },
) {
  const { xFront, yBot, yLight, halfW, bumperH, grilleH, grilleW, lightW, lightH, lightZ } = opts;
  const bSurf = opts.chrome ? SURF.metal : SURF.rubber;
  const bCol = opts.chrome ? CHROME : RUBBER_DARK;

  addBumper(b, 1, xFront, yBot, bumperH, halfW, bCol, bSurf, detail);

  // Clean recessed grille + metallic crossbar
  const gY0 = yLight - grilleH * 0.48;
  const gY1 = gY0 + grilleH;
  quadFrontX(b, xFront + 0.008, gY0, gY1, 0, grilleW, DARK_UNDER, SURF.rubber);
  if (detail !== 'low') {
    const barY0 = gY0 + grilleH * 0.42;
    const barY1 = barY0 + Math.max(0.028, grilleH * 0.18);
    quadFrontX(b, xFront + 0.014, barY0, barY1, 0, grilleW * 0.94, opts.chrome ? CHROME : STEEL, SURF.metal);
  }

  // Headlight bezels + flush glow quads (0.011m offset — no protruding white pegs in side profile!)
  const headCol = opts.warmLights ? GLOW_HEAD_WARM : GLOW_HEAD;
  for (const s of [-1, 1] as const) {
    const z = s * lightZ;
    if (detail !== 'low') {
      quadFrontX(
        b,
        xFront + 0.006,
        yLight - lightH * 0.56,
        yLight + lightH * 0.56,
        z,
        lightW * 1.12,
        opts.chrome ? CHROME : RUBBER_DARK,
        opts.chrome ? SURF.metal : SURF.rubber,
      );
    }
    quadFrontX(g, xFront + 0.012, yLight - lightH * 0.44, yLight + lightH * 0.44, z, lightW * 0.94, headCol, SURF.matte);
  }

  // Optional police pushbar (omitted at low LOD)
  if (opts.pushBar && detail !== 'low') {
    const px = xFront + 0.11;
    const py = yBot + bumperH * 0.25;
    const ph = grilleH + bumperH * 0.85;
    const pz = grilleW * 0.48;
    // Two vertical uprights (front + outer + top quads, mirrored across Z = 12 tris)
    b.quadMirroredZ([px + 0.03, py, pz + 0.025], [px + 0.03, py, pz - 0.025], [px + 0.03, py + ph, pz - 0.025], [px + 0.03, py + ph, pz + 0.025], RUBBER_DARK, SURF.rubber);
    b.quadMirroredZ([px - 0.03, py, pz + 0.025], [px + 0.03, py, pz + 0.025], [px + 0.03, py + ph, pz + 0.025], [px - 0.03, py + ph, pz + 0.025], RUBBER_DARK, SURF.rubber);
    b.quadMirroredZ([px - 0.03, py + ph, pz + 0.025], [px + 0.03, py + ph, pz + 0.025], [px + 0.03, py + ph, pz - 0.025], [px - 0.03, py + ph, pz - 0.025], RUBBER_MID, SURF.rubber);
    const barY = py + ph * 0.60;
    quadFrontX(b, px + 0.035, barY, barY + 0.055, 0, grilleW * 1.04, RUBBER_DARK, SURF.rubber);
    b.quad(
      [px - 0.015, barY + 0.055, grilleW * 0.52],
      [px + 0.035, barY + 0.055, grilleW * 0.52],
      [px + 0.035, barY + 0.055, -grilleW * 0.52],
      [px - 0.015, barY + 0.055, -grilleW * 0.52],
      RUBBER_DARK,
      SURF.rubber,
      [0, 1, 0],
    );
  }
}

/** Rear chamfered bumper, license plate, taillight bezels, and flush glow lenses (-X face). */
function addRearFascia(
  b: MeshBuilder,
  g: MeshBuilder,
  detail: AssetDetail,
  opts: {
    xRear: number;
    yBot: number;
    yLight: number;
    halfW: number;
    bumperH: number;
    lightW: number;
    lightH: number;
    lightZ: number;
    chrome?: boolean;
  },
) {
  const { xRear, yBot, yLight, halfW, bumperH, lightW, lightH, lightZ } = opts;
  const bSurf = opts.chrome ? SURF.metal : SURF.rubber;
  const bCol = opts.chrome ? CHROME : RUBBER_DARK;

  addBumper(b, -1, xRear, yBot, bumperH, halfW, bCol, bSurf, detail);
  if (detail !== 'low') {
    quadRearX(b, xRear - 0.008, yLight - lightH * 0.42, yLight - lightH * 0.42 + 0.13, 0, 0.34, 0xe8ebf0, SURF.paintFixed);
  }

  for (const s of [-1, 1] as const) {
    const z = s * lightZ;
    if (detail !== 'low') {
      quadRearX(b, xRear - 0.006, yLight - lightH * 0.56, yLight + lightH * 0.56, z, lightW * 1.12, RUBBER_DARK, SURF.rubber);
    }
    quadRearX(g, xRear - 0.012, yLight - lightH * 0.44, yLight + lightH * 0.44, z, lightW * 0.92, GLOW_TAIL, SURF.matte);
  }
}

/** Add all declarative roof accessories cleanly anchored onto the real roof surface (zero floating). */
function addRoofAccessories(
  b: MeshBuilder,
  g: MeshBuilder,
  accessories: RoofAccessory[],
  ctx: RoofMountCtx,
  detail: AssetDetail,
) {
  const { roofTopY, crownH, xRearRoof, xFrontRoof, hwRoof } = ctx;
  const cx = (xRearRoof + xFrontRoof) * 0.5;
  const len = xFrontRoof - xRearRoof;

  for (const acc of accessories) {
    switch (acc) {
      case 'taxi': {
        b.box(cx + 0.04, roofTopY - 0.01, 0, 0.24, 0.045, 0.62, RUBBER_DARK, SURF.rubber, { noBottom: true });
        g.taperBox(cx + 0.04, roofTopY + 0.032, 0, 0.23, 0.56, 0.16, 0.48, 0.13, 0xffe45c, SURF.matte, { noBottom: true });
        break;
      }

      case 'lightbar-rb':
      case 'lightbar-rw': {
        const lx = xFrontRoof - Math.min(0.42, len * 0.32);
        const barW = Math.min(1.26, hwRoof * 1.65);
        const y0 = roofTopY - 0.01;
        b.box(lx, y0, 0, 0.18, 0.05, barW, RUBBER_DARK, SURF.rubber, { noBottom: true });
        const podW = barW * 0.36;
        const podZ = barW * 0.30;
        const rightGlow = acc === 'lightbar-rb' ? GLOW_BLUE : GLOW_WHITE;
        g.box(lx, y0 + 0.046, podZ, 0.19, 0.095, podW, GLOW_TAIL, SURF.matte, { noBottom: true });
        g.box(lx, y0 + 0.046, -podZ, 0.19, 0.095, podW, rightGlow, SURF.matte, { noBottom: true });
        break;
      }

      case 'beacon': {
        const bx = xFrontRoof - 0.36;
        b.box(bx, roofTopY - 0.01, 0, 0.20, 0.05, 0.20, RUBBER_DARK, SURF.rubber, { noBottom: true });
        g.box(bx, roofTopY + 0.038, 0, 0.16, 0.12, 0.16, GLOW_AMBER, SURF.matte, { noBottom: true });
        break;
      }

      case 'rack': {
        // Flush-mounted OEM aerodynamic rails embedded directly into the roof bevel (zero air gap / zero floating)
        const rLen = len * 0.80;
        const rz = hwRoof * 0.80;
        const yEmbed = roofTopY - crownH - 0.015;
        const railH = crownH + 0.062;
        for (const s of [-1, 1] as const) {
          b.taperBox(cx, yEmbed, s * rz, rLen, 0.065, rLen * 0.86, 0.05, railH, RUBBER_DARK, SURF.rubber, { noBottom: true });
        }
        if (detail === 'high') {
          for (const f of [-0.28, 0.22]) {
            const xBar = cx + f * rLen;
            b.quad([xBar - 0.025, roofTopY + 0.042, rz], [xBar + 0.025, roofTopY + 0.042, rz], [xBar + 0.025, roofTopY + 0.042, -rz], [xBar - 0.025, roofTopY + 0.042, -rz], RUBBER_MID, SURF.rubber, [0, 1, 0]);
            quadFrontX(b, xBar + 0.025, roofTopY + 0.012, roofTopY + 0.042, 0, rz * 2, RUBBER_DARK, SURF.rubber);
          }
        }
        break;
      }

      case 'ac': {
        const podLen = Math.min(2.2, len * 0.24);
        const podW = hwRoof * 1.20;
        const centers = detail === 'low' ? [cx] : [cx - len * 0.22, cx + len * 0.18];
        for (const px of centers) {
          b.taperBox(px, roofTopY - 0.012, 0, podLen, podW, podLen * 0.86, podW * 0.88, 0.22, 0xdce1e8, SURF.paintFixed, { noBottom: true });
        }
        break;
      }

      case 'ladder': {
        // Rear turntable + front metallic gantry cradle + gently ramped telescopic ladder (zero cantilever float!)
        const baseY = ctx.ladderBaseY ?? roofTopY;
        const xBase = (ctx.ladderRearX ?? xRearRoof) + 0.85;
        const xCradle = (ctx.cabRearX ?? (xFrontRoof - 0.6)) - 0.22;
        const xTip = ctx.ladderFrontX ?? (xFrontRoof - 0.65);
        const yBase = baseY + 0.20;
        const yTip = Math.max(yBase + 0.04, (ctx.cabRoofY ?? baseY) + 0.14);
        const lhw = 0.34;
        const tCradle = (xCradle - xBase) / Math.max(0.1, xTip - xBase);
        const yAtCradle = yBase + (yTip - yBase) * tCradle;

        // Rear turntable pedestal anchored on apparatus roof
        b.box(xBase, baseY - 0.015, 0, 1.00, 0.20, 0.88, STEEL_DARK, SURF.metal, { noBottom: true });
        // Front ladder cradle stanchion anchored firmly on front of apparatus roof supporting both rails
        if (detail !== 'low') {
          const cY0 = baseY - 0.015;
          const cY1 = yAtCradle - 0.05;
          const chw = lhw * 1.12;
          quadFrontX(b, xCradle + 0.09, cY0, cY1, 0, chw * 2, STEEL_DARK, SURF.metal);
          quadRearX(b, xCradle - 0.09, cY0, cY1, 0, chw * 2, STEEL_DARK, SURF.metal);
          b.quadMirroredZ([xCradle - 0.09, cY0, chw], [xCradle + 0.09, cY0, chw], [xCradle + 0.09, cY1, chw], [xCradle - 0.09, cY1, chw], STEEL, SURF.metal);
        }

        // Twin side rails (clean 4-face lofted beams)
        for (const s of [-1, 1] as const) {
          const z = s * lhw;
          const hw = 0.04;
          const hh = 0.058;
          b.loft([
            [[xBase - 0.26, yBase - hh, z + hw], [xBase - 0.26, yBase - hh, z - hw], [xBase - 0.26, yBase + hh, z - hw], [xBase - 0.26, yBase + hh, z + hw]],
            [[xTip, yTip - hh, z + hw], [xTip, yTip - hh, z - hw], [xTip, yTip + hh, z - hw], [xTip, yTip + hh, z + hw]],
          ], CHROME, SURF.metal, { capStart: false, capEnd: true });
        }

        // Metallic ladder rungs
        const rungCount = detail === 'low' ? 3 : 4;
        for (let i = 0; i < rungCount; i++) {
          const t = (i + 0.5) / rungCount;
          const rx = xBase - 0.14 + (xTip - (xBase - 0.14)) * t;
          const ry = yBase + (yTip - yBase) * t;
          const rw = 0.06;
          b.quad(
            [rx - rw, ry + 0.01, lhw - 0.02],
            [rx + rw, ry + 0.01, lhw - 0.02],
            [rx + rw, ry + 0.01, -(lhw - 0.02)],
            [rx - rw, ry + 0.01, -(lhw - 0.02)],
            STEEL,
            SURF.metal,
            [0, 1, 0],
          );
          if (detail !== 'low') {
            quadFrontX(b, rx + rw, ry - 0.032, ry + 0.01, 0, (lhw - 0.02) * 2, STEEL_DARK, SURF.metal);
          }
        }
        break;
      }

      case 'tour-deck': {
        // Open-top upper sightseeing deck: recessed side parapets (zero corner overlap), 4 canopy posts, seats
        const yDeck = roofTopY;
        const wallH = 0.62;
        const railTop = yDeck + wallH;
        const hw = hwRoof + 0.04;
        const sidePanelH = 0.44;
        const rearWallT = 0.10;
        const sideStart = xRearRoof + rearWallT; // recessed 0.10m to butt cleanly against rear parapet
        const sideEnd = xFrontRoof - 0.42;
        const sideLen = sideEnd - sideStart;
        const sideCx = (sideStart + sideEnd) * 0.5;

        // Rear parapet wall (full width) + recessed side parapet walls (zero coplanar corner overlap)
        b.box(xRearRoof + rearWallT * 0.5, yDeck - 0.01, 0, rearWallT, sidePanelH, hw * 2, WHITE, SURF.paint, { noBottom: true });
        b.box(sideCx, yDeck - 0.01, hw - 0.045, sideLen, sidePanelH, 0.09, WHITE, SURF.paint, { noBottom: true });
        b.box(sideCx, yDeck - 0.01, -(hw - 0.045), sideLen, sidePanelH, 0.09, WHITE, SURF.paint, { noBottom: true });

        // Front sloped panoramic glass wind deflector
        b.taperBox(xFrontRoof - 0.24, yDeck - 0.01, 0, 0.54, hw * 1.98, 0.20, hw * 1.92, wallH + 0.16, GLASS_STD, SURF.glass, {
          oxTop: -0.16,
          topColor: WHITE,
          topSurf: SURF.paint,
          noBottom: true,
        });

        // Perimeter chrome safety handrail
        if (detail !== 'low') {
          for (const s of [-1, 1] as const) {
            b.box(sideCx, railTop - 0.04, s * (hw - 0.045), sideLen, 0.045, 0.045, CHROME, SURF.metal, { noBottom: true });
          }
        }

        // Rear half-canopy shade supported by ALL 4 chrome corner pillars (outer + front + rear quads = 6 tris/post)
        const canopyLen = len * 0.28;
        const canopyX = xRearRoof + canopyLen * 0.5;
        const canopyY = yDeck + 1.00;
        const pY0 = yDeck + sidePanelH - 0.02;
        const pY1 = canopyY + 0.02;
        const pz = hw - 0.055;
        b.box(canopyX, canopyY, 0, canopyLen, 0.07, hw * 1.94, WHITE, SURF.paint, { noBottom: true });
        for (const px of [xRearRoof + 0.06, xRearRoof + canopyLen - 0.05]) {
          b.quadMirroredZ([px - 0.032, pY0, pz + 0.032], [px + 0.032, pY0, pz + 0.032], [px + 0.032, pY1, pz + 0.032], [px - 0.032, pY1, pz + 0.032], CHROME, SURF.metal);
          b.quadMirroredZ([px + 0.032, pY0, pz + 0.032], [px + 0.032, pY0, pz - 0.032], [px + 0.032, pY1, pz - 0.032], [px + 0.032, pY1, pz + 0.032], CHROME, SURF.metal);
          b.quadMirroredZ([px - 0.032, pY0, pz - 0.032], [px - 0.032, pY0, pz + 0.032], [px - 0.032, pY1, pz + 0.032], [px - 0.032, pY1, pz - 0.032], CHROME, SURF.metal);
        }

        // Sightseeing seat rows (3-face angled seat backs = 6 tris per bench, crisp & lightweight)
        const rowCount = detail === 'low' ? 2 : 4;
        for (let i = 0; i < rowCount; i++) {
          const t = (i + 0.65) / (rowCount + 0.75);
          const sx = xRearRoof + 0.55 + t * (len - 1.55);
          const sw = hw * 0.64;
          const cz = hw * 0.54;
          const sy0 = yDeck + 0.01;
          const sy1 = yDeck + 0.49;
          b.quadMirroredZ([sx + 0.10, sy0, cz + sw * 0.5], [sx + 0.10, sy0, cz - sw * 0.5], [sx + 0.10, sy1, cz - sw * 0.5], [sx + 0.10, sy1, cz + sw * 0.5], 0x264b78, SURF.paintFixed);
          b.quadMirroredZ([sx - 0.10, sy0, cz - sw * 0.5], [sx - 0.10, sy0, cz + sw * 0.5], [sx - 0.10, sy1, cz + sw * 0.5], [sx - 0.10, sy1, cz - sw * 0.5], 0x1d3b5e, SURF.paintFixed);
          b.quadMirroredZ([sx - 0.10, sy1, cz + sw * 0.5], [sx + 0.10, sy1, cz + sw * 0.5], [sx + 0.10, sy1, cz - sw * 0.5], [sx - 0.10, sy1, cz - sw * 0.5], 0x2f5a8f, SURF.paintFixed);
        }
        break;
      }
    }
  }
}

/** Add non-Z-fighting fixed-color livery accents hugging the true hull side profile z(y). */
function addLivery(
  b: MeshBuilder,
  spec: VehicleSpec,
  x0: number,
  x1: number,
  wall: SideWallProfile,
  detail: AssetDetail,
) {
  if (spec.livery === 'none') return;
  const { yMid, yTop: yBelt } = wall;
  const zAt = (y: number, extra = 0.010) => evalSideHalfWidth(wall, y) + extra;

  switch (spec.livery) {
    case 'taxi-stripe': {
      const yA = yMid + (yBelt - yMid) * 0.44;
      const yB = yA + 0.11;
      const zA = zAt(yA), zB = zAt(yB);
      const count = detail === 'low' ? 4 : 6;
      const span = (x1 - x0) * 0.72;
      const startX = (x0 + x1) * 0.5 - span * 0.5;
      const step = span / count;
      for (let i = 0; i < count; i++) {
        const col = i % 2 === 0 ? 0x1c2026 : 0xf6f7fa;
        b.quadMirroredZ(
          [startX + i * step, yA, zA],
          [startX + (i + 1) * step, yA, zA],
          [startX + (i + 1) * step, yB, zB],
          [startX + i * step, yB, zB],
          col,
          SURF.paintFixed,
        );
      }
      return;
    }

    case 'police-doors': {
      const dx0 = x0 + (x1 - x0) * 0.24;
      const dx1 = x0 + (x1 - x0) * 0.68;
      const yA = yMid + 0.04;
      const yB = yBelt - 0.03;
      b.quadMirroredZ([dx0, yA, zAt(yA)], [dx1, yA, zAt(yA)], [dx1, yB, zAt(yB)], [dx0, yB, zAt(yB)], 0xf2f5f9, SURF.paintFixed);
      const yS0 = yA + (yB - yA) * 0.46;
      const yS1 = yS0 + 0.07;
      b.quadMirroredZ([dx0 + 0.06, yS0, zAt(yS0, 0.016)], [dx1 - 0.06, yS0, zAt(yS0, 0.016)], [dx1 - 0.06, yS1, zAt(yS1, 0.016)], [dx0 + 0.06, yS1, zAt(yS1, 0.016)], 0x2255a8, SURF.paintFixed);
      return;
    }

    case 'ambulance-cross': {
      const yStripe0 = yMid + (yBelt - yMid) * 0.35;
      const yStripe1 = yStripe0 + 0.18;
      b.quadMirroredZ([x0, yStripe0, zAt(yStripe0)], [x1, yStripe0, zAt(yStripe0)], [x1, yStripe1, zAt(yStripe1)], [x0, yStripe1, zAt(yStripe1)], 0xd62424, SURF.paintFixed);
      // Matching rear red stripe flush with patient lower hull
      quadRearX(b, x0 - 0.092, yStripe0, yStripe1, 0, wall.hwMid * 1.92, 0xd62424, SURF.paintFixed);
      // Crisp red medical cross hugging the tapered patient box wall
      const cx = (x0 + x1) * 0.5;
      const cy = yBelt + 0.56;
      const arm = 0.34;
      const thick = 0.11;
      // Patient box tapers from hwMid*1.02 at yBelt-0.02 to hwMid*0.96 at roofY
      const boxZ = (y: number, extra = 0.012) => {
        const t = Math.max(0, Math.min(1, (y - (yBelt - 0.02)) / Math.max(0.1, spec.roofY - yBelt)));
        return spec.width * 0.5 * (1.02 - 0.06 * t) + extra;
      };
      b.quadMirroredZ(
        [cx - arm, cy - thick, boxZ(cy - thick)],
        [cx + arm, cy - thick, boxZ(cy - thick)],
        [cx + arm, cy + thick, boxZ(cy + thick)],
        [cx - arm, cy + thick, boxZ(cy + thick)],
        0xd62424,
        SURF.paintFixed,
      );
      b.quadMirroredZ(
        [cx - thick, cy - arm, boxZ(cy - arm, 0.017)],
        [cx + thick, cy - arm, boxZ(cy - arm, 0.017)],
        [cx + thick, cy + arm, boxZ(cy + arm, 0.017)],
        [cx - thick, cy + arm, boxZ(cy + arm, 0.017)],
        0xd62424,
        SURF.paintFixed,
      );
      return;
    }

    case 'bus-stripe': {
      const y0 = yMid + (yBelt - yMid) * 0.26;
      const y1 = y0 + 0.24;
      b.quadMirroredZ([x0, y0, zAt(y0)], [x1, y0, zAt(y0)], [x1, y1, zAt(y1)], [x0, y1, zAt(y1)], 0xf2f4f8, SURF.paintFixed);
      return;
    }

    case 'tour-stripe': {
      const y0 = yMid + (yBelt - yMid) * 0.32;
      const y1 = y0 + 0.22;
      b.quadMirroredZ([x0, y0, zAt(y0)], [x1, y0, zAt(y0)], [x1, y1, zAt(y1)], [x0, y1, zAt(y1)], 0xf2cc44, SURF.paintFixed);
      return;
    }

    case 'school-rails': {
      for (const f of [0.22, 0.58]) {
        const y0 = yMid + (yBelt - yMid) * f;
        const y1 = y0 + 0.09;
        b.quadMirroredZ([x0, y0, zAt(y0)], [x1, y0, zAt(y0)], [x1, y1, zAt(y1)], [x0, y1, zAt(y1)], RUBBER_DARK, SURF.rubber);
      }
      return;
    }

    case 'fire-stripe': {
      const y0 = yMid + (yBelt - yMid) * 0.32;
      const y1 = y0 + 0.16;
      b.quadMirroredZ([x0, y0, zAt(y0)], [x1, y0, zAt(y0)], [x1, y1, zAt(y1)], [x0, y1, zAt(y1)], 0xf4f6fa, SURF.paintFixed);
      return;
    }

    case 'vintage-chrome': {
      const y0 = yBelt - 0.10;
      const y1 = y0 + 0.055;
      b.quadMirroredZ([x0, y0, zAt(y0)], [x1, y0, zAt(y0)], [x1, y1, zAt(y1)], [x0, y1, zAt(y1)], CHROME, SURF.metal);
      return;
    }

    case 'hearse-landau': {
      const y0 = yBelt - 0.07;
      const y1 = y0 + 0.045;
      b.quadMirroredZ([x0, y0, zAt(y0)], [x1, y0, zAt(y0)], [x1, y1, zAt(y1)], [x0, y1, zAt(y1)], CHROME, SURF.metal);
      return;
    }
  }
}

/** Shared cab-over heavy truck cab + dark chassis rails + optional fuel tanks. */
function buildTruckCabAndChassis(
  b: MeshBuilder,
  g: MeshBuilder,
  spec: VehicleSpec,
  cabLen: number,
  detail: AssetDetail,
): { xCabRear: number; xCabFront: number; cabRoofTop: number; chassisTopY: number; cabWall: SideWallProfile } {
  const halfL = spec.length * 0.5;
  const halfW = spec.width * 0.5;
  const xFront = halfL;
  const xRear = -halfL;
  const xCabRear = xFront - cabLen;
  const yChassisBot = spec.groundClearance;
  const chassisTopY = spec.wheelRadius * 2 + 0.10;
  const yCabBelt = spec.beltY;
  const yMid = yChassisBot + 0.34;

  // Exposed dark steel chassis frame (omitted on full-skirted fire apparatus where bodywork encloses frame)
  if (spec.bodyKind !== 'fire') {
    b.box(0, yChassisBot + 0.18, 0, spec.length * 0.96, chassisTopY - (yChassisBot + 0.18), spec.width * 0.62, RUBBER_DARK, SURF.rubber, { noBottom: true });
  }

  // Declarative side fuel tanks between front and rear axles
  if (spec.fuelTanks && detail !== 'low') {
    const midAxleX = (spec.axles[0] + spec.axles[spec.axles.length - 1]) * 0.5 + 0.35;
    for (const s of [-1, 1] as const) {
      b.box(midAxleX, yChassisBot + 0.14, s * (halfW - 0.24), 1.35, 0.44, 0.36, STEEL_DARK, SURF.metal, { noBottom: true });
    }
  }

  // Sculpted truck cab lower hull (3 stations along X)
  buildSculptedHull(b, [
    { x: xCabRear, yBot: yChassisBot + 0.16, yMid, yTop: yCabBelt, hwBot: halfW * 0.90, hwMid: halfW, hwTop: halfW * 0.97 },
    { x: xFront - 0.22, yBot: yChassisBot + 0.14, yMid, yTop: yCabBelt, hwBot: halfW * 0.92, hwMid: halfW, hwTop: halfW * 0.97 },
    { x: xFront, yBot: yChassisBot + 0.22, yMid: yMid + 0.08, yTop: yCabBelt - spec.noseDrop - 0.04, hwBot: halfW * 0.84, hwMid: halfW * 0.94, hwTop: halfW * 0.90 },
  ]);

  const cabWall: SideWallProfile = {
    yBot: yChassisBot + 0.14,
    yMid,
    yTop: yCabBelt,
    hwBot: halfW * 0.92,
    hwMid: halfW,
    hwTop: halfW * 0.97,
  };

  // Cab greenhouse
  const crownH = detail === 'low' || spec.bodyKind === 'fire' ? 0 : 0.055;
  buildFramedGreenhouse(b, {
    xRearBot: xCabRear + 0.06,
    xFrontBot: xFront - 0.10,
    xRearTop: xCabRear + 0.12,
    xFrontTop: xFront - 0.10 - spec.windshieldRake,
    yBot: yCabBelt - 0.01,
    yTop: spec.roofY - crownH,
    hwBot: halfW * 0.96,
    hwTop: halfW * 0.96 - spec.tumblehome,
    pillarPositions: spec.pillarPositions,
    aPillarWidth: 0.14,
    cPillarWidth: 0.22,
    roofRailH: 0.10,
    roofCrownH: crownH,
    glassColor: spec.glassColor ?? GLASS_STD,
    midPillarSurf: SURF.paint,
    midPillarColor: WHITE,
    rearGlass: false,
  }, detail);

  // Heavy truck front fascia (channel bumper on fire engine for authentic heavy steel profile)
  if (spec.bodyKind === 'fire') {
    if (detail === 'low') {
      quadFrontX(b, xFront + 0.03, yChassisBot + 0.10, yChassisBot + 0.36, 0, halfW * 1.94, CHROME, SURF.metal);
    } else {
      b.box(xFront + 0.045, yChassisBot + 0.10, 0, 0.11, 0.26, halfW * 1.94, CHROME, SURF.metal, { noBottom: true });
    }
    quadFrontX(b, xFront + 0.008, yChassisBot + 0.28, yChassisBot + 0.84, 0, spec.width * 0.54, DARK_UNDER, SURF.rubber);
    if (detail !== 'low') {
      quadFrontX(b, xFront + 0.014, yChassisBot + 0.50, yChassisBot + 0.60, 0, spec.width * 0.50, CHROME, SURF.metal);
    }
    for (const s of [-1, 1] as const) {
      const z = s * (halfW * 0.72);
      if (detail !== 'low') quadFrontX(b, xFront + 0.006, yChassisBot + 0.46, yChassisBot + 0.66, z, 0.38, CHROME, SURF.metal);
      quadFrontX(g, xFront + 0.012, yChassisBot + 0.48, yChassisBot + 0.64, z, 0.32, GLOW_HEAD, SURF.matte);
    }
    // Fire apparatus uses its metallic rear standing platform as the rear bumper; mount taillights cleanly above it
    for (const s of [-1, 1] as const) {
      quadRearX(g, xRear + 0.26, chassisTopY - 0.16, chassisTopY - 0.02, s * (halfW * 0.74), 0.32, GLOW_TAIL, SURF.matte);
    }
  } else {
    addFrontFascia(b, g, detail, {
      xFront,
      yBot: yChassisBot + 0.10,
      yLight: yChassisBot + 0.56,
      halfW: halfW * 0.96,
      bumperH: 0.26,
      grilleH: 0.56,
      grilleW: spec.width * 0.54,
      lightW: 0.34,
      lightH: 0.18,
      lightZ: halfW * 0.72,
      chrome: spec.chromeBumpers,
    });

    addRearFascia(b, g, detail, {
      xRear,
      yBot: yChassisBot + 0.16,
      yLight: chassisTopY - 0.12,
      halfW: halfW * 0.92,
      bumperH: 0.18,
      lightW: 0.34,
      lightH: 0.15,
      lightZ: halfW * 0.70,
      chrome: false,
    });
  }

  addSideMirrors(b, xFront - 0.36, yCabBelt + 0.22, halfW * 0.96, 1.45, detail);

  // Roof clearance marker lights (amber) flush on cab header
  for (const s of [-0.62, 0, 0.62]) {
    quadFrontX(g, xFront - 0.10 - spec.windshieldRake + 0.04, spec.roofY - 0.07, spec.roofY - 0.02, s * (halfW * 0.7), 0.11, GLOW_AMBER, SURF.matte);
  }

  return { xCabRear, xCabFront: xFront, cabRoofTop: spec.roofY, chassisTopY, cabWall };
}

/** Archetype 1: Heavy Trucks (cargo, garbage, dump, fire). */
function buildHeavyTruckBody(b: MeshBuilder, g: MeshBuilder, spec: VehicleSpec, detail: AssetDetail) {
  const halfL = spec.length * 0.5;
  const halfW = spec.width * 0.5;
  const xRear = -halfL;
  const cabLen = spec.bodyKind === 'fire' ? 2.55 : 2.15;
  const { xCabRear, xCabFront, cabRoofTop, chassisTopY, cabWall } = buildTruckCabAndChassis(b, g, spec, cabLen, detail);
  const bodyRear = xRear + 0.06;
  const bodyFront = xCabRear - (spec.bodyKind === 'fire' ? 0.04 : 0.18);
  const bodyLen = bodyFront - bodyRear;
  const bodyCx = (bodyRear + bodyFront) * 0.5;
  const crownH = detail === 'low' ? 0 : 0.055;

  if (spec.bodyKind === 'cargo') {
    b.taperBox(xCabRear + cabLen * 0.42, cabRoofTop - 0.01, 0, cabLen * 0.68, spec.width * 0.78, 0.24, spec.width * 0.72, 0.46, WHITE, SURF.paint, {
      oxTop: -cabLen * 0.22,
      noBottom: true,
    });
    const boxH = 2.22;
    b.box(bodyCx, chassisTopY, 0, bodyLen, boxH, spec.width * 0.98, 0xeaeef2, SURF.paintFixed, { noBottom: false });
    const yS0 = chassisTopY + boxH - 0.42;
    b.quadMirroredZ(
      [bodyRear + 0.08, yS0, halfW * 0.98 + 0.012],
      [bodyFront - 0.08, yS0, halfW * 0.98 + 0.012],
      [bodyFront - 0.08, yS0 + 0.28, halfW * 0.98 + 0.012],
      [bodyRear + 0.08, yS0 + 0.28, halfW * 0.98 + 0.012],
      WHITE,
      SURF.paint,
    );
    b.box(bodyCx, chassisTopY + boxH - 0.06, 0, bodyLen + 0.03, 0.08, spec.width * 1.0, STEEL, SURF.metal, { noBottom: true });
    if (detail !== 'low') {
      for (const s of [-0.26, 0.26]) {
        quadRearX(b, bodyRear - 0.012, chassisTopY + 0.25, chassisTopY + boxH - 0.25, s * halfW, 0.06, STEEL_DARK, SURF.metal);
      }
    }
    addRoofAccessories(b, g, spec.roofAccessories, {
      roofTopY: cabRoofTop, crownH, xRearRoof: xCabRear + 0.15, xFrontRoof: xCabFront - 0.2, hwRoof: halfW * 0.86,
    }, detail);
  } else if (spec.bodyKind === 'garbage') {
    const yTop = chassisTopY + 1.88;
    buildSculptedHull(b, [
      { x: bodyRear - 0.08, yBot: chassisTopY + 0.42, yMid: chassisTopY + 0.62, yTop: yTop - 0.68, hwBot: halfW * 0.82, hwMid: halfW * 0.92, hwTop: halfW * 0.84 },
      { x: bodyRear + 1.08, yBot: chassisTopY + 0.04, yMid: chassisTopY + 0.30, yTop: yTop - 0.04, hwBot: halfW * 0.88, hwMid: halfW * 0.98, hwTop: halfW * 0.91 },
      { x: bodyFront, yBot: chassisTopY, yMid: chassisTopY + 0.28, yTop, hwBot: halfW * 0.90, hwMid: halfW * 0.98, hwTop: halfW * 0.92 },
    ]);
    b.box(bodyRear + 0.06, chassisTopY + 0.16, 0, 0.36, 0.68, spec.width * 0.72, DARK_UNDER, SURF.rubber, { noBottom: true });
    b.quadMirroredZ(
      [bodyRear + 1.15, chassisTopY + 0.36, halfW * 0.98 + 0.012],
      [bodyFront - 0.12, chassisTopY + 0.36, halfW * 0.98 + 0.012],
      [bodyFront - 0.12, chassisTopY + 0.52, halfW * 0.98 + 0.012],
      [bodyRear + 1.15, chassisTopY + 0.52, halfW * 0.98 + 0.012],
      0xf2c629,
      SURF.paintFixed,
    );
    addRoofAccessories(b, g, spec.roofAccessories, {
      roofTopY: cabRoofTop, crownH, xRearRoof: xCabRear + 0.15, xFrontRoof: xCabFront - 0.2, hwRoof: halfW * 0.86,
    }, detail);
    // Declarative rear amber strobe firmly seated with dark rubber base on flat compactor crest (x >= bodyRear + 1.15)
    if (spec.rearFlashers === 'amber-strobe') {
      const bx = bodyRear + 1.38;
      const yCrest = yTop - 0.025;
      b.box(bx, yCrest - 0.015, 0, 0.20, 0.055, 0.20, RUBBER_DARK, SURF.rubber, { noBottom: true });
      g.box(bx, yCrest + 0.036, 0, 0.16, 0.12, 0.16, GLOW_AMBER, SURF.matte, { noBottom: true });
    }
  } else if (spec.bodyKind === 'dump') {
    const bedH = 1.32;
    const yRim = chassisTopY + bedH;
    buildSculptedHull(b, [
      { x: bodyRear, yBot: chassisTopY + 0.08, yMid: chassisTopY + 0.32, yTop: yRim, hwBot: halfW * 0.82, hwMid: halfW * 0.95, hwTop: halfW * 0.99 },
      { x: bodyFront, yBot: chassisTopY, yMid: chassisTopY + 0.28, yTop: yRim, hwBot: halfW * 0.84, hwMid: halfW * 0.96, hwTop: halfW * 0.99 },
    ]);
    b.taperBox(bodyFront + 0.34, cabRoofTop + 0.04, 0, 1.05, spec.width * 0.94, 0.90, spec.width * 0.90, 0.14, WHITE, SURF.paint, { noBottom: false });
    b.box(bodyFront - 0.06, yRim - 0.04, 0, 0.12, cabRoofTop + 0.08 - yRim, spec.width * 0.94, WHITE, SURF.paint, { noBottom: true });
    b.taperBox(bodyCx - 0.05, yRim - 0.02, 0, bodyLen * 0.88, spec.width * 0.82, bodyLen * 0.44, spec.width * 0.38, 0.54, 0x8f7352, SURF.matte, {
      topColor: 0xa68964,
      noBottom: true,
    });
    if (detail !== 'low') {
      for (const f of [0.24, 0.50, 0.76]) {
        const rx = bodyRear + bodyLen * f;
        b.quadMirroredZ(
          [rx - 0.07, chassisTopY + 0.28, halfW * 0.98 + 0.015],
          [rx + 0.07, chassisTopY + 0.28, halfW * 0.98 + 0.015],
          [rx + 0.07, yRim - 0.06, halfW * 1.00 + 0.015],
          [rx - 0.07, yRim - 0.06, halfW * 1.00 + 0.015],
          PAINT_SHADE,
          SURF.paint,
        );
      }
    }
    addRoofAccessories(b, g, spec.roofAccessories, {
      roofTopY: cabRoofTop, crownH, xRearRoof: xCabRear + 0.15, xFrontRoof: xCabFront - 0.2, hwRoof: halfW * 0.86,
    }, detail);
  } else if (spec.bodyKind === 'fire') {
    const appH = 1.62;
    const appTop = chassisTopY + appH;
    const appRearX = bodyRear + 0.22;
    const appFrontX = bodyFront;
    const appLen = appFrontX - appRearX;
    const appCx = (appRearX + appFrontX) * 0.5;
    const appHalfW = halfW * 0.98;

    // Main apparatus body + rear standing platform
    b.box(appCx, chassisTopY - 0.16, 0, appLen, appH + 0.16, appHalfW * 2, WHITE, SURF.paint, { noBottom: true });
    if (detail !== 'low') {
      b.box(bodyRear + 0.08, spec.groundClearance + 0.18, 0, 0.32, 0.14, spec.width * 0.94, STEEL, SURF.metal, { noBottom: true });
    }

    // Framed equipment bays: recessed dark backing + 3 aluminum shutter bays + central pump panel detail
    const zBay = appHalfW + 0.008;
    const bayY0 = chassisTopY + 0.20;
    const bayY1 = appTop - 0.20;
    const bayCount = detail === 'low' ? 2 : 3;
    const bayMargin = 0.22;
    const baySpan = (appLen - bayMargin * 2) / bayCount;

    if (detail !== 'low') {
      // Single recessed dark trim backing behind all 3 bays (creates crisp dark borders on all 4 sides)
      b.quadMirroredZ(
        [appRearX + bayMargin - 0.04, bayY0 - 0.04, zBay],
        [appFrontX - bayMargin + 0.04, bayY0 - 0.04, zBay],
        [appFrontX - bayMargin + 0.04, bayY1 + 0.04, zBay],
        [appRearX + bayMargin - 0.04, bayY1 + 0.04, zBay],
        RUBBER_DARK,
        SURF.rubber,
      );
    }
    for (let i = 0; i < bayCount; i++) {
      const bx0 = appRearX + bayMargin + i * baySpan + 0.07;
      const bx1 = bx0 + baySpan - 0.14;
      const isPumpBay = bayCount === 3 && i === 1 && detail === 'high';
      b.quadMirroredZ(
        [bx0, bayY0, zBay + 0.006],
        [bx1, bayY0, zBay + 0.006],
        [bx1, bayY1, zBay + 0.006],
        [bx0, bayY1, zBay + 0.006],
        isPumpBay ? STEEL : CHROME,
        SURF.metal,
      );
      if (isPumpBay) {
        // Dark instrument gauge band & valve bar on central pump bay
        const pMid = (bayY0 + bayY1) * 0.5;
        b.quadMirroredZ(
          [bx0 + 0.10, pMid + 0.06, zBay + 0.012],
          [bx1 - 0.10, pMid + 0.06, zBay + 0.012],
          [bx1 - 0.10, bayY1 - 0.10, zBay + 0.012],
          [bx0 + 0.10, bayY1 - 0.10, zBay + 0.012],
          RUBBER_MID,
          SURF.rubber,
        );
      }
    }

    // Detailed rear apparatus face: aluminum hose-bed shutter door + high-visibility safety chevron + top red flashers
    const xBack = appRearX - 0.008;
    if (detail !== 'low') {
      quadRearX(b, xBack, chassisTopY + 0.42, appTop - 0.28, 0, spec.width * 0.56, RUBBER_DARK, SURF.rubber);
      quadRearX(b, xBack - 0.006, chassisTopY + 0.47, appTop - 0.33, 0, spec.width * 0.50, CHROME, SURF.metal);
    }
    // Lower rear safety stripe (high-contrast amber/yellow band)
    quadRearX(b, xBack - 0.005, chassisTopY + 0.08, chassisTopY + 0.30, 0, spec.width * 0.88, 0xf2c629, SURF.paintFixed);
    if (spec.rearFlashers === 'red-pair') {
      for (const s of [-0.72, 0.72]) {
        quadRearX(g, xBack - 0.012, appTop - 0.24, appTop - 0.08, s * appHalfW, 0.28, GLOW_TAIL, SURF.matte);
      }
    }

    // Flush dark wheel-well arch on front axle + continuous tandem wheel-well cutout on rear bogie!
    const fireWall: SideWallProfile = {
      yBot: spec.groundClearance,
      yMid: chassisTopY - 0.16,
      yTop: appTop,
      hwBot: appHalfW,
      hwMid: appHalfW,
      hwTop: appHalfW,
    };
    addWheelArches(b, spec, detail, fireWall, { axles: [spec.axles[spec.axles.length - 1]], flareLip: false });
    if (detail !== 'low') {
      const zWell = appHalfW + 0.006;
      const xBogie0 = spec.axles[0] - spec.wheelRadius - 0.08;
      const xBogie1 = spec.axles[1] + spec.wheelRadius + 0.08;
      b.quadMirroredZ(
        [xBogie0, chassisTopY - 0.16, zWell],
        [xBogie1, chassisTopY - 0.16, zWell],
        [xBogie1 - 0.12, spec.wheelRadius * 2 + 0.04, zWell],
        [xBogie0 + 0.12, spec.wheelRadius * 2 + 0.04, zWell],
        DARK_UNDER,
        SURF.rubber,
      );
    }
    addLivery(b, spec, appRearX + 0.06, xCabFront - 0.18, cabWall, detail);

    addRoofAccessories(b, g, spec.roofAccessories, {
      roofTopY: cabRoofTop,
      crownH,
      xRearRoof: xCabRear + 0.18,
      xFrontRoof: xCabFront - 0.20,
      hwRoof: halfW * 0.88,
      ladderBaseY: appTop,
      ladderRearX: appRearX + 0.08,
      ladderFrontX: xCabFront - 0.82,
      cabRoofY: cabRoofTop,
      cabRearX: xCabRear,
    }, detail);
  }
}

/** Archetype 2: Buses & Coaches (urban bus, conventional-nose schoolbus, double-decker tourbus). */
function buildBusBody(b: MeshBuilder, g: MeshBuilder, spec: VehicleSpec, detail: AssetDetail) {
  const halfL = spec.length * 0.5;
  const halfW = spec.width * 0.5;
  const xRear = -halfL;
  const xFront = halfL;
  const isSchool = spec.bodyKind === 'schoolbus';
  const noseStart = isSchool ? xFront - spec.hoodLen : xFront;
  const yBot = spec.groundClearance;
  const yMid = yBot + 0.34;
  const yBelt = spec.beltY;

  if (isSchool) {
    buildSculptedHull(b, [
      { x: xRear, yBot: yBot + 0.06, yMid, yTop: yBelt, hwBot: halfW * 0.92, hwMid: halfW, hwTop: halfW * 0.98 },
      { x: noseStart + 0.12, yBot, yMid, yTop: yBelt, hwBot: halfW * 0.94, hwMid: halfW, hwTop: halfW * 0.98 },
      { x: noseStart + 0.30, yBot, yMid, yTop: yBelt - 0.06, hwBot: halfW * 0.84, hwMid: halfW * 0.88, hwTop: halfW * 0.82 },
      { x: xFront - 0.18, yBot: yBot + 0.04, yMid: yMid + 0.04, yTop: yBelt - spec.noseDrop, hwBot: halfW * 0.78, hwMid: halfW * 0.82, hwTop: halfW * 0.72 },
      { x: xFront, yBot: yBot + 0.08, yMid: yMid + 0.08, yTop: yBelt - spec.noseDrop - 0.08, hwBot: halfW * 0.74, hwMid: halfW * 0.78, hwTop: halfW * 0.68 },
    ]);
  } else {
    buildSculptedHull(b, [
      { x: xRear, yBot: yBot + 0.08, yMid, yTop: yBelt, hwBot: halfW * 0.92, hwMid: halfW, hwTop: halfW * 0.98 },
      { x: xRear + 0.6, yBot, yMid, yTop: yBelt, hwBot: halfW * 0.94, hwMid: halfW, hwTop: halfW * 0.98 },
      { x: xFront - 0.6, yBot, yMid, yTop: yBelt, hwBot: halfW * 0.94, hwMid: halfW, hwTop: halfW * 0.98 },
      { x: xFront, yBot: yBot + 0.08, yMid: yMid + 0.04, yTop: yBelt - spec.noseDrop, hwBot: halfW * 0.88, hwMid: halfW * 0.96, hwTop: halfW * 0.94 },
    ]);
  }

  const busWall: SideWallProfile = {
    yBot,
    yMid,
    yTop: yBelt,
    hwBot: halfW * 0.94,
    hwMid: halfW,
    hwTop: halfW * 0.98,
  };

  const crownH = spec.bodyKind === 'tourbus' ? 0 : (detail === 'low' ? 0 : 0.08);
  const xCabFront = isSchool ? noseStart + 0.12 : xFront - 0.06;
  buildFramedGreenhouse(b, {
    xRearBot: xRear + 0.04,
    xFrontBot: xCabFront,
    xRearTop: xRear + 0.04 + spec.rearRake,
    xFrontTop: xCabFront - spec.windshieldRake,
    yBot: yBelt - 0.02,
    yTop: spec.roofY - crownH,
    hwBot: halfW * 0.98,
    hwTop: halfW * 0.98 - spec.tumblehome,
    pillarPositions: spec.pillarPositions,
    pillarWidth: isSchool ? 0.14 : 0.11,
    aPillarWidth: 0.16,
    cPillarWidth: 0.24,
    roofRailH: isSchool ? 0.18 : 0.24,
    roofCrownH: crownH,
    glassColor: spec.glassColor ?? GLASS_STD,
    midPillarSurf: spec.blackoutPillars ? SURF.rubber : SURF.paint,
    midPillarColor: spec.blackoutPillars ? RUBBER_DARK : WHITE,
    rearGlass: true,
    frontSplitPillar: spec.splitWindshield,
  }, detail);

  if (isSchool) {
    const xSign = xCabFront - spec.windshieldRake + 0.05;
    for (const s of [-0.66, 0.66]) {
      quadFrontX(g, xSign, spec.roofY - 0.19, spec.roofY - 0.07, s * (halfW * 0.72), 0.16, GLOW_AMBER, SURF.matte);
    }
    for (const s of [-0.42, 0.42]) {
      quadFrontX(g, xSign, spec.roofY - 0.19, spec.roofY - 0.07, s * (halfW * 0.72), 0.16, GLOW_TAIL, SURF.matte);
    }
    if (detail !== 'low') {
      b.box(-0.5, spec.roofY - 0.01, 0, 0.95, 0.07, 0.95, 0xeaeef2, SURF.paintFixed, { noBottom: true });
    }
  } else {
    const signX = xCabFront - spec.windshieldRake + 0.035;
    quadFrontX(b, signX + 0.008, spec.roofY - 0.26, spec.roofY - 0.06, 0, spec.width * 0.56, DARK_UNDER, SURF.rubber);
    quadFrontX(g, signX + 0.015, spec.roofY - 0.23, spec.roofY - 0.09, 0, spec.width * 0.48, GLOW_AMBER, SURF.matte);
  }

  addLivery(b, spec, xRear + 0.25, noseStart - 0.15, busWall, detail);
  // Discreet wheel wells + flush arches on all buses (schoolbus front wheel is inside narrower hood)
  if (isSchool) {
    addWheelArches(b, spec, detail, busWall, { axles: [spec.axles[0]], flareLip: false });
  } else {
    addWheelArches(b, spec, detail, busWall, { flareLip: false });
  }

  const frontHalfW = isSchool ? halfW * 0.78 : halfW * 0.95;
  addFrontFascia(b, g, detail, {
    xFront,
    yBot: yBot + 0.06,
    yLight: yBot + 0.46,
    halfW: frontHalfW,
    bumperH: 0.24,
    grilleH: isSchool ? 0.54 : 0.28,
    grilleW: frontHalfW * (isSchool ? 1.15 : 0.95),
    lightW: 0.32,
    lightH: 0.16,
    lightZ: frontHalfW * 0.74,
    chrome: spec.chromeBumpers,
  });
  addRearFascia(b, g, detail, {
    xRear,
    yBot: yBot + 0.08,
    yLight: yBot + 0.62,
    halfW: halfW * 0.96,
    bumperH: 0.24,
    lightW: 0.34,
    lightH: 0.20,
    lightZ: halfW * 0.76,
  });

  addSideMirrors(b, xCabFront - 0.15, yBelt + 0.28, halfW * 0.98, 1.4, detail);
  addRoofAccessories(b, g, spec.roofAccessories, {
    roofTopY: spec.roofY,
    crownH,
    xRearRoof: xRear + 0.12,
    xFrontRoof: xCabFront - spec.windshieldRake - 0.10,
    hwRoof: halfW * 0.98 - spec.tumblehome,
  }, detail);
}

/** Archetype 3: Vans & Modular Ambulances. */
function buildVanBody(b: MeshBuilder, g: MeshBuilder, spec: VehicleSpec, detail: AssetDetail) {
  const halfL = spec.length * 0.5;
  const halfW = spec.width * 0.5;
  const xRear = -halfL;
  const xFront = halfL;
  const isAmb = spec.bodyKind === 'ambulance';
  const yBot = spec.groundClearance;
  const yMid = yBot + 0.26;
  const yBelt = spec.beltY;
  const xCowl = xFront - spec.hoodLen;
  const xCabRear = isAmb ? xCowl - 1.25 : xRear;

  buildSculptedHull(b, [
    { x: xRear, yBot: yBot + 0.06, yMid, yTop: yBelt, hwBot: halfW * 0.90, hwMid: halfW, hwTop: halfW * 0.97 },
    { x: xCowl, yBot, yMid, yTop: yBelt, hwBot: halfW * 0.92, hwMid: halfW, hwTop: halfW * 0.96 },
    { x: xFront - 0.25, yBot: yBot + 0.02, yMid: yMid + 0.02, yTop: yBelt - spec.noseDrop * 0.65, hwBot: halfW * 0.86, hwMid: halfW * 0.95, hwTop: halfW * 0.90 },
    { x: xFront, yBot: yBot + 0.08, yMid: yMid + 0.06, yTop: yBelt - spec.noseDrop, hwBot: halfW * 0.80, hwMid: halfW * 0.90, hwTop: halfW * 0.84 },
  ], {
    rockerSurf: SURF.rubber,
    rockerColor: RUBBER_DARK,
  });

  const vanWall: SideWallProfile = {
    yBot,
    yMid,
    yTop: yBelt,
    hwBot: halfW * 0.92,
    hwMid: halfW,
    hwTop: halfW * 0.96,
  };

  if (isAmb) {
    const cabRoof = spec.roofY - 0.30;
    const crownH = detail === 'low' ? 0 : 0.04;
    buildFramedGreenhouse(b, {
      xRearBot: xCabRear,
      xFrontBot: xCowl,
      xRearTop: xCabRear + 0.04,
      xFrontTop: xCowl - spec.windshieldRake,
      yBot: yBelt - 0.02,
      yTop: cabRoof - crownH,
      hwBot: halfW * 0.92,
      hwTop: halfW * 0.92 - spec.tumblehome,
      pillarPositions: [],
      aPillarWidth: 0.13,
      cPillarWidth: 0.18,
      roofRailH: 0.08,
      roofCrownH: crownH,
      glassColor: GLASS_STD,
      rearGlass: false,
    }, detail);

    // Tapered patient module box
    const boxY0 = yBelt - 0.02;
    const boxH = spec.roofY - boxY0;
    const boxLen0 = xCabRear - xRear;
    const boxLen1 = boxLen0 - 0.10;
    const boxCx = (xRear + xCabRear) * 0.5;
    b.taperBox(boxCx, boxY0, 0, boxLen0, spec.width * 1.02, boxLen1, spec.width * 0.96, boxH, WHITE, SURF.paint, { noBottom: true });

    // Exact sloped wall coordinates at any Y so windows & flashers sit flush with ZERO float!
    const boxFrontXAt = (y: number) => {
      const t = (y - boxY0) / boxH;
      return boxCx + (boxLen0 + (boxLen1 - boxLen0) * t) * 0.5;
    };
    const boxRearXAt = (y: number) => {
      const t = (y - boxY0) / boxH;
      return boxCx - (boxLen0 + (boxLen1 - boxLen0) * t) * 0.5;
    };

    addLivery(b, spec, xRear + 0.08, xCabRear - 0.05, vanWall, detail);

    // Rear dual-door dark glass panes hugging the sloped rear wall
    const rwY0 = yBelt + 0.24;
    const rwY1 = yBelt + 0.76;
    const rwX0 = boxRearXAt(rwY0) - 0.008;
    const rwX1 = boxRearXAt(rwY1) - 0.008;
    for (const s of [-0.36, 0.36]) {
      const cz = s * halfW;
      const hwPane = halfW * 0.26;
      b.quad(
        [rwX0, rwY0, cz - hwPane],
        [rwX0, rwY0, cz + hwPane],
        [rwX1, rwY1, cz + hwPane],
        [rwX1, rwY1, cz - hwPane],
        GLASS_DARK,
        SURF.glass,
      );
    }

    // Upper corner emergency flashers glued directly onto the exact sloped front & rear patient walls!
    if (spec.rearFlashers === 'red-pair') {
      const fY0 = spec.roofY - 0.22;
      const fY1 = spec.roofY - 0.08;
      const xf0 = boxFrontXAt(fY0) + 0.012;
      const xf1 = boxFrontXAt(fY1) + 0.012;
      const xr0 = boxRearXAt(fY0) - 0.012;
      const xr1 = boxRearXAt(fY1) - 0.012;
      for (const s of [-0.72, 0.72]) {
        const cz = s * halfW;
        const hwF = 0.12;
        g.quad([xf0, fY0, cz + hwF], [xf0, fY0, cz - hwF], [xf1, fY1, cz - hwF], [xf1, fY1, cz + hwF], GLOW_TAIL, SURF.matte);
        g.quad([xr0, fY0, cz - hwF], [xr0, fY0, cz + hwF], [xr1, fY1, cz + hwF], [xr1, fY1, cz - hwF], GLOW_TAIL, SURF.matte);
      }
    }

    addRoofAccessories(b, g, spec.roofAccessories, {
      roofTopY: cabRoof,
      crownH,
      xRearRoof: xCabRear + 0.08,
      xFrontRoof: xCowl - spec.windshieldRake,
      hwRoof: halfW * 0.80,
    }, detail);
  } else {
    const xSplit = xCowl - 1.35;
    const crownH = detail === 'low' ? 0 : 0.06;
    buildFramedGreenhouse(b, {
      xRearBot: xSplit,
      xFrontBot: xCowl,
      xRearTop: xSplit + 0.04,
      xFrontTop: xCowl - spec.windshieldRake,
      yBot: yBelt - 0.02,
      yTop: spec.roofY - crownH,
      hwBot: halfW * 0.96,
      hwTop: halfW * 0.96 - spec.tumblehome,
      pillarPositions: [],
      aPillarWidth: 0.13,
      cPillarWidth: 0.16,
      roofRailH: 0.09,
      roofCrownH: crownH,
      glassColor: GLASS_STD,
      rearGlass: false,
    }, detail);
    const cargoLen = xSplit - xRear;
    const cargoCx = (xRear + xSplit) * 0.5;
    b.taperBox(cargoCx + 0.02, yBelt - 0.02, 0, cargoLen + 0.04, (halfW * 0.96) * 2, cargoLen - 0.06, (halfW * 0.96 - spec.tumblehome) * 2, spec.roofY - yBelt + 0.02, WHITE, SURF.paint, {
      oxTop: 0.04,
      noBottom: true,
    });
    if (detail !== 'low') {
      b.quadMirroredZ(
        [xRear + 0.28, yBelt + 0.14, halfW * 0.94 + 0.010],
        [xSplit - 0.14, yBelt + 0.14, halfW * 0.94 + 0.010],
        [xSplit - 0.14, spec.roofY - 0.24, halfW * 0.90 + 0.010],
        [xRear + 0.28, spec.roofY - 0.24, halfW * 0.90 + 0.010],
        PAINT_SHADE,
        SURF.paint,
      );
    }
    for (const s of [-0.36, 0.36]) {
      quadRearX(b, xRear - 0.008, yBelt + 0.20, yBelt + 0.64, s * halfW, halfW * 0.50, GLASS_DARK, SURF.glass);
    }
  }

  addFrontFascia(b, g, detail, {
    xFront,
    yBot: yBot + 0.04,
    yLight: yBot + 0.46,
    halfW: halfW * 0.90,
    bumperH: 0.20,
    grilleH: 0.28,
    grilleW: spec.width * 0.46,
    lightW: 0.28,
    lightH: 0.15,
    lightZ: halfW * 0.66,
  });
  addRearFascia(b, g, detail, {
    xRear,
    yBot: yBot + 0.06,
    yLight: yBot + 0.54,
    halfW: halfW * 0.96,
    bumperH: 0.20,
    lightW: 0.22,
    lightH: 0.26,
    lightZ: halfW * 0.80,
  });
  addSideMirrors(b, xCowl - 0.20, yBelt + 0.12, halfW * 0.96, 1.15, detail);
  addWheelArches(b, spec, detail, vanWall);
}

/** Archetype 4: Pickup Truck (continuous dark rocker cladding, clean corner butt joints, SURF.rubber bed rails). */
function buildPickupBody(b: MeshBuilder, g: MeshBuilder, spec: VehicleSpec, detail: AssetDetail) {
  const halfL = spec.length * 0.5;
  const halfW = spec.width * 0.5;
  const xRear = -halfL;
  const xFront = halfL;
  const yBot = spec.groundClearance;
  const yMid = yBot + 0.24;
  const yBelt = spec.beltY;
  const xCowl = xFront - spec.hoodLen;
  const xBedFront = xCowl - 1.62;
  const wallT = 0.13;
  const floorY = yMid + 0.08;

  // 1. Rear lower bed chassis & dark rubber rocker cladding (exact same cross-section as front cab hull -> seamless!)
  buildSculptedHull(b, [
    { x: xRear, yBot: yBot + 0.04, yMid, yTop: floorY, hwBot: halfW * 0.90, hwMid: halfW, hwTop: halfW * 0.99 },
    { x: xBedFront, yBot, yMid, yTop: floorY, hwBot: halfW * 0.90, hwMid: halfW, hwTop: halfW * 0.99 },
  ], {
    rockerSurf: SURF.rubber,
    rockerColor: RUBBER_DARK,
    topColor: 0x262a30,
    topSurf: SURF.rubber,
    capEnd: false,
  });

  // 2. Sculpted front cab + hood hull (continuous dark rocker cladding matching bed base seamlessly!)
  buildSculptedHull(b, [
    { x: xBedFront, yBot, yMid, yTop: yBelt, hwBot: halfW * 0.90, hwMid: halfW, hwTop: halfW * 0.96 },
    { x: xCowl, yBot, yMid, yTop: yBelt, hwBot: halfW * 0.90, hwMid: halfW, hwTop: halfW * 0.96 },
    { x: xFront, yBot: yBot + 0.08, yMid: yMid + 0.06, yTop: yBelt - spec.noseDrop, hwBot: halfW * 0.82, hwMid: halfW * 0.92, hwTop: halfW * 0.86 },
  ], {
    rockerSurf: SURF.rubber,
    rockerColor: RUBBER_DARK,
  });

  // 3. Open pickup bed walls (exact butt joint at xRear + wallT, zero coplanar overlap, SURF.rubber top caps)
  const xSide0 = xRear + wallT;
  const zIn = halfW - wallT;
  // Side bed walls (outer painted face + inner bed wall + SURF.rubber top rail cap, mirrored across Z = 12 tris total!)
  b.quadMirroredZ([xSide0, floorY, halfW], [xBedFront, floorY, halfW], [xBedFront, yBelt, halfW * 0.98], [xSide0, yBelt, halfW * 0.98], WHITE, SURF.paint);
  b.quadMirroredZ([xBedFront, floorY, zIn], [xSide0, floorY, zIn], [xSide0, yBelt, zIn], [xBedFront, yBelt, zIn], PAINT_SHADE, SURF.paint);
  b.quadMirroredZ([xSide0, yBelt, halfW * 0.98], [xBedFront, yBelt, halfW * 0.98], [xBedFront, yBelt, zIn], [xSide0, yBelt, zIn], RUBBER_DARK, SURF.rubber);

  // Rear tailgate (outer face + inner face + 2 thin side ends + SURF.rubber top cap = 10 tris, ZERO corner overlap!)
  quadRearX(b, xRear, floorY, yBelt, 0, spec.width, WHITE, SURF.paint);
  quadFrontX(b, xSide0, floorY, yBelt, 0, zIn * 2, PAINT_SHADE, SURF.paint);
  b.quadMirroredZ([xRear, floorY, halfW], [xSide0, floorY, halfW], [xSide0, yBelt, halfW * 0.98], [xRear, yBelt, halfW * 0.98], WHITE, SURF.paint);
  b.quad([xRear, yBelt, halfW * 0.98], [xSide0, yBelt, halfW * 0.98], [xSide0, yBelt, -halfW * 0.98], [xRear, yBelt, -halfW * 0.98], RUBBER_DARK, SURF.rubber, [0, 1, 0]);

  // Sleek metallic rollbar behind cab (high/med only, clean 3-face uprights + crossbar = 16 tris)
  if (detail !== 'low') {
    const rx = xBedFront - 0.14;
    const rTop = spec.roofY - 0.08;
    const rz = halfW - 0.18;
    b.quadMirroredZ([rx - 0.035, yBelt, rz + 0.035], [rx + 0.035, yBelt, rz + 0.035], [rx + 0.035, rTop, rz + 0.035], [rx - 0.035, rTop, rz + 0.035], STEEL_DARK, SURF.metal);
    b.quadMirroredZ([rx - 0.035, yBelt, rz - 0.035], [rx - 0.035, yBelt, rz + 0.035], [rx - 0.035, rTop, rz + 0.035], [rx - 0.035, rTop, rz - 0.035], STEEL_DARK, SURF.metal);
    b.quadMirroredZ([rx + 0.035, yBelt, rz + 0.035], [rx + 0.035, yBelt, rz - 0.035], [rx + 0.035, rTop, rz - 0.035], [rx + 0.035, rTop, rz + 0.035], STEEL_DARK, SURF.metal);
    quadRearX(b, rx - 0.035, rTop - 0.06, rTop, 0, rz * 2 + 0.07, STEEL_DARK, SURF.metal);
    b.quad([rx - 0.035, rTop, rz + 0.035], [rx + 0.035, rTop, rz + 0.035], [rx + 0.035, rTop, -(rz + 0.035)], [rx - 0.035, rTop, -(rz + 0.035)], STEEL, SURF.metal, [0, 1, 0]);
  }

  const crownH = detail === 'low' ? 0 : 0.045;
  buildFramedGreenhouse(b, {
    xRearBot: xBedFront + 0.02,
    xFrontBot: xCowl,
    xRearTop: xBedFront + 0.02 + spec.rearRake,
    xFrontTop: xCowl - spec.windshieldRake,
    yBot: yBelt - 0.02,
    yTop: spec.roofY - crownH,
    hwBot: halfW * 0.94,
    hwTop: halfW * 0.94 - spec.tumblehome,
    pillarPositions: spec.pillarPositions,
    aPillarWidth: 0.12,
    cPillarWidth: 0.18,
    roofRailH: 0.065,
    roofCrownH: crownH,
    glassColor: spec.glassColor ?? GLASS_STD,
    midPillarSurf: SURF.rubber,
    midPillarColor: RUBBER_DARK,
    rearGlass: true,
    rearSmallWindow: true,
  }, detail);

  const pickupWall: SideWallProfile = {
    yBot,
    yMid,
    yTop: yBelt,
    hwBot: halfW * 0.90,
    hwMid: halfW,
    hwTop: halfW * 0.99,
  };

  addFrontFascia(b, g, detail, {
    xFront,
    yBot: yBot + 0.04,
    yLight: yBelt - spec.noseDrop - 0.16,
    halfW: halfW * 0.91,
    bumperH: 0.18,
    grilleH: 0.30,
    grilleW: spec.width * 0.48,
    lightW: 0.28,
    lightH: 0.15,
    lightZ: halfW * 0.68,
    chrome: spec.chromeBumpers,
  });
  addRearFascia(b, g, detail, {
    xRear,
    yBot: yBot + 0.06,
    yLight: yBelt - 0.22,
    halfW: halfW * 0.98,
    bumperH: 0.18,
    lightW: 0.18,
    lightH: 0.26,
    lightZ: halfW * 0.84,
    chrome: spec.chromeBumpers,
  });
  addSideMirrors(b, xCowl - 0.16, yBelt + 0.10, halfW * 0.94, 1.1, detail);
  addWheelArches(b, spec, detail, pickupWall, { flareLip: false });
}

/** Archetype 5: Passenger Cars (sedan, hatch, suv, vintage, taxi, police, hearse). */
function buildPassengerBody(b: MeshBuilder, g: MeshBuilder, spec: VehicleSpec, detail: AssetDetail) {
  const halfL = spec.length * 0.5;
  const halfW = spec.width * 0.5;
  const xRear = -halfL;
  const xFront = halfL;
  const yBot = spec.groundClearance;
  const yMid = yBot + (spec.bodyKind === 'suv' ? 0.24 : 0.18);
  const yBelt = spec.beltY;
  const xCowl = xFront - spec.hoodLen;
  const xTrunkStart = xRear + spec.trunkLen;
  const isVintage = spec.bodyKind === 'vintage';
  const yRearDeck = spec.trunkLen > 0.25 ? yBelt - (isVintage ? 0.03 : 0.05) : yBelt;
  const noseW = isVintage ? 0.86 : 0.90;

  // Multi-station sculpted hull with gentle nose crease to break flat hood specular glare
  const stations: HullStation[] = [
    {
      x: xRear,
      yBot: yBot + 0.08,
      yMid: yMid + 0.04,
      yTop: yRearDeck - 0.04,
      hwBot: halfW * 0.84,
      hwMid: halfW * 0.94,
      hwTop: halfW * 0.88,
    },
    {
      x: spec.trunkLen > 0.35 ? xTrunkStart : xRear + 0.45,
      yBot: yBot + 0.02,
      yMid,
      yTop: yBelt,
      hwBot: halfW * 0.88,
      hwMid: halfW,
      hwTop: halfW * 0.95,
    },
    {
      x: xCowl,
      yBot,
      yMid,
      yTop: yBelt,
      hwBot: halfW * 0.88,
      hwMid: halfW,
      hwTop: halfW * 0.95,
    },
    {
      x: xFront - Math.min(0.42, spec.hoodLen * 0.36),
      yBot: yBot + 0.02,
      yMid: yMid + 0.02,
      yTop: yBelt - spec.noseDrop * (isVintage ? 0.24 : 0.44),
      hwBot: halfW * 0.86,
      hwMid: halfW * 0.97,
      hwTop: halfW * 0.91,
    },
    {
      x: xFront,
      yBot: yBot + 0.08,
      yMid: yMid + 0.05,
      yTop: yBelt - spec.noseDrop,
      hwBot: halfW * 0.80,
      hwMid: halfW * noseW,
      hwTop: halfW * (noseW - 0.06),
    },
  ];

  buildSculptedHull(b, stations, {
    rockerSurf: spec.darkCladding ? SURF.rubber : SURF.paint,
    rockerColor: spec.darkCladding ? RUBBER_DARK : PAINT_SHADE,
  });

  const wall: SideWallProfile = {
    yBot,
    yMid,
    yTop: yBelt,
    hwBot: halfW * 0.88,
    hwMid: halfW,
    hwTop: halfW * 0.95,
  };

  const crownH = detail === 'low' ? 0 : (isVintage ? 0.075 : 0.045);
  const xGhRear = xRear + Math.max(0.08, spec.trunkLen);
  const xGhFront = xCowl + 0.08;
  buildFramedGreenhouse(b, {
    xRearBot: xGhRear,
    xFrontBot: xGhFront,
    xRearTop: xGhRear + spec.rearRake,
    xFrontTop: xGhFront - spec.windshieldRake,
    yBot: yBelt - 0.02,
    yTop: spec.roofY - crownH,
    hwBot: halfW * 0.93,
    hwTop: halfW * 0.93 - spec.tumblehome,
    pillarPositions: spec.pillarPositions,
    aPillarWidth: isVintage ? 0.13 : 0.11,
    cPillarWidth: spec.wideCPillar ? 0.22 : 0.18,
    roofRailH: isVintage ? 0.075 : 0.06,
    roofCrownH: crownH,
    glassColor: spec.glassColor ?? GLASS_STD,
    midPillarSurf: spec.blackoutPillars ? SURF.rubber : SURF.paint,
    midPillarColor: spec.blackoutPillars ? RUBBER_DARK : WHITE,
    roofSurf: spec.twoToneRoofColor !== undefined ? SURF.paintFixed : SURF.paint,
    roofColor: spec.twoToneRoofColor ?? WHITE,
    frontSplitPillar: spec.splitWindshield,
  }, detail);

  if (spec.tailfins && detail !== 'low') {
    for (const s of [-1, 1] as const) {
      b.taperBox(xRear + 0.42, yRearDeck - 0.02, s * (halfW * 0.86), 0.78, 0.09, 0.42, 0.05, 0.10, WHITE, SURF.paint, {
        oxTop: -0.14,
        noBottom: true,
      });
    }
  }

  addLivery(b, spec, xRear + 0.25, xFront - 0.35, wall, detail);

  const noseTopY = yBelt - spec.noseDrop;
  addFrontFascia(b, g, detail, {
    xFront,
    yBot: yBot + 0.04,
    yLight: noseTopY - 0.14,
    halfW: halfW * noseW,
    bumperH: isVintage ? 0.15 : 0.16,
    grilleH: isVintage ? 0.22 : 0.20,
    grilleW: spec.width * (isVintage ? 0.50 : 0.42),
    lightW: isVintage ? 0.20 : 0.28,
    lightH: isVintage ? 0.18 : 0.13,
    lightZ: halfW * (isVintage ? 0.66 : 0.64),
    chrome: spec.chromeBumpers,
    pushBar: spec.pushBar,
    warmLights: spec.warmHeadlights,
  });

  addRearFascia(b, g, detail, {
    xRear,
    yBot: yBot + 0.06,
    yLight: yRearDeck - 0.18,
    halfW: halfW * 0.92,
    bumperH: 0.16,
    lightW: isVintage ? 0.18 : 0.28,
    lightH: isVintage ? 0.16 : 0.12,
    lightZ: halfW * 0.66,
    chrome: spec.chromeBumpers,
  });

  addSideMirrors(b, xCowl - 0.12, yBelt + 0.08, halfW * 0.93, spec.bodyKind === 'suv' ? 1.05 : 0.92, detail);
  // Keep cars with heavy accessories (rack/pushbar/tailfins/taxi) crisp with dark wheel wells; pure silhouettes get full 3D flare lip
  const useFlareLip = !spec.pushBar && !spec.tailfins && spec.roofAccessories.length === 0;
  addWheelArches(b, spec, detail, wall, { flareLip: useFlareLip });
  addRoofAccessories(b, g, spec.roofAccessories, {
    roofTopY: spec.roofY,
    crownH,
    xRearRoof: xGhRear + spec.rearRake,
    xFrontRoof: xGhFront - spec.windshieldRake,
    hwRoof: halfW * 0.93 - spec.tumblehome,
  }, detail);
}

/** Build any four- or six-wheeled vehicle parametrically from a VehicleSpec. */
export function buildFourWheeler(spec: VehicleSpec, detail: AssetDetail = 'high'): AssetBuildResult {
  const b = new MeshBuilder();
  const g = new MeshBuilder();

  addWheels(b, spec, detail);

  if (spec.bodyKind === 'cargo' || spec.bodyKind === 'garbage' || spec.bodyKind === 'dump' || spec.bodyKind === 'fire') {
    buildHeavyTruckBody(b, g, spec, detail);
  } else if (spec.bodyKind === 'bus' || spec.bodyKind === 'schoolbus' || spec.bodyKind === 'tourbus') {
    buildBusBody(b, g, spec, detail);
  } else if (spec.bodyKind === 'van' || spec.bodyKind === 'ambulance') {
    buildVanBody(b, g, spec, detail);
  } else if (spec.bodyKind === 'pickup') {
    buildPickupBody(b, g, spec, detail);
  } else {
    buildPassengerBody(b, g, spec, detail);
  }

  return finalizeAsset(spec.id, spec.label, 'vehicles', b, g);
}

/**
 * Parametric motorcycle builder:
 * - 10-seg exposed alloy wheels in `high`, 8 in `med`, 6 in `low` (< 260 tris total at low!)
 * - Curved 2-segment front fender anchored to twin fork tubes (zero floating)
 * - Sculpted lofted fairing + windscreen + flush headlight (zero stacked blocks)
 * - Low-slung parallel chrome exhaust clearing the rear wheel hub cleanly
 */
export function buildMoto(spec: MotoSpec, detail: AssetDetail = 'high'): AssetBuildResult {
  const b = new MeshBuilder();
  const g = new MeshBuilder();

  const seg = wheelSegs(detail, true);
  const r = spec.wheelRadius;
  const cy = wheelCenterY(r, seg);
  const xRearW = -spec.wheelbase * 0.5;
  const xFrontW = spec.wheelbase * 0.5;
  const steerX = xFrontW - 0.28;
  const steerY = spec.tankHeight + 0.12;

  // 1. Centered front & rear wheels (alloy rims on BOTH sides: outerSign = 0)
  b.wheel(xRearW, cy, 0, r, spec.wheelWidth, seg, { outerSign: 0, rimColor: 0xc8d0da, hubColor: 0x3b424c, rimRatio: 0.64 });
  b.wheel(xFrontW, cy, 0, r, spec.wheelWidth * 0.88, seg, { outerSign: 0, rimColor: 0xc8d0da, hubColor: 0x3b424c, rimRatio: 0.64 });

  // 2. Front fork tubes (4-face lofts without wasted bottom caps -> 10 tris each in high/med; single fork leg in low)
  const addForkLeg = (z: number, w: number) => {
    const hw = w * 0.5;
    b.loft([
      [[xFrontW - hw, cy, z + hw], [xFrontW - hw, cy, z - hw], [xFrontW + hw, cy, z - hw], [xFrontW + hw, cy, z + hw]],
      [[steerX - hw, steerY, z + hw], [steerX - hw, steerY, z - hw], [steerX + hw, steerY, z - hw], [steerX + hw, steerY, z + hw]],
    ], CHROME, SURF.metal, { capStart: false, capEnd: true });
  };
  if (detail === 'low') {
    addForkLeg(0, 0.08);
  } else {
    addForkLeg(0.095, 0.044);
    addForkLeg(-0.095, 0.044);
  }

  // 3. Curved 2-segment front mudguard hugging the front tire & anchored between fork tubes
  if (detail !== 'low') {
    const fhw = spec.wheelWidth * 0.5 + 0.025;
    const fAngles = [Math.PI * 0.72, Math.PI * 0.50, Math.PI * 0.22];
    const rFIn = r + 0.024;
    const rFOut = r + 0.058;
    const fRings: Vec3[][] = fAngles.map((a) => {
      const ca = Math.cos(a), sa = Math.sin(a);
      return [
        [xFrontW + ca * rFIn, cy + sa * rFIn, fhw],
        [xFrontW + ca * rFIn, cy + sa * rFIn, -fhw],
        [xFrontW + ca * rFOut, cy + sa * rFOut, -fhw * 0.88],
        [xFrontW + ca * rFOut, cy + sa * rFOut, fhw * 0.88],
      ];
    });
    b.loft(fRings, WHITE, SURF.paint, { capStart: false, capEnd: false });
  }

  // 4. Handlebars + dark grips
  const hw = spec.handlebarWidth * 0.5;
  b.box(steerX - 0.02, steerY - 0.01, 0, 0.045, 0.042, hw * 1.48, CHROME, SURF.metal, { noBottom: true });
  if (detail !== 'low') {
    for (const s of [-1, 1] as const) {
      b.box(steerX - 0.04, steerY - 0.01, s * hw * 0.86, 0.052, 0.048, hw * 0.30, RUBBER_DARK, SURF.rubber, { noBottom: true });
    }
  }

  // 5. Cohesive dark engine block + rear subframe + swingarm (no air gaps)
  b.box(0.06, cy - 0.03, 0, 0.62, 0.44, 0.28, RUBBER_MID, SURF.rubber, { noBottom: true });
  if (detail !== 'low') {
    b.box(0.08, cy + 0.07, 0, 0.44, 0.20, 0.33, STEEL_DARK, SURF.metal, { noBottom: true });
    b.taperBox(-0.34, cy + 0.20, 0, 0.62, 0.24, 0.72, 0.22, spec.seatHeight - (cy + 0.20) - 0.06, RUBBER_MID, SURF.rubber, { oxTop: -0.10, noBottom: true });
    // Rear swingarm arms
    for (const s of [-1, 1] as const) {
      const z = s * 0.105;
      b.loft([
        [[xRearW, cy - 0.025, z + 0.02], [xRearW, cy - 0.025, z - 0.02], [xRearW, cy + 0.025, z - 0.02], [xRearW, cy + 0.025, z + 0.02]],
        [[-0.14, cy + 0.02, z + 0.022], [-0.14, cy + 0.02, z - 0.022], [-0.14, cy + 0.08, z - 0.022], [-0.14, cy + 0.08, z + 0.022]],
      ], STEEL_DARK, SURF.metal, { capStart: false, capEnd: false });
    }
  }

  // 6. Sculpted teardrop fuel tank hugging engine block seamlessly (SURF.paint)
  if (detail === 'low') {
    b.taperBox(0.10, spec.seatHeight - 0.12, 0, 0.62, 0.34, 0.36, 0.24, spec.tankHeight - spec.seatHeight + 0.14, WHITE, SURF.paint, { noBottom: true });
  } else {
    buildSculptedHull(b, [
      { x: -0.16, yBot: spec.seatHeight - 0.16, yMid: spec.seatHeight - 0.04, yTop: spec.seatHeight + 0.04, hwBot: 0.11, hwMid: 0.15, hwTop: 0.12 },
      { x: 0.14, yBot: spec.seatHeight - 0.18, yMid: spec.tankHeight - 0.10, yTop: spec.tankHeight + 0.03, hwBot: 0.14, hwMid: 0.21, hwTop: 0.15 },
      { x: steerX + 0.06, yBot: spec.seatHeight - 0.04, yMid: spec.tankHeight - 0.08, yTop: spec.tankHeight - 0.02, hwBot: 0.09, hwMid: 0.13, hwTop: 0.10 },
    ]);
  }

  // 7. Contoured saddle + painted sport tail cowl
  b.taperBox(-0.40, spec.seatHeight - 0.10, 0, 0.58, 0.26, 0.48, 0.22, 0.13, RUBBER_DARK, SURF.rubber, { noBottom: true });
  b.taperBox(-0.74, spec.seatHeight - 0.06, 0, 0.40, 0.22, 0.24, 0.15, 0.14, WHITE, SURF.paint, { oxTop: -0.06, noBottom: true });

  // 8. Sculpted lofted front sport fairing + angled windscreen (one unified swept shape, zero stacked blocks!)
  const fairX0 = steerX + 0.20;
  const fairY0 = steerY - 0.17;
  if (detail === 'low') {
    b.taperBox(steerX + 0.10, fairY0, 0, 0.20, 0.22, 0.12, 0.16, 0.28, WHITE, SURF.paint, { oxTop: -0.06, noBottom: true });
  } else {
    b.loft([
      [[steerX - 0.02, fairY0, 0.12], [steerX - 0.02, fairY0, -0.12], [fairX0, fairY0 + 0.02, -0.09], [fairX0, fairY0 + 0.02, 0.09]],
      [[steerX - 0.05, steerY + 0.06, 0.11], [steerX - 0.05, steerY + 0.06, -0.11], [steerX + 0.14, steerY + 0.08, -0.085], [steerX + 0.14, steerY + 0.08, 0.085]],
      [[steerX - 0.10, steerY + 0.22, 0.08], [steerX - 0.10, steerY + 0.22, -0.08], [steerX + 0.01, steerY + 0.23, -0.065], [steerX + 0.01, steerY + 0.23, 0.065]],
    ], WHITE, SURF.paint, {
      capStart: false,
      capEnd: true,
      faceColors: (segIdx) => (segIdx === 1 ? { color: GLASS_STD, surf: SURF.glass } : null),
    });
  }

  // 9. Low-slung parallel chrome exhaust muffler clearing BELOW the rear wheel hub cleanly
  const exZ = 0.175;
  const exY0 = cy - 0.14;
  const exY1 = cy - 0.08;
  const exX1 = xRearW + 0.18;
  b.loft([
    [[0.12, exY0 - 0.032, exZ + 0.032], [0.12, exY0 - 0.032, exZ - 0.032], [0.12, exY0 + 0.032, exZ - 0.032], [0.12, exY0 + 0.032, exZ + 0.032]],
    [[exX1, exY1 - 0.038, exZ + 0.038], [exX1, exY1 - 0.038, exZ - 0.038], [exX1, exY1 + 0.038, exZ - 0.038], [exX1, exY1 + 0.038, exZ + 0.038]],
  ], CHROME, SURF.metal, { capStart: false, capEnd: true, capEndColor: DARK_UNDER, capEndSurf: SURF.rubber });

  // 10. Flush integrated headlight & taillight glow
  quadFrontX(g, fairX0 + 0.008, fairY0 + 0.04, fairY0 + 0.15, 0, 0.14, GLOW_HEAD, SURF.matte);
  quadRearX(g, -0.945, spec.seatHeight - 0.01, spec.seatHeight + 0.06, 0, 0.12, GLOW_TAIL, SURF.matte);

  return finalizeAsset(spec.id, spec.label, 'vehicles', b, g);
}

/** Complete catalog of 18 parametric vehicle presets across civilian, service, transit, heavy, and 2-wheeler classes. */
export const VEHICLE_PRESETS: VehiclePreset[] = [
  // --- Civilian Cars ---
  {
    id: 'sedan',
    label: 'Sedã Urbano',
    category: 'civilian',
    vtype: VType.Car,
    defaultColor: 0x3b6ea5,
    swatches: [0x3b6ea5, 0xc83e37, 0xd8dce2, 0x367a58],
    spec: {
      kind: 'four-wheeler',
      id: 'sedan',
      label: 'Sedã Urbano',
      bodyKind: 'sedan',
      length: 4.44,
      width: 1.82,
      groundClearance: 0.20,
      beltY: 0.90,
      roofY: 1.46,
      wheelRadius: 0.34,
      wheelWidth: 0.23,
      axles: [-1.34, 1.32],
      hoodLen: 1.18,
      noseDrop: 0.20,
      trunkLen: 0.80,
      windshieldRake: 0.56,
      rearRake: 0.46,
      tumblehome: 0.17,
      pillarPositions: [0.47],
      blackoutPillars: true,
      roofAccessories: [],
      livery: 'none',
    },
  },
  {
    id: 'hatch',
    label: 'Hatch Compacto',
    category: 'civilian',
    vtype: VType.Car,
    defaultColor: 0xd1493f,
    swatches: [0xd1493f, 0xe8b538, 0x388296, 0xe4e8ee],
    spec: {
      kind: 'four-wheeler',
      id: 'hatch',
      label: 'Hatch Compacto',
      bodyKind: 'hatch',
      length: 4.02,
      width: 1.78,
      groundClearance: 0.19,
      beltY: 0.90,
      roofY: 1.48,
      wheelRadius: 0.33,
      wheelWidth: 0.22,
      axles: [-1.24, 1.20],
      hoodLen: 1.00,
      noseDrop: 0.21,
      trunkLen: 0.12,
      windshieldRake: 0.52,
      rearRake: 0.36,
      tumblehome: 0.16,
      pillarPositions: [0.48],
      blackoutPillars: true,
      roofAccessories: [],
      livery: 'none',
    },
  },
  {
    id: 'suv',
    label: 'SUV Familiar',
    category: 'civilian',
    vtype: VType.Car,
    defaultColor: 0x386650,
    swatches: [0x386650, 0x33475b, 0xb85233, 0xd4cfc7],
    spec: {
      kind: 'four-wheeler',
      id: 'suv',
      label: 'SUV Familiar',
      bodyKind: 'suv',
      length: 4.66,
      width: 1.94,
      groundClearance: 0.26,
      beltY: 1.06,
      roofY: 1.76,
      wheelRadius: 0.40,
      wheelWidth: 0.26,
      axles: [-1.40, 1.40],
      hoodLen: 1.20,
      noseDrop: 0.16,
      trunkLen: 0.14,
      windshieldRake: 0.44,
      rearRake: 0.22,
      tumblehome: 0.14,
      pillarPositions: [0.34, 0.66],
      darkCladding: true,
      blackoutPillars: true,
      wideCPillar: true,
      glassColor: GLASS_DARK,
      roofAccessories: ['rack'],
      livery: 'none',
    },
  },
  {
    id: 'pickup',
    label: 'Picape Utilitária',
    category: 'civilian',
    vtype: VType.Car,
    defaultColor: 0xb84c2b,
    swatches: [0xb84c2b, 0x2d5478, 0x4b5c49, 0xdfe2e6],
    spec: {
      kind: 'four-wheeler',
      id: 'pickup',
      label: 'Picape Utilitária',
      bodyKind: 'pickup',
      length: 5.05,
      width: 1.94,
      groundClearance: 0.28,
      beltY: 1.08,
      roofY: 1.76,
      wheelRadius: 0.41,
      wheelWidth: 0.27,
      axles: [-1.52, 1.54],
      hoodLen: 1.28,
      noseDrop: 0.16,
      trunkLen: 0,
      windshieldRake: 0.36,
      rearRake: 0.08,
      tumblehome: 0.13,
      pillarPositions: [0.44],
      darkCladding: true,
      chromeBumpers: true,
      roofAccessories: [],
      livery: 'none',
    },
  },
  {
    id: 'vintage',
    label: 'Clássico Era 0 (Anos 50)',
    category: 'civilian',
    vtype: VType.Car,
    defaultColor: 0x5ca09b,
    swatches: [0x5ca09b, 0xd4a45a, 0x9c3d41, 0x455a75],
    spec: {
      kind: 'four-wheeler',
      id: 'vintage',
      label: 'Clássico Era 0 (Anos 50)',
      bodyKind: 'vintage',
      length: 4.56,
      width: 1.82,
      groundClearance: 0.22,
      beltY: 0.94,
      roofY: 1.54,
      wheelRadius: 0.35,
      wheelWidth: 0.21,
      axles: [-1.38, 1.38],
      hoodLen: 1.28,
      noseDrop: 0.15,
      trunkLen: 0.88,
      windshieldRake: 0.34,
      rearRake: 0.40,
      tumblehome: 0.18,
      pillarPositions: [0.48],
      chromeBumpers: true,
      splitWindshield: true,
      tailfins: true,
      warmHeadlights: true,
      rimColor: 0xe6e8ec,
      hubColor: 0xd0d6de,
      rimRatio: 0.64,
      roofAccessories: [],
      livery: 'vintage-chrome',
    },
  },

  // --- Light Service & Emergency ---
  {
    id: 'taxi',
    label: 'Táxi Urbano',
    category: 'service',
    vtype: VType.Taxi,
    defaultColor: 0xefb824,
    swatches: [0xefb824, 0xf2cb40, 0xedf0f5, 0x2f8a68],
    spec: {
      kind: 'four-wheeler',
      id: 'taxi',
      label: 'Táxi Urbano',
      bodyKind: 'sedan',
      length: 4.44,
      width: 1.82,
      groundClearance: 0.20,
      beltY: 0.90,
      roofY: 1.46,
      wheelRadius: 0.34,
      wheelWidth: 0.23,
      axles: [-1.34, 1.32],
      hoodLen: 1.18,
      noseDrop: 0.20,
      trunkLen: 0.80,
      windshieldRake: 0.56,
      rearRake: 0.46,
      tumblehome: 0.17,
      pillarPositions: [0.47],
      blackoutPillars: true,
      roofAccessories: ['taxi'],
      livery: 'taxi-stripe',
    },
  },
  {
    id: 'police',
    label: 'Viatura Policial',
    category: 'emergency',
    vtype: VType.Police,
    defaultColor: 0x1f2d42,
    swatches: [0x1f2d42, 0x252830, 0x234c78, 0x3b4450],
    spec: {
      kind: 'four-wheeler',
      id: 'police',
      label: 'Viatura Policial',
      bodyKind: 'sedan',
      length: 4.78,
      width: 1.88,
      groundClearance: 0.21,
      beltY: 0.93,
      roofY: 1.49,
      wheelRadius: 0.36,
      wheelWidth: 0.24,
      axles: [-1.42, 1.42],
      hoodLen: 1.30,
      noseDrop: 0.19,
      trunkLen: 0.86,
      windshieldRake: 0.54,
      rearRake: 0.44,
      tumblehome: 0.16,
      pillarPositions: [0.48],
      blackoutPillars: true,
      pushBar: true,
      twoToneRoofColor: 0xf2f5f9,
      rimColor: 0x8a94a2,
      hubColor: 0xd8dee6,
      roofAccessories: ['lightbar-rb'],
      livery: 'police-doors',
    },
  },
  {
    id: 'hearse',
    label: 'Carro Funerário',
    category: 'service',
    vtype: VType.Hearse,
    defaultColor: 0x242830,
    swatches: [0x242830, 0x323740, 0x3a2c34, 0xd8dce2],
    spec: {
      kind: 'four-wheeler',
      id: 'hearse',
      label: 'Carro Funerário',
      bodyKind: 'suv',
      length: 5.46,
      width: 1.88,
      groundClearance: 0.20,
      beltY: 0.94,
      roofY: 1.62,
      wheelRadius: 0.35,
      wheelWidth: 0.23,
      axles: [-1.72, 1.64],
      hoodLen: 1.42,
      noseDrop: 0.14,
      trunkLen: 0.14,
      windshieldRake: 0.42,
      rearRake: 0.14,
      tumblehome: 0.13,
      pillarPositions: [0.36, 0.68],
      chromeBumpers: true,
      wideCPillar: true,
      glassColor: GLASS_DARK,
      roofAccessories: [],
      livery: 'hearse-landau',
    },
  },
  {
    id: 'van',
    label: 'Van de Entregas',
    category: 'service',
    vtype: VType.Van,
    defaultColor: 0xeaeef3,
    swatches: [0xeaeef3, 0x3c6ca8, 0xd97d2b, 0x4d825b],
    spec: {
      kind: 'four-wheeler',
      id: 'van',
      label: 'Van de Entregas',
      bodyKind: 'van',
      length: 5.45,
      width: 2.02,
      groundClearance: 0.24,
      beltY: 1.12,
      roofY: 2.24,
      wheelRadius: 0.39,
      wheelWidth: 0.26,
      axles: [-1.66, 1.64],
      hoodLen: 0.88,
      noseDrop: 0.22,
      trunkLen: 0,
      windshieldRake: 0.42,
      rearRake: 0.06,
      tumblehome: 0.10,
      pillarPositions: [],
      roofAccessories: [],
      livery: 'none',
    },
  },
  {
    id: 'ambulance',
    label: 'Ambulância',
    category: 'emergency',
    vtype: VType.Ambulance,
    defaultColor: 0xf2f5f8,
    swatches: [0xf2f5f8, 0xf2ecd8, 0xe8edf2, 0xf7e49e],
    spec: {
      kind: 'four-wheeler',
      id: 'ambulance',
      label: 'Ambulância',
      bodyKind: 'ambulance',
      length: 5.96,
      width: 2.12,
      groundClearance: 0.25,
      beltY: 1.14,
      roofY: 2.52,
      wheelRadius: 0.40,
      wheelWidth: 0.27,
      axles: [-1.76, 1.84],
      hoodLen: 0.92,
      noseDrop: 0.22,
      trunkLen: 0,
      windshieldRake: 0.38,
      rearRake: 0.04,
      tumblehome: 0.09,
      pillarPositions: [],
      rearFlashers: 'red-pair',
      roofAccessories: ['lightbar-rw'],
      livery: 'ambulance-cross',
    },
  },

  // --- Transit Buses ---
  {
    id: 'bus',
    label: 'Ônibus Urbano',
    category: 'transit',
    vtype: VType.Bus,
    defaultColor: 0x2a6fb2,
    swatches: [0x2a6fb2, 0xc83e36, 0x36875c, 0xde8c26],
    spec: {
      kind: 'four-wheeler',
      id: 'bus',
      label: 'Ônibus Urbano',
      bodyKind: 'bus',
      length: 11.80,
      width: 2.52,
      groundClearance: 0.28,
      beltY: 1.24,
      roofY: 2.94,
      wheelRadius: 0.50,
      wheelWidth: 0.34,
      axles: [-3.35, 3.35],
      hoodLen: 0,
      noseDrop: 0.08,
      trunkLen: 0,
      windshieldRake: 0.24,
      rearRake: 0.12,
      tumblehome: 0.08,
      pillarPositions: [0.17, 0.34, 0.51, 0.68, 0.85],
      blackoutPillars: true,
      roofAccessories: ['ac'],
      livery: 'bus-stripe',
    },
  },
  {
    id: 'schoolbus',
    label: 'Ônibus Escolar',
    category: 'transit',
    vtype: VType.SchoolBus,
    defaultColor: 0xe8a81c,
    swatches: [0xe8a81c, 0xf0be32, 0xdc9318, 0xe8c448],
    spec: {
      kind: 'four-wheeler',
      id: 'schoolbus',
      label: 'Ônibus Escolar',
      bodyKind: 'schoolbus',
      length: 9.85,
      width: 2.46,
      groundClearance: 0.32,
      beltY: 1.38,
      roofY: 3.00,
      wheelRadius: 0.49,
      wheelWidth: 0.33,
      axles: [-2.65, 2.85],
      hoodLen: 1.48,
      noseDrop: 0.18,
      trunkLen: 0,
      windshieldRake: 0.16,
      rearRake: 0.08,
      tumblehome: 0.09,
      pillarPositions: [0.20, 0.40, 0.60, 0.80],
      blackoutPillars: false,
      splitWindshield: true,
      chromeBumpers: true,
      roofAccessories: [],
      livery: 'school-rails',
    },
  },
  {
    id: 'tourbus',
    label: 'Ônibus Turístico (2 Andares)',
    category: 'transit',
    vtype: VType.TourBus,
    defaultColor: 0xc8322e,
    swatches: [0xc8322e, 0x2665a8, 0x2f875c, 0xd88822],
    spec: {
      kind: 'four-wheeler',
      id: 'tourbus',
      label: 'Ônibus Turístico (2 Andares)',
      bodyKind: 'tourbus',
      length: 11.80,
      width: 2.54,
      groundClearance: 0.28,
      beltY: 1.24,
      roofY: 2.82,
      wheelRadius: 0.50,
      wheelWidth: 0.34,
      axles: [-3.35, 3.35],
      hoodLen: 0,
      noseDrop: 0.08,
      trunkLen: 0,
      windshieldRake: 0.20,
      rearRake: 0.08,
      tumblehome: 0.06,
      pillarPositions: [0.20, 0.40, 0.60, 0.80],
      blackoutPillars: true,
      roofAccessories: ['tour-deck'],
      livery: 'tour-stripe',
    },
  },

  // --- Heavy Trucks (tandem rear axles = 6 wheels) ---
  {
    id: 'truck',
    label: 'Caminhão Baú',
    category: 'heavy',
    vtype: VType.Truck,
    defaultColor: 0x355f8c,
    swatches: [0x355f8c, 0xb83832, 0x3a7a56, 0xde9226],
    spec: {
      kind: 'four-wheeler',
      id: 'truck',
      label: 'Caminhão Baú',
      bodyKind: 'cargo',
      length: 9.55,
      width: 2.48,
      groundClearance: 0.34,
      beltY: 1.54,
      roofY: 2.84,
      wheelRadius: 0.50,
      wheelWidth: 0.34,
      axles: [-3.25, -2.05, 3.25],
      hoodLen: 0,
      noseDrop: 0.08,
      trunkLen: 0,
      windshieldRake: 0.20,
      rearRake: 0,
      tumblehome: 0.09,
      pillarPositions: [],
      chromeBumpers: true,
      fuelTanks: true,
      roofAccessories: [],
      livery: 'none',
    },
  },
  {
    id: 'garbage',
    label: 'Caminhão de Lixo',
    category: 'heavy',
    vtype: VType.Garbage,
    defaultColor: 0x38824c,
    swatches: [0x38824c, 0xd88822, 0x2f6899, 0xe4e8ec],
    spec: {
      kind: 'four-wheeler',
      id: 'garbage',
      label: 'Caminhão de Lixo',
      bodyKind: 'garbage',
      length: 8.20,
      width: 2.44,
      groundClearance: 0.34,
      beltY: 1.52,
      roofY: 2.82,
      wheelRadius: 0.49,
      wheelWidth: 0.34,
      axles: [-2.60, -1.42, 2.72],
      hoodLen: 0,
      noseDrop: 0.08,
      trunkLen: 0,
      windshieldRake: 0.18,
      rearRake: 0,
      tumblehome: 0.08,
      pillarPositions: [],
      fuelTanks: true,
      rearFlashers: 'amber-strobe',
      roofAccessories: ['beacon'],
      livery: 'none',
    },
  },
  {
    id: 'construction',
    label: 'Caminhão Basculante',
    category: 'heavy',
    vtype: VType.Construction,
    defaultColor: 0xde911d,
    swatches: [0xde911d, 0xc95224, 0x3a648c, 0x707882],
    spec: {
      kind: 'four-wheeler',
      id: 'construction',
      label: 'Caminhão Basculante',
      bodyKind: 'dump',
      length: 8.20,
      width: 2.48,
      groundClearance: 0.36,
      beltY: 1.54,
      roofY: 2.82,
      wheelRadius: 0.51,
      wheelWidth: 0.35,
      axles: [-2.62, -1.40, 2.74],
      hoodLen: 0,
      noseDrop: 0.08,
      trunkLen: 0,
      windshieldRake: 0.18,
      rearRake: 0,
      tumblehome: 0.08,
      pillarPositions: [],
      fuelTanks: true,
      roofAccessories: ['beacon'],
      livery: 'none',
    },
  },
  {
    id: 'fire',
    label: 'Caminhão de Bombeiros',
    category: 'emergency',
    vtype: VType.Fire,
    defaultColor: 0xc92622,
    swatches: [0xc92622, 0xd83226, 0xb82220, 0xdf9e1e],
    spec: {
      kind: 'four-wheeler',
      id: 'fire',
      label: 'Caminhão de Bombeiros',
      bodyKind: 'fire',
      length: 9.05,
      width: 2.50,
      groundClearance: 0.34,
      beltY: 1.54,
      roofY: 2.84,
      wheelRadius: 0.50,
      wheelWidth: 0.34,
      axles: [-3.05, -1.85, 3.05],
      hoodLen: 0,
      noseDrop: 0.06,
      trunkLen: 0,
      windshieldRake: 0.16,
      rearRake: 0,
      tumblehome: 0.07,
      pillarPositions: [],
      chromeBumpers: true,
      fuelTanks: false,
      rearFlashers: 'red-pair',
      roofAccessories: ['lightbar-rw', 'ladder'],
      livery: 'fire-stripe',
    },
  },

  // --- Two-Wheeler ---
  {
    id: 'moto',
    label: 'Motocicleta Urbana',
    category: 'two-wheeler',
    vtype: VType.Moto,
    defaultColor: 0xd1302a,
    swatches: [0xd1302a, 0x2665a8, 0x2c3038, 0xe8a822],
    spec: {
      kind: 'moto',
      id: 'moto',
      label: 'Motocicleta Urbana',
      length: 2.15,
      wheelRadius: 0.32,
      wheelWidth: 0.15,
      wheelbase: 1.44,
      seatHeight: 0.78,
      tankHeight: 0.94,
      handlebarWidth: 0.78,
    },
  },
];

export const VEHICLE_PRESET_MAP: Record<VehicleId, VehiclePreset> = Object.fromEntries(
  VEHICLE_PRESETS.map((p) => [p.id, p]),
) as Record<VehicleId, VehiclePreset>;

export const VTYPE_DEFAULT_PRESETS: Partial<Record<VType, VehicleId[]>> = {
  [VType.Car]: ['sedan', 'hatch', 'suv', 'pickup', 'vintage'],
  [VType.Taxi]: ['taxi'],
  [VType.Moto]: ['moto'],
  [VType.Bus]: ['bus'],
  [VType.SchoolBus]: ['schoolbus'],
  [VType.Truck]: ['truck'],
  [VType.Van]: ['van'],
  [VType.Garbage]: ['garbage'],
  [VType.Ambulance]: ['ambulance'],
  [VType.Police]: ['police'],
  [VType.Fire]: ['fire'],
  [VType.TourBus]: ['tourbus'],
  [VType.Construction]: ['construction'],
  [VType.Hearse]: ['hearse'],
};

/** Unified entry point to build any concrete vehicle by preset ID or custom spec. */
export function buildVehicle(
  idOrSpec: VehicleId | AnyVehicleSpec,
  detail: AssetDetail = 'high',
): AssetBuildResult {
  const spec = typeof idOrSpec === 'string' ? VEHICLE_PRESET_MAP[idOrSpec].spec : idOrSpec;
  if (spec.kind === 'moto') return buildMoto(spec, detail);
  return buildFourWheeler(spec, detail);
}
