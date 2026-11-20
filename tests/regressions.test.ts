// Cada teste reproduz um achado do parecer técnico e verifica a invariante correspondente.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { World } from '../src/sim/world';
import { Director, type DirectorWorld } from '../src/director/director';
import { DEFAULT_PARAMS, MAX_WARMUP_DAYS, sanitizeParams, sanitizeWarmup } from '../src/shared/params';
import { VEH_FLAG_SIREN, VType, RoadClass } from '../src/shared/constants';
import { P_CITIZEN, P_GARBAGE, P_SERVICE } from '../src/sim/traffic';
import { ST_VIRTUAL, ST_WALK } from '../src/sim/citizens';
import { activePlan, carPlan } from '../src/sim/trips';
import type { Line } from '../src/sim/transit';
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

describe('câmera não altera a simulação (determinismo sob carga)', () => {
  it('mover a câmera sob 2.400 veículos não muda lodAllowsVehicle nem consome o RNG', () => {
    const a = run(world(202), 0.2), b = run(world(202), 0.2);
    a.traffic.count = 2400;
    b.traffic.count = 2400;
    a.cam = { x: 100, z: 100, h: 120 };
    b.cam = { x: 2200, z: 2200, h: 900 };
    const ra: boolean[] = [], rb: boolean[] = [];
    for (let id = 0; id < 80; id++) {
      ra.push(a.lodAllowsVehicle(id));
      rb.push(b.lodAllowsVehicle(id));
    }
    expect(rb).toEqual(ra);
    expect(ra.some(Boolean)).toBe(true);
    expect(ra.some((v) => !v)).toBe(true);
    // neither call touched the simulation PRNG
    expect(b.rng.next()).toBe(a.rng.next());
  });
});

