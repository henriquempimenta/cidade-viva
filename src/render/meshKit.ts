import * as THREE from 'three';

export type Vec3 = [number, number, number];
export type AssetDetail = 'high' | 'med' | 'low';

/** Surface finish encoded per-vertex into aTint + aMat (roughness, metalness) for 1-draw-call instancing. */
export interface SurfMat {
  /** 0 = keep exact vertex color; 1 = multiply vertex color by instanceColor (paintable). */
  tint: number;
  roughness: number;
  metalness: number;
}

export const SURF = {
  /** Glossy painted bodywork tinted by instanceColor. */
  paint:      { tint: 1, roughness: 0.34, metalness: 0.22 } as SurfMat,
  /** Glossy painted accent with fixed vertex color (stripes, livery, decals). */
  paintFixed: { tint: 0, roughness: 0.34, metalness: 0.20 } as SurfMat,
  /** Reflective tinted glass (balanced metalness so it reflects sky even without an IBL envMap). */
  glass:      { tint: 0, roughness: 0.14, metalness: 0.28 } as SurfMat,
  /** Matte rubber / dark plastic trim (tires, bumpers, mudguards, seals). */
  rubber:     { tint: 0, roughness: 0.92, metalness: 0.02 } as SurfMat,
  /** Brushed/chrome metal (wheel rims, grilles, ladders, exhausts, rails). */
  metal:      { tint: 0, roughness: 0.28, metalness: 0.52 } as SurfMat,
  /** Matte fixed-color material (cargo, wood, concrete, cloth, matte paint). */
  matte:      { tint: 0, roughness: 0.84, metalness: 0.04 } as SurfMat,
  /** Matte tintable surface (foliage, cloth, awnings tinted by instanceColor). */
  matteTint:  { tint: 1, roughness: 0.84, metalness: 0.04 } as SurfMat,
} as const;

export interface AssetMeta {
  id: string;
  label: string;
  family: string;
  triangles: number;
  glowTriangles: number;
  /** Dimensions along X (length/forward), Y (height), Z (width) in meters. */
  size: [number, number, number];
  minY: number;
}

export interface AssetBuildResult {
  body: THREE.BufferGeometry;
  glow?: THREE.BufferGeometry;
  meta: AssetMeta;
}

/** Shared instanced PBR material supporting per-vertex tint mask (aTint) and roughness/metalness (aMat). */
export function createAssetMaterial(opts: { flatShading?: boolean; side?: THREE.Side } = {}): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.5,
    metalness: 0.2,
    flatShading: opts.flatShading ?? false,
    side: opts.side ?? THREE.FrontSide,
  });
  mat.customProgramCacheKey = () => `cidade-viva-asset-v1-${opts.flatShading ? 'f' : 's'}`;
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aTint;
        attribute vec2 aMat;
        varying vec2 vAssetMat;`,
      )
      .replace(
        '#include <color_vertex>',
        `#if defined( USE_COLOR_ALPHA )
          vColor = vec4( 1.0 );
        #elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
          vColor = vec3( 1.0 );
        #endif
        #ifdef USE_COLOR
          vColor *= color;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vColor.xyz *= mix( vec3( 1.0 ), instanceColor.xyz, aTint );
        #endif
        vAssetMat = aMat;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vAssetMat;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(vAssetMat.x, 0.04, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = clamp(vAssetMat.y, 0.0, 1.0);');
  };
  return mat;
}

export function createGlowMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
}

interface Xform {
  tx: number; ty: number; tz: number;
  ca: number; sa: number;
}

const tmpColor = new THREE.Color();
function resolveColor(c: THREE.Color | number): THREE.Color {
  return typeof c === 'number' ? tmpColor.setHex(c) : c;
}

/**
 * Parametric low-poly sculpting builder.
 * Convention across Cidade Viva: +X is forward, +Y is up, Y=0 is ground contact, Z is lateral symmetry axis.
 */
