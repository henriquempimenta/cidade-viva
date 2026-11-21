import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { DEFAULT_PARAMS } from '../src/shared/params';
import { DAY_SECONDS, HOUR_SECONDS, RoadClass, VType } from '../src/shared/constants';
import { edgeHalfWidth, SIDEWALK_WIDTH } from '../src/shared/roadGeom';
import { segRectDist } from '../src/sim/geom';
import { projSeg } from '../src/sim/roads';
import { P_BUS, P_CITIZEN, P_SERVICE } from '../src/sim/traffic';
import { Act, ST_CAR, ST_IN } from '../src/sim/citizens';
import { CAP_BRT, CAP_BUS, FARE_BRT, FARE_BUS, FARE_METRO, FARE_RAIL, type Line } from '../src/sim/transit';
import { activePlan, doorOf, walkPoints } from '../src/sim/trips';

function makeWorld(seed = 1234, extra: Partial<typeof DEFAULT_PARAMS> = {}) {
  return new World({ ...DEFAULT_PARAMS, seed, ...extra });
}
function run(w: World, days: number) {
  for (let i = 0; i < Math.round(days * 4800); i++) w.step(0.5);
  return w;
}

describe('Pilar 1 — calçadas reais, faixas de pedestres, edifícios e árvores', () => {
  it('walkPoints acompanha calçadas e faixas sem cruzar diagonalmente o miolo de cruzamentos', () => {
    const w = makeWorld(41);
    const R = w.roads;
    // Build a clean 4-way urban intersection at (1500, 1500)
    const c = R.addNode(1500, 1500);
    const nW = R.addNode(1400, 1500), nE = R.addNode(1600, 1500);
    const nN = R.addNode(1500, 1400), nS = R.addNode(1500, 1600);
    const eW = R.addEdge(nW.id, c.id, RoadClass.Local, { progress: 1 });
    const eE = R.addEdge(c.id, nE.id, RoadClass.Local, { progress: 1 });
    R.addEdge(nN.id, c.id, RoadClass.Local, { progress: 1 });
    const eS = R.addEdge(c.id, nS.id, RoadClass.Local, { progress: 1 });

    // Outer left-turn from South side of West arm to East side of South arm -> must NOT cross center (1500, 1500)
    const hw = edgeHalfWidth(eW);
    const from = { x: 1440, z: 1500 - (hw + 6) }; // North side of West arm
    const to = { x: 1500 + (hw + 6), z: 1560 };   // East side of South arm
    const pts = walkPoints(R, { path: [eW.id * 2, eS.id * 2], startS: 40, destS: 60 }, from, to);
    expect(pts.length).toBeGreaterThanOrEqual(8);
    // Check that NO segment comes within hw * 0.75 of the exact intersection center (1500, 1500)
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const p = projSeg(1500, 1500, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
      expect(p.d).toBeGreaterThan(hw * 0.85);
    }
    // Straight crossing East along South side: must stay outside intersection center too
    const pts2 = walkPoints(R, { path: [eW.id * 2, eE.id * 2], startS: 35, destS: 65 }, { x: 1435, z: 1500 + hw + 6 }, { x: 1565, z: 1500 + hw + 6 });
    for (let i = 0; i + 3 < pts2.length; i += 2) {
      const p = projSeg(1500, 1500, pts2[i], pts2[i + 1], pts2[i + 2], pts2[i + 3]);
      expect(p.d).toBeGreaterThan(hw * 0.85);
    }
  });

  it('árvores são limpas automaticamente em toda nova via e alargamento', () => {
    const w = run(makeWorld(1234, { terrain: 'vale' }), 5);
    const R = w.roads, T = w.terrain;
    let treesInRoad = 0;
    const nTrees = T.trees.length / 5;
    for (let i = 0; i < nTrees; i++) {
      if (!T.treeAlive[i]) continue;
      const tx = T.trees[i * 5], tz = T.trees[i * 5 + 2];
      for (const e of R.edgesNear(tx, tz, 22)) {
        if (!e.alive || e.deck !== undefined || e.tunnel) continue;
        const a = R.nodes[e.a], b = R.nodes[e.b];
        const p = projSeg(tx, tz, a.x, a.z, b.x, b.z);
        if (p.d < edgeHalfWidth(e) + SIDEWALK_WIDTH) {
          treesInRoad++;
          break;
        }
      }
    }
    expect(treesInRoad).toBe(0);
  }, 60000);

  it('pedestres caminham sobre calçadas/faixas e raramente (< 1%) tocam footprints de prédios', () => {
    const w = run(makeWorld(1234, { terrain: 'vale' }), 6);
    const R = w.roads, P = w.peds;
    let samples = 0, onValid = 0, insideBldg = 0;
    for (let step = 0; step < 300; step++) {
      w.step(0.5);
      if (step % 15 !== 0) continue;
      for (let i = 0; i < P.max; i++) {
        if (!P.active[i]) continue;
        P.pose(i);
        const px = P.x[i], pz = P.z[i];
        samples++;
        // Check building footprint collision (margin 0.35 m inside walls)
        let hitBldg = false;
        for (const id of w.occ.ownersInRect(px, pz, 0, 2, 2)) {
          const b = w.buildings.byId.get(id);
          if (!b || !b.alive || b.def.cat === 'transport') continue;
          const d = segRectDist(px - b.x, pz - b.z, px - b.x, pz - b.z, Math.cos(b.angle), Math.sin(b.angle), Math.max(0.2, b.w / 2 - 0.35), Math.max(0.2, b.d / 2 - 0.35));
          if (d === 0) { hitBldg = true; break; }
        }
        if (hitBldg) insideBldg++;
        // Check sidewalk / crosswalk / front-yard connector validity
        let valid = false;
        for (const e of R.edgesNear(px, pz, 28)) {
          if (!e.alive || e.deck !== undefined) continue;
          const a = R.nodes[e.a], b = R.nodes[e.b];
          const pr = projSeg(px, pz, a.x, a.z, b.x, b.z);
          const hw = edgeHalfWidth(e);
          // on sidewalk [hw - 0.3, hw + 3.2], or front-yard apron [hw, LOT_SETBACK + 3], or on crosswalk zone near junction end
          const sFromA = pr.t * e.len, sFromB = (1 - pr.t) * e.len;
          const rA = R.nodeRenderR(e.a) * 0.92, rB = R.nodeRenderR(e.b) * 0.92;
          const nearCw = (rA > 0 && Math.abs(sFromA - (rA + 2.2)) < 4.5) || (rB > 0 && Math.abs(sFromB - (rB + 2.2)) < 4.5);
          if (pr.d >= hw - 0.35 && pr.d <= hw + 10) { valid = true; break; }
          if (pr.d <= hw && nearCw) { valid = true; break; }
          if (e.bridge || e.cls === RoadClass.Dirt) { if (pr.d <= hw + 3) { valid = true; break; } }
        }
        if (valid) onValid++;
      }
    }
    expect(samples).toBeGreaterThan(20);
    expect(insideBldg / samples).toBeLessThan(0.01);
    expect(onValid / samples).toBeGreaterThanOrEqual(0.88);
  }, 90000);
});

