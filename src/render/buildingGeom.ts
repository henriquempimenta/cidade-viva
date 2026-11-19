import * as THREE from 'three';
import { KINDS } from '../shared/catalog';
import type { BuildingView } from '../shared/protocol';
import { RNG } from '../shared/rng';
import { GB } from './geomBuilder';

// window types: 0 none, 1 residential, 2 glass curtain, 3 shopfront, 4 industrial, 5 broken/abandoned, 6 lit sign (emissive)
const C = (h: number) => new THREE.Color(h);
const PAL = {
  vilaWalls: [0xf3eee2, 0xf1e3c4, 0xe8c98f, 0xbcd6e6, 0xf0c9c0, 0xd9e7c9, 0xffffff],
  terracotta: [0xb5532f, 0xa8492b, 0xc0663c, 0x9d4a33],
  concrete: [0xc9c4ba, 0xb8b2a6, 0xd6cfc2, 0xa8a49b, 0xe2dccd],
  brick: [0xa65a3f, 0x9a5038, 0xb86e4e],
  modern: [0xf4f4f2, 0xdedfdf, 0xc5c9cc, 0x9aa3a8, 0xe9e4d8, 0x6f7a80],
  glass: [0x6f95ad, 0x5e8aa0, 0x7aa6b8, 0x4f6f86, 0x8fb2c0, 0x3d5a6e, 0x86a39a],
  informal: [0xc0703f, 0xb4643a, 0xd08a55, 0x5aa0c8, 0xe5c84a, 0xd65a5a, 0x7cbf6a, 0xe8e2d0],
  awning: [0xd94a3d, 0x2f8f6a, 0x2f6fb0, 0xe5a52b, 0x8b4fb0, 0xf06a2a],
};
const pick = (rng: RNG, a: number[]) => C(a[Math.floor(rng.next() * a.length)]);

export interface BuildResult { geo: THREE.BufferGeometry; smoke: number[]; blades: number[]; lights: number[] }

export function buildingGeometry(b: BuildingView): BuildResult {
  const g = new GB();
  const rng = new RNG(b.seed);
  g.setTransform(b.x, b.y, b.z, b.angle);
  const smoke: number[] = [];
  const blades: number[] = []; // x,y,z,radius,angle(rotor facing)
  const lights: number[] = [];
  const front = -1; // local z sign toward the road is handled by symmetric designs; doors placed on both sides is not needed
  const w = b.w, d = b.d;
  const ctx: Ctx = { g, rng, b, w, d, front, smoke, blades, lights };
  const kind = b.kind;
  const def = KINDS[kind];
  g.winParams = [3.2, 3, (b.seed % 1000) / 1000];
  // pad / ground plinth so buildings sit on slopes
  const lotC: Record<string, number> = { res: 0x86a35e, informal: 0x9a8a6a, com: 0xb3aea4, off: 0xaaa69e, ind: 0x9a948a };
  const plinthC = C(lotC[def.cat] ?? (def.cat === 'park' || def.cat === 'deathcare' ? 0x6f9a50 : 0xa9a99a));
  g.box(0, -3, 0, w + 0.6, 3.02, d + 0.6, plinthC, 0, { noBottom: true });
  switch (def.cat) {
    case 'res': residential(ctx); break;
    case 'informal': informal(ctx); break;
    case 'com': commercial(ctx); break;
    case 'off': office(ctx); break;
    case 'ind': industry(ctx); break;
    default: publicB(ctx); break;
  }
  if (b.abandoned) {
    const col = g.col;
    for (let i = 0; i < col.length; i += 3) { const l = (col[i] + col[i + 1] + col[i + 2]) / 3; col[i] = col[i] * 0.4 + l * 0.35; col[i + 1] = col[i + 1] * 0.4 + l * 0.33; col[i + 2] = col[i + 2] * 0.4 + l * 0.3; }
    for (let i = 3; i < g.win.length; i += 4) if (g.win[i] > 0 && g.win[i] < 6) g.win[i] = 5;
  }
  return { geo: g.toGeometry(), smoke: toWorld(b, smoke), blades: toWorldBlades(b, blades), lights: toWorld(b, lights) };
}

interface Ctx { g: GB; rng: RNG; b: BuildingView; w: number; d: number; front: number; smoke: number[]; blades: number[]; lights: number[] }

function toWorld(b: BuildingView, arr: number[]): number[] {
  const out: number[] = [];
  const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
  for (let i = 0; i < arr.length; i += 3) out.push(b.x + arr[i] * ca - arr[i + 2] * sa, b.y + arr[i + 1], b.z + arr[i] * sa + arr[i + 2] * ca);
  return out;
}
function toWorldBlades(b: BuildingView, arr: number[]): number[] {
  const out: number[] = [];
  const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
  for (let i = 0; i < arr.length; i += 4) out.push(b.x + arr[i] * ca - arr[i + 2] * sa, b.y + arr[i + 1], b.z + arr[i] * sa + arr[i + 2] * ca, arr[i + 3]);
  return out;
}

function wallColor(c: Ctx): THREE.Color {
  const { b, rng } = c;
  if (b.heritage || b.era === 0) return pick(rng, PAL.vilaWalls);
  if (b.era === 1) return rng.chance(0.3) ? pick(rng, PAL.brick) : pick(rng, PAL.concrete);
  return rng.chance(0.15) ? pick(rng, PAL.vilaWalls) : pick(rng, PAL.modern);
}