export class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  tint: number[] = [];
  mat: number[] = [];

  private xf: Xform = { tx: 0, ty: 0, tz: 0, ca: 1, sa: 0 };
  private stack: Xform[] = [];

  setTransform(tx = 0, ty = 0, tz = 0, yaw = 0) {
    this.xf = { tx, ty, tz, ca: Math.cos(yaw), sa: Math.sin(yaw) };
  }

  pushTransform(tx = 0, ty = 0, tz = 0, yaw = 0) {
    this.stack.push({ ...this.xf });
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    const p = this.xf;
    this.xf = {
      tx: p.tx + tx * p.ca - tz * p.sa,
      ty: p.ty + ty,
      tz: p.tz + tx * p.sa + tz * p.ca,
      ca: p.ca * ca - p.sa * sa,
      sa: p.sa * ca + p.ca * sa,
    };
  }

  popTransform() {
    const prev = this.stack.pop();
    if (prev) this.xf = prev;
  }

  private pushVertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, r: number, g: number, b: number, s: SurfMat) {
    const { tx, ty, tz, ca, sa } = this.xf;
    this.pos.push(tx + x * ca - z * sa, ty + y, tz + x * sa + z * ca);
    this.nor.push(nx * ca - nz * sa, ny, nx * sa + nz * ca);
    this.col.push(r, g, b);
    this.tint.push(s.tint);
    this.mat.push(s.roughness, s.metalness);
  }

  /** Emit one triangle with auto-computed flat outward normal (CCW winding). */
  tri(a: Vec3, b: Vec3, c: Vec3, color: THREE.Color | number, surf: SurfMat = SURF.matte, explicitNormal?: Vec3) {
    let nx: number, ny: number, nz: number;
    if (explicitNormal) {
      [nx, ny, nz] = explicitNormal;
    } else {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      nx = uy * vz - uz * vy;
      ny = uz * vx - ux * vz;
      nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-8) return; // skip degenerate triangle
      nx /= len; ny /= len; nz /= len;
    }
    const cc = resolveColor(color);
    const r = cc.r, g = cc.g, bl = cc.b;
    this.pushVertex(a[0], a[1], a[2], nx, ny, nz, r, g, bl, surf);
    this.pushVertex(b[0], b[1], b[2], nx, ny, nz, r, g, bl, surf);
    this.pushVertex(c[0], c[1], c[2], nx, ny, nz, r, g, bl, surf);
  }

  /** Emit a quad (p0,p1,p2,p3 CCW from outside) split into 2 crisp triangles. */
  quad(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, color: THREE.Color | number, surf: SurfMat = SURF.matte, explicitNormal?: Vec3) {
    const cc = resolveColor(color);
    const colCopy = new THREE.Color(cc.r, cc.g, cc.b);
    this.tri(p0, p1, p2, colCopy, surf, explicitNormal);
    this.tri(p0, p2, p3, colCopy, surf, explicitNormal);
  }

  /** Mirror a quad across Z=0 (automatically reverses winding to preserve outward normal). */
  quadMirroredZ(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, color: THREE.Color | number, surf: SurfMat = SURF.matte) {
    const cc = new THREE.Color().copy(resolveColor(color));
    this.quad(p0, p1, p2, p3, cc, surf);
    const m = (p: Vec3): Vec3 => [p[0], p[1], -p[2]];
    this.quad(m(p3), m(p2), m(p1), m(p0), cc, surf);
  }

  /**
   * Stitch a sequence of closed cross-section rings into a sculpted lofted hull (inspired by AutoForge).
   * Winding is automatically verified against each segment's centroid so faces always point outward.
   */
  loft(
    rings: Vec3[][],
    color: THREE.Color | number,
    surf: SurfMat = SURF.paint,
    opts: {
      capStart?: boolean;
      capEnd?: boolean;
      capStartColor?: THREE.Color | number;
      capEndColor?: THREE.Color | number;
      capStartSurf?: SurfMat;
      capEndSurf?: SurfMat;
      faceColors?: (segIdx: number, edgeIdx: number) => { color?: THREE.Color | number; surf?: SurfMat } | null;
    } = {},
  ) {
    if (rings.length < 2) return;
    const baseCol = new THREE.Color().copy(resolveColor(color));
    const n = rings[0].length;
    if (n < 3) return;

    // Determine consistent outward winding from the first non-degenerate quad vs global centroid.
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

    for (let s = 0; s < rings.length - 1; s++) {
      const r0 = rings[s], r1 = rings[s + 1];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ov = opts.faceColors?.(s, i);
        const fc = ov?.color !== undefined ? new THREE.Color().copy(resolveColor(ov.color)) : baseCol;
        const fs = ov?.surf ?? surf;
        if (!flip) this.quad(r0[i], r0[j], r1[j], r1[i], fc, fs);
        else this.quad(r0[j], r0[i], r1[i], r1[j], fc, fs);
      }
    }

    const capRing = (ring: Vec3[], reverse: boolean, c: THREE.Color | number, s: SurfMat) => {
      let rx = 0, ry = 0, rz = 0;
      for (const p of ring) { rx += p[0]; ry += p[1]; rz += p[2]; }
      const center: Vec3 = [rx / n, ry / n, rz / n];
      const cc = new THREE.Color().copy(resolveColor(c));
      // Verify cap normal points away from global centroid
      const a = ring[0], b = ring[1];
      const ux = a[0] - center[0], uy = a[1] - center[1], uz = a[2] - center[2];
      const vx = b[0] - center[0], vy = b[1] - center[1], vz = b[2] - center[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const dot = nx * (center[0] - cx) + ny * (center[1] - cy) + nz * (center[2] - cz);
      const rev = dot < 0 ? !reverse : reverse;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (!rev) this.tri(center, ring[i], ring[j], cc, s);
        else this.tri(center, ring[j], ring[i], cc, s);
      }
    };

    if (opts.capStart !== false) {
      capRing(rings[0], false, opts.capStartColor ?? baseCol, opts.capStartSurf ?? surf);
    }
    if (opts.capEnd !== false) {
      capRing(rings[rings.length - 1], false, opts.capEndColor ?? baseCol, opts.capEndSurf ?? surf);
    }
  }

  /** Axis-aligned box with bottom at y0. */
  box(cx: number, y0: number, cz: number, sx: number, sy: number, sz: number, color: THREE.Color | number, surf: SurfMat = SURF.matte, opts: { topColor?: THREE.Color | number; noBottom?: boolean } = {}) {
    const cc = new THREE.Color().copy(resolveColor(color));
    const tc = opts.topColor !== undefined ? new THREE.Color().copy(resolveColor(opts.topColor)) : cc;
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y1 = y0 + sy, z0 = cz - sz / 2, z1 = cz + sz / 2;
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], cc, surf, [0, 0, 1]);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], cc, surf, [0, 0, -1]);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], cc, surf, [1, 0, 0]);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], cc, surf, [-1, 0, 0]);
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], tc, surf, [0, 1, 0]);
    if (!opts.noBottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], cc, surf, [0, -1, 0]);
  }

  /** Trapezoidal/tapered prism (frustum) with bottom at y0 and top at y0 + sy (optionally offset by oxTop, ozTop). */
  taperBox(
    cx: number, y0: number, cz: number,
    sx0: number, sz0: number,
    sx1: number, sz1: number,
    sy: number,
    color: THREE.Color | number,
    surf: SurfMat = SURF.paint,
    opts: { oxTop?: number; ozTop?: number; topColor?: THREE.Color | number; topSurf?: SurfMat; noBottom?: boolean } = {},
  ) {
    const cc = new THREE.Color().copy(resolveColor(color));
    const tc = opts.topColor !== undefined ? new THREE.Color().copy(resolveColor(opts.topColor)) : cc;
    const ts = opts.topSurf ?? surf;
    const ox = opts.oxTop ?? 0, oz = opts.ozTop ?? 0;
    const b0: Vec3 = [cx - sx0 / 2, y0, cz + sz0 / 2];
    const b1: Vec3 = [cx + sx0 / 2, y0, cz + sz0 / 2];
    const b2: Vec3 = [cx + sx0 / 2, y0, cz - sz0 / 2];
    const b3: Vec3 = [cx - sx0 / 2, y0, cz - sz0 / 2];
    const t0: Vec3 = [cx + ox - sx1 / 2, y0 + sy, cz + oz + sz1 / 2];
    const t1: Vec3 = [cx + ox + sx1 / 2, y0 + sy, cz + oz + sz1 / 2];
    const t2: Vec3 = [cx + ox + sx1 / 2, y0 + sy, cz + oz - sz1 / 2];
    const t3: Vec3 = [cx + ox - sx1 / 2, y0 + sy, cz + oz - sz1 / 2];
    this.quad(b0, b1, t1, t0, cc, surf); // +z
    this.quad(b2, b3, t3, t2, cc, surf); // -z
    this.quad(b1, b2, t2, t1, cc, surf); // +x
    this.quad(b3, b0, t0, t3, cc, surf); // -x
    this.quad(t0, t1, t2, t3, tc, ts, [0, 1, 0]);
    if (!opts.noBottom) this.quad(b3, b2, b1, b0, cc, surf, [0, -1, 0]);
  }

  /** Chamfered/beveled box along Y (bottom at y0) — softens harsh edges on close-ups. */
  bevelBox(cx: number, y0: number, cz: number, sx: number, sy: number, sz: number, bevel: number, color: THREE.Color | number, surf: SurfMat = SURF.paint) {
    const b = Math.min(bevel, sx * 0.28, sy * 0.28, sz * 0.28);
    if (b < 0.005) { this.box(cx, y0, cz, sx, sy, sz, color, surf); return; }
    const ring = (y: number, inset: number): Vec3[] => {
      const hx = sx / 2 - inset, hz = sz / 2 - inset;
      const hxB = Math.max(0.001, hx - b * 0.55), hzB = Math.max(0.001, hz - b * 0.55);
      return [
        [cx - hxB, y, cz + hz], [cx + hxB, y, cz + hz],
        [cx + hx, y, cz + hzB], [cx + hx, y, cz - hzB],
        [cx + hxB, y, cz - hz], [cx - hxB, y, cz - hz],
        [cx - hx, y, cz - hzB], [cx - hx, y, cz + hzB],
      ];
    };
    this.loft([
      ring(y0, b * 0.55),
      ring(y0 + b, 0),
      ring(y0 + sy - b, 0),
      ring(y0 + sy, b * 0.55),
    ], color, surf);
  }

  /** Cylinder/frustum oriented along 'x', 'y', or 'z', centered at (cx, cy, cz). */
  cylinder(
    cx: number, cy: number, cz: number,
    r0: number, r1: number, length: number, seg: number,
    axis: 'x' | 'y' | 'z',
    color: THREE.Color | number,
    surf: SurfMat = SURF.matte,
    opts: { capStart?: boolean; capEnd?: boolean; smooth?: boolean } = {},
  ) {
    const cc = new THREE.Color().copy(resolveColor(color));
    const h = length / 2;
    const pt = (u: number, v: number, w: number): Vec3 =>
      axis === 'y' ? [cx + u, cy + w, cz + v]
      : axis === 'x' ? [cx + w, cy + v, cz + u]
      : [cx + u, cy + v, cz + w];

    const ringA: Vec3[] = [];
    const ringB: Vec3[] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      ringA.push(pt(ca * r0, sa * r0, -h));
      ringB.push(pt(ca * r1, sa * r1, h));
    }
    this.loft([ringA, ringB], cc, surf, {
      capStart: opts.capStart ?? true,
      capEnd: opts.capEnd ?? true,
    });
  }

  /**
   * Sculpted low-poly wheel oriented along Z axis (rolling along +X), centered at (cx, cy, cz).
   * Optimized triangle count (~48 tris at seg=8) with recessed alloy rim and hubcap on the outer side.
   */
  wheel(
    cx: number, cy: number, cz: number,
    radius: number, width: number,
    seg = 8,
    opts: { tireColor?: number; rimColor?: number; hubColor?: number; rimRatio?: number; outerSign?: 1 | -1 | 0 } = {},
  ) {
    const tireC = opts.tireColor ?? 0x1e2024;
    const rimC = opts.rimColor ?? 0xc8ced6;
    const hubC = opts.hubColor ?? 0x4b525c;
    const rimR = radius * (opts.rimRatio ?? 0.58);
    const hubR = rimR * 0.36;
    const hw = width * 0.5;
    // Decide which face(s) get rim detail (outer face based on cz sign, or both for centered moto/bike wheels)
    const outerSign = opts.outerSign ?? (Math.abs(cz) < 0.05 ? 0 : cz > 0 ? 1 : -1);

    const cosA: number[] = [], sinA: number[] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      cosA.push(Math.cos(a)); sinA.push(Math.sin(a));
    }

    // Tire tread band (1 ring segment = 2*seg tris)
    const ringNeg: Vec3[] = [];
    const ringPos: Vec3[] = [];
    for (let i = 0; i < seg; i++) {
      ringNeg.push([cx + cosA[i] * radius, cy + sinA[i] * radius, cz - hw]);
      ringPos.push([cx + cosA[i] * radius, cy + sinA[i] * radius, cz + hw]);
    }
    this.loft([ringNeg, ringPos], tireC, SURF.rubber, { capStart: false, capEnd: false });

    // Side faces: detailed concentric sidewall + recessed alloy rim + hub on outer face(s), simple dark cap on inner face
    const buildFace = (sign: 1 | -1, detailed: boolean) => {
      const zOut = cz + sign * hw;
      const zRim = cz + sign * (hw - Math.min(0.03, width * 0.14));
      const zHub = cz + sign * (hw - Math.min(0.012, width * 0.06));
      const nVec: Vec3 = [0, 0, sign];
      const center: Vec3 = [cx, cy, detailed ? zHub : zOut];
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        const pT0: Vec3 = [cx + cosA[i] * radius, cy + sinA[i] * radius, zOut];
        const pT1: Vec3 = [cx + cosA[j] * radius, cy + sinA[j] * radius, zOut];
        if (!detailed) {
          if (sign > 0) this.tri(center, pT0, pT1, tireC, SURF.rubber, nVec);
          else this.tri(center, pT1, pT0, tireC, SURF.rubber, nVec);
        } else {
          const pR0: Vec3 = [cx + cosA[i] * rimR, cy + sinA[i] * rimR, zRim];
          const pR1: Vec3 = [cx + cosA[j] * rimR, cy + sinA[j] * rimR, zRim];
          const pH0: Vec3 = [cx + cosA[i] * hubR, cy + sinA[i] * hubR, zHub];
          const pH1: Vec3 = [cx + cosA[j] * hubR, cy + sinA[j] * hubR, zHub];
          if (sign > 0) {
            this.quad(pR0, pT0, pT1, pR1, tireC, SURF.rubber);
            this.quad(pH0, pR0, pR1, pH1, rimC, SURF.metal);
            this.tri(center, pH0, pH1, hubC, SURF.metal, nVec);
          } else {
            this.quad(pR1, pT1, pT0, pR0, tireC, SURF.rubber);
            this.quad(pH1, pR1, pR0, pH0, rimC, SURF.metal);
            this.tri(center, pH1, pH0, hubC, SURF.metal, nVec);
          }
        }
      }
    };
    buildFace(1, outerSign === 0 || outerSign === 1);
    buildFace(-1, outerSign === 0 || outerSign === -1);
  }

  /** Structural beam connecting p0 -> p1 with rectangular cross-section w x d (AutoForge-style pillars/rails/branches). */
  strut(p0: Vec3, p1: Vec3, w: number, d: number, color: THREE.Color | number, surf: SurfMat = SURF.matte) {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) return;
    const fx = dx / len, fy = dy / len, fz = dz / len;
    // Pick a stable perpendicular basis
    const ux0 = Math.abs(fy) < 0.9 ? 0 : 1, uy0 = Math.abs(fy) < 0.9 ? 1 : 0, uz0 = 0;
    let rx = fy * uz0 - fz * uy0, ry = fz * ux0 - fx * uz0, rz = fx * uy0 - fy * ux0;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const vx = ry * fz - rz * fy, vy = rz * fx - rx * fz, vz = rx * fy - ry * fx;
    const hw = w * 0.5, hd = d * 0.5;
    const ring = (p: Vec3): Vec3[] => [
      [p[0] - rx * hw - vx * hd, p[1] - ry * hw - vy * hd, p[2] - rz * hw - vz * hd],
      [p[0] + rx * hw - vx * hd, p[1] + ry * hw - vy * hd, p[2] + rz * hw - vz * hd],
      [p[0] + rx * hw + vx * hd, p[1] + ry * hw + vy * hd, p[2] + rz * hw + vz * hd],
      [p[0] - rx * hw + vx * hd, p[1] - ry * hw + vy * hd, p[2] - rz * hw + vz * hd],
    ];
    this.loft([ring(p0), ring(p1)], color, surf, { capStart: true, capEnd: true });
  }

  /** Merge another MeshBuilder's already-transformed vertices into this one (applies current transform). */
  merge(other: MeshBuilder) {
    const n = other.pos.length / 3;
    for (let i = 0; i < n; i++) {
      const p3 = i * 3, m2 = i * 2;
      this.pushVertex(
        other.pos[p3], other.pos[p3 + 1], other.pos[p3 + 2],
        other.nor[p3], other.nor[p3 + 1], other.nor[p3 + 2],
        other.col[p3], other.col[p3 + 1], other.col[p3 + 2],
        { tint: other.tint[i], roughness: other.mat[m2], metalness: other.mat[m2 + 1] },
      );
    }
  }

  get vertexCount() { return this.pos.length / 3; }
  get triangleCount() { return this.pos.length / 9; }

  bounds(): { min: Vec3; max: Vec3; size: Vec3 } {
    if (this.pos.length === 0) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.pos.length; i += 3) {
      const x = this.pos[i], y = this.pos[i + 1], z = this.pos[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], size: [maxX - minX, maxY - minY, maxZ - minZ] };
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.tint, 1));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 2));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/** Helper to finalize a body + optional glow MeshBuilder into the standard AssetBuildResult contract. */
export function finalizeAsset(
  id: string,
  label: string,
  family: string,
  bodyBuilder: MeshBuilder,
  glowBuilder?: MeshBuilder | null,
): AssetBuildResult {
  const b = bodyBuilder.bounds();
  const hasGlow = glowBuilder && glowBuilder.triangleCount > 0;
  return {
    body: bodyBuilder.toGeometry(),
    glow: hasGlow ? glowBuilder.toGeometry() : undefined,
    meta: {
      id,
      label,
      family,
      triangles: bodyBuilder.triangleCount,
      glowTriangles: hasGlow ? glowBuilder.triangleCount : 0,
      size: [Number(b.size[0].toFixed(2)), Number(b.size[1].toFixed(2)), Number(b.size[2].toFixed(2))],
      minY: Number(b.min[1].toFixed(3)),
    },
  };
}
