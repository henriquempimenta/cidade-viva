import { ROAD_HALF_WIDTH, ROAD_LANES } from '../src/shared/constants';
import { segRectDist } from '../src/sim/geom';
import type { World } from '../src/sim/world';

/** buildings whose footprint is crossed by a road axis (stations and terminals sit on the line by design) */
/** `paved`: test the carriageway half-width instead of only the axis */
export function axisHitsBuildings(w: World, margin = 0.5, paved = false): { b: number; kind: string; e: number; d: number }[] {
  const out: { b: number; kind: string; e: number; d: number }[] = [];
  const R = w.roads;
  for (const b of w.buildings.list) {
    if (!b.alive || b.def.cat === 'transport') continue;
    const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
    const hw = b.w / 2 - margin, hd = b.d / 2 - margin;
    if (hw <= 0 || hd <= 0) continue;
    for (const e of R.edgesNear(b.x, b.z, Math.max(b.w, b.d) + 30)) {
      if (!e.alive || e.tunnel || (e.deck !== undefined && e.deck >= 0)) continue;
      const p = e.pts;
      for (let k = 0; k + 5 < p.length; k += 3) {
        const d = segRectDist(p[k] - b.x, p[k + 2] - b.z, p[k + 3] - b.x, p[k + 5] - b.z, ca, sa, hw, hd);
        const extra = paved ? ROAD_HALF_WIDTH[e.cls] + (e.lanes > ROAD_LANES[e.cls] ? 3 : 0) - 0.5 : 0;
        if (d <= extra) { out.push({ b: b.id, kind: b.kind, e: e.id, d: +d.toFixed(2) }); break; }
      }
    }
  }
  return out;
}

