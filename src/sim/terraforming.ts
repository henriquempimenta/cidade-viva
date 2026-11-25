import { RoadClass } from '../shared/constants';
import { edgeHalfWidth, nodeRenderRadius, SIDEWALK_WIDTH } from '../shared/roadGeom';
import { clamp, lerp, smoothstep } from '../shared/rng';
import type { REdge, RNode, RoadNetwork } from './roads';
import type { Terrain } from './terrain';

/**
 * Compute geotechnical embankment/cut slope blend width proportional to actual vertical delta `dh`.
 * - Cuts into hillsides (`isFill = false`) hold a steeper ~1:1.65 batter.
 * - Fill embankments (`isFill = true`) spread on a gentler ~1:2.05 slope.
 * Bounded to `[minW, maxW]` (default `6..26 m`) to avoid both vertical cliffs on steep hillsides
 * and overly wide earthworks on nearly flat ground.
 */
export function geotechnicalBlendWidth(dh: number, isFill = false, minW = 6, maxW = 26): number {
  const ratio = isFill ? 2.05 : 1.65;
  return clamp(Math.abs(dh) * ratio + 3.5, minW, maxW);
}

/**
 * Deterministic terrain grading (cut-and-fill terraforming) under at-grade roads,
 * junctions, railways, and building footprints.
 *
 * Safety invariants:
 * - Never modifies water cells (`water[k] === 1`) or river channel cells (`riverDist[k] < riverWidth * 0.65`).
 * - Never lowers dry land below `seaLevel + 0.35 m`.
 * - Never grades underneath bridges, elevated viaducts, or grade-separated tunnels/decks.
 * - Blends smoothly with previously graded infrastructure (`graded[k]`) to avoid steps or burying neighbors.
 * - 100% deterministic (zero RNG; pure geometry & heightmap arithmetic).
 */
export class Terraforming {
  /** Accumulated grading weight per heightmap vertex for smooth multi-feature blending. */
  readonly graded: Float32Array;
  /** Set whenever `terrain.heights` changes; drained in `World.collectDiff()`. */
  heightsDirty = false;

  constructor(private readonly terrain: Terrain) {
    this.graded = new Float32Array(terrain.hres * terrain.hres);
  }

  /** Grade a single heightmap vertex while enforcing all water, river, and sea-level safety invariants. */
  private gradeCell(i: number, j: number, targetY: number, u: number, weight: number): boolean {
    const T = this.terrain;
    const { hres } = T;
    if (i < 0 || j < 0 || i >= hres || j >= hres || u <= 0) return false;
    const k = j * hres + i;
    if (T.water[k] === 1 || T.riverDist[k] < T.riverWidth * 0.65) return false;

    const minDry = T.seaLevel + 0.35;
    const oldH = T.heights[k];
    // Never lower dry land below seaLevel + 0.35 m, never cut low dry banks below natural height or < 0.65 m,
    // and never excavate riverbanks/floodplains downward toward water level (fill-only near river channels).
    let floorH = Math.max(minDry, Math.min(oldH, T.seaLevel + 0.65));
    if (T.riverDist[k] < T.riverWidth + 32) floorH = Math.max(floorH, oldH);
    const clampedTarget = Math.max(floorH, targetY);
    const prior = this.graded[k];
    const blendFactor = u * (weight / (weight + prior * 1.25));
    const newH = Math.max(floorH, oldH + (clampedTarget - oldH) * blendFactor);
    this.graded[k] = Math.min(4, prior + u * weight);

    if (Math.abs(newH - oldH) > 1e-4) {
      T.heights[k] = newH;
      if (newH >= 2.4 && T.flood[k]) T.flood[k] = 0;
      this.heightsDirty = true;
      return true;
    }
    return false;
  }