describe('transição de interseção: reserva comprimento real', () => {
  it('ônibus não entra em faixa de saída onde só cabem 5 m livres', () => {
    const w = run(world(17), 0.4);
    const R = w.roads, T = w.traffic;
    // find two connected usable edges: e1 -> node -> e2
    let e1: REdge | null = null, e2: REdge | null = null, dir1 = 0, dir2 = 0;
    for (const n of R.nodes) {
      if (!n.alive || n.edges.length < 2) continue;
      const live = n.edges.map((id) => R.edges[id]).filter((e) => e.alive && e.progress >= 1 && e.lanes === 1 && e.len > 60 && !e.oneway);
      if (live.length >= 2) {
        e1 = live[0]; e2 = live[1];
        dir1 = e1.b === n.id ? 0 : 1;
        dir2 = e2.a === n.id ? 0 : 1;
        break;
      }
    }
    expect(e1 && e2).toBeTruthy();
    for (let i = 0; i < T.max; i++) if (T.active[i]) T.despawn(i);
    // park a car right near the entry of e2 leaving only ~4 m behind it (too tight for a 12 m bus)
    const ss2 = T.sStart(e2!, dir2);
    const blocker = T.spawn(VType.Car, [e2!.id * 2 + dir2], ss2 + 8.5, e2!.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(blocker).toBeGreaterThanOrEqual(0);
    T.dwell[blocker] = 999; // keep it parked
    const bus = T.spawn(VType.Bus, [e1!.id * 2 + dir1, e2!.id * 2 + dir2], T.sEnd(e1!, dir1) - 18, e2!.len - 2, { kind: P_SERVICE, id: -1, aux: -1 });
    expect(bus).toBeGreaterThanOrEqual(0);
    for (let k = 0; k < 20; k++) T.step(0.5, () => true);
    // bus must still be waiting on e1, never overlapped on e2
    expect(T.edge[bus]).toBe(e1!.id);
    expect(overlaps(w)).toBe(0);
  });
});

describe('congestionamento honesto: serviços presos e viagens virtuais', () => {
  it('bombeiro e caminhão de lixo presos no trânsito não entregam o serviço', () => {
    const w = run(world(33), 1);
    const b = w.buildings.list.find((x) => x.alive && x.state === 'done' && !x.def.public)!;
    expect(b).toBeTruthy();
    const e = longEdge(w, 60);
    // active fire + fire truck stuck in traffic
    b.fire = 2;
    const incId = 99901;
    w.services.incidents.set(incId, { id: incId, type: 'fire', b: b.id, t: w.t, responded: false });
    const fslot = w.traffic.spawn(VType.Fire, [e.id * 2], 12, e.len - 2, { kind: P_SERVICE, id: incId, aux: -1 }, -1, b.id, VEH_FLAG_SIREN);
    expect(fslot).toBeGreaterThanOrEqual(0);
    const beforeDelays = w.services.delayedResponses;
    w.vehicleStuck(fslot);
    expect(b.fire).toBeGreaterThan(0); // fire was NOT magically extinguished
    expect(w.services.delayedResponses).toBe(beforeDelays + 1);
    // garbage truck stuck in traffic does NOT clean the building
    b.garbage = 5;
    const gslot = w.traffic.spawn(VType.Garbage, [e.id * 2], 35, e.len - 2, { kind: P_GARBAGE, id: b.id, aux: -1 }, -1, b.id);
    expect(gslot).toBeGreaterThanOrEqual(0);
    w.vehicleStuck(gslot);
    expect(b.garbage).toBe(5);
  });

  it('viagem virtual não mostra cidadão dentro do destino antes da chegada, e preso perto muda para a pé', () => {
    const w = run(world(44), 1);
    const buildings = w.buildings.list.filter((x) => x.alive && x.state === 'done');
    expect(buildings.length).toBeGreaterThanOrEqual(2);
    const from = buildings[0], to = buildings[buildings.length - 1];
    const cid = w.citizens.add({ age: 30, hh: -1 });
    w.citizens.loc[cid] = from.id;
    w.citizens.tripDest[cid] = to.id;
    w.citizens.virtualArrive(cid, 120, from.x, from.z);
    expect(w.citizens.state[cid]).toBe(ST_VIRTUAL);
    const p0 = w.citizens.position(cid)!;
    expect(p0.inside).toBe(false);
    expect(p0.building).toBe(-1);
    expect(Math.hypot(p0.x - from.x, p0.z - from.z)).toBeLessThan(1);
    // halfway through the virtual trip, position advances smoothly instead of jumping inside destination
    w.t += 60;
    const pMid = w.citizens.position(cid)!;
    expect(pMid.inside).toBe(false);
    expect(Math.hypot(pMid.x - (from.x + to.x) / 2, pMid.z - (from.z + to.z) / 2)).toBeLessThan(1);
    // stuck driver within 600 m of destination switches observably to walking
    const switched = w.citizens.switchToWalk(cid, to.x + 80, to.z);
    expect(switched).toBe(true);
    expect(w.citizens.state[cid]).toBe(ST_WALK);
    expect(w.citizens.tripMode[cid]).toBe(0);
  });
});

describe('obras transacionais: binário e BRT', () => {
  it('BRT não é anunciado sem faixa exclusiva nem antes da conclusão das obras', () => {
    const w = run(world(55), 1);
    const S = w.transitSys;
    const e1 = longEdge(w, 60, (x) => x.lanes === 1);
    const line1: Line = {
      id: 901, kind: 'bus', color: '#e74c3c', name: 'Linha 901 · Teste',
      stops: [{ x: w.center.x, z: w.center.z, node: e1.a, s: 0, name: 'A' }, { x: w.center.x + 100, z: w.center.z, node: e1.b, s: 100, name: 'B' }],
      path: [e1.id * 2], startS: 0, destS: e1.len - 1, fleet: 2, vehicles: new Set<number>(),
      ridersToday: 0, ridersYday: 900, waiting: new Map(), onboard: new Map(), edges: new Set([e1.id]),
      headway: 120, lastSpawn: 0, pts: [],
    };
    S.lines.push(line1);
    const evBefore = w.events.chronicle.length;
    (S as unknown as { toBRT(l: Line): void }).toBRT(line1);
    // 1-lane road cannot hold a dedicated bus lane -> stays ordinary bus, no BRT headline
    expect(line1.kind).toBe('bus');
    expect(w.events.chronicle.length).toBe(evBefore);
    // now widen to 2 lanes: toBRT starts road works first, promotes to BRT only when finishUpgrade completes
    e1.lanes = 2;
    (S as unknown as { toBRT(l: Line): void }).toBRT(line1);
    expect(line1.kind).toBe('bus');
    expect(line1.pendingBRT).toBe(true);
    expect(e1.upgrading).toBe(true);
    w.finishUpgrade(e1);
    expect(e1.busLane).toBe(true);
    expect(line1.kind).toBe('brt');
    expect(line1.name.startsWith('BRT')).toBe(true);
    expect(w.events.chronicle.length).toBe(evBefore + 1);
  });

  it('oneWayPair com rollback de conectividade não cobra o caixa nem emite manchete', () => {
    const w = run(world(61), 0.5);
    const R = w.roads;
    // build two dead-end parallel edges: turning them one-way breaks strong connectivity and forces rollback
    const n1 = R.addNode(120, 120), n2 = R.addNode(220, 120);
    const n3 = R.addNode(120, 200), n4 = R.addNode(220, 200);
    const e1 = R.addEdge(n1.id, n2.id, 1, { progress: 1 });
    const e2 = R.addEdge(n3.id, n4.id, 1, { progress: 1 });
    const ok = (w.upgrades as unknown as { oneWayPair(a: REdge, b: REdge): boolean }).oneWayPair(e1, e2);
    expect(ok).toBe(false);
    expect(e1.oneway).toBe(0);
    expect(e2.oneway).toBe(0);
  });
});

describe('validação de parâmetros de URL e teto de warmup', () => {
  it('sanitizeParams rejeita NaN/Infinity/enum inválido e faz clamp nas faixas válidas', () => {
    const p = sanitizeParams({
      seed: 'abc',
      terrain: 'marte',
      vocation: 'cripto',
      mapSize: 999999,
      taxRate: -5,
      corruption: Infinity,
      raininess: '0.75',
      snow: 'true',
      maxDensity: 12,
    });
    expect(p.seed).toBe(DEFAULT_PARAMS.seed);
    expect(p.terrain).toBe(DEFAULT_PARAMS.terrain);
    expect(p.vocation).toBe(DEFAULT_PARAMS.vocation);
    expect(p.mapSize).toBe(4800);
    expect(p.taxRate).toBe(0);
    expect(p.corruption).toBe(DEFAULT_PARAMS.corruption);
    expect(p.raininess).toBe(0.75);
    expect(p.snow).toBe(true);
    expect(p.maxDensity).toBe(5);
  });

  it('sanitizeWarmup bloqueia valores inválidos, negativos ou acima do teto', () => {
    expect(sanitizeWarmup(undefined)).toBe(0);
    expect(sanitizeWarmup('abc')).toBe(0);
    expect(sanitizeWarmup(-10)).toBe(0);
    expect(sanitizeWarmup(Infinity)).toBe(0);
    expect(sanitizeWarmup('15')).toBe(15);
    expect(sanitizeWarmup(99999)).toBe(MAX_WARMUP_DAYS);
  });
});

describe('modos ativos independentes do carro e cancela para pedestres', () => {
  it('caminhada funciona contra mão única onde carro não pode ir e exclui rodovia regional', () => {
    const w = run(world(71), 0.2);
    const R = w.roads;
    // isolated one-way street: car can only go n1->n2, never n2->n1
    const n1 = R.addNode(160, 160), n2 = R.addNode(300, 160);
    const e = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1, oneway: 1 });
    R.invalidateRoutes();
    const b1 = w.buildings.create('res', { x: 185, z: 175, angle: 0, edge: e.id, t: 0.2, side: 1, access: n1.id, offDist: 10, total: 0, terms: {} }, { era: 0, day: 0, w: 10, d: 10, maxDensity: 2, decision: null });
    const b2 = w.buildings.create('res', { x: 275, z: 175, angle: 0, edge: e.id, t: 0.8, side: 1, access: n2.id, offDist: 10, total: 0, terms: {} }, { era: 0, day: 0, w: 10, d: 10, maxDensity: 2, decision: null });
    expect(carPlan(R, b2, b1)).toBeNull();
    const walk = activePlan(R, b2, b1);
    expect(walk).not.toBeNull();
    expect(walk!.len).toBeGreaterThan(50);
    // walkRoute must never use Highway edges
    const hw = R.edges.find((x) => x.alive && x.progress >= 1 && x.cls === RoadClass.Highway);
    expect(hw).toBeTruthy();
    const route = R.walkRoute(hw!.a, hw!.b);
    if (route) expect(route.some((de) => R.edges[de >> 1].cls === RoadClass.Highway)).toBe(false);
  });

  it('pedestre para diante de cancela fechada (inclusive em avenida de 3 faixas) sem inchar a heap', () => {
    const w = world(72);
    const P = w.peds;
    // 3-lane avenue sidewalk sits ~12.2 m off the axis; oriented gate box covers carriageway + sidewalks
    P.closedGates = [{ x: 150, z: 100, ux: 1, uz: 0, halfW: 14 }];
    const slot = P.spawn([120, 112.2, 200, 112.2], 0, 1.5, 0, 0);
    expect(slot).toBeGreaterThanOrEqual(0);
    for (let k = 0; k < 80; k++) P.step(0.5); // 40 s waiting at the gate
    expect(P.active[slot]).toBe(1);
    P.pose(slot);
    expect(P.x[slot]).toBeLessThan(148);
    // heap must not accumulate stale entries while waiting
    expect((P as unknown as { q: { size: number } }).q.size).toBeLessThanOrEqual(2);
    // open the gate -> pedestrian finishes crossing and arrives
    P.closedGates = [];
    for (let k = 0; k < 120; k++) P.step(0.5);
    expect(P.active[slot]).toBe(0);
  });
});

