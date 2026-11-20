// Cada teste reproduz um achado do parecer técnico e verifica a invariante correspondente.
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { DEFAULT_PARAMS } from '../src/shared/params';
import { VEH_FLAG_SIREN, VType } from '../src/shared/constants';
import { P_CITIZEN, P_SERVICE } from '../src/sim/traffic';
import { edgeNoiseIndex, RoadNetwork, type REdge } from '../src/sim/roads';
import { InlineBackend, type RouteBackend, type RouteGraph } from '../src/sim/routeKernel';
import { updateFields } from '../src/sim/fieldsUpdate';
import { axisHitsBuildings } from './invariants';
import { inspect } from '../src/sim/hostApi';

function world(seed = 777, extra: Partial<typeof DEFAULT_PARAMS> = {}) { return new World({ ...DEFAULT_PARAMS, seed, ...extra }); }
function run(w: World, days: number) { for (let i = 0; i < days * 4800; i++) w.step(0.5); return w; }
function longEdge(w: World, min = 120, pred: (e: REdge) => boolean = () => true): REdge {
  const e = w.roads.edges.filter((x) => x.alive && x.progress >= 1 && x.deck === undefined && x.len > min && pred(x)).sort((a, b) => b.len - a.len)[0];
  if (!e) throw new Error('sem via longa');
  return e;
}
/** pairs of vehicles that physically overlap on the same lane */
function overlaps(w: World): number {
  const T = w.traffic, lanes = new Map<number, number[]>();
  for (let i = 0; i < T.max; i++) {
    if (!T.active[i] || T.s[i] < T.sStart(w.roads.edges[T.edge[i]], T.dir[i])) continue; // inside a junction box
    const k = (T.edge[i] * 2 + T.dir[i]) * 4 + T.lane[i];
    (lanes.get(k) ?? lanes.set(k, []).get(k)!).push(i);
  }
  let n = 0;
  for (const arr of lanes.values()) {
    arr.sort((a, b) => T.s[a] - T.s[b]);
    for (let k = 0; k + 1 < arr.length; k++) if (T.s[arr[k + 1]] - T.len[arr[k + 1]] < T.s[arr[k]] - 0.05) n++;
  }
  return n;
}

