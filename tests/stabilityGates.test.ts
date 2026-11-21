import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { DEFAULT_PARAMS } from '../src/shared/params';
import { RoadClass, VEH_FLAG_SIREN, VType } from '../src/shared/constants';
import { pickVehiclePreset, VEHICLE_MESH_LEN } from '../src/shared/vehiclePresets';
import { buildVehicle, VEHICLE_PRESETS } from '../src/render/vehicleGeom';
import { P_CITIZEN, P_SERVICE } from '../src/sim/traffic';
import { ST_IN, ST_TRANSIT } from '../src/sim/citizens';
import { activePlan } from '../src/sim/trips';
import { WorkerBackend } from '../src/sim/routeKernel';
import type { Line } from '../src/sim/transit';

function makeWorld(seed = 1234, extra: Partial<typeof DEFAULT_PARAMS> = {}) {
  return new World({ ...DEFAULT_PARAMS, seed, ...extra });
}
function run(w: World, days: number) {
  const steps = Math.round(days * 4800);
  for (let i = 0; i < steps; i++) w.step(0.5);
  return w;
}
async function runAsync(w: World, days: number) {
  const steps = Math.round(days * 4800);
  for (let i = 0; i < steps; i++) {
    w.step(0.5);
    if ((i & 2047) === 2047) await new Promise((r) => setImmediate(r));
  }
  return w;
}