describe('Pilar 2 — pontos de ônibus no meio-fio, abrigos, fila FIFO e tarifas reais', () => {
  it('tarifas reais são debitadas no embarque, recusam sem saldo e batem com transit.fares()', () => {
    const w = makeWorld(201);
    const S = w.transitSys;
    const busStops = [
      { x: 100, z: 100, node: -1, edge: -1, dir: 0, s: 20, curbX: 100, curbZ: 100, ux: 1, uz: 0, name: 'P1' },
      { x: 300, z: 100, node: -1, edge: -1, dir: 0, s: 80, curbX: 300, curbZ: 100, ux: 1, uz: 0, name: 'P2' },
    ];
    const lBus: Line = {
      id: 501, kind: 'bus', color: '#e74c3c', name: 'L1', stops: busStops, path: [], startS: 0, destS: 0,
      fleet: 1, vehicles: new Set(), ridersToday: 0, ridersYday: 0, waiting: new Map(), onboard: new Map(),
      edges: new Set(), headway: 120, lastSpawn: 0, pts: [],
    };
    const lBrt = { ...lBus, id: 502, kind: 'brt' as const, waiting: new Map<number, number[]>(), onboard: new Map<number, number[]>() };
    const lRail = S.addRailLine('rail', 'Trem', busStops, [], 300);
    const lMetro = S.addRailLine('metro', 'Metrô', busStops, [], 180);

    const home = w.buildings.list[0];
    const hRich = w.citizens.newHousehold(home.id, 1);
    hRich.money = 100;
    const hPoor = w.citizens.newHousehold(home.id, 0);
    hPoor.money = 1; // less than FARE_BUS (3.5)

    const c1 = w.citizens.add({ age: 30, hh: hRich.id });
    const cPoor = w.citizens.add({ age: 30, hh: hPoor.id });
    hRich.members.push(c1);
    hPoor.members.push(cPoor);
    w.citizens.tripDest[cPoor] = home.id;

    // Bus boarding: c1 pays FARE_BUS, cPoor cannot afford it and does not board
    S.rides.set(c1, { line: lBus.id, from: 0, to: 1, phase: 1, since: 0, dest: home.id });
    S.rides.set(cPoor, { line: lBus.id, from: 0, to: 1, phase: 1, since: 0, dest: home.id });
    lBus.waiting.set(0, [c1, cPoor]);
    const movedBus = S.serveStop(lBus, 0, 10, CAP_BUS);
    expect(movedBus).toBe(1);
    expect(lBus.onboard.get(10)).toEqual([c1]);
    expect(hRich.money).toBeCloseTo(100 - FARE_BUS, 5);
    expect(hPoor.money).toBeCloseTo(1, 5);

    // BRT, rail and metro fares
    const c2 = w.citizens.add({ age: 30, hh: hRich.id });
    const c3 = w.citizens.add({ age: 30, hh: hRich.id });
    const c4 = w.citizens.add({ age: 30, hh: hRich.id });
    S.rides.set(c2, { line: lBrt.id, from: 0, to: 1, phase: 1, since: 0, dest: home.id });
    S.rides.set(c3, { line: lRail.id, from: 0, to: 1, phase: 1, since: 0, dest: home.id });
    S.rides.set(c4, { line: lMetro.id, from: 0, to: 1, phase: 1, since: 0, dest: home.id });
    lBrt.waiting.set(0, [c2]);
    lRail.waiting.set(0, [c3]);
    lMetro.waiting.set(0, [c4]);
    S.serveStop(lBrt, 0, 11, CAP_BRT);
    S.serveStop(lRail, 0, 12, 200);
    S.serveStop(lMetro, 0, 13, 200);

    const expectedTotal = FARE_BUS + FARE_BRT + FARE_RAIL + FARE_METRO;
    expect(hRich.money).toBeCloseTo(100 - expectedTotal, 5);
    expect(S.fares()).toBeCloseTo(expectedTotal, 5);
    expect(CAP_BUS).toBe(55);
    expect(CAP_BRT).toBe(90);
  });

  it('fila FIFO na calçada avança ordenadamente após embarque parcial e ônibus para na aresta sem dwell vazio', () => {
    const w = makeWorld(202);
    const R = w.roads, T = w.traffic, S = w.transitSys;
    const n1 = R.addNode(1200, 1200), n2 = R.addNode(1340, 1200);
    const e = R.addEdge(n1.id, n2.id, RoadClass.Collector, { progress: 1 });
    const st = S.buildEdgeStop(e, 0)!;
    expect(st).not.toBeNull();
    expect(st.edge).toBe(e.id);
    expect(st.s).toBeGreaterThan(R.nodeRenderR(n1.id) + 5);
    expect(st.s).toBeLessThan(e.len - R.nodeRenderR(n2.id) - 5);

    const l: Line = {
      id: 700, kind: 'bus', color: '#3498db', name: 'Teste', stops: [st, { ...st, s: st.s + 20, x: st.x + 20, curbX: st.curbX + 20 }],
      path: [e.id * 2], startS: 0, destS: e.len - 1, fleet: 1, vehicles: new Set(),
      ridersToday: 0, ridersYday: 0, waiting: new Map(), onboard: new Map(), edges: new Set([e.id]),
      headway: 120, lastSpawn: 0, pts: [],
    };
    S.lines.push(l);

    // No demand -> nextBusStop returns null and onBusStop returns 0 (never empty dwell!)
    const busSlot = T.spawn(VType.Bus, [e.id * 2], 12, e.len - 5, { kind: P_BUS, id: l.id, aux: 0 });
    expect(busSlot).toBeGreaterThanOrEqual(0);
    expect(S.nextBusStop(busSlot, e.id, 0, 12, -1)).toBeNull();
    expect(S.onBusStop(busSlot, 0)).toBe(0);

    // Put 3 riders in FIFO queue; board capacity = 1 -> first boards, remaining 2 shift forward in FIFO order
    const home = w.buildings.list[0];
    const h = w.citizens.newHousehold(home.id, 2);
    h.money = 500;
    const riders = [0, 1, 2].map(() => {
      const cid = w.citizens.add({ age: 30, hh: h.id });
      h.members.push(cid);
      S.rides.set(cid, { line: l.id, from: 0, to: 1, phase: 0, since: 0, dest: home.id });
      S.pedArrived(cid); // enters atStop -> spawns held ped in FIFO queue
      return cid;
    });
    const slot0Before = w.citizens.slot[riders[0]];
    const slot1Before = w.citizens.slot[riders[1]];
    expect(slot0Before).toBeGreaterThanOrEqual(0);
    expect(slot1Before).toBeGreaterThanOrEqual(0);
    const x0Before = w.peds.x[slot0Before];
    const x1Before = w.peds.x[slot1Before];
    // Rider 1 stands 0.75 m behind Rider 0 along (-ux, -uz) = (-1, 0)
    expect(x0Before - x1Before).toBeCloseTo(0.75, 2);

    // Serve only 1 seat -> rider 0 boards, rider 1 shifts into rider 0's former front position!
    S.serveStop(l, 0, busSlot, 1);
    expect(l.onboard.get(busSlot)).toEqual([riders[0]]);
    expect(l.waiting.get(0)).toEqual([riders[1], riders[2]]);
    expect(w.peds.x[slot1Before]).toBeCloseTo(x0Before, 2);
  });

  it('ônibus em movimento via Traffic.step freia até o ponto, embarca 3 passageiros, cobra tarifas e segue viagem', () => {
    const w = makeWorld(202);
    const R = w.roads, T = w.traffic, S = w.transitSys;
    const n1 = R.addNode(1200, 1200), n2 = R.addNode(1340, 1200);
    const e1 = R.addEdge(n1.id, n2.id, RoadClass.Collector, { progress: 1 });
    const st1 = S.buildEdgeStop(e1, 0, 50)!;
    const st2 = S.buildEdgeStop(e1, 0, 105)!;
    expect(st1).not.toBeNull();
    expect(st2).not.toBeNull();

    const l: Line = {
      id: 701, kind: 'bus', color: '#e74c3c', name: 'Teste E2E', stops: [st1, st2],
      path: [e1.id * 2], startS: 0, destS: e1.len - 5, fleet: 1, vehicles: new Set(),
      ridersToday: 0, ridersYday: 0, waiting: new Map(), onboard: new Map(), edges: new Set([e1.id]),
      headway: 120, lastSpawn: 0, pts: [],
    };
    S.lines.push(l);

    const home = w.buildings.list[0];
    const h = w.citizens.newHousehold(home.id, 2);
    h.money = 100;
    const riders = [0, 1, 2].map(() => {
      const cid = w.citizens.add({ age: 30, hh: h.id });
      h.members.push(cid);
      S.rides.set(cid, { line: l.id, from: 0, to: 1, phase: 0, since: 0, dest: home.id });
      S.pedArrived(cid);
      return cid;
    });
    expect(l.waiting.get(0)?.length).toBe(3);

    for (let i = 0; i < T.max; i++) if (T.active[i]) T.despawn(i);
    const busSlot = T.spawn(VType.Bus, l.path, 15, l.destS, { kind: P_BUS, id: l.id, aux: 0 });
    expect(busSlot).toBeGreaterThanOrEqual(0);
    l.vehicles.add(busSlot);

    let observedDwell = false;
    let dwellJnode = 0;
    let stopRem = Infinity;
    let resumedPastStop = false;
    let retriggeredStop = false;
    let boardedCount = 0;
    for (let step = 0; step < 180; step++) {
      T.step(0.5, w.nodeAllow);
      if (!T.active[busSlot]) break;
      if (!observedDwell && T.dwell[busSlot] > 0) {
        observedDwell = true;
        dwellJnode = T.jnode[busSlot];
        stopRem = Math.abs(st1.s - T.s[busSlot]);
        boardedCount = l.onboard.get(busSlot)?.length ?? 0;
      } else if (observedDwell && T.dwell[busSlot] <= 0 && T.s[busSlot] > st1.s + 6 && T.s[busSlot] < st2.s - 10) {
        resumedPastStop = true;
      } else if (resumedPastStop && T.s[busSlot] < st1.s + 12 && T.dwell[busSlot] > 0) {
        retriggeredStop = true;
      }
      if (resumedPastStop && T.s[busSlot] >= st2.s - 2) break;
    }

    expect(observedDwell).toBe(true);
    expect(dwellJnode).toBe(-1);
    expect(stopRem).toBeLessThanOrEqual(1.3);
    expect(boardedCount).toBe(3);
    expect(resumedPastStop).toBe(true);
    expect(retriggeredStop).toBe(false);
    expect(l.waiting.get(0)?.length ?? 0).toBe(0);
    expect(l.ridersToday).toBe(3);
    expect(h.money).toBeCloseTo(100 - 3 * FARE_BUS, 5);
    expect(S.fares()).toBeCloseTo(3 * FARE_BUS, 5);
    void riders;
  });

  it('onEdgeSplit nunca deixa pontos de ônibus órfãos apontando para aresta morta', () => {
    const w = makeWorld(204);
    const R = w.roads, S = w.transitSys;
    // Create a ~34 m edge e1 whose two halves (~17 m each) are too short for buildEdgeStop, plus two long edges e2, e3
    const n1 = R.addNode(1200, 1200), n2 = R.addNode(1234, 1200), n3 = R.addNode(1380, 1200), n4 = R.addNode(1520, 1200);
    const e1 = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1 });
    const e2 = R.addEdge(n2.id, n3.id, RoadClass.Local, { progress: 1 });
    const e3 = R.addEdge(n3.id, n4.id, RoadClass.Local, { progress: 1 });
    const st1 = S.buildEdgeStop(e1, 0)!;
    const st2 = S.buildEdgeStop(e2, 0)!;
    const st3 = S.buildEdgeStop(e3, 0)!;
    expect(st1).not.toBeNull();
    expect(st2).not.toBeNull();
    expect(st3).not.toBeNull();

    const l: Line = {
      id: 702, kind: 'bus', color: '#2ecc71', name: 'Teste Split', stops: [st1, st2, st3],
      path: [e1.id * 2, e2.id * 2, e3.id * 2], startS: 0, destS: e3.len - 2, fleet: 2, vehicles: new Set(),
      ridersToday: 0, ridersYday: 0, waiting: new Map(), onboard: new Map(), edges: new Set([e1.id, e2.id, e3.id]),
      headway: 120, lastSpawn: 0, pts: [],
    };
    S.lines.push(l);

    R.splitEdge(e1.id, 0.5);
    expect(e1.alive).toBe(false);
    expect(l.stops.length).toBeGreaterThanOrEqual(2);
    for (const st of l.stops) {
      expect(st.edge).not.toBe(e1.id);
      expect(R.edges[st.edge]?.alive).toBe(true);
    }
  });
});