  /** Grade terrain along an at-grade road edge (carriageway + sidewalk/shoulder + geotechnical cut/fill slope). */
  gradeRoad(e: REdge, roads: RoadNetwork): { changed: boolean; cx: number; cz: number; radius: number } {
    const na = roads.nodes[e.a], nb = roads.nodes[e.b];
    if (!e.alive || !na || !nb || e.bridge || e.elevated || e.tunnel || e.deck !== undefined) {
      return { changed: false, cx: 0, cz: 0, radius: 0 };
    }
    const T = this.terrain;
    const { hres, step } = T;
    const minDry = T.seaLevel + 0.35;
    const hw = edgeHalfWidth(e);
    const urban = roads.hasSidewalk(e.id);
    // Keep the level roadbed wide enough to clear carriageway + sidewalks without interior heightmap ridges,
    // while scaling the outer cut/fill embankment slope dynamically via geotechnicalBlendWidth().
    const flatW = urban ? hw + SIDEWALK_WIDTH + 2.0 : hw + 2.0;
    const maxBlendW = 26;
    const searchR = flatW + maxBlendW;

    const steps = Math.max(2, Math.ceil(e.len / 10));
    const ys = new Float32Array(steps + 1);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = na.x + (nb.x - na.x) * t;
      const pz = na.z + (nb.z - na.z) * t;
      ys[s] = Math.max(minDry, T.heightAt(px, pz));
    }
    // Smooth internal road grade gently while keeping endpoints anchored
    for (let pass = 0; pass < 2; pass++) {
      for (let s = 1; s < steps; s++) {
        ys[s] = Math.max(minDry, (ys[s - 1] + ys[s] * 2 + ys[s + 1]) * 0.25);
      }
    }

    const dx = nb.x - na.x, dz = nb.z - na.z;
    const l2 = dx * dx + dz * dz || 1;
    const i0 = Math.max(0, Math.floor((Math.min(na.x, nb.x) - searchR) / step));
    const i1 = Math.min(hres - 1, Math.ceil((Math.max(na.x, nb.x) + searchR) / step));
    const j0 = Math.max(0, Math.floor((Math.min(na.z, nb.z) - searchR) / step));
    const j1 = Math.min(hres - 1, Math.ceil((Math.max(na.z, nb.z) + searchR) / step));

    let changed = false;
    let maxUsedR = flatW + 6;
    for (let j = j0; j <= j1; j++) {
      const gz = j * step;
      for (let i = i0; i <= i1; i++) {
        const gx = i * step;
        const t = clamp(((gx - na.x) * dx + (gz - na.z) * dz) / l2, 0, 1);
        const px = na.x + dx * t, pz = na.z + dz * t;
        const d = Math.hypot(gx - px, gz - pz);
        if (d >= searchR) continue;
        const sf = t * steps;
        const si = Math.min(steps - 1, Math.floor(sf));
        const targetY = lerp(ys[si], ys[si + 1], sf - si);
        const oldH = T.heights[j * hres + i];
        const dh = targetY - oldH;
        const blendW = geotechnicalBlendWidth(dh, dh > 0, 6, maxBlendW);
        const cellMaxR = flatW + blendW;
        if (d >= cellMaxR) continue;
        const u = d <= flatW ? 1 : 1 - smoothstep(flatW, cellMaxR, d);
        if (this.gradeCell(i, j, targetY, u, 1.0)) {
          changed = true;
          if (cellMaxR > maxUsedR) maxUsedR = cellMaxR;
        }
      }
    }