// ---------------- residential ----------------
function residential(c: Ctx) {
  const { g, rng, b, w, d } = c;
  const L = b.level;
  const wall = wallColor(c);
  if (L <= 2) {
    const fl = b.floors;
    const hw = Math.min(w - 2, rng.range(7, 10) * (b.wealth === 2 ? 1.4 : 1));
    const hd = Math.min(d - 4, rng.range(6.5, 9) * (b.wealth === 2 ? 1.25 : 1));
    const ox = rng.range(-(w - hw) / 2 + 1, (w - hw) / 2 - 1) * 0.6;
    const oz = -d / 2 + hd / 2 + rng.range(2, 4) * (b.wealth === 2 ? 1.5 : 1);
    const h = fl * 3;
    g.winParams = [3, 2.6, g.winParams[2]];
    g.box(ox, 0, oz, hw, h, hd, wall, 1);
    const roofC = b.era >= 2 && rng.chance(0.4) ? C(0x5d6266) : pick(rng, PAL.terracotta);
    if (b.era >= 2 && rng.chance(0.35)) {
      g.box(ox, h, oz, hw + 0.4, 0.4, hd + 0.4, C(0xe0e0e0));
    } else if (rng.chance(0.5)) g.gable(ox, h, oz, hw + 0.8, hd + 0.8, rng.range(1.6, 2.6), roofC, wall);
    else { g.setRot(c, 0); g.pyramidRoof(ox, h, oz, hw + 0.8, hd + 0.8, rng.range(1.5, 2.3), roofC); }
    // door
    g.box(ox + rng.range(-hw / 4, hw / 4), 0, oz - hd / 2 - 0.05, 1.1, 2.1, 0.12, C(0x6b4a2f));
    if (rng.chance(0.35)) g.box(ox + hw / 3, h, oz + hd / 4, 0.6, 2.4, 0.6, C(0x8a6b55));
    // yard: fence + clothesline + garage/pool
    const fenceC = rng.chance(0.5) ? C(0xf0f0ea) : C(0x8a6b55);
    g.box(0, 0, -d / 2 + 0.1, w - 0.4, 0.9, 0.12, fenceC);
    g.box(-w / 2 + 0.1, 0, 0, 0.12, 0.9, d - 0.4, fenceC);
    g.box(w / 2 - 0.1, 0, 0, 0.12, 0.9, d - 0.4, fenceC);
    g.flat(0, 0.06, d / 4, w - 1, d / 2 - 1, C(b.wealth === 0 ? 0x9a9a6a : 0x86b063));
    if (b.wealth === 0 && rng.chance(0.75)) {
      // varal: clothesline with colorful clothes
      const zc = d / 2 - 3;
      g.box(-w / 3, 0, zc, 0.1, 1.9, 0.1, C(0x666666));
      g.box(w / 3, 0, zc, 0.1, 1.9, 0.1, C(0x666666));
      g.box(0, 1.8, zc, (w * 2) / 3, 0.03, 0.03, C(0x444444));
      for (let i = 0; i < 4; i++) g.box(-w / 4 + (i * w) / 6, 1.15, zc, 0.7, 0.6, 0.04, pick(rng, PAL.awning));
    }
    if (b.wealth >= 1 && rng.chance(0.6)) g.box(ox + hw / 2 + 1.8, 0, oz, 3.2, 2.4, 5.5, wall.clone().multiplyScalar(0.92));
    if (b.wealth === 2) {
      g.flat(rng.range(-2, 2), 0.1, d / 2 - 4, Math.min(8, w - 3), 3.6, C(0x3fb7d9));
      g.flat(rng.range(-2, 2), 0.08, d / 2 - 4, Math.min(9, w - 2), 4.6, C(0xe8e0cc));
    }
    if (b.era >= 1 && rng.chance(0.3)) g.box(ox - hw / 4, h + 0.4, oz + hd / 4, 1.2, 1, 1.2, C(0x3a7bc8)); // caixa d'água
    return;
  }
  // apartments / towers
  const fl = b.floors;
  const flH = 3.1;
  const glassy = b.era >= 2 && L >= 4;
  const bw = w - 3, bd = d - 3;
  g.winParams = [flH, glassy ? 1.6 : 2.6, g.winParams[2]];
  let y = 0;
  // podium
  if (L >= 4 || rng.chance(0.4)) {
    g.box(0, 0, 0, bw + 1, 4.2, bd + 1, C(0x8a8c8e), 3);
    y = 4.2;
  }
  const body = glassy ? pick(rng, PAL.glass) : wall;
  const nf = fl - (y > 0 ? 1 : 0);
  if (L === 5 && b.era >= 2) {
    // tower with setbacks and crown
    const tiers = rng.int(1, 3);
    let tw = bw, td = bd, rem = nf;
    for (let t = 0; t < tiers; t++) {
      const n = t === tiers - 1 ? rem : Math.floor(rem * rng.range(0.45, 0.65));
      g.box(0, y, 0, tw, n * flH, td, body, 2);
      if (t === 0 && rng.chance(0.5)) bands(g, y, n, flH, tw, td, C(0xeeeeee));
      y += n * flH; rem -= n;
      tw *= 0.78; td *= 0.78;
      if (rem <= 0) break;
    }
    crown(c, y, tw / 0.78, td / 0.78);
  } else {
    g.box(0, y, 0, bw, nf * flH, bd, body, glassy ? 2 : 1);
    if (!glassy) bands(g, y, nf, flH, bw, bd, wall.clone().multiplyScalar(0.85));
    y += nf * flH;
    // parapet + rooftop
    g.box(0, y, 0, bw + 0.3, 0.8, bd + 0.3, C(0xd8d4cc));
    g.box(rng.range(-bw / 4, bw / 4), y, rng.range(-bd / 4, bd / 4), 3, 2.6, 3, C(0xbdb8ae));
    g.box(rng.range(-bw / 3, bw / 3), y, rng.range(-bd / 3, bd / 3), 2.2, 1.6, 2.2, C(0x3a7bc8));
    if (b.era >= 2 && rng.chance(0.4)) for (let i = 0; i < 6; i++) g.box(-bw / 3 + (i % 3) * bw / 3, y + 0.2, -bd / 4 + Math.floor(i / 3) * bd / 2, bw / 4, 0.15, bd / 3.5, C(0x1d2a4a));
  }
}

function bands(g: GB, y0: number, n: number, flH: number, w: number, d: number, col: THREE.Color) {
  // balcony slabs every floor on front/back
  for (let i = 1; i < n; i += 1) {
    g.box(0, y0 + i * flH - 0.15, -d / 2 - 0.5, w * 0.92, 0.25, 1.0, col);
    g.box(0, y0 + i * flH - 0.15, d / 2 + 0.5, w * 0.92, 0.25, 1.0, col);
  }
}

function crown(c: Ctx, y: number, w: number, d: number) {
  const { g, rng, lights } = c;
  const t = rng.int(0, 3);
  if (t === 0) { // spire
    g.cylinder(0, y, 0, 1.2, 0.1, rng.range(14, 28), 6, C(0xcfd6db));
    lights.push(0, y + 20, 0);
  } else if (t === 1) { // pyramid crown
    g.pyramid(0, y, 0, w * 0.8, d * 0.8, rng.range(6, 12), C(0x9fb6c4));
  } else if (t === 2) { // helipad
    g.cylinder(0, y, 0, Math.min(w, d) * 0.38, Math.min(w, d) * 0.38, 0.5, 12, C(0x444a50));
    g.flat(0, y + 0.55, 0, 3, 0.6, C(0xffffff)); g.flat(-1.2, y + 0.55, 0, 0.5, 3, C(0xffffff)); g.flat(1.2, y + 0.55, 0, 0.5, 3, C(0xffffff));
    lights.push(Math.min(w, d) * 0.35, y + 0.8, 0);
  } else { // LED crown band
    g.winParams = [1.5, 1.5, g.winParams[2]];
    g.box(0, y, 0, w * 0.9, 3, d * 0.9, C(0x9fd0ff), 6);
    g.box(0, y + 3, 0, 1, 10, 1, C(0xbbbbbb));
    lights.push(0, y + 13, 0);
  }
}

function informal(c: Ctx) {
  const { g, rng, b, w, d } = c;
  const fl = b.floors;
  const col = pick(rng, PAL.informal);
  g.winParams = [2.7, 2.2, g.winParams[2]];
  g.box(0, 0, 0, w * 0.92, fl * 2.7, d * 0.9, col, 1);
  g.box(0, fl * 2.7, 0, w * 0.95, 0.25, d * 0.95, C(0x9a9a92));
  if (rng.chance(0.7)) g.box(rng.range(-1, 1), fl * 2.7 + 0.25, rng.range(-1, 1), 1.2, 1, 1.2, C(0x2f6fd0)); // caixa d'água azul
  if (rng.chance(0.4)) for (let i = 0; i < 4; i++) g.box(-w / 3 + i * w / 4.5, fl * 2.7 + 0.25, d / 3, 0.08, 1.2, 0.08, C(0x6a5040)); // rebar for the next floor
  if (rng.chance(0.4)) g.box(0, fl * 2.7 + 0.25, 0, w * 0.6, 0.06, d * 0.5, pick(rng, PAL.awning)); // laje / lona
}

