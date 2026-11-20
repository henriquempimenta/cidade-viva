// Diagnóstico: eixos de vias que entram no volume de prédios comuns
import { World } from '../src/sim/world';
import { DEFAULT_PARAMS } from '../src/shared/params';
import { axisHitsBuildings } from './invariants';
const days = Number(process.argv[2] ?? 10);
for (const [seed, terrain] of [[42, 'litoral'], [1234, 'litoral'], [1234, 'vale']] as const) {
  const w = new World({ ...DEFAULT_PARAMS, seed, terrain });
  for (let i = 0; i < days * 4800; i++) w.step(0.5);
  const hits = axisHitsBuildings(w, 0.5, process.argv[3] === 'paved');
  console.log(seed, terrain, 'day', w.day, 'pop', w.population, 'hits', hits.length, JSON.stringify(hits.slice(0, 6)));
}