    return {
      changed,
      cx: (na.x + nb.x) * 0.5,
      cz: (na.z + nb.z) * 0.5,
      radius: e.len * 0.5 + maxUsedR,
    };
  }

  /** Grade a level pad under an at-grade junction (deg >= 3) so all incident arms meet without steps. */
  gradeJunction(n: RNode, roads: RoadNetwork): { changed: boolean; cx: number; cz: number; radius: number } {
    if (!n.alive || n.deck || n.edges.length < 3) return { changed: false, cx: 0, cz: 0, radius: 0 };
    const surf: REdge[] = [];
    for (const id of n.edges) {
      const e = roads.edges[id];
      if (!e || !e.alive || e.bridge || e.elevated || e.tunnel || e.deck !== undefined) continue;
      surf.push(e);
    }
    if (surf.length < 2) return { changed: false, cx: 0, cz: 0, radius: 0 };

    const T = this.terrain;
    const { hres, step } = T;
    const minDry = T.seaLevel + 0.35;
    const r = Math.max(n.radius, nodeRenderRadius(n.control, surf)) + 3.0;
    const maxBlendW = 24;
    const searchR = r + maxBlendW;

    let sumY = Math.max(minDry, T.heightAt(n.x, n.z)) * 2;
    let cnt = 2;
    for (const e of surf) {
      const o = roads.nodes[e.a === n.id ? e.b : e.a];
      if (!o) continue;
      const dist = Math.min(r * 0.8, e.len * 0.35);
      const t = dist / Math.max(1, e.len);
      sumY += Math.max(minDry, T.heightAt(n.x + (o.x - n.x) * t, n.z + (o.z - n.z) * t));
      cnt++;
    }
    const targetY = Math.max(minDry, sumY / cnt);

    const i0 = Math.max(0, Math.floor((n.x - searchR) / step));
    const i1 = Math.min(hres - 1, Math.ceil((n.x + searchR) / step));
    const j0 = Math.max(0, Math.floor((n.z - searchR) / step));
    const j1 = Math.min(hres - 1, Math.ceil((n.z + searchR) / step));

    let changed = false;
    let maxUsedR = r + 6;
    for (let j = j0; j <= j1; j++) {
      const gz = j * step;
      for (let i = i0; i <= i1; i++) {
        const gx = i * step;
        const d = Math.hypot(gx - n.x, gz - n.z);
        if (d >= searchR) continue;
        const oldH = T.heights[j * hres + i];
        const dh = targetY - oldH;
        const blendW = geotechnicalBlendWidth(dh, dh > 0, 6, maxBlendW);
        const cellMaxR = r + blendW;
        if (d >= cellMaxR) continue;
        const u = d <= r ? 1 : 1 - smoothstep(r, cellMaxR, d);
        if (this.gradeCell(i, j, targetY, u, 1.3)) {
          changed = true;
          if (cellMaxR > maxUsedR) maxUsedR = cellMaxR;
        }
      }
    }

    return { changed, cx: n.x, cz: n.z, radius: maxUsedR };
  }

  /** Grade terrain along a ground-level railway polyline (skipping elevated lines and bridge spans). */
  gradeRail(xs: number[], ys: number[], zs: number[], tracks: number, elevated: boolean): boolean {
    if (elevated || xs.length < 2) return false;
    const T = this.terrain;
    const { hres, step } = T;
    const minDry = T.seaLevel + 0.35;
    const flatW = tracks * 2.1 + 1.6;
    const maxBlendW = 26;
    const searchR = flatW + maxBlendW;

    let changed = false;
    for (let seg = 0; seg < xs.length - 1; seg++) {
      const ax = xs[seg], ay = ys[seg], az = zs[seg];
      const bx = xs[seg + 1], by = ys[seg + 1], bz = zs[seg + 1];
      const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
      const mg = T.heightAt(mx, mz);
      // Never grade under bridges/water or lifted viaduct stretches
      if (mg < T.seaLevel + 0.5) continue;
      if (T.heightAt(ax, az) < T.seaLevel + 0.5 || T.heightAt(bx, bz) < T.seaLevel + 0.5) continue;
      if ((ay + by) * 0.5 - Math.max(0, mg) > 2.2) continue;

      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz || 1;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - searchR) / step));
      const i1 = Math.min(hres - 1, Math.ceil((Math.max(ax, bx) + searchR) / step));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - searchR) / step));
      const j1 = Math.min(hres - 1, Math.ceil((Math.max(az, bz) + searchR) / step));

      for (let j = j0; j <= j1; j++) {
        const gz = j * step;
        for (let i = i0; i <= i1; i++) {
          const gx = i * step;
          const t = clamp(((gx - ax) * dx + (gz - az) * dz) / l2, 0, 1);
          const px = ax + dx * t, pz = az + dz * t;
          const d = Math.hypot(gx - px, gz - pz);
          if (d >= searchR) continue;
          const trackY = lerp(ay, by, t);
          const oldH = T.heights[j * hres + i];
          if (trackY - Math.max(0, oldH) > 3.5) continue;
          const targetY = Math.max(minDry, trackY - 0.22);
          const dh = targetY - oldH;
          const blendW = geotechnicalBlendWidth(dh, dh > 0, 6, maxBlendW);
          const cellMaxR = flatW + blendW;
          if (d >= cellMaxR) continue;
          const u = d <= flatW ? 1 : 1 - smoothstep(flatW, cellMaxR, d);
          if (this.gradeCell(i, j, targetY, u, 1.1)) changed = true;
        }
      }
    }
    return changed;
  }

  /** Grade a level terrace under an oriented building / station footprint with proportional geotechnical slopes. */
  gradeBuilding(x: number, z: number, angle: number, w: number, d: number): { changed: boolean; radius: number } {
    const T = this.terrain;
    if (T.isWater(x, z)) return { changed: false, radius: 0 };
    const { hres, step } = T;
    const minDry = T.seaLevel + 0.35;
    const ca = Math.cos(angle), sa = Math.sin(angle);

    // Balanced cut/fill pad elevation from center + 4 footprint corners
    let sum = Math.max(minDry, T.heightAt(x, z)) * 2;
    let cnt = 2;
    for (const [u, v] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
      const px = x + ca * u * w - sa * v * d;
      const pz = z + sa * u * w + ca * v * d;
      const h = T.heightAt(px, pz);
      if (h >= T.seaLevel + 0.2) { sum += Math.max(minDry, h); cnt++; }
    }
    const padY = Math.max(minDry, sum / cnt);

    // Tight footprint terrace (+1.4 m yard margin for ordinary lots, +2.2 m for large complexes)
    const large = Math.max(w, d) > 35;
    const margin = large ? 2.2 : 1.4;
    const hw = w * 0.5 + margin;
    const hd = d * 0.5 + margin;
    const maxBlendW = large ? 26 : 22;
    const searchR = Math.hypot(hw + maxBlendW, hd + maxBlendW);

    const i0 = Math.max(0, Math.floor((x - searchR) / step));
    const i1 = Math.min(hres - 1, Math.ceil((x + searchR) / step));
    const j0 = Math.max(0, Math.floor((z - searchR) / step));
    const j1 = Math.min(hres - 1, Math.ceil((z + searchR) / step));

    let changed = false;
    let maxUsedBlend = 6;
    const padWeight = large ? 2.2 : 1.3;
    for (let j = j0; j <= j1; j++) {
      const gz = j * step;
      for (let i = i0; i <= i1; i++) {
        const gx = i * step;
        const rx = gx - x, rz = gz - z;
        const lx = rx * ca + rz * sa;
        const lz = -rx * sa + rz * ca;
        const ex = Math.max(0, Math.abs(lx) - hw);
        const ez = Math.max(0, Math.abs(lz) - hd);
        const dist = Math.hypot(ex, ez);
        if (dist >= maxBlendW) continue;
        const oldH = T.heights[j * hres + i];
        const dh = padY - oldH;
        const blendW = geotechnicalBlendWidth(dh, dh > 0, 6, maxBlendW);
        if (dist >= blendW) continue;
        const u = dist <= 0 ? 1 : 1 - smoothstep(0, blendW, dist);
        if (this.gradeCell(i, j, padY, u, padWeight)) {
          changed = true;
          if (blendW > maxUsedBlend) maxUsedBlend = blendW;
        }
      }
    }
    return { changed, radius: Math.hypot(hw + maxUsedBlend, hd + maxUsedBlend) };
  }
}