// ---------------- commercial ----------------
function commercial(c: Ctx) {
  const { g, rng, b, w, d } = c;
  const kind = b.kind;
  const wall = wallColor(c);
  if (kind === 'mall') {
    g.box(0, 0, d * 0.12, w - 4, 11, d * 0.6, C(0xe9e5dc), 3);
    g.box(0, 0, -d * 0.2, w * 0.25, 13, 6, C(0x7fa9c2), 2);
    g.box(0, 13, -d * 0.2, w * 0.27, 2.6, 6.5, pick(rng, PAL.awning), 6);
    g.flat(0, 0.08, -d * 0.36, w - 4, d * 0.24, C(0x5b5e62));
    for (let i = 0; i < 18; i++) g.box(-w / 2 + 5 + (i % 9) * (w - 10) / 9, 0.1, -d * 0.42 + Math.floor(i / 9) * 6, 2, 1.3, 4, pick(rng, [0xcc3333, 0xeeeeee, 0x3355aa, 0x222222, 0x999999]));
    return;
  }
  if (kind === 'hotel') {
    const fl = b.floors;
    g.box(0, 0, 0, w - 2, 5, d - 2, C(0x99a3a8), 3);
    g.winParams = [3.1, 2.4, g.winParams[2]];
    g.box(0, 5, d * 0.1, w - 5, fl * 3.1, d * 0.45, b.era >= 2 ? pick(rng, PAL.glass) : wall, b.era >= 2 ? 2 : 1);
    g.box(0, 5 + fl * 3.1, d * 0.1, w * 0.5, 2.5, 1, C(0xffd27a), 6);
    if (rng.chance(0.6)) g.flat(0, 5.1, -d * 0.25, w * 0.5, d * 0.2, C(0x3fb7d9));
    return;
  }
  if (kind === 'restaurant' || kind === 'souvenir' || kind === 'hostel') {
    const h = kind === 'hostel' ? b.floors * 3 : 3.8;
    g.box(0, 0, 0, w - 2, h, d - 3, wall, kind === 'hostel' ? 1 : 3);
    g.gable(0, h, 0, w - 1.4, d - 2.4, 1.6, pick(rng, PAL.terracotta), wall);
    awning(g, rng, w - 2, -(d - 3) / 2, 2.4);
    if (kind === 'restaurant') for (let i = 0; i < 3; i++) { g.cylinder(-w / 3 + i * w / 3, 0, -d / 2 + 1.2, 0.5, 0.5, 0.8, 6, C(0xf0f0f0)); g.cylinder(-w / 3 + i * w / 3, 0.8, -d / 2 + 1.2, 0.05, 1.1, 1.4, 6, pick(rng, PAL.awning), 0, false); }
    if (kind === 'souvenir') g.box(0, h + 1.5, -(d - 3) / 2, w * 0.6, 1, 0.3, C(0xff7ac0), 6);
    return;
  }
  // zoned commercial
  const L = b.level;
  if (L <= 2) {
    const h1 = 4;
    g.box(0, 0, 0, w - 2, h1, d - 3, wall, 3);
    awning(g, rng, w - 2, -(d - 3) / 2, 2.8);
    g.box(0, h1 - 0.2, -(d - 3) / 2 - 0.3, w * 0.6, 1.1, 0.25, pick(rng, PAL.awning), 6); // sign
    let y = h1;
    if (L === 2) { g.winParams = [3, 2.6, g.winParams[2]]; g.box(0, y, 0.5, w - 2.6, 3, d - 4, wall.clone().multiplyScalar(0.95), 1); y += 3; }
    if (b.era === 0) g.gable(0, y, 0, w - 1.2, d - 2.2, 1.8, pick(rng, PAL.terracotta), wall);
    else g.box(0, y, 0, w - 1.6, 0.7, d - 2.6, C(0xdedad0));
    return;
  }
  const fl = b.floors;
  g.box(0, 0, 0, w - 1.5, 4.5, d - 1.5, C(0x6f7f8a), 3);
  awning(g, rng, w - 1.5, -(d - 1.5) / 2, 3.4);
  g.winParams = [3.4, 2, g.winParams[2]];
  const glassy = b.era >= 2;
  g.box(0, 4.5, 0, w - 2.5, (fl - 1) * 3.4, d - 2.5, glassy ? pick(rng, PAL.glass) : wall, glassy ? 2 : 1);
  const top = 4.5 + (fl - 1) * 3.4;
  g.box(0, top, 0, w - 2, 0.8, d - 2, C(0xd0d0d0));
  g.box(0, top + 0.8, -(d - 2.5) / 2, w * 0.5, 1.6, 0.4, pick(rng, PAL.awning), 6);
}

function awning(g: GB, rng: RNG, w: number, z: number, y: number) {
  const col = pick(rng, PAL.awning);
  g.box(0, y, z - 0.9, w * 0.9, 0.18, 1.8, col);
}

// ---------------- offices ----------------
function office(c: Ctx) {
  const { g, rng, b, w, d } = c;
  if (b.kind === 'techPark') {
    const n = rng.int(2, 3);
    for (let i = 0; i < n; i++) {
      const bw = w / n - 3, bh = b.floors * 3.8 * rng.range(0.7, 1);
      g.winParams = [3.8, 1.5, g.winParams[2]];
      g.box(-w / 2 + (i + 0.5) * (w / n), 0, rng.range(-3, 3), bw, bh, d * 0.55, pick(rng, PAL.glass), 2);
      g.flat(-w / 2 + (i + 0.5) * (w / n), bh + 0.05, 0, bw * 0.8, d * 0.4, C(0x6aa84f)); // green roof
    }
    g.flat(0, 0.06, -d * 0.38, w - 2, d * 0.16, C(0x7cb85a));
    return;
  }
  const fl = b.floors;
  const flH = 3.8;
  const glassy = b.era >= 2 || fl > 10;
  const body = glassy ? pick(rng, PAL.glass) : pick(rng, PAL.concrete);
  g.winParams = [flH, glassy ? 1.5 : 2.2, g.winParams[2]];
  const bw = w - 3, bd = d - 3;
  g.box(0, 0, 0, bw + 1, 5, bd + 1, C(0x3e4a52), 3);
  let y = 5;
  const n = fl - 1;
  const shape = rng.int(0, 2);
  if (shape === 0 || fl < 8) {
    g.box(0, y, 0, bw, n * flH, bd, body, glassy ? 2 : 1);
    y += n * flH;
  } else if (shape === 1) {
    // twisted/stacked slabs
    let rem = n, k = 0;
    while (rem > 0) {
      const s = Math.min(rem, rng.int(3, 6));
      const off = (k % 2 === 0 ? 1 : -1) * rng.range(0, 1.5);
      g.box(off, y, -off, bw * (1 - k * 0.04), s * flH, bd * (1 - k * 0.04), body, 2);
      y += s * flH; rem -= s; k++;
    }
  } else {
    g.cylinder(0, y, 0, Math.min(bw, bd) / 2, Math.min(bw, bd) / 2.3, n * flH, 10, body, 2);
    y += n * flH;
  }
  if (fl >= 10) crown(c, y, bw * 0.8, bd * 0.8);
  else g.box(0, y, 0, bw * 0.4, 3, bd * 0.4, C(0xb8b8b8));
}