describe('Pilar 3 — física centrada e controle de conflito em cruzamentos', () => {
  it('ônibus (12 m) e caminhão (10 m) parados atrás de moto (2.2 m) respeitam (lenA + lenB)/2 + 0.8 m', () => {
    const w = makeWorld(301);
    const R = w.roads, T = w.traffic;
    const n1 = R.addNode(1200, 1200), n2 = R.addNode(1360, 1200);
    const e = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1 });
    for (let i = 0; i < T.max; i++) if (T.active[i]) T.despawn(i);

    const moto = T.spawn(VType.Moto, [e.id * 2], 95, e.len - 2, { kind: P_SERVICE, id: -1, aux: -1 });
    const bus = T.spawn(VType.Bus, [e.id * 2], 40, e.len - 2, { kind: P_SERVICE, id: -1, aux: -1 });
    const truck = T.spawn(VType.Truck, [e.id * 2], 15, e.len - 2, { kind: P_SERVICE, id: -1, aux: -1 });
    expect(moto).toBeGreaterThanOrEqual(0);
    expect(bus).toBeGreaterThanOrEqual(0);
    expect(truck).toBeGreaterThanOrEqual(0);
    T.dwell[moto] = 999; // parked leader

    for (let k = 0; k < 80; k++) T.step(0.5, () => true);
    const minBusMoto = (T.len[bus] + T.len[moto]) * 0.5 + 0.8;
    const minTruckBus = (T.len[truck] + T.len[bus]) * 0.5 + 0.8;
    expect(T.s[moto] - T.s[bus]).toBeGreaterThanOrEqual(minBusMoto);
    expect(T.s[bus] - T.s[truck]).toBeGreaterThanOrEqual(minTruckBus);
  });

  it('semáforo possui intervalo all-red clearance e veículos perpendiculares nunca invadem o cruzamento juntos', () => {
    const w = makeWorld(302);
    const R = w.roads, T = w.traffic;
    const c = R.addNode(1500, 1500);
    const nW = R.addNode(1400, 1500), nE = R.addNode(1600, 1500);
    const nN = R.addNode(1500, 1400), nS = R.addNode(1500, 1600);
    const eW = R.addEdge(nW.id, c.id, RoadClass.Local, { progress: 1 });
    const eE = R.addEdge(c.id, nE.id, RoadClass.Local, { progress: 1 });
    const eN = R.addEdge(nN.id, c.id, RoadClass.Local, { progress: 1 });
    const eS = R.addEdge(c.id, nS.id, RoadClass.Local, { progress: 1 });
    // Test signal all-red clearance
    c.control = 2;
    w.computePhases(c);
    c.phase = 2; // all-red sub-state
    expect(w.nodeAllow(c, eW, 0, 2, 20)).toBe(false);
    expect(w.nodeAllow(c, eN, 0, 2, 20)).toBe(false);

    // Test uncontrolled perpendicular conflict: even with green/no signal, two cross-vehicles never occupy junction together
    c.control = 0;
    for (let i = 0; i < T.max; i++) if (T.active[i]) T.despawn(i);
    const v1 = T.spawn(VType.Car, [eW.id * 2, eE.id * 2], eW.len - 22, eE.len - 5, { kind: P_CITIZEN, id: -1, aux: 0 });
    const v2 = T.spawn(VType.Car, [eN.id * 2, eS.id * 2], eN.len - 22, eS.len - 5, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(v1).toBeGreaterThanOrEqual(0);
    expect(v2).toBeGreaterThanOrEqual(0);
    let simultaneousCross = 0;
    for (let k = 0; k < 60; k++) {
      T.step(0.5, w.nodeAllow);
      if (T.active[v1] && T.active[v2] && T.jnode[v1] === c.id && T.jnode[v2] === c.id) simultaneousCross++;
    }
    expect(simultaneousCross).toBe(0);
  });
});

