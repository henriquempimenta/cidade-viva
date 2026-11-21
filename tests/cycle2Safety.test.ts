import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { DEFAULT_PARAMS } from '../src/shared/params';
import { RoadClass, VEH_FLAG_HAZARD, VEH_FLAG_SIREN, VType } from '../src/shared/constants';
import { P_CITIZEN, P_SERVICE } from '../src/sim/traffic';
import { Act, ST_CAR, ST_IN, ST_WALK } from '../src/sim/citizens';
import type { Line } from '../src/sim/transit';

function makeWorld(seed = 1234, extra: Partial<typeof DEFAULT_PARAMS> = {}) {
  return new World({ ...DEFAULT_PARAMS, seed, ...extra });
}

function clearVehicles(w: World) {
  const T = w.traffic;
  for (let i = 0; i < T.max; i++) if (T.active[i]) T.despawn(i);
}

function countLaneOverlaps(w: World): number {
  const T = w.traffic;
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < T.max; i++) {
    if (!T.active[i] || T.lat[i] > 1.0) continue;
    const key = ((T.edge[i] * 2 + T.dir[i]) * 8) + T.lane[i];
    let b = buckets.get(key);
    if (!b) { b = []; buckets.set(key, b); }
    b.push(i);
  }
  let overlaps = 0;
  for (const b of buckets.values()) {
    if (b.length < 2) continue;
    b.sort((a, c) => T.s[a] - T.s[c]);
    for (let k = 1; k < b.length; k++) {
      const r = b[k - 1], f = b[k];
      const gap = (T.s[f] - T.s[r]) - (T.len[f] + T.len[r]) * 0.5;
      if (gap < -0.05) overlaps++;
    }
  }
  return overlaps;
}