// ---------------- industry ----------------
function industry(c: Ctx) {
  const { g, rng, b, w, d, smoke } = c;
  const kind = b.kind;
  if (kind === 'farm') {
    const rows = rng.int(3, 6);
    const cropC = [0xc9b458, 0x8fae4a, 0x6d9a3f, 0xb58b4a, 0xa7c25a];
    for (let i = 0; i < rows; i++) {
      const cc = C(cropC[(i + b.seed) % cropC.length]);
      g.flat(0, 0.1, -d / 2 + (i + 0.5) * (d / rows), w - 4, d / rows - 2, cc);
      for (let k = 0; k < 6; k++) g.flat(0, 0.13, -d / 2 + (i + 0.5) * (d / rows) - d / rows / 2 + (k + 0.5) * (d / rows / 6), w - 6, 0.6, cc.clone().multiplyScalar(0.8));
    }
    g.box(w / 2 - 12, 0, -d / 2 + 9, 12, 5, 8, C(0xa83a2c));
    g.gable(w / 2 - 12, 5, -d / 2 + 9, 12.6, 8.6, 3, C(0x5a5a5a), C(0xa83a2c));
    g.cylinder(w / 2 - 3, 0, -d / 2 + 6, 2.2, 2.2, 10, 8, C(0xd8d8d8));
    g.cylinder(w / 2 - 3, 10, -d / 2 + 6, 2.2, 0.2, 1.8, 8, C(0x999999));
    return;
  }
  if (kind === 'mine') {
    for (let i = 0; i < 4; i++) g.flat(0, 0.15 - i * 0.02, 0, w - 8 - i * 12, d - 8 - i * 12, C([0x8a7a62, 0x7a6a52, 0x6a5a45, 0x5a4a38][i]));
    g.box(-w / 3, 0, -d / 3, 3, 22, 3, C(0x444444));
    g.box(-w / 3, 22, -d / 3, 6, 3, 4, C(0x7a3a2a));
    g.box(0, 3, -d / 3, w / 1.8, 1, 1.4, C(0x555555));
    g.pyramid(w / 4, 0, d / 4, 18, 18, 9, C(0x3d3a36));
    smoke.push(w / 4, 6, d / 4);
    return;
  }
  const wall = b.era >= 2 ? C(0xd6d9dc) : pick(rng, [0xb9b2a4, 0xa69c8c, 0xc4bcae, 0x8f9aa3]);
  if (kind === 'warehouse') {
    g.winParams = [6, 8, g.winParams[2]];
    g.box(0, 0, 0, w - 4, 9, d - 6, wall, 4);
    g.box(0, 9, 0, w - 3.4, 0.6, d - 5.4, C(0x8c8c8c));
    for (let i = 0; i < 5; i++) g.box(-w / 2 + 6 + i * (w - 12) / 4, 0, -(d - 6) / 2 - 0.2, 3.5, 4, 0.3, C(0x5a6a7a));
    for (let i = 0; i < 2; i++) truck(g, -w / 4 + i * w / 2, -(d - 6) / 2 - 7, rng);
    return;
  }
  // factories: sawtooth roofs + chimneys + tanks
  const bw = w * 0.62, bd = d * 0.7;
  const h = kind === 'steelMill' ? 14 : 8;
  g.winParams = [6, 5, g.winParams[2]];
  g.box(-w * 0.15, 0, 0, bw, h, bd, wall, 4);
  const teeth = Math.max(3, Math.floor(bd / 6));
  for (let i = 0; i < teeth; i++) {
    const z = -bd / 2 + (i + 0.5) * (bd / teeth);
    g.gable(-w * 0.15, h, z, bw, bd / teeth, 2.6, C(0x8f8f88), C(0xbfd5e0));
  }
  const nCh = kind === 'steelMill' ? 3 : kind === 'factory' ? 2 : 1;
  for (let i = 0; i < nCh; i++) {
    const x = w * 0.28, z = -d / 3 + i * (d / 3);
    const hh = kind === 'steelMill' ? 42 : 28;
    g.cylinder(x, 0, z, 1.8, 1.2, hh * 0.8, 8, C(0xc8c2b8));
    g.cylinder(x, hh * 0.8, z, 1.2, 1.1, hh * 0.2, 8, C(0xc23a2a));
    smoke.push(x, hh + 1, z);
  }
  if (kind === 'steelMill') {
    g.cylinder(-w * 0.15, h, -bd / 4, 5, 3, 16, 10, C(0x5c4a3a));
    smoke.push(-w * 0.15, h + 16, -bd / 4);
  }
  if (kind === 'foodPlant' || kind === 'factory') for (let i = 0; i < 3; i++) g.cylinder(w * 0.38, 0, d * 0.2 + i * 5 - 5, 2, 2, 11, 8, C(0xe0e0e0));
  truck(g, -w * 0.15, -bd / 2 - 7, rng);
}

function truck(g: GB, x: number, z: number, rng: RNG) {
  g.box(x, 0.4, z, 2.4, 2.6, 7, pick(rng, [0xdddddd, 0x3a6ea5, 0xc94a3a, 0x4a8a4a]));
  g.box(x, 0.4, z - 4.2, 2.4, 2.2, 1.8, C(0x333a44));
}

