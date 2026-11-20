import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { DEFAULT_PARAMS } from '../src/shared/params';
import { segInt } from '../src/sim/roads';
import { evaluate, profileFor, sampleSites } from '../src/sim/siting';
import { InlineBackend, type RouteBackend, type RouteGraph } from '../src/sim/routeKernel';

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

describe('multithreaded routing', () => {
  it('routing results installed at fixed steps: async pool == inline', () => {
    // a backend that answers late (like worker threads); the loop waits exactly as SimHost does
    class LateBackend implements RouteBackend {
      readonly threads = 3;
      private inner = new InlineBackend();
      private polls = new Map<number, number>();
      submit(g: RouteGraph, d: number[]) { const t = this.inner.submit(g, d); this.polls.set(t, 0); return t; }
      ready(t: number) { const n = (this.polls.get(t) ?? 0) + 1; this.polls.set(t, n); return n > 3; }
      take(t: number) { return this.inner.take(t); }
    }
    const a = new World({ ...DEFAULT_PARAMS, seed: 4242 });
    const b = new World({ ...DEFAULT_PARAMS, seed: 4242 });
    b.roads.backend = new LateBackend();
    for (let i = 0; i < 2 * 4800; i++) {
      a.step(0.5);
      while (!b.roads.routingReady()) { /* host would yield to the event loop here */ }
      b.step(0.5);
    }
    expect(b.population).toBe(a.population);
    expect(b.traffic.count).toBe(a.traffic.count);
    expect(b.buildings.list.map((x) => `${x.kind}:${x.x.toFixed(2)}`).join()).toBe(a.buildings.list.map((x) => `${x.kind}:${x.x.toFixed(2)}`).join());
  }, 120000);
});

describe('no hard population cap', () => {
  it('citizen, vehicle and pedestrian storage grows on demand', () => {
    const w = new World({ ...DEFAULT_PARAMS, seed: 5 });
    const before = w.citizens.max;
    for (let k = 0; k < before + 50; k++) w.citizens.add({ age: 30, hh: -1 });
    expect(w.citizens.max).toBeGreaterThan(before);
    const pmax = w.peds.max;
    for (let k = 0; k < pmax + 10; k++) w.peds.spawn([0, 0, 10, 0], -1, 1, 0, 0);
    expect(w.peds.max).toBeGreaterThan(pmax);
  });
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
    const w = run(6, 5);
    const sites = sampleSites(w.siteCtx(), 50, 50, 160, { offRoad: true });
    const prof = profileFor('factory', 1, w.params);
    for (const c of sites) evaluate(w.siteCtx(), c, 'factory', prof, 50, 50);
    // neighbours counted from the actual homes, not from a smoothed field
    const homes = w.buildings.list.filter((b) => b.alive && b.def.cat === 'res');
    const near = sites.map((c) => homes.filter((b) => Math.hypot(b.x - c.x, b.z - c.z) < 160).length);
    const withHomes = sites.filter((_, k) => near[k] >= 3);
    const empty = sites.filter((c) => !homes.some((b) => Math.hypot(b.x - c.x, b.z - c.z) < 450));
    // the comparison needs real samples on both sides, otherwise the loop proves nothing
    expect(withHomes.length).toBeGreaterThanOrEqual(5);
    expect(empty.length).toBeGreaterThanOrEqual(3);
    for (const c of withHomes) expect(c.terms.nimby ?? 0).toBeLessThan(0);
    const mean = (a: typeof sites) => a.reduce((s, c) => s + (c.terms.nimby ?? 0), 0) / a.length;
    expect(mean(withHomes)).toBeLessThan(mean(empty));
  }, 60000);
});
