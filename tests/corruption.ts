import { World } from '../src/sim/world';
import { DEFAULT_PARAMS } from '../src/shared/params';

// usage: corruption.ts <days> <corruption> <transparency>
const days = Number(process.argv[2] ?? 60);
const w = new World({ ...DEFAULT_PARAMS, corruption: Number(process.argv[3] ?? 0.35), transparency: Number(process.argv[4] ?? 0.5) });
const heads: string[] = [];
w.events.onEmit = (e) => { if (/investigation|election|mayor|works_|collapse|occupation|expropriation/.test(e.type)) heads.push(`d${e.day} ${e.headline ?? e.text}`); };
for (let d = 0; d < days; d++) {
  for (let s = 0; s < 4800; s++) w.step(0.5);
  if (d % 6 === 5) {
    const r = w.integrity.report();
    const permits = w.buildings.list.filter((b) => b.decision?.chosen.terms.permit).length;
    console.log(`d${w.day} pop ${w.population} era ${w.era} corr ${(r.index * 100).toFixed(0)}% trust ${(r.trust * 100).toFixed(0)}% mayor ${r.mayor} diverted ${r.diverted} stalled ${r.stalled} derelict ${r.derelict} (${r.avgAbandonYears.toFixed(1)}y) squat ${r.squatted} collapses ${r.collapses} inv ${r.investigations} permitTerms ${permits} crime ${w.services.avgCrime.toFixed(2)}`);
  }
}
console.log(heads.slice(-25).join('\n'));