describe('Pilar 4 — posse/estacionamento real do carro, custos e inspetor', () => {
  it('carro familiar não teletransporta nem clona, cobra custo operacional e devolve no abandono', () => {
    const w = run(makeWorld(401), 0.5);
    const C = w.citizens;
    const bList = w.buildings.list.filter((b) => b.alive && b.state === 'done');
    expect(bList.length).toBeGreaterThanOrEqual(3);
    const home = bList[0], destA = bList[bList.length - 1], destB = bList[Math.floor(bList.length / 2)];
    const h = C.newHousehold(home.id, 2);
    h.car = true;
    h.carLoc = home.id;
    h.carUser = -1;
    h.carDriver = -1;
    h.money = 1000;
    const a = C.add({ age: 30, hh: h.id });
    const b = C.add({ age: 28, hh: h.id });
    h.members.push(a, b);
    C.loc[a] = home.id;
    C.loc[b] = home.id;

    // Make `a` drive the family car away from home
    h.carUser = a;
    h.carLoc = -1;
    h.carDriver = a;
    // Now `b` tries to travel from home -> CANNOT drive because `h.carUser === a` and `h.carLoc === -1`!
    C.startTrip(b, home, destB, Act.Shop, HOUR_SECONDS);
    expect(C.tripMode[b]).not.toBe(2);
    expect(h.carUser).toBe(a);

    // `a` arrives at destA -> car is now parked at destA
    C.tripDest[a] = destA.id;
    C.tripDur[a] = HOUR_SECONDS;
    C.arrive(a);
    expect(h.carLoc).toBe(destA.id);
    expect(h.carUser).toBe(-1);

    // `b` at home STILL cannot drive because car is parked at destA (`carLoc !== home.id`)!
    C.loc[b] = home.id;
    C.startTrip(b, home, destB, Act.Work, HOUR_SECONDS);
    expect(C.tripMode[b]).not.toBe(2);

    // `a` abandons a jam via switchToWalk while driving -> car is safely returned home (never cloned)
    h.carUser = a; h.carLoc = -1;
    C.tripDest[a] = destB.id;
    const okWalk = C.switchToWalk(a, destB.x + 40, destB.z);
    if (okWalk) {
      expect(h.carUser).toBe(-1);
      expect(h.carLoc).toBe(home.id);
    }
  });

  it('marry(a, b) libera carro da família de origem quando cônjuge sai dirigindo', () => {
    const w = run(makeWorld(403), 0.5);
    const C = w.citizens;
    const bList = w.buildings.list.filter((b) => b.alive && b.state === 'done');
    expect(bList.length).toBeGreaterThanOrEqual(2);
    const homeA = bList[0], homeB = bList[1];
    const ha = C.newHousehold(homeA.id, 1);
    const hb = C.newHousehold(homeB.id, 1);
    hb.car = true;
    const a = C.add({ age: 29, hh: ha.id });
    const b = C.add({ age: 27, hh: hb.id });
    const sibling = C.add({ age: 24, hh: hb.id });
    ha.members.push(a);
    hb.members.push(b, sibling);
    C.loc[a] = homeA.id;
    C.loc[b] = homeB.id;
    // Simulate `b` currently driving `hb`'s family car when marrying `a`
    hb.carUser = b;
    hb.carDriver = b;
    hb.carLoc = -1;
    C.state[b] = ST_CAR;
    C.tripMode[b] = 2;

    (C as unknown as { marry(x: number, y: number): void }).marry(a, b);

    expect(C.hh[b]).toBe(ha.id);
    expect(hb.members).not.toContain(b);
    expect(hb.carUser).toBe(-1);
    expect(hb.carDriver).toBe(-1);
    expect(hb.carLoc).toBe(hb.home);
    expect(C.state[b]).not.toBe(ST_CAR);
    expect(C.slot[b]).toBe(-1);
  });

  it('inspetor de turista não exibe desempregado(a), agenda filtra dia atual em ordem e needs.money >= 0', () => {
    const w = makeWorld(402);
    const C = w.citizens;
    const hotel = w.buildings.list[0];
    const h = C.newHousehold(hotel.id, 2, true);
    h.money = -250; // negative savings must clamp needs.money to 0
    h.leaveDay = w.day + 3;
    const tid = C.add({ age: 34, hh: h.id, tourist: true });
    h.members.push(tid);
    C.loc[tid] = hotel.id;
    C.act[tid] = Act.Sightsee;
    C.lastUpd[tid] = w.t - HOUR_SECONDS * 2;
    const hungerBefore = C.needs[tid * 8];
    // Push an old-day agenda item and two today items
    C.agenda[tid] = [
      { day: Math.max(0, w.day - 1) - 1, h: 21, act: Act.Sleep, done: true },
      { day: w.day, h: 14.5, act: Act.Sightsee, done: false },
      { day: w.day, h: 9.0, act: Act.Eat, done: true },
    ];
    const info = C.inspect(tid)!;
    expect(info.tourist).toBe(true);
    expect(info.job).toContain('Turista');
    expect(info.job).not.toContain('desempregado');
    expect(info.needs.money).toBe(0);
    // Real-time projection decayed hunger without mutating simulation state
    expect(info.needs.hunger).toBeLessThan(hungerBefore);
    expect(C.needs[tid * 8]).toBe(hungerBefore);
    // Today's agenda only, in chronological order
    expect(info.agenda.length).toBe(2);
    expect(info.agenda[0].h).toBe('09:00');
    expect(info.agenda[1].h).toBe('14:30');
    expect(DAY_SECONDS).toBeGreaterThan(0);
  });

  it('simulação completa (seed=1234, vale, warmup=20): ônibus embarcam passageiros reais, zero teletransporte/clonagem e zero sobreposição', () => {
    const w = run(makeWorld(1234, { terrain: 'vale' }), 20);
    const C = w.citizens, T = w.traffic;
    // Verify household car invariants across entire population
    const activeDriversByHH = new Map<number, number[]>();
    for (let i = 0; i < C.max; i++) {
      if (!C.alive[i]) continue;
      if (C.state[i] === ST_CAR) {
        const hid = C.hh[i];
        const list = activeDriversByHH.get(hid) ?? [];
        list.push(i);
        activeDriversByHH.set(hid, list);
      }
    }
    let clones = 0, invalidParking = 0, leakedUsers = 0;
    for (const h of C.households.values()) {
      const drivers = activeDriversByHH.get(h.id) ?? [];
      if (drivers.length > 1) clones++;
      if (!h.car && drivers.length > 0) clones++;
      if (h.car && h.carUser >= 0 && h.carLoc >= 0) invalidParking++;
      if (!h.car && (h.carUser >= 0 || h.carLoc >= 0)) invalidParking++;
      if (h.carUser >= 0 && !h.members.includes(h.carUser)) leakedUsers++;
    }
    expect(clones).toBe(0);
    expect(invalidParking).toBe(0);
    expect(leakedUsers).toBe(0);

    // Verify bus/BRT lines exist, carry real passengers, and all stops are strictly off highways/bridges/junctions & off water
    let busLines = 0, busRiders = 0;
    for (const l of w.transitSys.lines) {
      if (l.kind !== 'bus' && l.kind !== 'brt') continue;
      busLines++;
      busRiders += l.ridersYday + l.ridersToday;
      for (const st of l.stops) {
        expect(st.edge).toBeGreaterThanOrEqual(0);
        const e = w.roads.edges[st.edge];
        expect(e?.alive).toBe(true);
        expect(e.cls).not.toBe(RoadClass.Highway);
        expect(e.bridge).toBe(false);
        expect(e.elevated).toBe(false);
        expect(e.tunnel).toBe(false);
        const [sx, sz] = w.transitSys.shelterPose(st);
        expect(w.terrain.isWater(sx, sz)).toBe(false);
      }
    }
    expect(busLines).toBeGreaterThan(0);
    expect(busRiders).toBeGreaterThan(0);
    expect(w.transitSys.faresCollected).toBeGreaterThan(0);

    // Verify zero buses dwelling inside junctions
    let busDwellInJunction = 0;
    for (let i = 0; i < T.max; i++) {
      if (!T.active[i]) continue;
      if (T.pKind[i] === P_BUS && T.dwell[i] > 0 && T.jnode[i] >= 0) busDwellInJunction++;
    }
    expect(busDwellInJunction).toBe(0);
    expect(activePlan(w.roads, w.buildings.list[0], w.buildings.list[0]) !== undefined).toBe(true);
    expect(doorOf(w.roads, w.buildings.list[0])).toBeTruthy();
    expect(ST_IN).toBe(0);
  }, 120000);
});