// ---------------- public / utilities / landmarks ----------------
function publicB(c: Ctx) {
  const { g, rng, b, w, d, smoke, blades, lights } = c;
  const W = C(0xf2f0ea), grass = C(0x6fa451), path = C(0xd8ceb4);
  g.winParams = [3.4, 3, g.winParams[2]];
  switch (b.kind) {
    case 'well':
      g.cylinder(0, 0, 0, 1.6, 1.6, 1, 10, C(0x9a9288));
      g.box(-1.4, 1, 0, 0.2, 2, 0.2, C(0x6b4a2f)); g.box(1.4, 1, 0, 0.2, 2, 0.2, C(0x6b4a2f));
      g.gable(0, 3, 0, 3.6, 2.4, 1, C(0xa8492b));
      break;
    case 'dieselGen':
      g.box(0, 0, 0, 6, 3, 4, C(0x5f7a4a)); g.cylinder(2, 3, 1, 0.3, 0.3, 2.5, 6, C(0x333333)); smoke.push(2, 5.6, 1);
      g.box(-2, 0, -1.5, 2, 2, 1.5, C(0x888888));
      break;
    case 'thermalPlant': case 'nuclearPlant': {
      const nuke = b.kind === 'nuclearPlant';
      g.box(-w * 0.2, 0, -d * 0.15, w * 0.45, 16, d * 0.4, C(0xcfd2d4), 4);
      const towers = nuke ? 2 : 2;
      for (let i = 0; i < towers; i++) {
        const tx = w * 0.22, tz = -d * 0.25 + i * d * 0.45, R = nuke ? 13 : 10;
        g.lathe(tx, 0, tz, [[R, 0], [R * 0.75, 16], [R * 0.62, 28], [R * 0.7, 38]], 14, C(0xd9d6d0));
        smoke.push(tx, 40, tz);
      }
      if (nuke) { g.cylinder(-w * 0.25, 0, d * 0.25, 9, 9, 10, 14, C(0xe8e8e8)); g.lathe(-w * 0.25, 10, d * 0.25, [[9, 0], [7, 4], [4, 7], [0.1, 8.5]], 14, C(0xe8e8e8)); }
      else { g.cylinder(-w * 0.35, 0, d * 0.3, 2.5, 1.8, 55, 8, C(0xb34a3a)); smoke.push(-w * 0.35, 56, d * 0.3); }
      break;
    }
    case 'hydroPlant':
      g.box(0, 0, 0, w - 4, 12, d * 0.5, C(0xc9c4ba), 4);
      for (let i = 0; i < 3; i++) g.cylinder(-w / 3 + i * w / 3, 12, d * 0.25, 1.4, 1.4, 1, 8, C(0x6a6a6a));
      g.box(0, 0, d * 0.35, w, 18, 4, C(0xb0aaa0));
      break;
    case 'windFarm': {
      const n = 5;
      for (let i = 0; i < n; i++) {
        const tx = -w / 2 + 12 + ((i * 37) % (w - 24)), tz = -d / 2 + 12 + ((i * 53) % (d - 24));
        g.cylinder(tx, 0, tz, 1.3, 0.7, 48, 8, C(0xf4f4f4));
        g.box(tx, 48, tz, 2, 2, 5, C(0xeeeeee));
        blades.push(tx, 49, tz - 2.8, 20);
      }
      break;
    }
    case 'solarFarm':
      for (let i = 0; i < 6; i++) for (let k = 0; k < 4; k++) {
        const px = -w / 2 + 8 + i * (w - 16) / 5, pz = -d / 2 + 8 + k * (d - 16) / 3;
        g.box(px, 1, pz, (w - 16) / 6.5, 0.2, 7, C(0x1f2d55));
        g.box(px, 0, pz, 0.3, 1, 0.3, C(0x888888));
      }
      break;
    case 'waterPump':
      g.box(0, 0, 0, 10, 5, 8, C(0xd8d2c4), 1); g.gable(0, 5, 0, 10.6, 8.6, 2, C(0x3a6a8a));
      g.cylinder(4, 0, 5, 1.2, 1.2, 1.2, 8, C(0x4a7aa0));
      break;
    case 'waterTreatment': case 'sewagePlant': {
      const water = b.kind === 'waterTreatment' ? C(0x4aa3c8) : C(0x7a7a4a);
      for (let i = 0; i < 4; i++) {
        const tx = -w / 3 + (i % 2) * w / 3, tz = -d / 4 + Math.floor(i / 2) * d / 2.2;
        g.cylinder(tx, 0, tz, 8, 8, 2.5, 16, C(0xcdc8bd));
        g.cylinder(tx, 2.5, tz, 7.5, 7.5, 0.05, 16, water);
      }
      g.box(w / 3, 0, 0, 10, 6, 14, C(0xe0dccf), 1);
      break;
    }
    case 'waterTower':
      for (const [lx, lz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) g.box(lx, 0, lz, 0.4, 16, 0.4, C(0x8a8a8a));
      g.cylinder(0, 16, 0, 4, 4, 5, 12, C(0x5a8ab5));
      g.cylinder(0, 21, 0, 4, 0.5, 2, 12, C(0x4a7aa5));
      lights.push(0, 23.5, 0);
      break;
    case 'dump':
      for (let i = 0; i < 9; i++) g.pyramid(rng.range(-w / 3, w / 3), 0, rng.range(-d / 3, d / 3), rng.range(14, 26), rng.range(14, 26), rng.range(3, 8), C(pick(rng, [0x7a6a52, 0x8a7a60, 0x6a6a5a, 0x9a8a6a, 0x5a7a5a]).getHex()));
      for (let i = 0; i < 20; i++) g.box(rng.range(-w / 2.5, w / 2.5), 0, rng.range(-d / 2.5, d / 2.5), 1.2, 0.8, 1, pick(rng, PAL.awning));
      smoke.push(0, 4, 0);
      break;
    case 'landfill':
      g.lathe(0, 0, 0, [[Math.min(w, d) / 2 - 4, 0], [Math.min(w, d) / 2.6, 6], [Math.min(w, d) / 4, 11], [0.1, 12]], 12, C(0x7a9a5a));
      g.box(w / 2 - 8, 0, -d / 2 + 6, 8, 3, 6, C(0xcccccc));
      break;
    case 'recycling':
      g.box(0, 0, 0, w - 8, 10, d - 10, C(0x5aa04a), 4);
      for (let i = 0; i < 4; i++) g.box(-w / 2 + 6 + i * 4, 0, -d / 2 + 3, 3, 2, 2.4, C([0x2f6fd0, 0xd94a3d, 0xe5c84a, 0x2f8f6a][i]));
      break;
    case 'incinerator':
      g.box(-4, 0, 0, w - 14, 14, d - 10, C(0x9aa0a6), 4);
      g.cylinder(w / 2 - 6, 0, 0, 2.4, 1.8, 50, 10, C(0xd8d8d8));
      smoke.push(w / 2 - 6, 51, 0);
      break;
    case 'clinic':
      g.box(0, 0, 0, w - 3, 4, d - 4, W, 1);
      g.box(0, 4, 0, 4, 0.3, 1.2, C(0xd92b2b)); g.box(0, 4, 0, 1.2, 0.3, 4, C(0xd92b2b));
      g.box(0, 2.5, -(d - 4) / 2 - 0.1, 3, 1, 0.2, C(0xd92b2b), 6);
      break;
    case 'hospital': {
      const fl = b.floors;
      g.box(0, 0, 0, w - 4, 5, d - 4, C(0xdfe7ea), 3);
      g.box(-w * 0.15, 5, 0, w * 0.5, fl * 3.4, d * 0.45, W, 1);
      g.box(w * 0.25, 5, -d * 0.1, w * 0.25, (fl - 2) * 3.4, d * 0.6, W, 1);
      const top = 5 + fl * 3.4;
      g.cylinder(-w * 0.15, top, 0, 6, 6, 0.4, 12, C(0x3a8a4a));
      g.flat(-w * 0.15 - 1.2, top + 0.45, 0, 0.6, 4, C(0xffffff)); g.flat(-w * 0.15 + 1.2, top + 0.45, 0, 0.6, 4, C(0xffffff)); g.flat(-w * 0.15, top + 0.45, 0, 2, 0.6, C(0xffffff));
      g.box(w * 0.25, 5 + (fl - 2) * 3.4, -d * 0.4, 6, 2, 0.4, C(0xd92b2b), 6);
      break;
    }
    case 'daycare':
      g.box(0, 0, 0.5, w - 4, 3.5, d * 0.5, C(0xffe08a), 1);
      g.gable(0, 3.5, 0.5, w - 3.4, d * 0.5 + 0.6, 1.6, C(0x4a9ae0));
      g.flat(0, 0.07, -d * 0.3, w - 4, d * 0.3, C(0x5ac06a));
      g.box(-3, 0, -d * 0.3, 0.2, 2, 2, C(0xe04a4a)); g.box(2, 0, -d * 0.3, 2, 1, 2, C(0x4ac0e0));
      break;
    case 'school': case 'highSchool': {
      const fl = b.floors;
      const wc = b.kind === 'school' ? C(0xf0e2c0) : C(0xe0d8c8);
      g.box(-w * 0.1, 0, d * 0.2, w * 0.75, fl * 3.4, d * 0.35, wc, 1);
      g.box(w * 0.3, 0, -d * 0.05, w * 0.25, fl * 3.4, d * 0.6, wc, 1);
      g.flat(-w * 0.12, 0.07, -d * 0.22, w * 0.5, d * 0.36, C(0x3a7ac0));
      g.flat(-w * 0.12, 0.08, -d * 0.22, w * 0.48, 0.25, C(0xffffff));
      g.box(-w * 0.12 - w * 0.22, 0, -d * 0.22, 0.2, 3, 0.2, C(0xffffff)); g.box(-w * 0.12 + w * 0.22, 0, -d * 0.22, 0.2, 3, 0.2, C(0xffffff));
      g.cylinder(-w * 0.4, fl * 3.4, d * 0.2, 0.1, 0.1, 5, 4, C(0xdddddd)); g.box(-w * 0.4 + 0.8, fl * 3.4 + 3.8, d * 0.2, 1.6, 1, 0.05, C(0x2f9a4a));
      break;
    }
    case 'university': {
      g.flat(0, 0.07, 0, w - 6, d - 6, grass);
      g.flat(0, 0.09, 0, w - 8, 3, path); g.flat(0, 0.09, 0, 3, d - 8, path);
      for (let i = 0; i < 4; i++) {
        const bx = (i % 2 === 0 ? -1 : 1) * w * 0.27, bz = (i < 2 ? -1 : 1) * d * 0.25;
        g.box(bx, 0, bz, w * 0.32, b.floors * 3.6, d * 0.3, pick(rng, [0xb86e4e, 0xe0d8c8, 0xc9c4ba]), 1);
      }
      g.box(0, 0, 0, 5, 26, 5, C(0xb86e4e)); g.pyramid(0, 26, 0, 6, 6, 6, C(0x3a5a4a));
      lights.push(0, 22, -2.6);
      break;
    }
    case 'library':
      g.box(0, 0, 2, w - 4, 8, d - 8, C(0xe8e0cc), 1);
      for (let i = 0; i < 6; i++) g.cylinder(-w / 2 + 4 + i * (w - 8) / 5, 0, -(d - 8) / 2 + 1, 0.6, 0.6, 7, 8, C(0xf5f0e5));
      g.box(0, 7, -(d - 8) / 2 + 1, w - 6, 1.4, 2.4, C(0xf5f0e5));
      break;
    case 'police':
      g.box(0, 0, 0, w - 4, 7, d - 5, W, 1);
      g.box(0, 3, -(d - 5) / 2 - 0.05, w - 4, 1, 0.1, C(0x2a4fa0));
      g.box(w / 3, 7, 0, 1, 1, 1, C(0x2a6aff), 6);
      g.flat(0, 0.07, -d / 2 + 2, w - 4, 3, C(0x555a60));
      break;
    case 'prison':
      g.box(0, 0, -d / 2 + 1, w, 6, 1, C(0x9a9a92)); g.box(0, 0, d / 2 - 1, w, 6, 1, C(0x9a9a92));
      g.box(-w / 2 + 1, 0, 0, 1, 6, d, C(0x9a9a92)); g.box(w / 2 - 1, 0, 0, 1, 6, d, C(0x9a9a92));
      for (const [tx, tz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { g.box(tx * (w / 2 - 2), 0, tz * (d / 2 - 2), 3, 11, 3, C(0x8a8a82)); lights.push(tx * (w / 2 - 2), 11.5, tz * (d / 2 - 2)); }
      for (let i = 0; i < 3; i++) g.box(-w / 4 + i * w / 4, 0, 0, w / 6, 9, d * 0.55, C(0xbab4a8), 4);
      break;
    case 'fire':
      g.box(0, 0, 0, w - 4, 7, d - 5, C(0xc8352b), 1);
      for (let i = 0; i < 3; i++) g.box(-w / 3 + i * w / 3, 0, -(d - 5) / 2 - 0.05, 4, 4.6, 0.1, C(0xeeeeee));
      g.box(w / 2 - 4, 0, d / 4, 3, 16, 3, C(0xc8352b));
      break;
    case 'cemetery': {
      g.flat(0, 0.07, 0, w - 2, d - 2, C(0x5f8f4a));
      g.box(0, 0, -d / 2 + 0.5, w - 2, 1.6, 0.4, C(0xd8d2c4));
      for (let i = 0; i < 70; i++) {
        const tx = -w / 2 + 5 + (i % 10) * (w - 10) / 9, tz = -d / 2 + 6 + Math.floor(i / 10) * (d - 12) / 6;
        g.box(tx, 0, tz, 0.9, 1 + (i % 3) * 0.3, 1.8, C(0xb8b4ac));
        if (i % 9 === 0) g.box(tx, 1.2, tz - 0.6, 0.15, 1.2, 0.15, C(0x8a8680));
      }
      for (let i = 0; i < 10; i++) g.cylinder(-w / 2 + 3, 0, -d / 2 + 4 + i * (d - 8) / 9, 0.9, 0.05, 7, 6, C(0x2f5a37));
      g.box(w / 2 - 8, 0, d / 2 - 8, 6, 5, 7, C(0xf0ece2));
      g.gable(w / 2 - 8, 5, d / 2 - 8, 6.4, 7.4, 2, C(0x8a4a3a));
      break;
    }
    case 'crematorium':
      g.box(0, 0, 0, w - 6, 6, d - 8, C(0xd8d4cc), 1);
      g.cylinder(w / 3, 0, d / 4, 1.2, 1, 16, 8, C(0x9a9a9a));
      smoke.push(w / 3, 16.5, d / 4);
      break;
    case 'park': case 'plaza': {
      const park = b.kind === 'park';
      g.flat(0, 0.07, 0, w - 2, d - 2, park ? grass : C(0xcfc6b0));
      g.flat(0, 0.09, 0, w - 2, 2.4, path); g.flat(0, 0.09, 0, 2.4, d - 2, path);
      if (park) {
        if (rng.chance(0.6)) g.cylinder(w / 4, 0.02, d / 4, Math.min(w, d) / 7, Math.min(w, d) / 7, 0.1, 14, C(0x4aa3c8));
        const nT = Math.floor((w * d) / 120);
        for (let i = 0; i < nT; i++) {
          const tx = rng.range(-w / 2 + 3, w / 2 - 3), tz = rng.range(-d / 2 + 3, d / 2 - 3);
          if (Math.abs(tx) < 3 || Math.abs(tz) < 3) continue;
          g.cylinder(tx, 0, tz, 0.25, 0.25, 2.2, 5, C(0x6b4a2f));
          g.cylinder(tx, 2.2, tz, rng.range(1.6, 2.6), 0.3, rng.range(3, 4.5), 7, pick(rng, [0x4e8a3a, 0x5f9a44, 0x3f7a35, 0xd88ab0, 0xe0c040]));
        }
        g.box(-w / 4, 0, -d / 4, 3, 0.3, 3, C(0xe04a4a)); g.box(-w / 4, 0, -d / 4, 0.2, 2.5, 0.2, C(0x4ac0e0));
      } else {
        g.cylinder(0, 0, 0, 3.5, 3.5, 0.8, 14, C(0xd8d2c4));
        g.cylinder(0, 0.8, 0, 3.1, 3.1, 0.05, 14, C(0x6ab8d8));
        g.cylinder(0, 0.8, 0, 0.4, 0.3, 2.2, 6, C(0xd8d2c4));
        for (const [tx, tz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { g.cylinder(tx * w / 3, 0, tz * d / 3, 0.25, 0.25, 2.4, 5, C(0x6b4a2f)); g.cylinder(tx * w / 3, 2.4, tz * d / 3, 2.4, 0.3, 3.6, 7, C(0x4e8a3a)); }
        g.box(w / 3, 0, -d / 3 + 3, 3, 2.6, 3, C(0x2f8f6a)); g.pyramid(w / 3, 2.6, -d / 3 + 3, 3.6, 3.6, 1.4, C(0xd94a3d)); // banca de jornal
      }
      for (let i = 0; i < 4; i++) g.box(-4 + i * 2.8, 0, 2.2, 1.6, 0.5, 0.5, C(0x7a5a3a)); // bancos
      break;
    }
    case 'sportsCenter':
      g.box(0, 0, d * 0.15, w - 4, 8, d * 0.5, C(0xe0e0e8), 4);
      g.lathe(0, 8, d * 0.15, [[Math.min(w - 4, d * 0.5) / 2, 0], [0.2, 3]], 12, C(0x9ab0c0));
      g.flat(0, 0.07, -d * 0.3, w - 6, d * 0.32, C(0xc0603a));
      g.flat(0, 0.08, -d * 0.3, 0.3, d * 0.32, C(0xffffff));
      break;
    case 'church': {
      const wc = b.era >= 2 ? C(0xf4f2ec) : pick(rng, [0xf3eee2, 0xf1e3c4, 0xe8d8b0]);
      g.box(0, 0, d * 0.08, w * 0.6, 8, d * 0.7, wc, 1);
      g.gable(0, 8, d * 0.08, w * 0.64, d * 0.72, 4, C(0xa8492b), wc);
      g.setRot(c, Math.PI / 2);
      g.box(0, 0, -d * 0.32, 4.4, 15, 4.4, wc, 1);
      g.pyramid(0, 15, -d * 0.32, 4.8, 4.8, 5, C(0xa8492b));
      g.box(0, 20, -d * 0.32, 0.2, 2.2, 0.2, C(0x444444)); g.box(0, 21.2, -d * 0.32, 1.2, 0.2, 0.2, C(0x444444));
      break;
    }
    case 'cinema':
      g.box(0, 0, 2, w - 4, 10, d - 6, C(0x3a3a4a), 0);
      g.box(0, 4, -(d - 6) / 2 + 1.5, w - 3, 2.5, 1, C(0xffd27a), 6);
      g.box(0, 6.5, -(d - 6) / 2 + 1.5, w * 0.5, 2.4, 0.4, C(0xff4a6a), 6);
      break;
    case 'theater':
      g.box(0, 0, 3, w - 4, 14, d - 8, C(0xe8dcc6), 1);
      for (let i = 0; i < 8; i++) g.cylinder(-w / 2 + 3 + i * (w - 6) / 7, 0, -(d - 8) / 2 + 1.5, 0.7, 0.7, 11, 8, C(0xf5efe2));
      g.gable(0, 11, -(d - 8) / 2 + 1.5, w - 4, 3.6, 3, C(0xf5efe2));
      g.lathe(0, 14, 5, [[8, 0], [6, 3], [3, 5], [0.1, 6]], 14, C(0x6a9a8a));
      break;
    case 'museum':
      g.setRot(c, 0.3);
      g.box(0, 0, 0, w * 0.6, 12, d * 0.5, C(0xf4f4f2), 0);
      g.setRot(c, -0.4);
      g.box(w * 0.15, 4, d * 0.1, w * 0.45, 10, d * 0.35, C(0xc9a46a), 0);
      g.setRot(c, 0);
      g.cylinder(-w * 0.3, 0, -d * 0.25, 5, 7, 9, 12, C(0x8fb2c0), 2);
      break;
    case 'stadium': {
      const R = Math.min(w, d) / 2 - 3;
      g.setRot(c, 0);
      g.flat(0, 0.12, 0, R * 1.0, R * 0.62, C(0x3f9a3f));
      for (let i = 0; i < 5; i++) g.flat(-R * 0.4 + i * R * 0.2, 0.13, 0, R * 0.1, R * 0.62, C(0x4aaa4a));
      g.lathe(0, 0, 0, [[R * 0.8, 0], [R * 0.86, 4], [R * 0.96, 14], [R, 18]], 24, C(0xcfd4d8));
      g.lathe(0, 18, 0, [[R * 1.02, 0], [R * 0.82, 1.5]], 24, C(0xf2f2f2));
      for (const [tx, tz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { g.box(tx * R * 0.85, 0, tz * R * 0.75, 1, 30, 1, C(0x888888)); lights.push(tx * R * 0.85, 30.5, tz * R * 0.75); }
      break;
    }
    case 'postOffice':
      g.box(0, 0, 0, w - 4, 5, d - 4, C(0xf0d040), 1);
      g.box(0, 3.2, -(d - 4) / 2 - 0.1, w - 4, 1, 0.15, C(0x2a4a9a));
      break;
    case 'busDepot':
      g.box(0, 0, d * 0.15, w - 4, 7, d * 0.5, C(0xc0c4c8), 4);
      g.flat(0, 0.07, -d * 0.25, w - 4, d * 0.4, C(0x5a5e62));
      for (let i = 0; i < 4; i++) g.box(-w / 3 + i * w / 4.5, 0.3, -d * 0.25, 2.5, 3, 11, C(0xe0a020));
      break;
    case 'railStation': {
      g.box(0, 0, d * 0.25, w * 0.4, 9, d * 0.45, C(0xd8c8a8), 1);
      g.gable(0, 9, d * 0.25, w * 0.42, d * 0.47, 3, C(0x7a3a2a));
      g.box(0, 9, d * 0.25 - d * 0.23, 2.4, 2.4, 0.3, C(0xffffff), 6);
      g.box(0, 0, -d * 0.1, w - 2, 1.1, d * 0.3, C(0xb8b2a6));
      for (let i = 0; i < 8; i++) g.box(-w / 2 + 4 + i * (w - 8) / 7, 1.1, -d * 0.1, 0.25, 4, 0.25, C(0x555555));
      g.box(0, 5.1, -d * 0.1, w - 2, 0.3, d * 0.34, C(0x6a7a8a));
      break;
    }
    case 'freightTerminal':
      g.flat(0, 0.08, 0, w - 2, d - 2, C(0x8a8478));
      for (let i = 0; i < 24; i++) {
        const tx = -w / 2 + 8 + (i % 8) * (w - 16) / 7, tz = -d / 4 + Math.floor(i / 8) * 3;
        const stack = rng.int(1, 3);
        for (let s = 0; s < stack; s++) g.box(tx, s * 2.6, tz, 6, 2.5, 2.4, pick(rng, [0xc94a3a, 0x3a6ea5, 0xe0a020, 0x4a8a4a, 0x8a4ab0, 0xdddddd]));
      }
      g.box(-w / 4, 0, d / 4 - 4, 1, 16, 1, C(0xe0a020)); g.box(w / 4, 0, d / 4 - 4, 1, 16, 1, C(0xe0a020)); g.box(0, 15, d / 4 - 4, w / 2 + 2, 1.2, 1.2, C(0xe0a020));
      break;
    case 'metroStation':
      g.box(0, 0, 0, w - 6, 4, d - 8, C(0xdedede), 3);
      g.box(0, 4, 0, w - 4, 0.4, d - 6, C(0x4a4a5a));
      g.box(-(w - 6) / 2 - 0.5, 0, -(d - 8) / 2, 0.3, 5.5, 0.3, C(0x555555));
      g.box(-(w - 6) / 2 - 0.5, 5.5, -(d - 8) / 2, 1.6, 1.6, 0.3, C(0xd92b2b), 6);
      break;
    case 'airport': {
      g.flat(0, 0.1, d * 0.2, w - 10, 30, C(0x4a4e52));
      for (let i = 0; i < 20; i++) g.flat(-w / 2 + 20 + i * (w - 40) / 19, 0.12, d * 0.2, 8, 0.8, C(0xffffff));
      g.box(-w * 0.2, 0, -d * 0.25, w * 0.4, 12, d * 0.25, C(0xe0e4e8), 2);
      g.lathe(-w * 0.2, 12, -d * 0.25, [[w * 0.18, 0], [w * 0.1, 4]], 12, C(0xb0c4d0));
      g.cylinder(w * 0.15, 0, -d * 0.2, 2.5, 2, 30, 8, C(0xd8d8d8)); g.cylinder(w * 0.15, 30, -d * 0.2, 4.5, 4, 4, 8, C(0x5a8aa0), 2);
      lights.push(w * 0.15, 35, -d * 0.2);
      for (let i = 0; i < 2; i++) plane(g, -w * 0.3 + i * 40, -d * 0.02);
      break;
    }
    case 'port':
      g.flat(0, 0.1, 0, w - 2, d - 2, C(0x8a8a86));
      for (let i = 0; i < 40; i++) {
        const tx = -w / 2 + 8 + (i % 10) * (w - 16) / 9, tz = -d / 4 + Math.floor(i / 10) * 3;
        for (let s = 0; s < rng.int(1, 4); s++) g.box(tx, s * 2.6, tz, 6, 2.5, 2.4, pick(rng, [0xc94a3a, 0x3a6ea5, 0xe0a020, 0x4a8a4a, 0xdddddd]));
      }
      for (let i = 0; i < 3; i++) { const tx = -w / 3 + i * w / 3; g.box(tx - 4, 0, d / 2 - 6, 1.2, 30, 1.2, C(0xc94a3a)); g.box(tx + 4, 0, d / 2 - 6, 1.2, 30, 1.2, C(0xc94a3a)); g.box(tx, 28, d / 2 - 2, 1.5, 1.5, 30, C(0xc94a3a)); }
      break;
    case 'landmarkTower':
      g.cylinder(0, 0, 0, 6, 3.4, 150, 10, C(0xdfe4e8));
      g.cylinder(0, 130, 0, 9, 9, 8, 14, C(0x7aa6c0), 2);
      g.cylinder(0, 138, 0, 9, 4, 3, 14, C(0xdfe4e8));
      g.cylinder(0, 150, 0, 0.6, 0.1, 30, 6, C(0xc0c0c0));
      lights.push(0, 180, 0, 0, 134, 9);
      break;
    case 'cathedral': {
      // Modern hyperboloid cathedral: ring of curved ribs
      const R = Math.min(w, d) / 2 - 4;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const x0 = Math.cos(a) * R, z0 = Math.sin(a) * R;
        const pts = [[x0, 0], [x0 * 0.55, 10], [x0 * 0.35, 22], [x0 * 0.55, 34]];
        for (let k = 0; k < 3; k++) {
          const [ax, ay] = pts[k], [bx2, by] = pts[k + 1];
          const az = (ax / x0) * z0 || 0, bz2 = (bx2 / x0) * z0 || 0;
          const mx = (ax + bx2) / 2, mz = (az + bz2) / 2;
          g.box(mx, ay, mz, 1.1, by - ay, 1.1, C(0xf4f4f4));
        }
      }
      g.lathe(0, 0, 0, [[R * 0.9, 0], [R * 0.5, 10], [R * 0.33, 22], [R * 0.5, 33]], 16, C(0x7fb0d0));
      g.box(R + 6, 0, 0, 2, 26, 2, C(0xf4f4f4));
      lights.push(0, 34, 0);
      break;
    }
    case 'monument':
      g.box(0, 0, 0, 10, 2, 10, C(0xc8c0b0));
      g.box(0, 2, 0, 3, 3, 3, C(0xd8d0c0));
      g.pyramid(0, 5, 0, 2.4, 2.4, 22, C(0xe8e0d0));
      break;
    default:
      g.box(0, 0, 0, w - 3, 6, d - 3, C(0xd8d4cc), 1);
  }
}

function plane(g: GB, x: number, z: number) {
  g.box(x, 2, z, 3.4, 3.4, 30, C(0xf4f4f4));
  g.box(x, 3.4, z, 32, 0.5, 5, C(0xf4f4f4));
  g.box(x, 4, z + 13, 10, 0.4, 2.5, C(0xf4f4f4));
  g.box(x, 4.4, z + 14, 0.4, 5, 3, C(0x2a6ab0));
}

// extend GB with a couple of helpers used above
declare module './geomBuilder' {
  interface GB {
    setRot(c: Ctx, a: number): void;
    pyramidRoof(cx: number, y0: number, cz: number, w: number, d: number, h: number, col: THREE.Color): void;
  }
}
GB.prototype.setRot = function (this: GB, c: Ctx, a: number) {
  this.setTransform(c.b.x, c.b.y, c.b.z, c.b.angle + a);
};
GB.prototype.pyramidRoof = function (this: GB, cx: number, y0: number, cz: number, w: number, d: number, h: number, col: THREE.Color) {
  this.pyramid(cx, y0, cz, w, d, h, col);
};

/** Window/night-light shader injected into a MeshStandardMaterial. */
export function patchBuildingMaterial(m: THREE.MeshStandardMaterial, U: Record<string, THREE.IUniform>, extra: Record<string, THREE.IUniform> = {}) {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uNight: U.uNight, uLitRes: U.uLitRes, uLitOff: U.uLitOff, uOutage: U.uOutage, uMapSize: U.uMapSize, uTime: U.uTime, uSnow: U.uSnow }, extra);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aWin; varying vec4 vWin; varying vec2 vUvM; varying vec3 vWP; varying vec3 vNrm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vWin = aWin; vUvM = uv; vNrm = normal;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vWin; varying vec2 vUvM; varying vec3 vWP; varying vec3 vNrm;
        uniform float uNight; uniform float uLitRes; uniform float uLitOff; uniform sampler2D uOutage; uniform float uMapSize; uniform float uTime; uniform float uSnow;
        ${'#ifdef USE_BOOST\nuniform float uLitBoost;\n#endif'}
        float h21(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }
        vec3 winEmis; `)
      .replace('#include <color_fragment>', `#include <color_fragment>
        winEmis = vec3(0.0);
        float wt = vWin.w;
        if (wt > 0.5) {
          float out_ = texture2D(uOutage, vWP.xz / uMapSize).r;
          vec2 cellSz = vec2(vWin.y, vWin.x);
          vec2 cid = floor(vUvM / cellSz);
          vec2 f = fract(vUvM / cellSz);
          float mask;
          if (wt > 5.5) mask = 1.0;
          else if (wt > 3.5 && wt < 4.5) mask = step(0.15, f.x) * step(f.x, 0.85) * step(0.62, f.y) * step(f.y, 0.88);
          else if (wt > 2.5 && wt < 3.5) mask = step(0.06, f.x) * step(f.x, 0.94) * step(0.08, f.y) * step(f.y, 0.78);
          else if (wt > 1.5 && wt < 2.5) mask = step(0.04, f.x) * step(f.x, 0.96) * step(0.1, f.y) * step(f.y, 0.92);
          else mask = step(0.25, f.x) * step(f.x, 0.75) * step(0.3, f.y) * step(f.y, 0.82);
          if (vUvM.y < 0.6) mask = 0.0;
          float r = h21(cid + vec2(vWin.z * 137.0, vWin.z * 71.0));
          float lit = (wt > 1.5 && wt < 2.5) ? uLitOff : uLitRes;
          if (wt > 2.5 && wt < 3.5) lit = uLitOff * 1.2 + 0.25 * uNight;
          ${'#ifdef USE_BOOST\nlit = mix(0.0, lit, uLitBoost);\n#endif'}
          float on = step(r, lit) * (1.0 - out_);
          if (wt > 4.5 && wt < 5.5) on = 0.0;
          vec3 glass = (wt > 1.5 && wt < 2.5) ? diffuseColor.rgb * 0.75 + vec3(0.05, 0.08, 0.1) : vec3(0.16, 0.2, 0.25);
          if (wt > 4.5 && wt < 5.5) glass = vec3(0.05);
          vec3 warm = mix(vec3(1.0, 0.78, 0.45), vec3(0.85, 0.92, 1.0), step(0.7, h21(cid * 1.7 + vWin.z)));
          if (wt > 5.5) { warm = diffuseColor.rgb * 1.4; on = (0.35 + 0.65 * uNight) * (1.0 - out_); glass = diffuseColor.rgb; }
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, mask * (wt > 5.5 ? 0.0 : 1.0));
          winEmis = warm * on * mask * (0.15 + 1.6 * uNight);
        }
        float up = clamp(vNrm.y, 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 1.0), uSnow * step(0.9, up));`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += winEmis;');
  };
}