describe('infraestrutura conectada: energia, água e coleta real de lixo', () => {
  it('bairro isolado fica sem energia e água mesmo com sobra global, e usina remota exige linha pronta', () => {
    const w = run(world(81), 0.3);
    const R = w.roads;
    // build an isolated road and house far from the village (> 250 m and disconnected graph)
    const na = R.addNode(1950, 1950), nb = R.addNode(2050, 1950);
    const isoEdge = R.addEdge(na.id, nb.id, RoadClass.Local, { progress: 1 });
    const isoHouse = w.buildings.create('res', { x: 2000, z: 1965, angle: 0, edge: isoEdge.id, t: 0.5, side: 1, access: na.id, offDist: 10, total: 0, terms: {} }, { era: 0, day: 0, w: 10, d: 10, maxDensity: 2, decision: null });
    isoHouse.state = 'done'; isoHouse.progress = 1;
    // add huge local surplus in the village so global supply >> demand
    const village = w.buildings.list.find((b) => b.state === 'done' && b.id !== isoHouse.id)!;
    const plant = w.buildings.create('thermalPlant', { x: village.x + 20, z: village.z + 20, angle: 0, edge: village.edge, t: village.edgeT, side: 1, access: 0, offDist: 10, total: 0, terms: {} }, { era: 1, day: 0, w: 20, d: 20, maxDensity: 2, decision: null });
    plant.state = 'done'; plant.progress = 1;
    const waterSrc = w.buildings.create('waterTreatment', { x: village.x - 20, z: village.z + 20, angle: 0, edge: village.edge, t: village.edgeT, side: 1, access: 0, offDist: 10, total: 0, terms: {} }, { era: 1, day: 0, w: 20, d: 20, maxDensity: 2, decision: null });
    waterSrc.state = 'done'; waterSrc.progress = 1;
    w.utils.hourly();
    expect(w.utils.power.supply).toBeGreaterThan(w.utils.power.demand);
    expect(w.utils.water.supply).toBeGreaterThan(w.utils.water.demand);
    expect(village.powered).toBe(true);
    expect(village.watered).toBe(true);
    expect(isoHouse.powered).toBe(false);
    expect(isoHouse.watered).toBe(false);
    // remote power plant (> 250 m from center) does not supply power while its transmission line has progress < 1
    const supplyBefore = w.utils.power.supply;
    const remotePlant = w.buildings.create('thermalPlant', { x: w.center.x + 600, z: w.center.z + 600, angle: 0, edge: -1, t: 0, side: 1, access: 0, offDist: 10, total: 0, terms: {} }, { era: 1, day: 0, w: 20, d: 20, maxDensity: 2, decision: null });
    remotePlant.state = 'done'; remotePlant.progress = 1;
    w.utils.hourly();
    expect(w.utils.power.supply).toBeCloseTo(supplyBefore, 3);
    // finish its transmission line -> supply rises
    for (const l of w.utils.powerLines) l.progress = 1;
    w.utils.hourly();
    expect(w.utils.power.supply).toBeGreaterThan(supplyBefore);
  });

  it('prédio desconectado na mesma célula de 25 m não derruba energia de prédio conectado', () => {
    const w = run(world(83), 0.3);
    const R = w.roads;
    const village = w.buildings.list.find((b) => b.state === 'done' && b.edge >= 0)!;
    const plant = w.buildings.create('thermalPlant', { x: village.x + 15, z: village.z + 15, angle: 0, edge: village.edge, t: village.edgeT, side: 1, access: 0, offDist: 10, total: 0, terms: {} }, { era: 1, day: 0, w: 20, d: 20, maxDensity: 2, decision: null });
    plant.state = 'done'; plant.progress = 1;
    // put an isolated dead edge 400 m away, and place a disconnected building + connected building in the SAME 25 m cell
    const na = R.addNode(1900, 1900), nb = R.addNode(1980, 1900);
    const isoEdge = R.addEdge(na.id, nb.id, RoadClass.Local, { progress: 1 });
    const disc = w.buildings.create('res', { x: 1940, z: 1910, angle: 0, edge: isoEdge.id, t: 0.5, side: 1, access: na.id, offDist: 10, total: 0, terms: {} }, { era: 0, day: 0, w: 10, d: 10, maxDensity: 2, decision: null });
    disc.state = 'done'; disc.progress = 1;
    // connected building right next to `disc` (same 25 m cell), attached to the village road
    const conn = w.buildings.create('res', { x: 1942, z: 1912, angle: 0, edge: village.edge, t: village.edgeT, side: 1, access: 0, offDist: 10, total: 0, terms: {} }, { era: 0, day: 0, w: 10, d: 10, maxDensity: 2, decision: null });
    conn.state = 'done'; conn.progress = 1;
    expect(w.fields.idx(disc.x, disc.z)).toBe(w.fields.idx(conn.x, conn.z));
    w.utils.hourly();
    expect(disc.powered).toBe(false);
    expect(conn.powered).toBe(true);
  });

  it('lixo só é removido quando o caminhão de coleta chega ao quarteirão e despacho escalonado evita explosão de spawnRefused', () => {
    const w = run(world(82), 0.3);
    const b = w.buildings.list.find((x) => x.state === 'done' && !x.def.public)!;
    const dump = w.buildings.create('dump', { x: b.x + 30, z: b.z + 30, angle: 0, edge: b.edge, t: b.edgeT, side: 1, access: 0, offDist: 10, total: 0, terms: {} }, { era: 0, day: 0, w: 20, d: 20, maxDensity: 2, decision: null });
    dump.state = 'done'; dump.progress = 1;
    for (const x of w.buildings.list) if (x.state === 'done' && !x.def.public) x.garbage = 6;
    const stockBefore = w.utils.garbage.stock;
    const refBefore = w.traffic.spawnRefused;
    w.utils.daily();
    // daily() dispatches at most a small shift per hour and breaks on occupied gate (never hammering spawn)
    expect(w.traffic.spawnRefused - refBefore).toBeLessThanOrEqual(2);
    // daily() does NOT magically zero garbage before arrival
    expect(b.garbage).toBeGreaterThanOrEqual(6);
    expect(w.utils.garbage.stock).toBe(stockBefore);
    // when a collection truck arrives, garbage drops and landfill stock rises
    const e = longEdge(w, 40);
    const slot = w.traffic.spawn(VType.Garbage, [e.id * 2], 10, e.len - 2, { kind: P_GARBAGE, id: b.id, aux: 40 }, dump.id, b.id);
    expect(slot).toBeGreaterThanOrEqual(0);
    w.services.arrived(slot);
    expect(b.garbage).toBeLessThan(6);
    expect(w.utils.garbage.stock).toBeGreaterThan(stockBefore);
  });
});