describe('Ciclo 2 — Segurança Viária, Emergências Avançadas, Guincho & Ciclo de Vida da Frota', () => {
  it('bloqueio parcial em avenida de 2 faixas desvia pela faixa livre sem sobreposição e bloqueio total desvia novas rotas automaticamente', () => {
    const w = makeWorld(701);
    const R = w.roads, T = w.traffic;
    clearVehicles(w);

    // Parallel road network: A --(main 2-lane ave)--> B, and A --(detour via C)--> B
    const nA = R.addNode(1000, 1000);
    const nB = R.addNode(1220, 1000);
    const nC = R.addNode(1110, 1130);
    const eMain = R.addEdge(nA.id, nB.id, RoadClass.Avenue, { progress: 1, lanes: 2 });
    const eDet1 = R.addEdge(nA.id, nC.id, RoadClass.Collector, { progress: 1, lanes: 1 });
    const eDet2 = R.addEdge(nC.id, nB.id, RoadClass.Collector, { progress: 1, lanes: 1 });
    R.invalidateRoutes();

    // Baseline shortest path A -> B uses eMain directly
    const baseRoute = R.route(nA.id, nB.id);
    expect(baseRoute).toEqual([eMain.id * 2]);

    // 1. Partial lane blockage (breakdown in lane 1 of 2-lane avenue): following car in lane 1 changes to lane 0 and passes cleanly!
    const broken = T.spawn(VType.Car, [eMain.id * 2], 125, eMain.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(broken).toBeGreaterThanOrEqual(0);
    T.lane[broken] = 1;
    const incPartial = w.incidents.triggerBreakdown(broken);
    expect(incPartial).not.toBeNull();
    expect(incPartial!.fullClosure).toBe(false);
    expect((T.flags[broken] & VEH_FLAG_HAZARD) !== 0).toBe(true);

    const follower = T.spawn(VType.Car, [eMain.id * 2], 70, eMain.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(follower).toBeGreaterThanOrEqual(0);
    T.lane[follower] = 1;
    let passedCleanly = false;
    for (let k = 0; k < 60; k++) {
      T.step(0.5, () => true);
      expect(countLaneOverlaps(w)).toBe(0);
      if (T.active[follower] && T.s[follower] > 145) {
        expect(T.lane[follower]).toBe(0);
        passedCleanly = true;
        break;
      }
    }
    expect(passedCleanly).toBe(true);

    // 2. Full closure (major crash on eMain): new routes A -> B automatically detour via C (eDet1, eDet2)!
    R.setIncidentPenalty(eMain.id * 2, 900);
    const detourRoute = R.route(nA.id, nB.id);
    expect(detourRoute).toEqual([eDet1.id * 2, eDet2.id * 2]);

    // Clearing penalty restores direct route
    R.setIncidentPenalty(eMain.id * 2, 0);
    const restoredRoute = R.route(nA.id, nB.id);
    expect(restoredRoute).toEqual([eMain.id * 2]);
  });

  it('emergência com sirene ultrapassa fila pela faixa livre e avança sinal vermelho com preempção segura (zero colisão transversal)', () => {
    const w = makeWorld(702);
    const R = w.roads, T = w.traffic;
    clearVehicles(w);

    // 4-way signalized intersection at nC: W->C->E (2-lane avenue) crossed by N->C->S (1-lane collector)
    const nC = R.addNode(1500, 1500);
    const nW = R.addNode(1320, 1500);
    const nE = R.addNode(1680, 1500);
    const nN = R.addNode(1500, 1340);
    const nS = R.addNode(1500, 1660);
    nC.control = 2;
    const eW = R.addEdge(nW.id, nC.id, RoadClass.Avenue, { progress: 1, lanes: 2 });
    const eE = R.addEdge(nC.id, nE.id, RoadClass.Avenue, { progress: 1, lanes: 2 });
    const eN = R.addEdge(nN.id, nC.id, RoadClass.Collector, { progress: 1, lanes: 1 });
    const eS = R.addEdge(nC.id, nS.id, RoadClass.Collector, { progress: 1, lanes: 1 });

    // Signal strictly RED for eW and strictly GREEN for eN (cross traffic)
    const redForW_greenForN = (_n: unknown, inEdge: { id: number }) => inEdge.id === eN.id;

    // Stopped civilian car in lane 1 of eW blocking the lane at the red light
    const stoppedCiv = T.spawn(VType.Car, [eW.id * 2, eE.id * 2], T.sEnd(eW, 0) - 6, eE.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(stoppedCiv).toBeGreaterThanOrEqual(0);
    T.lane[stoppedCiv] = 1;

    // Ambulance with siren behind stoppedCiv in lane 1 -> should switch to open lane 0, slow for red light, and cross safely!
    const amb = T.spawn(VType.Ambulance, [eW.id * 2, eE.id * 2], T.sEnd(eW, 0) - 34, eE.len - 2, { kind: P_SERVICE, id: -1, aux: -1 }, -1, -1, VEH_FLAG_SIREN);
    expect(amb).toBeGreaterThanOrEqual(0);
    T.lane[amb] = 1;

    // Cross-traffic car approaching nC on GREEN signal from eN -> MUST hold at stop line while ambulance preempts!
    const crossCar = T.spawn(VType.Car, [eN.id * 2, eS.id * 2], T.sEnd(eN, 0) - 18, eS.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(crossCar).toBeGreaterThanOrEqual(0);

    let ambSwitchedLane = false;
    let ambCrossedRed = false;
    let ambMaxJunctionSpeed = 0;
    let simultaneousConflict = false;

    for (let k = 0; k < 70; k++) {
      T.step(0.5, redForW_greenForN);
      expect(countLaneOverlaps(w)).toBe(0);
      if (T.active[amb] && T.edge[amb] === eW.id && T.lane[amb] === 0) ambSwitchedLane = true;
      if (T.active[amb] && T.jnode[amb] === nC.id) {
        ambMaxJunctionSpeed = Math.max(ambMaxJunctionSpeed, T.v[amb]);
        if (T.active[crossCar] && T.jnode[crossCar] === nC.id) simultaneousConflict = true;
      }
      if (T.active[amb] && T.edge[amb] === eE.id && T.s[amb] > T.sStart(eE, 0) + 5) {
        ambCrossedRed = true;
        break;
      }
    }

    expect(ambSwitchedLane).toBe(true);
    expect(ambCrossedRed).toBe(true);
    expect(simultaneousConflict).toBe(false);
    expect(ambMaxJunctionSpeed).toBeLessThanOrEqual(9.5); // cautious crossing speed on red
    // Stopped civilian still obeyed the red light on eW
    expect(T.active[stoppedCiv]).toBe(1);
    expect(T.edge[stoppedCiv]).toBe(eW.id);
  });

  it('atendimento coordenado completo: acidente grave aciona Polícia + Ambulância (leva ferido ao hospital) + Bombeiros + Guincho e reabre via limpa', () => {
    const w = makeWorld(703);
    const R = w.roads, T = w.traffic, C = w.citizens;
    clearVehicles(w);

    // Build a clean connected urban corridor with Police, Hospital, Fire, BusDepot (Tow)
    const n1 = R.addNode(1000, 1800), n2 = R.addNode(1220, 1800), n3 = R.addNode(1440, 1800);
    const e1 = R.addEdge(n1.id, n2.id, RoadClass.Avenue, { progress: 1, lanes: 2 });
    const e2 = R.addEdge(n2.id, n3.id, RoadClass.Avenue, { progress: 1, lanes: 2 });
    R.invalidateRoutes();

    const makeDone = (kind: string, x: number, z: number, eId: number, t: number, acc: number) => {
      const b = w.buildings.create(kind, { x, z, angle: 0, edge: eId, t, side: 1, access: acc, offDist: 10, total: 0, terms: {} }, { era: 1, day: 1, w: 14, d: 14, maxDensity: 2, decision: null });
      b.state = 'done'; b.progress = 1;
      return b;
    };
    const home = makeDone('res', 1020, 1815, e1.id, 0.09, n1.id);
    const pol = makeDone('police', 1050, 1815, e1.id, 0.23, n1.id);
    const hosp = makeDone('hospital', 1090, 1815, e1.id, 0.41, n1.id);
    const fire = makeDone('fire', 1130, 1815, e1.id, 0.59, n1.id);
    const depot = makeDone('busDepot', 1170, 1815, e1.id, 0.77, n1.id);
    void pol; void fire; void depot;

    const hh = C.newHousehold(home.id, 2);
    hh.car = true; hh.carLoc = -1; hh.money = 3000;
    const driver = C.add({ age: 34, hh: hh.id });
    hh.members.push(driver);
    hh.carUser = driver;
    hh.carDriver = driver;
    C.health[driver] = 0.85;
    C.state[driver] = ST_CAR;
    C.tripDest[driver] = home.id;

    const carSlot = T.spawn(VType.Car, [e2.id * 2], 110, e2.len - 2, { kind: P_CITIZEN, id: driver, aux: 0 }, home.id, home.id);
    expect(carSlot).toBeGreaterThanOrEqual(0);
    C.slot[driver] = carSlot;

    const inc = w.incidents.triggerCrash(carSlot, 'major_crash');
    expect(inc).not.toBeNull();
    expect(inc!.kind).toBe('major_crash');
    expect(inc!.injuredCitizen).toBe(driver);
    expect(C.health[driver]).toBeLessThan(0.6);
    expect(inc!.units.police.slot).toBeGreaterThanOrEqual(0);
    expect(inc!.units.ambulance.slot).toBeGreaterThanOrEqual(0);
    expect(inc!.units.fire.slot).toBeGreaterThanOrEqual(0);
    expect(inc!.units.tow.slot).toBeGreaterThanOrEqual(0);
    expect(T.type[inc!.units.tow.slot]).toBe(VType.Tow);
    // Active incident view is queued for 3D rendering
    expect(w.incidents.views().length).toBe(1);

    // Step simulation until the incident resolves completely (police + ambulance + fire + tow)
    for (let k = 0; k < 500 && w.incidents.active.size > 0; k++) {
      w.step(0.5);
    }
    expect(w.incidents.active.size).toBe(0);
    expect(w.incidents.views().length).toBe(0);
    expect(w.incidents.towRemovals).toBeGreaterThanOrEqual(1);
    expect(w.incidents.ambulanceEvacuations).toBeGreaterThanOrEqual(1);
    expect(T.blockages.size).toBe(0);
    expect(R.incidentPenalty.size).toBe(0);
    // Run additional steps so ambulance reaches hospital and treats the injured driver
    for (let k = 0; k < 250 && C.state[driver] !== ST_IN; k++) {
      w.step(0.5);
    }
    expect(C.alive[driver]).toBe(1);
    expect(C.state[driver]).toBe(ST_IN);
    expect(C.loc[driver]).toBe(hosp.id);
    expect(C.act[driver]).toBe(Act.Doctor);
    expect(C.health[driver]).toBeGreaterThanOrEqual(0.75);
    // Household car invariants intact (no dangling carUser)
    expect(hh.carUser).toBe(-1);
  });

  it('atropelamento (ped_crash) fere pedestre, aciona Polícia + Ambulância e preserva integridade de Citizens.gen e rides', () => {
    const w = makeWorld(704);
    const R = w.roads, T = w.traffic, C = w.citizens;
    clearVehicles(w);

    const n1 = R.addNode(1000, 2100), n2 = R.addNode(1220, 2100);
    const e1 = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1 });
    R.invalidateRoutes();

    const makeDone = (kind: string, x: number, z: number, t: number) => {
      const b = w.buildings.create(kind, { x, z, angle: 0, edge: e1.id, t, side: 1, access: n1.id, offDist: 10, total: 0, terms: {} }, { era: 1, day: 1, w: 12, d: 12, maxDensity: 2, decision: null });
      b.state = 'done'; b.progress = 1;
      return b;
    };
    const home = makeDone('res', 1020, 2115, 0.09);
    makeDone('police', 1050, 2115, 0.22);
    const hosp = makeDone('hospital', 1080, 2115, 0.36);

    const hh = C.newHousehold(home.id, 1);
    const pedCid = C.add({ age: 29, hh: hh.id });
    hh.members.push(pedCid);
    C.health[pedCid] = 0.9;
    C.state[pedCid] = ST_WALK;
    const pedSlot = w.peds.spawn([1140, 2103, 1200, 2103], pedCid, 1.3, 0, 0);
    expect(pedSlot).toBeGreaterThanOrEqual(0);
    C.slot[pedCid] = pedSlot;
    const genBefore = C.gen[pedCid];

    const vehSlot = T.spawn(VType.Car, [e1.id * 2], 140, e1.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(vehSlot).toBeGreaterThanOrEqual(0);

    const inc = w.incidents.triggerPedCrash(vehSlot, pedSlot);
    expect(inc).not.toBeNull();
    expect(inc!.kind).toBe('ped_crash');
    expect(C.health[pedCid]).toBeLessThan(0.6);

    for (let k = 0; k < 550 && (w.incidents.active.size > 0 || C.state[pedCid] !== ST_IN); k++) {
      w.step(0.5);
    }
    expect(w.incidents.active.size).toBe(0);
    expect(C.gen[pedCid]).toBe(genBefore);
    expect(C.state[pedCid]).toBe(ST_IN);
    expect(C.loc[pedCid]).toBe(hosp.id);
    expect(C.health[pedCid]).toBeGreaterThanOrEqual(0.75);
  });

  it('ciclo de vida veicular: desgaste por km, manutenção paga, renovação da frota privada (aposentando vintage) e frota de ônibus', () => {
    const w = makeWorld(705);
    const C = w.citizens;
    w.era = 1;
    w.budget.money = 10000;
    const home = w.buildings.list[0];

    // 1. Private car maintenance & renewal retiring Era-0 vintage car
    const hhMaint = C.newHousehold(home.id, 1);
    hhMaint.car = true; hhMaint.carLoc = home.id; hhMaint.carWear = 0.55; hhMaint.carAge = 5; hhMaint.carVariant = 2; hhMaint.money = 600;
    const c1 = C.add({ age: 30, hh: hhMaint.id });
    hhMaint.members.push(c1);

    const hhRenew = C.newHousehold(home.id, 1);
    hhRenew.car = true; hhRenew.carLoc = home.id; hhRenew.carWear = 0.30; hhRenew.carAge = 20; hhRenew.carVariant = 0; hhRenew.money = 2000;
    const c2 = C.add({ age: 35, hh: hhRenew.id });
    hhRenew.members.push(c2);

    // 2. Public bus line aging, maintenance & renewal
    const l: Line = {
      id: 901, kind: 'bus', color: '#2ecc71', name: 'Linha Teste Frota', stops: [],
      path: [], startS: 0, destS: 0, fleet: 3, vehicles: new Set(), ridersToday: 150, ridersYday: 150,
      waiting: new Map(), onboard: new Map(), edges: new Set(), headway: 180, lastSpawn: 0, pts: [],
      fleetAge: 28, fleetWear: 0.72,
    };
    w.transitSys.lines.push(l);

    const moneyBeforeMaint = hhMaint.money;
    const maintBefore = C.carMaintenances;
    const renewBefore = C.carRenewals;
    const busRenewBefore = w.transitSys.busRenewals;

    C.daily();
    w.transitSys.daily();

    // Maintenance deducted money & reduced carWear
    expect(C.carMaintenances).toBeGreaterThan(maintBefore);
    expect(hhMaint.money).toBeLessThan(moneyBeforeMaint);
    expect(hhMaint.carWear).toBeLessThan(0.35);

    // Vintage car in Era 1 renewed into modern variant with reset age/wear/km
    expect(C.carRenewals).toBeGreaterThan(renewBefore);
    expect(hhRenew.carVariant).toBeGreaterThan(0);
    expect(hhRenew.carAge).toBe(0);
    expect(hhRenew.carWear).toBe(0);

    // Bus fleet renewed & cost accounted
    expect(w.transitSys.busRenewals).toBeGreaterThan(busRenewBefore);
    expect(l.fleetAge).toBe(0);
    expect(l.fleetWear).toBeLessThan(0.2);
    expect(w.transitSys.busMaintCostToday).toBeGreaterThan(0);
  });

  it('regressão splitEdge: criar nó atrás de veículo além do novo sEntry nunca puxa s[i] para trás nem causa sobreposição', () => {
    const w = makeWorld(706);
    const R = w.roads, T = w.traffic;
    clearVehicles(w);

    // Straight road n1 -> n2 (100 m), with two cars close together around s = 44 and s = 51
    const n1 = R.addNode(1000, 2300), n2 = R.addNode(1100, 2300);
    const e = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1 });
    const rear = T.spawn(VType.Car, [e.id * 2], 42, e.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    const lead = T.spawn(VType.Car, [e.id * 2], 49, e.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(rear).toBeGreaterThanOrEqual(0);
    expect(lead).toBeGreaterThanOrEqual(0);

    // Split edge right ahead of `lead` at t = 0.51 (cut = 51 m) and attach a 3rd arm so the new node has deg=3 & trim > 4 m!
    const nMid = R.splitEdge(e.id, 0.51);
    const nSide = R.addNode(nMid.x, nMid.z + 60);
    R.addEdge(nMid.id, nSide.id, RoadClass.Local, { progress: 1 });

    // `lead` is now on e1 at s = 49, which is PAST the new sEntry (~51 - trim - len/2 ≈ 43 m)!
    const sLeadBefore = T.s[lead];
    // Step with red signal blocking transition at nMid: lead MUST NOT be pulled backwards onto `rear`!
    for (let k = 0; k < 10; k++) {
      T.step(0.5, () => false);
      expect(T.s[lead]).toBeGreaterThanOrEqual(sLeadBefore - 0.001);
      expect(countLaneOverlaps(w)).toBe(0);
    }
  });

  it('fail-safe determinístico em Era 0 (sem delegacia/hospital/bombeiros): incidente encerra e libera via sem órfãos', () => {
    const w = makeWorld(707);
    const R = w.roads, T = w.traffic;
    clearVehicles(w);
    // Confirm Era 0 has no hospital/police/fire stations yet
    expect(w.buildings.list.some((b) => b.kind === 'police' || b.kind === 'hospital' || b.kind === 'fire')).toBe(false);

    const n1 = R.addNode(1000, 2450), n2 = R.addNode(1220, 2450);
    const e = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1 });
    const car = T.spawn(VType.Car, [e.id * 2], 110, e.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(car).toBeGreaterThanOrEqual(0);

    const inc = w.incidents.triggerCrash(car, 'major_crash');
    expect(inc).not.toBeNull();
    expect(w.incidents.active.size).toBe(1);

    // Step until resolved via Tow or fail-safe timeout
    for (let k = 0; k < 560 && w.incidents.active.size > 0; k++) w.step(0.5);
    expect(w.incidents.active.size).toBe(0);
    expect(T.blockages.size).toBe(0);
    expect(R.incidentPenalty.size).toBe(0);
    expect(T.active[car]).toBe(0);
  });

  it('regressão pedestre fantasma: triggerCrash que fere motorista a <= 600 m do destino não deixa pedestre órfão em w.peds', () => {
    const w = makeWorld(708);
    const R = w.roads, T = w.traffic, C = w.citizens, P = w.peds;
    clearVehicles(w);
    for (let i = 0; i < P.max; i++) if (P.active[i]) P.despawn(i);

    const n1 = R.addNode(1000, 2600), n2 = R.addNode(1220, 2600);
    const e1 = R.addEdge(n1.id, n2.id, RoadClass.Avenue, { progress: 1, lanes: 2 });
    R.invalidateRoutes();

    const makeDone = (kind: string, x: number, z: number, t: number) => {
      const b = w.buildings.create(kind, { x, z, angle: 0, edge: e1.id, t, side: 1, access: n1.id, offDist: 10, total: 0, terms: {} }, { era: 1, day: 1, w: 12, d: 12, maxDensity: 2, decision: null });
      b.state = 'done'; b.progress = 1;
      return b;
    };
    const home = makeDone('res', 1030, 2614, 0.14);
    const dest = makeDone('com', 1200, 2614, 0.91); // only ~100 m from crash site (well within <= 600 m walk threshold!)

    const hh = C.newHousehold(home.id, 1);
    hh.car = true; hh.carLoc = -1;
    const driver = C.add({ age: 31, hh: hh.id });
    hh.members.push(driver);
    hh.carUser = driver;
    hh.carDriver = driver;
    C.state[driver] = ST_CAR;
    C.tripDest[driver] = dest.id;

    const carSlot = T.spawn(VType.Car, [e1.id * 2], 110, e1.len - 2, { kind: P_CITIZEN, id: driver, aux: 0 }, home.id, dest.id);
    expect(carSlot).toBeGreaterThanOrEqual(0);
    C.slot[driver] = carSlot;

    const inc = w.incidents.triggerCrash(carSlot, 'major_crash');
    expect(inc).not.toBeNull();
    expect(inc!.injuredCitizen).toBe(driver);
    expect(C.slot[driver]).toBe(-1);

    // Verify ZERO orphan pedestrians exist in w.peds for the injured driver
    let driverPeds = 0;
    for (let i = 0; i < P.max; i++) {
      if (P.active[i] && P.citizen[i] === driver) driverPeds++;
    }
    expect(driverPeds).toBe(0);
    expect(hh.carUser).toBe(-1);
  });

  it('saneamento de incidentes em splitEdge, removeEdge e oneWayPair mantém blockages, incidentPenalty e carros 100% íntegros', () => {
    const w = makeWorld(709);
    const R = w.roads, T = w.traffic;
    clearVehicles(w);

    // 1. splitEdge with active incident: migrates cleanly to the split sub-edge with updated blockages/penalty
    const n1 = R.addNode(1000, 2800), n2 = R.addNode(1240, 2800);
    const eSplit = R.addEdge(n1.id, n2.id, RoadClass.Avenue, { progress: 1, lanes: 2 });
    const c1 = T.spawn(VType.Car, [eSplit.id * 2], 70, eSplit.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    const incSplit = w.incidents.triggerBreakdown(c1);
    expect(incSplit).not.toBeNull();
    const oldId = eSplit.id;
    R.splitEdge(oldId, 0.5);
    expect(w.incidents.active.size).toBe(1);
    expect(incSplit!.edge).not.toBe(oldId);
    expect(T.blockages.has(oldId * 2)).toBe(false);
    expect(R.incidentPenalty.has(oldId * 2)).toBe(false);
    expect(T.blockages.has(incSplit!.edge * 2)).toBe(true);
    expect(R.incidentPenalty.get(incSplit!.edge * 2)).toBeGreaterThan(0);

    // 2. removeEdge on the active incident edge: clears incident, blockage, penalty and immobilized car immediately
    const migratedEdgeId = incSplit!.edge;
    R.removeEdge(migratedEdgeId);
    expect(w.incidents.active.size).toBe(0);
    expect(T.blockages.size).toBe(0);
    expect(R.incidentPenalty.size).toBe(0);
    expect(T.active[c1]).toBe(0);

    // 3. oneWayPair on parallel edges with an active incident: cleans incident, blockages, penalty & immobilized car
    const a1 = R.addNode(1000, 2100), a2 = R.addNode(1220, 2100);
    const b1 = R.addNode(1000, 2190), b2 = R.addNode(1220, 2190);
    const eTop = R.addEdge(a1.id, a2.id, RoadClass.Collector, { progress: 1, lanes: 1 });
    const eBot = R.addEdge(b1.id, b2.id, RoadClass.Collector, { progress: 1, lanes: 1 });
    R.addEdge(a1.id, b1.id, RoadClass.Collector, { progress: 1, lanes: 1 });
    R.addEdge(a2.id, b2.id, RoadClass.Collector, { progress: 1, lanes: 1 });
    R.invalidateRoutes();
    R.stepRouting();

    const c2 = T.spawn(VType.Car, [eBot.id * 2], 110, eBot.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(c2).toBeGreaterThanOrEqual(0);
    const incPair = w.incidents.triggerCrash(c2, 'minor_crash');
    expect(incPair).not.toBeNull();
    expect(w.incidents.active.size).toBe(1);

    const paired = (w.upgrades as unknown as { oneWayPair: (e: typeof eTop, p: typeof eBot) => boolean }).oneWayPair(eTop, eBot);
    expect(paired).toBe(true);
    expect(w.incidents.active.size).toBe(0);
    expect(T.blockages.size).toBe(0);
    expect(R.incidentPenalty.size).toBe(0);
    expect(T.active[c2]).toBe(0);
  });

  it('contador towRemovals só incrementa em chegada real de guincho e incidente sem unidades conta como failSafe', () => {
    const w = makeWorld(710);
    const R = w.roads, T = w.traffic;
    clearVehicles(w);

    // Isolated disconnected road segment: no station or nearby node >= 65 m can route to it -> 0 units dispatched
    const n1 = R.addNode(2800, 2800), n2 = R.addNode(2880, 2800);
    const eIso = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1 });
    R.invalidateRoutes();
    const car = T.spawn(VType.Car, [eIso.id * 2], 40, eIso.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(car).toBeGreaterThanOrEqual(0);

    const towBefore = w.incidents.towRemovals;
    const fsBefore = w.incidents.failSafeResolutions;
    const inc = w.incidents.triggerBreakdown(car);
    expect(inc).not.toBeNull();
    expect(inc!.units.tow.slot).toBe(-1);

    for (let k = 0; k < 100 && w.incidents.active.size > 0; k++) w.step(0.5);
    expect(w.incidents.active.size).toBe(0);
    // Tow never arrived -> towRemovals MUST NOT increment, and resolution MUST count as failSafe
    expect(w.incidents.towRemovals).toBe(towBefore);
    expect(w.incidents.failSafeResolutions).toBe(fsBefore + 1);
  });

  it('determinismo do Ciclo 2: mesma seed produz contadores idênticos de incidentes, atendimentos e chegadas', () => {
    const runSeed = () => {
      const w = makeWorld(4242, { terrain: 'vale' });
      for (let i = 0; i < 4800 * 6; i++) w.step(0.5); // 6 days
      return {
        arrivals: w.traffic.arrivals,
        crashes: w.incidents.totalCrashes,
        breakdowns: w.incidents.breakdowns,
        resolved: w.incidents.incidentsResolved,
        maint: w.citizens.carMaintenances,
        renewals: w.citizens.carRenewals,
      };
    };
    expect(runSeed()).toEqual(runSeed());
  }, 60000);
});
