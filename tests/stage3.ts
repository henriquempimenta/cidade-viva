import { World } from '../src/sim/world';
import { DEFAULT_PARAMS } from '../src/shared/params';

const w = new World(DEFAULT_PARAMS);
const t0 = performance.now();
const days = Number(process.argv[2] ?? 30);
for (let d = 0; d < days; d++) {
  for (let s = 0; s < 4800; s++) w.step(0.5);
  if (d % 3 === 2 || d === days - 1) {
    const k: Record<string, number> = {};
    for (const b of w.buildings.list) if (b.def.public) k[b.kind] = (k[b.kind] ?? 0) + 1;
    const U = w.utils;
    console.log(
      `d${w.day} pop ${w.population} era ${w.era} $${Math.round(w.budget.money)} debt ${Math.round(w.budget.debt)} ` +
        `P ${U.power.demand.toFixed(0)}/${U.power.supply.toFixed(0)} W ${U.water.demand.toFixed(0)}/${U.water.supply.toFixed(0)} ` +
        `crime ${w.services.avgCrime.toFixed(2)} cr/d ${w.services.crimeHistory.slice(-1)} veh ${w.traffic.count} ` +
        `t ${((performance.now() - t0) / 1000).toFixed(0)}s`,
      JSON.stringify(k),
    );
  }
}
for (const l of w.cityHall.log.slice(-3)) console.log(JSON.stringify(l));