describe('metrô terminal e velocidade no inspetor do cidadão', () => {
  it('trem de metrô inverte no terminal sem saltar para fora dos trilhos', () => {
    const w = world(91);
    const rail = w.rail2 as unknown as {
      lines: { id: number; kind: string; len: number; x: number[]; z: number[]; y: number[]; cum: number[]; tracks: number; elevated: boolean; stations: { s: number; b: number; name: string; stop: number }[] }[];
      trains: { id: number; line: number; kind: string; s: number; dir: number; v: number; vmax: number; cars: number[]; dwell: number; served: Set<number>; gen: number }[];
    };
    const l = { id: rail.lines.length, kind: 'metro', len: 1000, x: [0, 1000], z: [0, 0], y: [10, 10], cum: [0, 1000], tracks: 2, elevated: true, stations: [] };
    rail.lines.push(l);
    const tr = { id: 777, line: l.id, kind: 'metro', s: 999, dir: 1, v: 10, vmax: 19, cars: [5, 5, 5, 5], dwell: 0, served: new Set<number>([0]), gen: 0 };
    rail.trains.push(tr);
    w.rail2.step(0.5);
    expect(tr.dir).toBe(-1);
    expect(tr.s).toBe(1000);
    expect(tr.dwell).toBeGreaterThanOrEqual(25);
  });

  it('inspetor do cidadão reporta velocidade atual em km/h quando em movimento', () => {
    const w = run(world(92), 0.3);
    const cid = w.citizens.add({ age: 25, hh: -1 });
    const pslot = w.peds.spawn([100, 100, 300, 100], cid, 1.5, 0, 0);
    w.citizens.state[cid] = ST_WALK;
    w.citizens.slot[cid] = pslot;
    const info = w.citizens.inspect(cid)!;
    expect(info.speedKmh).toBeCloseTo(w.peds.speed[pslot] * 3.6, 2);
  });
});