describe('faixa: espaço reservado', () => {
  it('duas partidas simultâneas no mesmo acesso não se sobrepõem', () => {
    const w = run(world(), 0.3);
    const e = longEdge(w, 80, (x) => x.lanes === 1);
    const T = w.traffic;
    const a = T.spawn(VType.Car, [e.id * 2], 15, e.len - 5, { kind: P_CITIZEN, id: -1, aux: 0 });
    const b = T.spawn(VType.Car, [e.id * 2], 15, e.len - 5, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(a).toBeGreaterThanOrEqual(0);
    if (b >= 0) {
      const sameLane = T.lane[a] === T.lane[b];
      if (sameLane) expect(Math.abs(T.s[a] - T.s[b])).toBeGreaterThanOrEqual(T.len[a] + 2);
    }
    expect(overlaps(w)).toBe(0);
  });
  it('um dia de cidade sem veículos sobrepostos na mesma faixa', () => {
    const w = run(world(31), 1);
    let worst = 0;
    for (let i = 0; i < 4800; i++) { w.step(0.5); if (i % 60 === 0) worst = Math.max(worst, overlaps(w)); }
    expect(worst).toBe(0);
  }, 60000);
});

describe('cancela fechada é barreira física', () => {
  for (const [label, type, flags] of [['carro', VType.Car, 0], ['ambulância com sirene', VType.Ambulance, VEH_FLAG_SIREN], ['moto', VType.Moto, 0]] as const) {
    it(`${label} para antes da passagem`, () => {
      const w = run(world(), 2);
      const e = longEdge(w, 85);
      const T = w.traffic;
      T.closedCrossings.set(e.id, [0.5]);
      const slot = T.spawn(type, [e.id * 2], 8, e.len - 3, { kind: P_SERVICE, id: -1, aux: -1 }, -1, -1, flags);
      expect(slot).toBeGreaterThanOrEqual(0);
      for (let k = 0; k < 90; k++) T.step(0.5, () => true); // 45 s: chega à cancela e espera
      expect(T.active[slot]).toBe(1);
      expect(T.s[slot]).toBeLessThan(e.len * 0.5 - 4);
    });
  }
});

describe('mão única: cache e veículos', () => {
  it('rota em cache não usa o arco proibido depois da conversão', () => {
    const w = run(world(), 0.5);
    const R = w.roads;
    const e = longEdge(w, 40, (x) => !x.oneway && R.nodes[x.a].edges.length >= 2 && R.nodes[x.b].edges.length >= 2);
    const before = R.route(e.b, e.a);
    expect(before).not.toBeNull();
    e.oneway = 1; // como no parecer: muda o sentido sem passar pela prefeitura
    const after = R.route(e.b, e.a) ?? [];
    expect(after.includes(e.id * 2 + 1)).toBe(false);
    expect(R.validPath(after)).toBe(true);
  });
  it('veículos com rota contra o novo sentido são replanejados', () => {
    const w = run(world(), 0.5);
    const R = w.roads, T = w.traffic;
    const e = longEdge(w, 40, (x) => !x.oneway && R.nodes[x.a].edges.length >= 2 && R.nodes[x.b].edges.length >= 2);
    // a car about to use e from b to a
    const n = R.nodes[e.b];
    const inEdge = n.edges.map((id) => R.edges[id]).find((x) => x.id !== e.id && x.progress >= 1)!;
    const inDe = inEdge.b === n.id ? inEdge.id * 2 : inEdge.id * 2 + 1;
    const slot = T.spawn(VType.Car, [inDe, e.id * 2 + 1], 5, e.len - 3, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(slot).toBeGreaterThanOrEqual(0);
    e.oneway = 1;
    R.invalidateRoutes();
    w.replanAfterTopology();
    for (let i = 0; i < T.max; i++) if (T.active[i]) expect(R.validPath(T.path[i]!, T.pidx[i] + 1)).toBe(true);
  });
});

describe('implantação: eixo viário não corta prédios', () => {
  for (const [seed, terrain] of [[42, 'litoral'], [1234, 'litoral'], [1234, 'vale']] as const) {
    it(`seed ${seed} ${terrain}, dia 10: nenhum eixo e nenhuma pista dentro de edificação comum`, () => {
      const w = run(world(seed, { terrain }), 10);
      expect(axisHitsBuildings(w, 0.5)).toEqual([]);
      expect(axisHitsBuildings(w, 0.5, true)).toEqual([]);
    }, 120000);
  }
});

describe('relógio nunca espera para sempre por rotas', () => {
  class Never implements RouteBackend {
    readonly threads = 2;
    submit() { return 1; }
    ready() { return false; }
    take(): Int32Array[] | null { throw new Error('não deveria ser chamado'); }
  }
  it('lote emitido pelo backend inline sobrevive à troca para o pool', () => {
    const w = run(world(4242), 0.3);
    const R = w.roads as unknown as { pending: unknown; backend: RouteBackend };
    let guard = 0;
    while (!R.pending && guard++ < 400) w.step(0.5);
    expect(R.pending).toBeTruthy();
    R.backend = new Never(); // swap with a batch still pending (como no warmup)
    for (let k = 0; k < 40; k++) { expect(w.roads.routingReady()).toBe(true); w.step(0.5); }
  });
  it('worker travado: lote recalculado no passo previsto, mesmo resultado', () => {
    const a = run(world(99), 0.2), b = run(world(99), 0.2);
    b.roads.backend = new Never();
    const old = RoadNetwork.ROUTE_TIMEOUT_MS;
    RoadNetwork.ROUTE_TIMEOUT_MS = -1;
    try {
      for (let k = 0; k < 2400; k++) {
        a.step(0.5);
        let spins = 0;
        while (!b.roads.routingReady()) if (++spins > 5) throw new Error('relógio travado');
        b.step(0.5);
      }
    } finally { RoadNetwork.ROUTE_TIMEOUT_MS = old; }
    expect(b.roads.routeFallbacks).toBeGreaterThan(0);
    expect(b.traffic.count).toBe(a.traffic.count);
    expect(b.population).toBe(a.population);
  }, 60000);
  it('backend que falha devolve null e a simulação recalcula', () => {
    class Failing implements RouteBackend {
      readonly threads = 1; private inner = new InlineBackend();
      submit(g: RouteGraph, d: number[]) { return this.inner.submit(g, d); }
      ready() { return true; }
      take() { return null; }
    }
    const w = run(world(7), 0.1);
    w.roads.backend = new Failing();
    for (let k = 0; k < 400; k++) w.step(0.5);
    expect(w.roads.routeFallbacks).toBeGreaterThan(0);
  });
});

describe('ruído: uma só medição para via, mapa e bairro', () => {
  it('mesmo volume, composição mais pesada → índice da via, mapa e valor do solo coerentes', () => {
    const A = run(world(5), 1.5), B = run(world(5), 1.5);
    // a street where land is worth something (at the floor the clamp would hide any effect)
    const mid = (e: REdge) => { const p = e.pts, k = Math.floor(p.length / 6) * 3; return [p[k], p[k + 2]]; };
    const pick = (w: World) => w.roads.edges.filter((x) => x.alive && x.progress >= 1 && x.deck === undefined && x.len > 60 && x.cls >= 1 && w.fields.sample('noise', mid(x)[0], mid(x)[1]) < 0.8)
      .map((e) => [e, w.fields.sample('landValue', mid(e)[0], mid(e)[1])] as const).sort((a, b) => b[1] - a[1] || a[0].id - b[0].id)[0][0];
    const ea = pick(A), eb = pick(B);
    expect(ea.id).toBe(eb.id);
    ea.volume = [200, 200]; eb.volume = [200, 200];
    ea.sndMean = new Float32Array([2, 0, 0, 30, 3]); // carros
    eb.sndMean = new Float32Array([0.6, 0, 6, 25, 3]); // mesmo volume, caminhões
    expect(edgeNoiseIndex(eb)).toBeGreaterThan(edgeNoiseIndex(ea));
    const p = ea.pts, k = Math.floor(p.length / 6) * 3, x = p[k], z = p[k + 2];
    for (let i = 0; i < 4; i++) { ea.sndMean = new Float32Array([2, 0, 0, 30, 3]); eb.sndMean = new Float32Array([0.6, 0, 6, 25, 3]); updateFields(A); updateFields(B); }
    expect(B.fields.sample('noise', x, z)).toBeGreaterThan(A.fields.sample('noise', x, z));
    expect(B.fields.sample('landValue', x, z)).toBeLessThan(A.fields.sample('landValue', x, z));
    // o inspetor lê exatamente o mesmo índice
    expect((inspect(B, 'edge', eb.id) as { noise: { index: number } }).noise.index).toBeCloseTo(edgeNoiseIndex(eb));
  }, 60000);
});

describe('velocidade: limite sinalizado e teto por modo', () => {
  for (const [label, type, flags, maxKmh] of [['moto', VType.Moto, 0, 90], ['carro', VType.Car, 0, 90], ['caminhão', VType.Truck, 0, 80], ['ambulância com sirene', VType.Ambulance, VEH_FLAG_SIREN, 110]] as const) {
    it(`${label} sozinho na via de 90 km/h não passa de ${maxKmh} km/h`, () => {
      const w = run(world(), 0.1);
      const e = w.roads.edges.filter((x) => x.alive && x.progress >= 1 && x.cls === 4 && !x.upgrading).sort((a, b) => b.len - a.len)[0];
      expect(e).toBeTruthy();
      const T = w.traffic, R = w.roads;
      // a long stretch of highway: follow highway edges forward from e
      const path = [e.id * 2];
      let head = e.b;
      for (let k = 0; k < 12; k++) {
        const nx = R.nodes[head].edges.map((id) => R.edges[id]).find((x) => x.cls === 4 && x.alive && x.progress >= 1 && !path.some((d) => d >> 1 === x.id));
        if (!nx) break;
        path.push(nx.a === head ? nx.id * 2 : nx.id * 2 + 1);
        head = nx.a === head ? nx.b : nx.a;
      }
      for (let i = 0; i < T.max; i++) if (T.active[i]) T.despawn(i); // pista seca, um único veículo
      const last = R.edges[path[path.length - 1] >> 1];
      const slot = T.spawn(type, path, 5, last.len - 2, { kind: P_SERVICE, id: -1, aux: -1 }, -1, -1, flags);
      let vmax = 0;
      for (let k = 0; k < 600 && T.active[slot]; k++) { T.step(0.5, () => true); if (T.active[slot]) vmax = Math.max(vmax, T.v[slot]); }
      expect(vmax * 3.6).toBeLessThanOrEqual(maxKmh + 0.5);
      expect(vmax * 3.6).toBeGreaterThan(maxKmh * 0.5); // it did actually get going
    });
  }
});

describe('transporte: embarque no sentido certo', () => {
  it('no ponto B, quem vai para A não entra no trem A→B→C', () => {
    const w = world(3);
    const S = w.transitSys;
    const stops = [0, 1, 2].map((k) => ({ x: 100 + k * 500, z: 100, node: -1, s: k * 500, name: 'E' + k }));
    const l = S.addRailLine('rail', 'Teste', stops, [], 600);
    const toA = w.citizens.add({ age: 30, hh: -1 }), toC = w.citizens.add({ age: 30, hh: -1 });
    S.rides.set(toA, { line: l.id, from: 1, to: 0, phase: 1, since: 0, dest: -1 });
    S.rides.set(toC, { line: l.id, from: 1, to: 2, phase: 1, since: 0, dest: -1 });
    l.waiting.set(1, [toA, toC]);
    const dir = 1; // trem indo de A (s=0) para C (s=1000)
    S.serveStop(l, 1, 999, 400, (to) => (stops[to].s - stops[1].s) * dir > 0);
    expect(l.onboard.get(999)).toEqual([toC]);
    expect(l.waiting.get(1)).toEqual([toA]);
  });
});