describe('Rodada de Estabilização — Gates Quantitativos e Sondas Críticas', () => {
  it('walkRoute / activePlan alcança >= 95% de sucesso em 200 pares de prédios no dia 20 (seed=1234, vale)', async () => {
    const w = await runAsync(makeWorld(1234, { terrain: 'vale' }), 20);
    const done = w.buildings.list.filter((b) => b.alive && b.state === 'done');
    expect(done.length).toBeGreaterThan(40);
    let ok = 0;
    const N = 200;
    // deterministic pseudo-random pairs
    let s = 1234567;
    const next = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    for (let k = 0; k < N; k++) {
      const a = done[Math.floor(next() * done.length)];
      let b = done[Math.floor(next() * done.length)];
      if (b.id === a.id) b = done[(done.indexOf(a) + 1) % done.length];
      if (activePlan(w.roads, a, b, 5200)) ok++;
    }
    const rate = ok / N;
    expect(rate).toBeGreaterThanOrEqual(0.95);
  }, 120000);

  it('saúde de fluxo em 40 dias (seed=1234, vale): viagens > 70k, despawns < 2,5%, red-light === 0, bikes > 10k, lixo < 0,30, zero sobreposições', async () => {
    const w = makeWorld(1234, { terrain: 'vale' });
    const T = w.traffic;
    const steps = Math.round(40 * 4800);
    let overlaps = 0;
    const scanLaneOverlaps = () => {
      const buckets = new Map<number, number[]>();
      for (let i = 0; i < T.max; i++) {
        if (!T.active[i] || T.lat[i] > 1.0) continue;
        const key = ((T.edge[i] * 2 + T.dir[i]) * 8) + T.lane[i];
        let b = buckets.get(key);
        if (!b) { b = []; buckets.set(key, b); }
        b.push(i);
      }
      for (const b of buckets.values()) {
        if (b.length < 2) continue;
        b.sort((a, c) => T.s[a] - T.s[c]);
        for (let k = 1; k < b.length; k++) {
          const r = b[k - 1], f = b[k];
          const gap = (T.s[f] - T.s[r]) - (T.len[f] + T.len[r]) * 0.5;
          if (gap < -0.05) overlaps++;
        }
      }
    };
    for (let i = 0; i < steps; i++) {
      w.step(0.5);
      if (i % 40 === 0) scanLaneOverlaps();
      if ((i & 2047) === 2047) await new Promise((r) => setImmediate(r));
    }
    const completedTrips = w.citizens.tripsCompleted;
    const vehArrivals = T.arrivals;
    const stuckRate = T.despawnsStuck / Math.max(1, vehArrivals);
    const bikeTrips = w.citizens.modeCount[1];
    const privateBld = w.buildings.list.filter((b) => b.alive && b.state === 'done' && !b.def.public);
    const avgGarbage = privateBld.reduce((acc, b) => acc + b.garbage, 0) / Math.max(1, privateBld.length);

    expect(completedTrips).toBeGreaterThan(70000);
    expect(vehArrivals).toBeGreaterThan(50000);
    expect(stuckRate).toBeLessThan(0.025);
    expect(T.despawnsRedLight).toBe(0);
    expect(bikeTrips).toBeGreaterThan(10000);
    expect(avgGarbage).toBeLessThan(0.30);
    expect(overlaps).toBe(0);
  }, 240000);

  it('passageiro zumbi: remover cidadão esperando e reusar mesmo ID não embarca nem debita tarifa', () => {
    const w = makeWorld(501);
    const S = w.transitSys;
    const home = w.buildings.list[0];
    const hOld = w.citizens.newHousehold(home.id, 1);
    hOld.money = 100;
    const hNew = w.citizens.newHousehold(home.id, 1);
    hNew.money = 100;

    const s1 = { id: S.allocStopId(), x: 100, z: 100, node: -1, edge: -1, dir: 0, s: 20, curbX: 100, curbZ: 100, ux: 1, uz: 0, name: 'S1' };
    const s2 = { id: S.allocStopId(), x: 300, z: 100, node: -1, edge: -1, dir: 0, s: 80, curbX: 300, curbZ: 100, ux: 1, uz: 0, name: 'S2' };
    const l: Line = {
      id: 801, kind: 'bus', color: '#e74c3c', name: 'Teste Zumbi', stops: [s1, s2],
      path: [], startS: 0, destS: 0, fleet: 1, vehicles: new Set(), ridersToday: 0, ridersYday: 0,
      waiting: new Map(), onboard: new Map(), edges: new Set(), headway: 120, lastSpawn: 0, pts: [],
    };
    S.lines.push(l);

    const oldId = w.citizens.add({ age: 30, hh: hOld.id });
    hOld.members.push(oldId);
    const oldGen = w.citizens.gen[oldId];
    w.citizens.state[oldId] = ST_TRANSIT;
    S.rides.set(oldId, { line: l.id, fromId: s1.id, toId: s2.id, gen: oldGen, phase: 1, since: 0, dest: home.id });
    l.waiting.set(s1.id, [oldId]);

    // Remove citizen -> immediately reuse exact same slot ID for a brand new resident
    w.citizens.remove(oldId);
    const newId = w.citizens.add({ age: 25, hh: hNew.id });
    hNew.members.push(newId);
    expect(newId).toBe(oldId);
    expect(w.citizens.gen[newId]).not.toBe(oldGen);
    expect(w.citizens.state[newId]).toBe(ST_IN);

    // Even if a stale entry were somehow left in waiting, serveStop must reject by gen/state
    S.rides.set(newId, { line: l.id, fromId: s1.id, toId: s2.id, gen: oldGen, phase: 1, since: 0, dest: home.id });
    l.waiting.set(s1.id, [newId]);
    const faresBefore = S.faresCollected;
    const moved = S.serveStop(l, 0, 77, 55);
    expect(moved).toBe(0);
    expect(l.onboard.get(77)?.length ?? 0).toBe(0);
    expect(hNew.money).toBe(100);
    expect(S.faresCollected).toBe(faresBefore);
  });

  it('cancela fechada: bloqueia spawn dentro/através da barreira e bloqueia aproximação', () => {
    const w = makeWorld(502);
    const R = w.roads, T = w.traffic;
    const n1 = R.addNode(1100, 1100), n2 = R.addNode(1240, 1100);
    const e = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1 });
    for (let i = 0; i < T.max; i++) if (T.active[i]) T.despawn(i);

    // Close crossing at midpoint (s = 70 m)
    T.closedCrossings.set(e.id, [0.5]);
    // Spawn directly at the closed crossing must NOT place a vehicle inside [65, 75] or past the barrier
    const onGate = T.spawn(VType.Car, [e.id * 2], 70, e.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    if (onGate >= 0) {
      expect(T.s[onGate] + T.len[onGate] * 0.5).toBeLessThanOrEqual(65.01);
      T.despawn(onGate);
    }
    // Spawn ahead of barrier and run: must stop strictly before cs - 5 and never cross
    const approach = T.spawn(VType.Car, [e.id * 2], 15, e.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(approach).toBeGreaterThanOrEqual(0);
    for (let k = 0; k < 200; k++) T.step(0.5, () => true); // 100 s (> STUCK_LIMIT): must NOT despawn either!
    expect(T.active[approach]).toBe(1);
    expect(T.s[approach] + T.len[approach] * 0.5).toBeLessThanOrEqual(66);
  });

  it('trecho curto: caminhão de 9+ m é recusado em trecho de 6 m', () => {
    const w = makeWorld(503);
    const R = w.roads, T = w.traffic;
    const n1 = R.addNode(1400, 1400), n2 = R.addNode(1406, 1400);
    const shortEdge = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1 });
    expect(shortEdge.len).toBeCloseTo(6, 1);
    const slot = T.spawn(VType.Fire, [shortEdge.id * 2], 3, 5, { kind: P_SERVICE, id: -1, aux: -1 });
    expect(slot).toBe(-1);
  });

  it('faixa BRT exclusiva: carros comuns nunca ocupam e.busLane em spawn nem em transição de cruzamento', () => {
    const w = makeWorld(504);
    const R = w.roads, T = w.traffic;
    const n1 = R.addNode(1000, 1200), n2 = R.addNode(1140, 1200), n3 = R.addNode(1280, 1200);
    const e1 = R.addEdge(n1.id, n2.id, RoadClass.Avenue, { progress: 1, lanes: 2 });
    const e2 = R.addEdge(n2.id, n3.id, RoadClass.Avenue, { progress: 1, lanes: 2 });
    e1.busLane = true;
    e2.busLane = true;
    for (let i = 0; i < T.max; i++) if (T.active[i]) T.despawn(i);

    // Fill lane 0 on e1 and e2 with parked cars so only lane 1 (busLane) is empty
    const block1 = T.spawn(VType.Car, [e1.id * 2], 30, e1.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(block1).toBeGreaterThanOrEqual(0);
    expect(T.lane[block1]).toBe(0);
    // Spawning another car at the exact same spot (with lane 0 blocked around s=30..60) must NEVER use lane 1
    for (let s = 15; s <= 55; s += 8) {
      const c = T.spawn(VType.Car, [e1.id * 2], s, e1.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
      if (c >= 0) expect(T.lane[c]).toBe(0);
    }
    // Now test junction transition fallback: block lane 0 at the entry of e2, leaving lane 1 (busLane) completely free
    for (let i = 0; i < T.max; i++) if (T.active[i]) T.despawn(i);
    const parked = T.spawn(VType.Car, [e2.id * 2], T.sStart(e2, 0) + 4, e2.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(parked).toBeGreaterThanOrEqual(0);
    expect(T.lane[parked]).toBe(0);
    T.dwell[parked] = 999;

    const car = T.spawn(VType.Car, [e1.id * 2, e2.id * 2], e1.len - 18, e2.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(car).toBeGreaterThanOrEqual(0);
    expect(T.lane[car]).toBe(0);
    for (let k = 0; k < 40; k++) {
      T.step(0.5, () => true);
      if (T.active[car] && T.edge[car] === e2.id) expect(T.lane[car]).toBe(0);
    }
    // Bus and siren emergency CAN use lane 1 (busLane)
    expect(T.allowedLanes(e2, VType.Bus, 0)).toEqual([0, 1]);
    expect(T.allowedLanes(e2, VType.Ambulance, VEH_FLAG_SIREN)).toEqual([0, 1]);
    expect(T.allowedLanes(e2, VType.Car, 0)).toEqual([0]);
  });

  it('chegada fictícia de serviço removida: carro-bomba parado a 22 m do incêndio por > 10 s NÃO apaga o fogo', () => {
    const w = makeWorld(505);
    const R = w.roads, T = w.traffic;
    const n1 = R.addNode(1200, 1400), n2 = R.addNode(1360, 1400);
    const e = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1 });
    for (let i = 0; i < T.max; i++) if (T.active[i]) T.despawn(i);

    const b = w.buildings.list.find((x) => x.alive && x.state === 'done' && !x.def.public)!;
    b.fire = 2;
    const incId = 88801;
    w.services.incidents.set(incId, { id: incId, type: 'fire', b: b.id, t: w.t, responded: false });

    const destS = 110;
    // Block the road at s = 96 so the fire truck (len 9.26) gets stuck around s = 88 (~22 m before destS)
    const blocker = T.spawn(VType.Truck, [e.id * 2], 98, e.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(blocker).toBeGreaterThanOrEqual(0);
    T.dwell[blocker] = 999;

    const fire = T.spawn(VType.Fire, [e.id * 2], 70, destS, { kind: P_SERVICE, id: incId, aux: -1 }, -1, b.id, VEH_FLAG_SIREN);
    expect(fire).toBeGreaterThanOrEqual(0);

    for (let k = 0; k < 40; k++) T.step(0.5, () => true); // 20 s stopped ~22 m short of destS
    expect(T.active[fire]).toBe(1);
    expect(T.stuck[fire]).toBeGreaterThan(10);
    expect(destS - T.s[fire]).toBeGreaterThan(15);
    expect(b.fire).toBe(2); // fire MUST NOT be extinguished remotely
  });

  it('worker de roteamento corrompido ({ id, nexts: [] }) dispara fallback limpo sem crash', () => {
    const w = run(makeWorld(506), 0.1);
    let posted = 0;
    const fakeWorker: {
      onmessage: ((ev: MessageEvent) => void) | null;
      onerror: ((ev: ErrorEvent) => void) | null;
      onmessageerror: ((ev: MessageEvent) => void) | null;
      postMessage(msg: { id: number }): void;
    } = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage(msg: { id: number }) {
        posted++;
        // malicious/corrupt worker responds with empty nexts array
        this.onmessage?.({ data: { id: msg.id, nexts: [] } } as MessageEvent);
      },
    };

    const wb = new WorkerBackend([fakeWorker as unknown as Worker]);
    w.roads.backend = wb;
    const fbBefore = w.roads.routeFallbacks;
    // Run simulation steps with corrupt worker returning { id, nexts: [] } -> clean inline fallback, zero crash
    for (let k = 0; k < 200; k++) {
      expect(() => w.step(0.5)).not.toThrow();
    }
    expect(posted).toBeGreaterThan(0);
    expect(wb.failures).toBeGreaterThan(0);
    expect(w.roads.routeFallbacks).toBeGreaterThan(fbBefore);
    // Repeated consecutive corrupt responses retire the faulty worker from the pool
    const g = w.roads.routeGraph();
    for (let k = 0; k < 3; k++) {
      const tk = wb.submit(g, [0]);
      expect(wb.ready(tk)).toBe(true);
      expect(wb.take(tk)).toBeNull();
    }
    expect(wb.threads).toBe(0);
  });

  it('energia e água por componente: ilha A em déficit sofre corte mesmo com ilha B tendo enorme sobra', () => {
    const w = makeWorld(507);
    const R = w.roads;
    // Island A: disconnected local road with 1 dieselGen (60 power) + 1 well (40 water) vs heavy demand (>120 power, >60 water)
    const a1 = R.addNode(200, 200), a2 = R.addNode(340, 200);
    const eA = R.addEdge(a1.id, a2.id, RoadClass.Local, { progress: 1 });
    const genA = w.buildings.create('dieselGen', { x: 215, z: 215, angle: 0, edge: eA.id, t: 0.1, side: 1, access: a1.id, offDist: 10, total: 0, terms: {} }, { era: 0, day: 0, w: 12, d: 12, maxDensity: 2, decision: null });
    genA.state = 'done'; genA.progress = 1;
    const wellA = w.buildings.create('well', { x: 225, z: 215, angle: 0, edge: eA.id, t: 0.2, side: 1, access: a1.id, offDist: 10, total: 0, terms: {} }, { era: 0, day: 0, w: 10, d: 10, maxDensity: 2, decision: null });
    wellA.state = 'done'; wellA.progress = 1;
    const consumersA = [];
    for (let k = 0; k < 10; k++) {
      const b = w.buildings.create('steelMill', { x: 235 + k * 9, z: 215, angle: 0, edge: eA.id, t: 0.25 + k * 0.06, side: 1, access: a2.id, offDist: 10, total: 0, terms: {} }, { era: 1, day: 0, w: 14, d: 14, maxDensity: 3, decision: null });
      b.state = 'done'; b.progress = 1;
      consumersA.push(b);
    }
    for (let k = 0; k < 12; k++) {
      const f = w.buildings.create('farm', { x: 235 + k * 8, z: 185, angle: 0, edge: eA.id, t: 0.25 + k * 0.06, side: -1, access: a2.id, offDist: 10, total: 0, terms: {} }, { era: 0, day: 0, w: 12, d: 12, maxDensity: 1, decision: null });
      f.state = 'done'; f.progress = 1;
      consumersA.push(f);
    }

    // Island B: disconnected local road with massive surplus (hydroPlant = 1600 power, waterTreatment = 2600 water) vs 1 small house
    const b1 = R.addNode(2100, 2100), b2 = R.addNode(2240, 2100);
    const eB = R.addEdge(b1.id, b2.id, RoadClass.Local, { progress: 1 });
    const plantB = w.buildings.create('hydroPlant', { x: 2120, z: 2115, angle: 0, edge: eB.id, t: 0.15, side: 1, access: b1.id, offDist: 10, total: 0, terms: {} }, { era: 2, day: 0, w: 20, d: 20, maxDensity: 2, decision: null });
    plantB.state = 'done'; plantB.progress = 1;
    const waterB = w.buildings.create('waterTreatment', { x: 2150, z: 2115, angle: 0, edge: eB.id, t: 0.35, side: 1, access: b1.id, offDist: 10, total: 0, terms: {} }, { era: 1, day: 0, w: 20, d: 20, maxDensity: 2, decision: null });
    waterB.state = 'done'; waterB.progress = 1;
    const houseB = w.buildings.create('res', { x: 2210, z: 2115, angle: 0, edge: eB.id, t: 0.8, side: 1, access: b2.id, offDist: 10, total: 0, terms: {} }, { era: 0, day: 0, w: 10, d: 10, maxDensity: 2, decision: null });
    houseB.state = 'done'; houseB.progress = 1;

    w.utils.hourly();

    // Global supply >> global demand, yet Island A MUST experience power & water shedding while Island B stays 100% served
    expect(w.utils.power.supply).toBeGreaterThan(w.utils.power.demand);
    expect(w.utils.water.supply).toBeGreaterThan(w.utils.water.demand);
    expect(houseB.powered).toBe(true);
    expect(houseB.watered).toBe(true);
    expect(consumersA.some((c) => !c.powered)).toBe(true);
    expect(consumersA.some((c) => !c.watered)).toBe(true);
  });

  it('estação ferroviária em obra (state=site) não entra em main.transit nem despacha trem de passageiros até concluir', () => {
    const w = makeWorld(508);
    const rail = w.rail2 as unknown as {
      lines: { len: number; stations: { b: number; s: number }[]; openStations: { b: number; s: number }[]; transit?: Line }[];
      trains: { kind: string }[];
      buildStation(s: number): boolean;
      syncOpenStations(): void;
    };
    const main = rail.lines[0];
    const ok = rail.buildStation(main.len * 0.5);
    expect(ok).toBe(true);
    expect(main.stations.length).toBe(1);
    const stBld = w.buildings.byId.get(main.stations[0].b)!;
    expect(stBld.state).toBe('site');
    expect(main.openStations.length).toBe(0);
    expect(main.transit?.stops.length ?? 0).toBe(0);

    // Step rail for 3 hours while station is still under construction: zero passenger trains dispatched
    for (let k = 0; k < 600; k++) { w.t += 0.5; w.rail2.step(0.5); }
    expect(rail.trains.filter((t) => t.kind === 'pass').length).toBe(0);
    expect(main.openStations.length).toBe(0);

    // Complete station construction -> opens cleanly into openStations & main.transit
    stBld.state = 'done';
    stBld.progress = 1;
    w.onBuildingCompleted(stBld, true);
    expect(main.openStations.length).toBe(1);
    expect(main.transit?.stops.length).toBe(1);
  });

  it('folga real entre picapes (5,24 m) paradas em fila >= 0,75 m e VEHICLE_MESH_LEN >= malha 3D para todos os 19 presets', () => {
    // 1. Verify single source of truth across all 19 3D presets
    for (const p of VEHICLE_PRESETS) {
      const built = buildVehicle(p.id, 'high');
      built.body.computeBoundingBox();
      const bb = built.body.boundingBox!;
      const exactExtent = 2 * Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x));
      expect(VEHICLE_MESH_LEN[p.id], `${p.id} physical length >= 3D mesh extent`).toBeGreaterThanOrEqual(exactExtent - 0.001);
    }

    // 2. Spawn two pickups (era >= 1) in queue on the same lane and verify real body-to-body gap >= 0.75 m
    const w = makeWorld(509);
    const R = w.roads, T = w.traffic;
    T.era = 1;
    const n1 = R.addNode(1200, 1200), n2 = R.addNode(1360, 1200);
    const e = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1 });
    for (let i = 0; i < T.max; i++) if (T.active[i]) T.despawn(i);

    // Find two slots whose deterministic pickVehiclePreset resolves to 'pickup'
    const pickups: number[] = [];
    for (let attempt = 0; attempt < 200 && pickups.length < 2; attempt++) {
      const sPos = pickups.length === 0 ? 110 : 75;
      const slot = T.spawn(VType.Car, [e.id * 2], sPos, e.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
      if (slot < 0) continue;
      if (pickVehiclePreset(VType.Car, slot, T.gen[slot], 1) === 'pickup') {
        pickups.push(slot);
      } else {
        T.despawn(slot);
      }
    }
    expect(pickups.length).toBe(2);
    const [lead, follow] = pickups;
    expect(T.len[lead]).toBeGreaterThanOrEqual(5.24);
    expect(T.len[follow]).toBeGreaterThanOrEqual(5.24);

    T.dwell[lead] = 999; // parked lead pickup
    for (let k = 0; k < 80; k++) T.step(0.5, () => true);

    const meshLen = buildVehicle('pickup', 'high').meta.size[0];
    const bodyGap = (T.s[lead] - T.s[follow]) - meshLen;
    expect(bodyGap).toBeGreaterThanOrEqual(0.75);
  });

  it('trevo desnivelado: veículo no viaduto superior não bloqueia veículo na via inferior', () => {
    const w = makeWorld(510);
    const R = w.roads, T = w.traffic;
    const c = R.addNode(1500, 1500);
    c.interchange = true;
    const nW = R.addNode(1400, 1500), nE = R.addNode(1600, 1500);
    const nN = R.addNode(1500, 1400), nS = R.addNode(1500, 1600);
    const eW = R.addEdge(nW.id, c.id, RoadClass.Highway, { progress: 1 });
    const eE = R.addEdge(c.id, nE.id, RoadClass.Highway, { progress: 1 });
    const eN = R.addEdge(nN.id, c.id, RoadClass.Local, { progress: 1 });
    const eS = R.addEdge(c.id, nS.id, RoadClass.Local, { progress: 1 });
    for (let i = 0; i < T.max; i++) if (T.active[i]) T.despawn(i);

    // Put a highway vehicle actively inside the interchange box on the viaduct (major class)
    const upper = T.spawn(VType.Car, [eW.id * 2, eE.id * 2], eW.len - 18, eE.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(upper).toBeGreaterThanOrEqual(0);
    // Advance until upper is inside interchange jSlots
    for (let k = 0; k < 20 && T.jnode[upper] !== c.id; k++) T.step(0.5, w.nodeAllow);
    expect(T.jnode[upper]).toBe(c.id);
    expect(c.jSlots.includes(upper)).toBe(true);

    // Lower-level road vehicle MUST be allowed into the interchange while upper viaduct car is overhead
    expect(w.nodeAllow(c, eN, 0, 1, 0)).toBe(true);
    const lower = T.spawn(VType.Car, [eN.id * 2, eS.id * 2], T.sEnd(eN, 0) - 10, eS.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(lower).toBeGreaterThanOrEqual(0);
    let lowerEntered = false;
    for (let k = 0; k < 30; k++) {
      T.step(0.5, w.nodeAllow);
      if (T.active[lower] && T.edge[lower] === eS.id) { lowerEntered = true; break; }
    }
    expect(lowerEntered).toBe(true);
  });

  it('comboio em alta velocidade no cruzamento: overshoot nunca causa sobreposição de carrocerias', () => {
    const w = makeWorld(511);
    const R = w.roads, T = w.traffic;
    const n1 = R.addNode(1000, 1600), n2 = R.addNode(1160, 1600), n3 = R.addNode(1320, 1600);
    const e1 = R.addEdge(n1.id, n2.id, RoadClass.Highway, { progress: 1, lanes: 2 });
    const e2 = R.addEdge(n2.id, n3.id, RoadClass.Highway, { progress: 1, lanes: 2 });
    for (let i = 0; i < T.max; i++) if (T.active[i]) T.despawn(i);

    // Lead and follower rushing in convoy at 21 m/s across n2, with a slow truck on e2 forcing compression
    const slow = T.spawn(VType.Truck, [e2.id * 2], T.sStart(e2, 0) + 18, e2.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    const lead = T.spawn(VType.Car, [e1.id * 2, e2.id * 2], T.sEnd(e1, 0) - 4, e2.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    const follow = T.spawn(VType.Car, [e1.id * 2, e2.id * 2], T.sEnd(e1, 0) - 11.5, e2.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(slow).toBeGreaterThanOrEqual(0);
    expect(lead).toBeGreaterThanOrEqual(0);
    expect(follow).toBeGreaterThanOrEqual(0);
    T.lane[slow] = 0; T.lane[lead] = 0; T.lane[follow] = 0;
    T.v[slow] = 2;
    T.v[lead] = 21;
    T.v[follow] = 21;

    for (let k = 0; k < 40; k++) {
      T.step(0.5, () => true);
      if (T.active[lead] && T.active[follow] && T.edge[lead] === T.edge[follow] && T.dir[lead] === T.dir[follow] && T.lane[lead] === T.lane[follow]) {
        const gap = Math.abs(T.s[lead] - T.s[follow]) - (T.len[lead] + T.len[follow]) * 0.5;
        expect(gap).toBeGreaterThanOrEqual(-0.01);
      }
      if (T.active[slow] && T.active[lead] && T.edge[slow] === T.edge[lead] && T.dir[slow] === T.dir[lead] && T.lane[slow] === T.lane[lead]) {
        const gap = Math.abs(T.s[slow] - T.s[lead]) - (T.len[slow] + T.len[lead]) * 0.5;
        expect(gap).toBeGreaterThanOrEqual(-0.01);
      }
    }
  });

  it('despawnsRedLight é fiel: espera legítima no vermelho não despawna, mas despawn sob semáforo vermelho contabiliza o contador', () => {
    const w = makeWorld(512);
    const R = w.roads, T = w.traffic;
    const n1 = R.addNode(1000, 1750), n2 = R.addNode(1150, 1750), n3 = R.addNode(1300, 1750);
    n2.control = 2;
    const e1 = R.addEdge(n1.id, n2.id, RoadClass.Avenue, { progress: 1 });
    const e2 = R.addEdge(n2.id, n3.id, RoadClass.Avenue, { progress: 1 });
    for (let i = 0; i < T.max; i++) if (T.active[i]) T.despawn(i);

    // 1. Legitimate wait at red light for 120 s (> STUCK_LIMIT = 90) must NOT despawn
    const waiting = T.spawn(VType.Car, [e1.id * 2, e2.id * 2], T.sEnd(e1, 0) - 5, e2.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(waiting).toBeGreaterThanOrEqual(0);
    for (let k = 0; k < 240; k++) T.step(0.5, () => false);
    expect(T.active[waiting]).toBe(1);
    expect(T.despawnsRedLight).toBe(0);

    // 2. A vehicle hitting STUCK_LIMIT while held behind a red-signal edge MUST increment despawnsRedLight
    const behind = T.spawn(VType.Fire, [e1.id * 2], T.sEnd(e1, 0) - 22, e1.len - 1, { kind: P_SERVICE, id: -1, aux: -1 });
    expect(behind).toBeGreaterThanOrEqual(0);
    T.lane[behind] = T.lane[waiting];
    T.stuck[behind] = 95;
    T.v[behind] = 0;
    const beforeRed = T.despawnsRedLight;
    T.step(0.5, () => false);
    expect(T.active[behind]).toBe(0);
    expect(T.despawnsRedLight).toBe(beforeRed + 1);
  });

  it('serveStop valida ride.phase: embarque aceita somente phase=1 e desembarque aceita somente phase=2', () => {
    const w = makeWorld(513);
    const S = w.transitSys;
    const home = w.buildings.list[0];
    const hh = w.citizens.newHousehold(home.id, 1);
    hh.money = 100;

    const s1 = { id: S.allocStopId(), x: 100, z: 100, node: -1, edge: -1, dir: 0, s: 20, curbX: 100, curbZ: 100, ux: 1, uz: 0, name: 'S1' };
    const s2 = { id: S.allocStopId(), x: 300, z: 100, node: -1, edge: -1, dir: 0, s: 80, curbX: 300, curbZ: 100, ux: 1, uz: 0, name: 'S2' };
    const l: Line = {
      id: 803, kind: 'bus', color: '#3498db', name: 'Teste Fase', stops: [s1, s2],
      path: [], startS: 0, destS: 0, fleet: 1, vehicles: new Set(), ridersToday: 0, ridersYday: 0,
      waiting: new Map(), onboard: new Map(), edges: new Set(), headway: 120, lastSpawn: 0, pts: [],
    };
    S.lines.push(l);

    // 4 waiting citizens with phase 0, 1, 2, 3 -> ONLY phase 1 may board
    const waitIds: number[] = [];
    for (const ph of [0, 1, 2, 3] as const) {
      const cid = w.citizens.add({ age: 30, hh: hh.id });
      hh.members.push(cid);
      w.citizens.state[cid] = ST_TRANSIT;
      S.rides.set(cid, { line: l.id, fromId: s1.id, toId: s2.id, gen: w.citizens.gen[cid], phase: ph, since: 0, dest: home.id });
      waitIds.push(cid);
    }
    l.waiting.set(s1.id, [...waitIds]);
    const fares0 = S.faresCollected;
    S.serveStop(l, 0, 91, 55);
    expect(l.onboard.get(91)).toEqual([waitIds[1]]);
    expect(S.rides.get(waitIds[1])?.phase).toBe(2);
    expect(S.faresCollected).toBeGreaterThan(fares0);
    // Non-phase-1 citizens were NOT boarded
    expect(S.rides.get(waitIds[0])?.phase).toBe(0);
    expect(S.rides.get(waitIds[3])?.phase).toBe(3);

    // 4 onboard entries with phase 0, 1, 2, 3 targeting s2 -> ONLY phase 2 alights
    const obIds: number[] = [];
    for (const ph of [0, 1, 2, 3] as const) {
      const cid = w.citizens.add({ age: 28, hh: hh.id });
      hh.members.push(cid);
      w.citizens.state[cid] = ST_TRANSIT;
      S.rides.set(cid, { line: l.id, fromId: s1.id, toId: s2.id, gen: w.citizens.gen[cid], phase: ph, since: 0, dest: home.id });
      obIds.push(cid);
    }
    l.onboard.set(92, [...obIds]);
    const alighted = S.serveStop(l, 1, 92, 55);
    expect(alighted).toBe(1);
    // obIds[2] alighted cleanly (either phase 3 walking or completed via virtualArrive)
    const r2 = S.rides.get(obIds[2]);
    expect(r2 === undefined || r2.phase === 3).toBe(true);
    expect(S.rides.get(obIds[0])?.phase).toBe(0);
    expect(S.rides.get(obIds[1])?.phase).toBe(1);
    expect(S.rides.get(obIds[3])?.phase).toBe(3);
  });

  it('repathWalkingRiders reroteia da posição viva (fx, fz) sem teletransportar para o prédio de origem', () => {
    const w = makeWorld(514);
    const R = w.roads, S = w.transitSys;
    const n1 = R.addNode(1000, 1900), n2 = R.addNode(1200, 1900), n3 = R.addNode(1400, 1900);
    const e1 = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1 });
    const e2 = R.addEdge(n2.id, n3.id, RoadClass.Local, { progress: 1 });
    const fromB = w.buildings.create('res', { x: 1015, z: 1915, angle: 0, edge: e1.id, t: 0.08, side: 1, access: n1.id, offDist: 10, total: 0, terms: {} }, { era: 0, day: 0, w: 10, d: 10, maxDensity: 2, decision: null });
    fromB.state = 'done'; fromB.progress = 1;
    const toB = w.buildings.create('com', { x: 1380, z: 1915, angle: 0, edge: e2.id, t: 0.9, side: 1, access: n3.id, offDist: 10, total: 0, terms: {} }, { era: 0, day: 0, w: 10, d: 10, maxDensity: 2, decision: null });
    toB.state = 'done'; toB.progress = 1;

    const hh = w.citizens.newHousehold(fromB.id, 1);
    const cid = w.citizens.add({ age: 32, hh: hh.id });
    hh.members.push(cid);
    w.citizens.loc[cid] = fromB.id;
    w.citizens.tripDest[cid] = toB.id;
    w.citizens.state[cid] = ST_TRANSIT;

    const s1 = { id: S.allocStopId(), x: 1180, z: 1905.8, node: -1, edge: e1.id, dir: 0, s: 180, curbX: 1180, curbZ: 1903.5, ux: 1, uz: 0, name: 'S1' };
    const s2 = { id: S.allocStopId(), x: 1360, z: 1905.8, node: -1, edge: e2.id, dir: 0, s: 160, curbX: 1360, curbZ: 1903.5, ux: 1, uz: 0, name: 'S2' };
    const l: Line = {
      id: 804, kind: 'bus', color: '#2ecc71', name: 'Teste Repath', stops: [s1, s2],
      path: [e1.id * 2, e2.id * 2], startS: 10, destS: 180, fleet: 1, vehicles: new Set([1]), ridersToday: 0, ridersYday: 0,
      waiting: new Map(), onboard: new Map(), edges: new Set([e1.id, e2.id]), headway: 120, lastSpawn: 0, pts: [],
    };
    S.lines.push(l);
    S.rides.set(cid, { line: l.id, fromId: s1.id, toId: s2.id, gen: w.citizens.gen[cid], phase: 0, since: 0, dest: toB.id });

    // Spawn citizen ped already halfway along e1 at x = 1120 (far from fromB at x = 1015)
    const oldSlot = w.peds.spawn([1120, 1905.8, 1180, 1905.8], cid, 1.35, 0, 0);
    expect(oldSlot).toBeGreaterThanOrEqual(0);
    w.citizens.slot[cid] = oldSlot;
    const fx = w.peds.x[oldSlot], fz = w.peds.z[oldSlot];
    expect(Math.hypot(fx - fromB.x, fz - fromB.z)).toBeGreaterThan(80);

    // Move s1 forward by 30 m onto e2 and invoke replaceStops (which triggers repathWalkingRiders)
    const s1Moved = { ...s1, x: 1215, z: 1905.8, edge: e2.id, s: 15, curbX: 1215, curbZ: 1903.5 };
    (S as unknown as { replaceStops(line: Line, next: typeof l.stops): void }).replaceStops(l, [s1Moved, s2]);

    const newSlot = w.citizens.slot[cid];
    expect(newSlot).toBeGreaterThanOrEqual(0);
    expect(w.peds.active[newSlot]).toBe(1);
    // New walk polyline MUST start right at live (fx, fz), NOT back at fromB
    expect(Math.hypot(w.peds.x[newSlot] - fx, w.peds.z[newSlot] - fz)).toBeLessThan(1.5);
    expect(Math.hypot(w.peds.x[newSlot] - fromB.x, w.peds.z[newSlot] - fromB.z)).toBeGreaterThan(80);
  });

  it('limpeza completa de rides: fim de linha ferroviária e suspensão por onEdgeSplit (< 2 paradas) não deixam órfãos', () => {
    const w = makeWorld(515);
    const R = w.roads, S = w.transitSys;
    const home = w.buildings.list[0];
    const hh = w.citizens.newHousehold(home.id, 1);

    // 1. Rail end-of-line: passenger onboard a regional train past l.len + tail
    const rail = w.rail2 as unknown as {
      lines: { id: number; len: number; transit?: Line }[];
      trains: { id: number; line: number; kind: string; s: number; dir: number; v: number; vmax: number; dwell: number; cars: number[]; served: Set<number>; gen: number }[];
    };
    const main = rail.lines[0];
    const rLine: Line = main.transit ?? {
      id: 805, kind: 'rail', color: '#9b59b6', name: 'Trem', stops: [],
      path: [], startS: 0, destS: 0, fleet: 1, vehicles: new Set(), ridersToday: 0, ridersYday: 0,
      waiting: new Map(), onboard: new Map(), edges: new Set(), headway: 300, lastSpawn: 0, pts: [],
    };
    main.transit = rLine;
    const railCid = w.citizens.add({ age: 40, hh: hh.id });
    hh.members.push(railCid);
    w.citizens.state[railCid] = ST_TRANSIT;
    S.rides.set(railCid, { line: rLine.id, fromId: 1, toId: 2, gen: w.citizens.gen[railCid], phase: 2, since: 0, dest: home.id });
    rLine.onboard.set(100000 + 777, [railCid]);
    rail.trains.push({ id: 777, line: 0, kind: 'pass', s: main.len + 500, dir: 1, v: 20, vmax: 25, dwell: 0, cars: [0, 1], served: new Set(), gen: 1 });

    w.rail2.step(0.5);
    expect(S.rides.has(railCid)).toBe(false);
    expect(rLine.onboard.has(100000 + 777)).toBe(false);

    // 2. onEdgeSplit leaving < 2 viable stops cleans phase 0 (walking), phase 1 (waiting), and phase 2 (onboard)
    const n1 = R.addNode(1000, 2050), n2 = R.addNode(1140, 2050), n3 = R.addNode(1280, 2050);
    const e1 = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1 });
    const e2 = R.addEdge(n2.id, n3.id, RoadClass.Local, { progress: 1 });
    const stA = { id: S.allocStopId(), x: 1070, z: 2055, node: -1, edge: e1.id, dir: 0, s: 70, curbX: 1070, curbZ: 2053, ux: 1, uz: 0, name: 'A' };
    const stB = { id: S.allocStopId(), x: 1210, z: 2055, node: -1, edge: e2.id, dir: 0, s: 70, curbX: 1210, curbZ: 2053, ux: 1, uz: 0, name: 'B' };
    const busLine: Line = {
      id: 806, kind: 'bus', color: '#e67e22', name: 'Suspensa', stops: [stA, stB],
      path: [e1.id * 2, e2.id * 2], startS: 10, destS: 120, fleet: 1, vehicles: new Set(), ridersToday: 0, ridersYday: 0,
      waiting: new Map(), onboard: new Map(), edges: new Set([e1.id, e2.id]), headway: 120, lastSpawn: 0, pts: [],
    };
    S.lines.push(busLine);

    const cWalk = w.citizens.add({ age: 25, hh: hh.id });
    const cWait = w.citizens.add({ age: 26, hh: hh.id });
    const cRide = w.citizens.add({ age: 27, hh: hh.id });
    const cAlight = w.citizens.add({ age: 28, hh: hh.id });
    hh.members.push(cWalk, cWait, cRide, cAlight);
    for (const c of [cWalk, cWait, cRide, cAlight]) w.citizens.state[c] = ST_TRANSIT;
    S.rides.set(cWalk, { line: busLine.id, fromId: stA.id, toId: stB.id, gen: w.citizens.gen[cWalk], phase: 0, since: 0, dest: home.id });
    S.rides.set(cWait, { line: busLine.id, fromId: stA.id, toId: stB.id, gen: w.citizens.gen[cWait], phase: 1, since: 0, dest: home.id });
    S.rides.set(cRide, { line: busLine.id, fromId: stA.id, toId: stB.id, gen: w.citizens.gen[cRide], phase: 2, since: 0, dest: home.id });
    S.rides.set(cAlight, { line: busLine.id, fromId: stA.id, toId: stB.id, gen: w.citizens.gen[cAlight], phase: 3, since: 0, dest: home.id });
    busLine.waiting.set(stA.id, [cWait]);
    busLine.onboard.set(55, [cRide]);

    // Split e1 into two tiny 8 m halves where buildEdgeStop cannot place a stop -> only stB survives (< 2 stops)
    const nMid = R.addNode(1008, 2050), nShortEnd = R.addNode(1016, 2050);
    const half1 = R.addEdge(n1.id, nMid.id, RoadClass.Local, { progress: 1 });
    const half2 = R.addEdge(nMid.id, nShortEnd.id, RoadClass.Local, { progress: 1 });
    e1.alive = false;
    S.onEdgeSplit(e1, half1, half2, 0.5);
    expect(S.rides.has(cWalk)).toBe(false);
    expect(S.rides.has(cWait)).toBe(false);
    expect(S.rides.has(cRide)).toBe(false);
    expect(S.rides.has(cAlight)).toBe(false);
    expect(busLine.waiting.size).toBe(0);
    expect(busLine.onboard.size).toBe(0);

    // 3. revalidateLines suspending a broken line (fleet = 0) MUST also evacuate waiting, onboard and rides
    const brokenLine: Line = {
      id: 807, kind: 'bus', color: '#8e44ad', name: 'Quebrada', stops: [stB],
      path: [e1.id * 2], startS: 0, destS: 50, fleet: 2, vehicles: new Set(), ridersToday: 0, ridersYday: 0,
      waiting: new Map(), onboard: new Map(), edges: new Set([e1.id]), headway: 120, lastSpawn: 0, pts: [],
    };
    S.lines.push(brokenLine);
    const cRev = w.citizens.add({ age: 30, hh: hh.id });
    hh.members.push(cRev);
    w.citizens.state[cRev] = ST_TRANSIT;
    S.rides.set(cRev, { line: brokenLine.id, fromId: stB.id, toId: stB.id, gen: w.citizens.gen[cRev], phase: 1, since: 0, dest: home.id });
    brokenLine.waiting.set(stB.id, [cRev]);
    S.revalidateLines();
    expect(brokenLine.fleet).toBe(0);
    expect(S.rides.has(cRev)).toBe(false);
    expect(brokenLine.waiting.size).toBe(0);
  });

  it('usina desconectada da rede não infla power.supply e pedestre sobre ponte recebe cota do tabuleiro acima da água', () => {
    const w = makeWorld(516);
    w.utils.hourly();
    const supplyBefore = w.utils.power.supply;
    // Place an isolated thermalPlant with edge = -1 far from any road node (> 45 m) and no completed transmission line
    const isolated = w.buildings.create('thermalPlant', { x: 100, z: 100, angle: 0, edge: -1, t: 0, side: 1, access: -1, offDist: 0, total: 0, terms: {} }, { era: 1, day: 0, w: 20, d: 20, maxDensity: 2, decision: null });
    isolated.state = 'done';
    isolated.progress = 1;
    w.utils.hourly();
    expect(w.utils.power.supply).toBe(supplyBefore);

    // Create a road bridge over low water/valley and confirm pedElevation returns the bridge deck height (> 2 m)
    const R = w.roads;
    const b1 = R.addNode(1600, 1600), b2 = R.addNode(1700, 1600);
    const br = R.addEdge(b1.id, b2.id, RoadClass.Avenue, { progress: 1 });
    br.bridge = true;
    br.pts = [1600, 4.5, 1600, 1650, 5.2, 1600, 1700, 4.5, 1600];
    R.topoVer++;
    // Pedestrian walking on the bridge walkway at lateral offset ~hw + 0.75 from centerline
    const yDeck = w.pedElevation(1650, 1600 + 6.5);
    expect(yDeck).toBeGreaterThanOrEqual(5.2);
  });
});
