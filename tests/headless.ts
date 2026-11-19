import { World } from '../src/sim/world';
import { DEFAULT_PARAMS } from '../src/shared/params';
import { DAY_SECONDS, MOTION_DT } from '../src/shared/constants';
const days = Number(process.argv[2] ?? 10);
const p = { ...DEFAULT_PARAMS, seed: Number(process.argv[3] ?? DEFAULT_PARAMS.seed), terrain: (process.argv[4] ?? 'vale') as any };
const t0 = performance.now();
const w = new World(p);
console.log('init ms', (performance.now()-t0).toFixed(0), 'nodes', w.roads.nodes.length, 'bld', w.buildings.list.length);
let last = performance.now();
for (let d = 0; d < days; d++) {
  for (let s = 0; s < DAY_SECONDS / MOTION_DT; s++) w.step(MOTION_DT);
  const now = performance.now();
  const kinds: Record<string, number> = {};
  for (const b of w.buildings.list) kinds[b.kind] = (kinds[b.kind] ?? 0) + 1;
  console.log(`day ${w.day} ms ${(now-last).toFixed(0)} pop ${w.population} era ${w.era} edges ${w.roads.edges.filter(e=>e.alive).length} bld ${w.buildings.list.length} uc ${w.buildings.underConstruction.size}`, JSON.stringify(kinds), JSON.stringify(Object.fromEntries(Object.entries(w.demand).map(([k,v])=>[k,+v.toFixed(1)]))), (w as any).statLine?.() ?? '');
  last = now;
}
