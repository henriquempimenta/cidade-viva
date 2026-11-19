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
console.log('lines', w.transitSys.lines.map((l) => `${l.name} fleet ${l.fleet} riders ${l.ridersYday}`));
console.log('upgrades', w.upgrades.history.map((d) => `d${d.day} ${d.chosen}`));
console.log('rail', { stations: w.rail2.lines[0].stations.length, terminal: !!w.rail2.terminal, crossings: w.rail2.crossings.length, sep: w.rail2.crossings.filter((c) => c.separated).length, trains: w.rail2.trains.length, tracks: w.rail2.lines[0].tracks });
console.log('modal', w.citizens.modeCount);
const sig = w.roads.nodes.filter((n) => n.control >= 2).length; console.log('controlled nodes', sig, 'interchanges', w.roads.nodes.filter((n) => n.interchange).length);
const vcs = w.roads.edges.filter((e) => e.alive && e.progress >= 1).map((e) => ({ n: e.name, vc: Math.max(...e.vcHistory, 0), cd: e.congestedDays, cls: e.cls }));
vcs.sort((a, b) => b.vc - a.vc);
console.log('top vc', JSON.stringify(vcs.slice(0, 6)));
console.log('rail2', w.rail2.lines.map((l) => `${l.kind} st ${l.stations.length} tr ${l.tracks}`).join(' | '), 'waitSingle', w.rail2.waitingSingle);
console.log('tourism', JSON.stringify({ attr: w.tourismSys.attractiveness.toFixed(2), started: w.tourismSys.started, tourists: w.tourismSys.count, hotels: w.buildings.list.filter((b) => b.kind === 'hotel' || b.kind === 'hostel').length, floods: w.happen.floods, dikes: w.happen.dikes.length, heritage: w.buildings.list.filter((b) => b.heritage).length }));
console.log('chronicle', w.events.chronicle.slice(-25).map((e) => `d${e.day} ${e.headline}`).join('\n'));
