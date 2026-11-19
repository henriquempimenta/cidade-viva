import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { DEFAULT_PARAMS } from '../src/shared/params';
import { segInt } from '../src/sim/roads';
import { evaluate, profileFor, sampleSites } from '../src/sim/siting';

function run(days: number, seed = 777) {
  const w = new World({ ...DEFAULT_PARAMS, seed });
  for (let i = 0; i < days * 4800; i++) w.step(0.5);
  return w;
}

describe('determinism', () => {
  it('same seed + params => same city', () => {
    const a = run(2), b = run(2);
    expect(a.population).toBe(b.population);
    expect(a.buildings.list.length).toBe(b.buildings.list.length);
    expect(a.roads.edges.length).toBe(b.roads.edges.length);
    expect(a.buildings.list.map((x) => `${x.kind}:${x.x.toFixed(2)}`).join()).toBe(b.buildings.list.map((x) => `${x.kind}:${x.x.toFixed(2)}`).join());
  }, 60000);
});

describe('road network geometry', () => {
  it('has no crossing segments without a shared node', () => {
    const w = run(4, 99);
    const R = w.roads;
    const es = R.edges.filter((e) => e.alive);
    let bad = 0;
    for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) {
      const e = es[i], f = es[j];
      if (e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b) continue;
      const a = R.nodes[e.a], b = R.nodes[e.b], c = R.nodes[f.a], d = R.nodes[f.b];
      const hit = segInt(a.x, a.z, b.x, b.z, c.x, c.z, d.x, d.z);
      if (hit && hit.t > 0.02 && hit.t < 0.98 && hit.u > 0.02 && hit.u < 0.98) bad++;
    }
    expect(bad).toBe(0);
  }, 120000);
});

describe('emergent siting', () => {
  it('polluting industry is rejected by its neighbors (NIMBY term is negative near homes)', () => {
    const w = run(3, 5);
    const sites = sampleSites(w.siteCtx(), 50, 50, 40, {});
    const prof = profileFor('factory', 1, w.params);
    for (const c of sites) evaluate(w.siteCtx(), c, 'factory', prof, 50, 50);
    const withHomes = sites.filter((c) => w.fields.sample('resDensity', c.x, c.z) > 1);
    for (const c of withHomes) expect(c.terms.nimby ?? 0).toBeLessThanOrEqual(0);
  }, 60000);
});