describe('auto-diretor: movimento contínuo sem pausas > 2 s', () => {
  it('mantém a câmera em movimento contínuo mesmo com alvo desaparecendo, parado ou sem geometria de trajetória', () => {
    let targetAlive = true;
    const dw: DirectorWorld = {
      groundClear: () => 20,
      mapSize: 2400,
      center: () => new THREE.Vector3(1200, 20, 1200),
      cityRadius: () => 500,
      buildingTop: () => 40,
      buildingProgress: () => 0.5,
      buildingPos: () => new THREE.Vector3(1200, 20, 1200),
      edgePts: () => null, // force travelling fallback
      edgeProgress: () => 0.5,
      vehiclePos: () => (targetAlive ? { p: new THREE.Vector3(1250, 21, 1250), h: 0 } : null), // stationary car that vanishes
      pedPos: () => null,
      trainPos: () => null,
      citizenPos: () => null,
      flyPaths: () => [], // force flyover fallback
      dateLabel: () => 'Ano 1',
    };
    const dir = new Director(dw);
    // inject chase, travelling and flyover-triggering events
    dir.feature({ id: 1, type: 'police_chase', t: 0, day: 1, x: 1250, z: 1250, mag: 1, text: 'Perseguição', entity: { kind: 'vehicle', id: 1, gen: 0 } });
    let lastPos = dir.pose.pos.clone();
    let still = 0, maxStill = 0, minClear = Infinity;
    for (let k = 0; k < 1200; k++) { // 40 seconds at 30 fps
      if (k === 180) targetAlive = false; // target disappears mid-chase
      if (k === 300) dir.feature({ id: 2, type: 'road_upgrade', t: 10, day: 1, x: 1100, z: 1100, mag: 1, text: 'Obra', entity: { kind: 'edge', id: 99 } });
      if (k === 600) dir.feature({ id: 3, type: 'power_line', t: 20, day: 1, x: 1300, z: 1300, mag: 1, text: 'Linha' });
      dir.update(1 / 30);
      const p = dir.pose.pos;
      if (p.distanceTo(lastPos) < 0.02) { still += 1 / 30; maxStill = Math.max(maxStill, still); }
      else still = 0;
      lastPos.copy(p);
      minClear = Math.min(minClear, p.y - dw.groundClear(p.x, p.z));
    }
    expect(maxStill).toBeLessThan(1.0); // strict margin well under the 2 s acceptance limit
    expect(minClear).toBeGreaterThanOrEqual(1.5);
  });
});
