import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { World } from '../src/sim/world';
import { DEFAULT_PARAMS, sanitizeParams } from '../src/shared/params';
import {
  MAX_TRAIN_CARS,
  PED_FLAG_CHILD,
  PED_FLAG_ELDER,
  PED_FLAG_FEMALE,
  PED_FLAG_WAITING,
  PED_STRIDE,
  RoadClass,
  TRAIN_STRIDE,
  VEH_FLAG_SIREN,
  VType,
} from '../src/shared/constants';
import { P_BUS, P_CITIZEN, P_INCIDENT } from '../src/sim/traffic';
import { INC_ROLE_EVAC_HOSPITAL, INC_ROLE_POLICE, INC_ROLE_TOW } from '../src/sim/incidents';
import { Act, ST_IN, ST_TRANSIT, ST_VIRTUAL, ST_WALK } from '../src/sim/citizens';
import type { Line } from '../src/sim/transit';
import { findFamily } from '../src/workbench/registry';
import { AgentsLayer } from '../src/render/agentsLayer';

function makeWorld(seed = 801, extra: Partial<typeof DEFAULT_PARAMS> = {}) {
  return new World({ ...DEFAULT_PARAMS, seed, ...extra });
}

function clearAgents(w: World) {
  for (let i = 0; i < w.traffic.max; i++) if (w.traffic.active[i]) w.traffic.despawn(i);
  for (let i = 0; i < w.peds.max; i++) if (w.peds.active[i]) w.peds.despawn(i);
}

describe('Onda 1 — Regressões do Parecer 3, Causalidade, Física e QA', () => {
  it('1. atropelamento causal: rejeita calçada paralela a 12 m e separação vertical de 12 m; aceita conflito frontal/travessia no mesmo nível', () => {
    const w = makeWorld(811);
    const R = w.roads, T = w.traffic, P = w.peds, C = w.citizens;
    clearAgents(w);

    const n1 = R.addNode(1000, 1200);
    const n2 = R.addNode(1200, 1200);
    const e = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1, lanes: 1 });
    const home = w.buildings.list[0];
    const hh = C.newHousehold(home.id, 1);

    const vehSlot = T.spawn(VType.Car, [e.id * 2], 60, e.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(vehSlot).toBeGreaterThanOrEqual(0);
    T.v[vehSlot] = 8.0;
    T.computePose(vehSlot);
    const vx = T.x[vehSlot], vy = T.y[vehSlot], vz = T.z[vehSlot];

    const spawnWalkPed = (pts: number[], ys: number[], speed = 1.4) => {
      const cid = C.add({ age: 30, hh: hh.id });
      hh.members.push(cid);
      C.state[cid] = ST_WALK;
      const ps = P.spawn(pts, cid, speed, 0, 0, 0, ys);
      expect(ps).toBeGreaterThanOrEqual(0);
      C.slot[cid] = ps;
      return { cid, ps };
    };

    // Case A: Pedestrian walking parallel on sidewalk 12 m laterally away -> MUST be rejected!
    const par = spawnWalkPed([vx + 4, vz + 12, vx + 44, vz + 12], [vy, vy]);
    expect(w.incidents.pickPedCrashPair()).toBeNull();
    P.despawn(par.ps);
    C.state[par.cid] = ST_IN;

    // Case B: Pedestrian directly ahead horizontally but 12 m above on a viaduct -> MUST be rejected by both selector and trigger!
    const high = spawnWalkPed([vx + 5, vz, vx + 5, vz + 20], [vy + 12, vy + 12]);
    expect(w.incidents.pickPedCrashPair()).toBeNull();
    expect(w.incidents.triggerPedCrash(vehSlot, high.ps)).toBeNull();
    P.despawn(high.ps);
    C.state[high.cid] = ST_IN;

    // Case B2 (P1-01): Car at 2.5 m/s, ped 4.9 m ahead & 1.7 m laterally moving perpendicular AWAY at 1.5 m/s -> MUST be rejected!
    T.v[vehSlot] = 2.5;
    const div = spawnWalkPed([vx + 4.9, vz + 1.7, vx + 4.9, vz + 30.0], [vy, vy], 1.5);
    expect(w.incidents.pickPedCrashPair()).toBeNull();
    P.despawn(div.ps);
    C.state[div.cid] = ST_IN;

    // Case C: Pedestrian actively crossing INTO the vehicle's lane in the coincident interval at same vertical level -> MUST be accepted!
    T.v[vehSlot] = 8.0;
    const cross = spawnWalkPed([vx + 6, vz - 2.2, vx + 6, vz + 6.0], [vy, vy], 1.5);
    const pair = w.incidents.pickPedCrashPair();
    expect(pair).toEqual({ vehSlot, pedSlot: cross.ps });

    // Triggering ped_crash holds victim with PED_FLAG_WAITING and freezes 3D position completely (P1-05)
    const inc = w.incidents.triggerPedCrash(vehSlot, cross.ps);
    expect(inc).not.toBeNull();
    expect((P.flags[cross.ps] & PED_FLAG_WAITING) !== 0).toBe(true);
    expect(Number.isFinite(P.arrive[cross.ps])).toBe(false);
    const hx0 = P.x[cross.ps], hy0 = P.y[cross.ps], hz0 = P.z[cross.ps];
    for (let k = 0; k < 20; k++) P.step(0.5);
    P.pose(cross.ps);
    expect(P.x[cross.ps]).toBe(hx0);
    expect(P.y[cross.ps]).toBe(hy0);
    expect(P.z[cross.ps]).toBe(hz0);
  });

  it('2. evacuação hospitalar honesta: ambulância presa não registra hospital nem sobe saúde para 0,75; apenas chegada real trata no hospital', () => {
    const w = makeWorld(812);
    const R = w.roads, T = w.traffic, C = w.citizens;
    clearAgents(w);

    const n1 = R.addNode(1000, 1500), n2 = R.addNode(1220, 1500);
    const e = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1 });
    R.invalidateRoutes();

    const makeDone = (kind: string, x: number, z: number, t: number) => {
      const b = w.buildings.create(kind, { x, z, angle: 0, edge: e.id, t, side: 1, access: n1.id, offDist: 10, total: 0, terms: {} }, { era: 1, day: 1, w: 12, d: 12, maxDensity: 2, decision: null });
      b.state = 'done'; b.progress = 1;
      return b;
    };
    const home = makeDone('res', 1030, 1515, 0.14);
    const hosp = makeDone('hospital', 1190, 1515, 0.86);

    // Part A: Ambulance stuck ~100 m from hospital with retries exhausted -> field stabilization ONLY
    const hh1 = C.newHousehold(home.id, 1);
    const cidStuck = C.add({ age: 33, hh: hh1.id });
    hh1.members.push(cidStuck);
    C.health[cidStuck] = 0.42;
    C.state[cidStuck] = ST_VIRTUAL;

    const ambStuck = T.spawn(VType.Ambulance, [e.id * 2], 80, e.len - 10, { kind: P_INCIDENT, id: 77, aux: INC_ROLE_EVAC_HOSPITAL }, -1, hosp.id, VEH_FLAG_SIREN);
    expect(ambStuck).toBeGreaterThanOrEqual(0);
    type EvacMap = Map<number, { citizenId: number; citizenGen: number; hospitalId: number; incidentId: number; vehGen: number; retries: number; deadline: number; lastX: number; lastZ: number }>;
    const evacs = (w.incidents as unknown as { evacs: EvacMap }).evacs;
    const registerEvac = (w.incidents as unknown as { registerEvac: (slot: number, ev: EvacMap extends Map<number, infer V> ? V : never) => void }).registerEvac.bind(w.incidents);
    // Register evac already at retry cap (2) to force exhaustion on stuck
    registerEvac(ambStuck, {
      citizenId: cidStuck,
      citizenGen: C.gen[cidStuck],
      hospitalId: hosp.id,
      incidentId: 77,
      vehGen: T.gen[ambStuck],
      retries: 2,
      deadline: w.t + 480,
      lastX: 1080,
      lastZ: 1500,
    });

    w.incidents.unitStuck(ambStuck);
    T.despawn(ambStuck);

    expect(C.health[cidStuck]).toBeCloseTo(0.52, 2);
    expect(C.health[cidStuck]).toBeLessThan(0.75);
    expect(C.loc[cidStuck]).not.toBe(hosp.id);
    expect(C.act[cidStuck]).not.toBe(Act.Doctor);
    const bioStuck = C.bio[cidStuck].map((b) => b.text).join(' | ');
    expect(bioStuck).toContain('primeiros socorros no local');
    expect(bioStuck).not.toContain('Atendid');

    // Part B: Real hospital arrival -> hospital treatment, health >= 0.75, Act.Doctor, hospital bio
    const hh2 = C.newHousehold(home.id, 1);
    const cidArr = C.add({ age: 40, hh: hh2.id });
    hh2.members.push(cidArr);
    C.health[cidArr] = 0.40;
    C.state[cidArr] = ST_VIRTUAL;

    const ambOk = T.spawn(VType.Ambulance, [e.id * 2], 180, e.len - 10, { kind: P_INCIDENT, id: 78, aux: INC_ROLE_EVAC_HOSPITAL }, -1, hosp.id, VEH_FLAG_SIREN);
    expect(ambOk).toBeGreaterThanOrEqual(0);
    registerEvac(ambOk, {
      citizenId: cidArr,
      citizenGen: C.gen[cidArr],
      hospitalId: hosp.id,
      incidentId: 78,
      vehGen: T.gen[ambOk],
      retries: 0,
      deadline: w.t + 480,
      lastX: 1180,
      lastZ: 1500,
    });

    w.incidents.unitArrived(ambOk);
    T.despawn(ambOk);

    expect(C.health[cidArr]).toBeGreaterThanOrEqual(0.75);
    expect(C.state[cidArr]).toBe(ST_IN);
    expect(C.loc[cidArr]).toBe(hosp.id);
    expect(C.act[cidArr]).toBe(Act.Doctor);
    expect(C.bio[cidArr].some((b) => b.text.includes(hosp.name))).toBe(true);

    // Part C: Timeout / fail-safe resolution with injured citizen still unpicked -> field stabilization ONLY
    const hh3 = C.newHousehold(home.id, 1);
    const cidFs = C.add({ age: 27, hh: hh3.id });
    hh3.members.push(cidFs);
    C.health[cidFs] = 0.80;
    C.state[cidFs] = ST_WALK;
    const pedFs = w.peds.spawn([1100, 1502, 1140, 1502], cidFs, 1.3, 0, 0);
    C.slot[cidFs] = pedFs;
    const carFs = T.spawn(VType.Car, [e.id * 2], 100, e.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    const incFs = w.incidents.triggerPedCrash(carFs, pedFs);
    expect(incFs).not.toBeNull();
    // Force immediate timeout fail-safe before ambulance arrives
    incFs!.timeoutAt = w.t - 1;
    const hBeforeFs = C.health[cidFs];
    w.incidents.step(0.5);
    expect(w.incidents.active.size).toBe(0);
    expect(C.health[cidFs]).toBeCloseTo(hBeforeFs + 0.10, 2);
    expect(C.health[cidFs]).toBeLessThan(0.75);
    expect(C.loc[cidFs]).not.toBe(hosp.id);
    expect(C.act[cidFs]).not.toBe(Act.Doctor);

    // Part D (P1-02 #1): Ambulance held at closed crossing for > 300 s -> Citizens MUST NOT virtual-arrive into hospital!
    const hh4 = C.newHousehold(home.id, 1);
    const cidGate = C.add({ age: 36, hh: hh4.id });
    hh4.members.push(cidGate);
    C.health[cidGate] = 0.44;
    C.state[cidGate] = ST_VIRTUAL;
    C.tripDest[cidGate] = hosp.id; // even if someone set tripDest, evacCitizens guard blocks virtual arrival!
    const ambGate = T.spawn(VType.Ambulance, [e.id * 2], 120, e.len - 10, { kind: P_INCIDENT, id: 79, aux: INC_ROLE_EVAC_HOSPITAL }, -1, hosp.id, VEH_FLAG_SIREN);
    expect(ambGate).toBeGreaterThanOrEqual(0);
    registerEvac(ambGate, {
      citizenId: cidGate,
      citizenGen: C.gen[cidGate],
      hospitalId: hosp.id,
      incidentId: 79,
      vehGen: T.gen[ambGate],
      retries: 0,
      deadline: w.t + 480,
      lastX: 1120,
      lastZ: 1500,
    });
    C.schedule(cidGate, w.t + 300);
    // Advance clock past 300 s (320 s) while ambulance is still alive waiting before deadline (480 s)
    w.t += 320;
    C.step(0.5);
    w.incidents.step(0.5);
    expect(C.state[cidGate]).toBe(ST_VIRTUAL);
    expect(C.loc[cidGate]).not.toBe(hosp.id);
    expect(C.act[cidGate]).not.toBe(Act.Doctor);
    expect(C.health[cidGate]).toBeCloseTo(0.44, 2);
    expect(evacs.has(ambGate)).toBe(true);
    // Advance past evacuation deadline (480 s) -> clean field stabilization & ambulance despawned
    w.t += 200;
    w.incidents.step(0.5);
    expect(evacs.has(ambGate)).toBe(false);
    expect(T.active[ambGate]).toBe(0);
    expect(C.health[cidGate]).toBeCloseTo(0.54, 2);
    expect(C.loc[cidGate]).not.toBe(hosp.id);

    // Part E (P1-02 #3): Clinic/hospital demolished mid-transport -> arrival MUST NOT grant hospital cure (0.44 -> 0.89)!
    const hh5 = C.newHousehold(home.id, 1);
    const cidDem = C.add({ age: 42, hh: hh5.id });
    hh5.members.push(cidDem);
    C.health[cidDem] = 0.44;
    C.state[cidDem] = ST_VIRTUAL;
    const ambDem = T.spawn(VType.Ambulance, [e.id * 2], 180, e.len - 10, { kind: P_INCIDENT, id: 80, aux: INC_ROLE_EVAC_HOSPITAL }, -1, hosp.id, VEH_FLAG_SIREN);
    expect(ambDem).toBeGreaterThanOrEqual(0);
    registerEvac(ambDem, {
      citizenId: cidDem,
      citizenGen: C.gen[cidDem],
      hospitalId: hosp.id,
      incidentId: 80,
      vehGen: T.gen[ambDem],
      retries: 2, // no alternate hospital available
      deadline: w.t + 480,
      lastX: 1180,
      lastZ: 1500,
    });
    // Demolish the destination hospital before ambulance arrives
    hosp.alive = false;
    hosp.state = 'demolishing';
    w.incidents.unitArrived(ambDem);
    T.despawn(ambDem);
    expect(C.health[cidDem]).toBeCloseTo(0.54, 2);
    expect(C.health[cidDem]).toBeLessThan(0.75);
    expect(C.loc[cidDem]).not.toBe(hosp.id);
    expect(C.act[cidDem]).not.toBe(Act.Doctor);
    expect(C.bio[cidDem].some((b) => b.text.includes('Atendid'))).toBe(false);

    // Part F (P1-02 #2): Road edge removed while ambulance is evacuating -> no orphan in evacs, honest field stabilization!
    const nIso1 = R.addNode(2400, 2400), nIso2 = R.addNode(2600, 2400);
    const eIso = R.addEdge(nIso1.id, nIso2.id, RoadClass.Local, { progress: 1 });
    const hh6 = C.newHousehold(home.id, 1);
    const cidLost = C.add({ age: 29, hh: hh6.id });
    hh6.members.push(cidLost);
    C.health[cidLost] = 0.44;
    C.state[cidLost] = ST_VIRTUAL;
    const ambLost = T.spawn(VType.Ambulance, [eIso.id * 2], 90, eIso.len - 10, { kind: P_INCIDENT, id: 81, aux: INC_ROLE_EVAC_HOSPITAL }, -1, hosp.id, VEH_FLAG_SIREN);
    expect(ambLost).toBeGreaterThanOrEqual(0);
    registerEvac(ambLost, {
      citizenId: cidLost,
      citizenGen: C.gen[cidLost],
      hospitalId: hosp.id,
      incidentId: 81,
      vehGen: T.gen[ambLost],
      retries: 0,
      deadline: w.t + 480,
      lastX: 2490,
      lastZ: 2400,
    });
    // Remove the edge the ambulance is driving on, then revalidate & step incidents
    R.removeEdge(eIso.id);
    T.revalidate();
    w.incidents.step(0.5);
    expect(evacs.has(ambLost)).toBe(false);
    expect(w.incidents.isCitizenEvacuating(cidLost)).toBe(false);
    expect(C.health[cidLost]).toBeCloseTo(0.54, 2);
    expect(C.loc[cidLost]).not.toBe(hosp.id);
  });

  it('3. guincho a 31,8 m com velocidade baixa não chega em 1 tick; viatura em avenida com canteiro central aproxima-se na mesma mão', () => {
    const w = makeWorld(813);
    const R = w.roads, T = w.traffic;
    clearAgents(w);

    // Loop with a divided 2-lane Avenue (nA -> nB) and return road (nB -> nC -> nA)
    const nA = R.addNode(1000, 1800);
    const nB = R.addNode(1240, 1800);
    const nC = R.addNode(1120, 1940);
    const eAve = R.addEdge(nA.id, nB.id, RoadClass.Avenue, { progress: 1, lanes: 2 });
    R.addEdge(nB.id, nC.id, RoadClass.Collector, { progress: 1, lanes: 1 });
    R.addEdge(nC.id, nA.id, RoadClass.Collector, { progress: 1, lanes: 1 });
    R.invalidateRoutes();

    // Place a police station and busDepot DOWNSTREAM on eAve (t = 0.85, closer to nB than nA!)
    const makeDone = (kind: string, x: number, z: number, t: number) => {
      const b = w.buildings.create(kind, { x, z, angle: 0, edge: eAve.id, t, side: 1, access: nB.id, offDist: 12, total: 0, terms: {} }, { era: 2, day: 1, w: 14, d: 14, maxDensity: 2, decision: null });
      b.state = 'done'; b.progress = 1;
      return b;
    };
    makeDone('police', 1200, 1820, 0.83);
    makeDone('busDepot', 1185, 1820, 0.77);

    // Part A: Tow truck spawned 31.8 m short of destS with low speed MUST NOT arrive in 1 tick!
    const destS = 160;
    let arrivedEarly = false;
    const origArrive = T.onArrive;
    T.onArrive = (slot) => {
      if (T.pKind[slot] === P_INCIDENT && T.pAux[slot] === INC_ROLE_TOW) arrivedEarly = true;
    };
    const towProbe = T.spawn(VType.Tow, [eAve.id * 2], destS - 31.8, destS, { kind: P_INCIDENT, id: 999, aux: INC_ROLE_TOW });
    expect(towProbe).toBeGreaterThanOrEqual(0);
    T.v[towProbe] = 0.2;
    T.step(0.5, () => true);
    expect(arrivedEarly).toBe(false);
    expect(T.active[towProbe]).toBe(1);
    T.despawn(towProbe);

    // Part A2 (P1-03): Tow truck blocked behind another stopped car at destS - 13.5 m (~22.5 m before scene) for 15 ticks MUST NOT arrive or count towRemovals!
    const n1L = R.addNode(1400, 1800), n2L = R.addNode(1640, 1800);
    const e1L = R.addEdge(n1L.id, n2L.id, RoadClass.Local, { progress: 1, lanes: 1 });
    const towRemBefore = w.incidents.towRemovals;
    const blockerCar = T.spawn(VType.Car, [e1L.id * 2], destS - 5.5, e1L.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(blockerCar).toBeGreaterThanOrEqual(0);
    T.incidentId[blockerCar] = 888; // keep blocker stopped in the single lane
    const towBlocked = T.spawn(VType.Tow, [e1L.id * 2], destS - 13.5, destS, { kind: P_INCIDENT, id: 998, aux: INC_ROLE_TOW });
    expect(towBlocked).toBeGreaterThanOrEqual(0);
    T.v[towBlocked] = 0;
    for (let k = 0; k < 15; k++) {
      T.step(0.5, () => true);
    }
    expect(arrivedEarly).toBe(false);
    expect(w.incidents.towRemovals).toBe(towRemBefore);
    expect(T.active[towBlocked]).toBe(1);
    T.despawn(towBlocked);
    T.despawn(blockerCar);
    T.onArrive = origArrive;

    // Part B: Major crash on eAve in dir = 0 (nA -> nB, full closure +900 s penalty on eAve*2)
    // Responders coming from downstream MUST loop around and approach upstream on the SAME carriageway (lastDe === eAve.id * 2)!
    const crashed = T.spawn(VType.Car, [eAve.id * 2], 110, eAve.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(crashed).toBeGreaterThanOrEqual(0);
    const inc = w.incidents.triggerCrash(crashed, 'major_crash');
    expect(inc).not.toBeNull();
    expect(R.incidentPenalty.get(eAve.id * 2)).toBe(900);

    const polSlot = inc!.units.police.slot;
    const towSlot = inc!.units.tow.slot;
    expect(polSlot).toBeGreaterThanOrEqual(0);
    expect(towSlot).toBeGreaterThanOrEqual(0);

    const polPath = T.path[polSlot]!;
    const towPath = T.path[towSlot]!;
    expect(polPath[polPath.length - 1]).toBe(eAve.id * 2);
    expect(towPath[towPath.length - 1]).toBe(eAve.id * 2);
  });

  it('4. metrô em linha de 300 m mantém os 4 carros visíveis antes, durante todos os 25 s de inversão e após partir', () => {
    const w = makeWorld(814);
    const rail = w.rail2;
    rail.trains.length = 0;

    // Create a clean 300 m elevated metro line
    const x = [500, 600, 700, 800];
    const y = [12, 12, 12, 12];
    const z = [500, 500, 500, 500];
    const cum = [0, 100, 200, 300];
    const lineId = rail.lines.length;
    rail.lines.push({
      id: lineId,
      kind: 'metro',
      x, y, z, cum,
      tracks: 2,
      elevated: true,
      len: 300,
      built: 1,
      stations: [],
      openStations: [],
    });

    const metroTrain = {
      id: 901,
      line: lineId,
      kind: 'metro' as const,
      s: 295,
      dir: 1,
      v: 15,
      vmax: 19,
      cars: [5, 5, 5, 5],
      dwell: 0,
      served: new Set<number>(),
      gen: 0,
    };
    rail.trains.push(metroTrain);

    const buf = new Float32Array(MAX_TRAIN_CARS * TRAIN_STRIDE);
    const getMetroCars = () => {
      const total = rail.fillSnapshot(buf);
      const xs: number[] = [];
      for (let i = 0; i < total; i++) {
        const o = i * TRAIN_STRIDE;
        if (buf[o + 5] === metroTrain.id) xs.push(buf[o]);
      }
      return xs;
    };

    // 1. Just before reaching end of line: all 4 cars present & center trainPose tracked (P2-01)
    const xsBefore = getMetroCars();
    expect(xsBefore.length).toBe(4);
    const poseBefore = rail.trainPose(metroTrain.id + 100000)!;
    expect(poseBefore).not.toBeNull();

    // 2. Step through terminal reversal and full 25 s dwell (80 ticks of 0.5 s = 40 s)
    let reversedSeen = false;
    let departedSeen = false;
    let maxPoseJumpAtReversal = 0;
    for (let tick = 0; tick < 80; tick++) {
      const prevPose = rail.trainPose(metroTrain.id + 100000)!;
      const prevDir = metroTrain.dir;
      rail.step(0.5);
      const xsNow = getMetroCars();
      expect(xsNow.length).toBe(4);
      if (prevDir !== metroTrain.dir) {
        const afterPose = rail.trainPose(metroTrain.id + 100000)!;
        maxPoseJumpAtReversal = Math.max(maxPoseJumpAtReversal, Math.hypot(afterPose.x - prevPose.x, afterPose.z - prevPose.z));
      }
      if (metroTrain.dir === -1 && metroTrain.dwell > 0) {
        reversedSeen = true;
        // On reversal, physical car x-positions stay continuous (no teleport off-track)
        for (let k = 0; k < 4; k++) {
          expect(xsNow[k]).toBeGreaterThanOrEqual(500);
          expect(xsNow[k]).toBeLessThanOrEqual(800);
        }
        if (tick <= 2) {
          for (let k = 0; k < 4; k++) {
            expect(Math.abs(xsNow[k] - xsBefore[k])).toBeLessThan(8);
          }
        }
      }
      if (metroTrain.dir === -1 && metroTrain.dwell <= 0 && metroTrain.v > 0.5) {
        departedSeen = true;
      }
    }
    expect(reversedSeen).toBe(true);
    expect(departedSeen).toBe(true);
    expect(maxPoseJumpAtReversal).toBeLessThanOrEqual(5);
  });

  it('5. terraplenagem elevando célula de 1,91 m para 10 m sincroniza heights e flood=0 via collectDiff()', () => {
    const w = makeWorld(815);
    const T = w.terrain;
    // Drain any initial dirty flag
    w.collectDiff();

    // Pick an interior dry-land cell outside the river channel and set it to 1.91 m with flood=1
    let ti = -1, tj = -1, tk = -1;
    for (let j = 10; j < T.hres - 10 && tk < 0; j++) {
      for (let i = 10; i < T.hres - 10; i++) {
        const k = j * T.hres + i;
        if (T.water[k] === 0 && T.riverDist[k] > T.riverWidth + 50) {
          ti = i; tj = j; tk = k;
          break;
        }
      }
    }
    expect(tk).toBeGreaterThanOrEqual(0);
    // Raise neighbors around (ti, tj) to 10 m and set (ti, tj) to 1.91 m flooded, then grade a building pad centered on it
    const cx = ti * T.step, cz = tj * T.step;
    for (let dj = -3; dj <= 3; dj++) {
      for (let di = -3; di <= 3; di++) {
        const nk = (tj + dj) * T.hres + (ti + di);
        T.water[nk] = 0;
        T.heights[nk] = 10.0;
        T.flood[nk] = 0;
      }
    }
    T.heights[tk] = 1.91;
    T.flood[tk] = 1;
    w.terraforming.graded[tk] = 0;

    const res = w.terraforming.gradeBuilding(cx, cz, 0, 24, 24);
    expect(res.changed).toBe(true);
    expect(T.heights[tk]).toBeGreaterThanOrEqual(5.0);
    expect(T.flood[tk]).toBe(0);

    const diff = w.collectDiff();
    expect(diff.heights).toBeDefined();
    expect(diff.flood).toBeDefined();
    expect(diff.heights![tk]).toBeCloseTo(T.heights[tk], 4);
    expect(diff.flood![tk]).toBe(0);
  });

  it('6. cancela em nível com cota 3D bloqueia pedestre no nível (e ativa PED_FLAG_WAITING), mas não bloqueia 12 m acima nem abaixo', () => {
    const w = makeWorld(816);
    const P = w.peds;
    clearAgents(w);

    const gx = 1000, gz = 1000, gy = 2.0;
    P.closedGates = [{ x: gx, z: gz, y: gy, ux: 1, uz: 0, halfW: 10 }];

    // Spawn 3 identical walkers approaching gate along +X from x = 994 (6 m before gate)
    const pLevel = P.spawn([gx - 6, gz, gx + 40, gz], -1, 1.4, 0, 0, 0, [gy + 0.15, gy + 0.15]);
    const pAbove = P.spawn([gx - 6, gz, gx + 40, gz], -1, 1.4, 0, 0, 0, [gy + 12.0, gy + 12.0]);
    const pBelow = P.spawn([gx - 6, gz, gx + 40, gz], -1, 1.4, 0, 0, 0, [gy - 6.0, gy - 6.0]);

    for (let k = 0; k < 6; k++) P.step(0.5);

    P.pose(pLevel);
    P.pose(pAbove);
    P.pose(pBelow);

    // At-grade pedestrian was held right before the gate with gateHeld === 1
    expect(P.gateHeld[pLevel]).toBe(1);
    expect(P.x[pLevel]).toBeLessThan(gx - 5.0);

    // Viaduct (+12 m) and underpass (-6 m) pedestrians passed unimpeded!
    expect(P.gateHeld[pAbove]).toBe(0);
    expect(P.x[pAbove]).toBeGreaterThan(gx - 3.0);
    expect(P.gateHeld[pBelow]).toBe(0);
    expect(P.x[pBelow]).toBeGreaterThan(gx - 3.0);

    // Snapshot emits PED_FLAG_WAITING for gate-held pedestrian and NOT for free walkers
    const out = new Float32Array(P.max * PED_STRIDE);
    P.fillSnapshot(out, { x: gx, z: gz, h: 100 });
    expect((out[pLevel * PED_STRIDE + 5] & PED_FLAG_WAITING) !== 0).toBe(true);
    expect((out[pAbove * PED_STRIDE + 5] & PED_FLAG_WAITING) !== 0).toBe(false);
    expect((out[pBelow * PED_STRIDE + 5] & PED_FLAG_WAITING) !== 0).toBe(false);
  });

  it('7. incidentFreq = 0 bloqueia acidentes emergentes mesmo com disasterFreq > 0, enquanto injectIncident() continua funcionando', () => {
    expect(DEFAULT_PARAMS.incidentFreq).toBe(1);
    expect(sanitizeParams({ incidentFreq: 0 }).incidentFreq).toBe(0);
    expect(sanitizeParams({ incidentFreq: -5 }).incidentFreq).toBe(0);
    expect(sanitizeParams({ incidentFreq: 9 }).incidentFreq).toBe(3);

    const w = makeWorld(817, { incidentFreq: 0, disasterFreq: 3 });
    w.day = 5;
    // Populate road with moving cars and run emergent generator many times
    const e = w.roads.edges.find((q) => q.alive && q.progress >= 1 && q.len >= 50 && !q.bridge && !q.tunnel && !q.elevated && q.deck === undefined);
    expect(e).toBeDefined();
    for (let k = 0; k < 15; k++) {
      const s = w.traffic.spawn(VType.Car, [e!.id * 2], 16 + k * 2, e!.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
      if (s >= 0) w.traffic.v[s] = 10;
    }
    const maybe = (w.incidents as unknown as { maybeGenerateEmergent: () => void }).maybeGenerateEmergent.bind(w.incidents);
    for (let k = 0; k < 200; k++) {
      w.t += 200;
      maybe();
    }
    expect(w.incidents.totalCrashes).toBe(0);
    expect(w.incidents.breakdowns).toBe(0);
    expect(w.incidents.active.size).toBe(0);

    // Manual injectIncident() still works regardless of incidentFreq = 0
    const injected = w.incidents.injectIncident('minor_crash');
    expect(injected).not.toBeNull();
    expect(w.incidents.active.size).toBe(1);
  });

  it('8. renovação gradual de ônibus renova 1 unidade por ciclo sem zerar a linha toda de uma vez e aposenta na garagem em busArrived()', () => {
    const w = makeWorld(818);
    const R = w.roads, T = w.traffic;
    clearAgents(w);
    w.budget.money = 5000;

    const n1 = R.addNode(1000, 2200), n2 = R.addNode(1200, 2200);
    const e = R.addEdge(n1.id, n2.id, RoadClass.Collector, { progress: 1 });
    const busSlot = T.spawn(VType.Bus, [e.id * 2], 20, e.len - 2, { kind: P_BUS, id: 902, aux: 0 });
    expect(busSlot).toBeGreaterThanOrEqual(0);

    const line: Line = {
      id: 902,
      kind: 'bus',
      color: '#3498db',
      name: 'Linha Gradual 1',
      stops: [{ id: 1, x: 1050, z: 2200, node: n1.id, edge: e.id, dir: 0, s: 50, curbX: 1050, curbZ: 2204, ux: 1, uz: 0, name: 'Ponto 1' }],
      path: [e.id * 2],
      startS: 5,
      destS: e.len - 2,
      fleet: 4,
      vehicles: new Set([busSlot]),
      ridersToday: 160,
      ridersYday: 160,
      waiting: new Map(),
      onboard: new Map(),
      edges: new Set([e.id]),
      headway: 120,
      lastSpawn: 0,
      pts: [n1.x, n1.y, n1.z, n2.x, n2.y, n2.z],
      fleetAge: 28,
      fleetWear: 0.72,
    };
    w.transitSys.lines.push(line);

    const renewalsBefore = w.transitSys.busRenewals;
    w.transitSys.daily();

    // P1-04: daily() only schedules pendingRenewals without reducing age/wear, charging $40, or incrementing busRenewals
    expect(w.transitSys.busRenewals).toBe(renewalsBefore);
    expect(line.fleetAge).toBe(29);
    expect(line.pendingRenewals).toBe(1);
    const wearAfterDaily = line.fleetWear!;
    const costAfterDaily = w.transitSys.busMaintCostToday;

    // Mid-route interruption (vehicleStuck / busInterrupted) MUST preserve pendingRenewals and NOT count a renewal!
    w.events.drain();
    const midSlot = T.spawn(VType.Bus, [e.id * 2], 35, e.len - 2, { kind: P_BUS, id: 902, aux: 0 });
    expect(midSlot).toBeGreaterThanOrEqual(0);
    line.vehicles.add(midSlot);
    w.vehicleStuck(midSlot);
    T.despawn(midSlot);
    expect(line.pendingRenewals).toBe(1);
    expect(line.fleetAge).toBe(29);
    expect(line.fleetWear).toBe(wearAfterDaily);
    expect(w.transitSys.busRenewals).toBe(renewalsBefore);
    expect(w.transitSys.busMaintCostToday).toBe(costAfterDaily);
    expect(w.events.drain().some((ev) => ev.text.includes('Ônibus renovado'))).toBe(false);

    // Genuine depot return in busArrived() consumes pendingRenewals, applies proportional 1/4 age/wear reduction, charges $40, and emits honest event
    w.transitSys.busArrived(busSlot);
    expect(w.transitSys.busRenewals).toBe(renewalsBefore + 1);
    expect(line.pendingRenewals).toBe(0);
    expect(line.fleetAge).toBeCloseTo(29 * 0.75, 2);
    expect(line.fleetAge).toBeGreaterThan(15);
    expect(w.transitSys.busMaintCostToday).toBe(costAfterDaily + 40);
    expect(line.vehicles.has(busSlot)).toBe(false);
    const evs = w.events.drain();
    expect(evs.some((ev) => ev.text.includes('Ônibus renovado na frota da Linha Gradual 1'))).toBe(true);
  });

  it('9. carros ferroviários em rampa (4%) emitem pitch não-nulo com sinal correto em subida e descida', () => {
    expect(TRAIN_STRIDE).toBe(7);
    const w = makeWorld(819);
    const rail = w.rail2;
    rail.trains.length = 0;

    // 4% uphill grade along +X: y rises 4 m per 100 m (atan2(4, 100) ≈ +0.03998 rad)
    const lineId = rail.lines.length;
    rail.lines.push({
      id: lineId,
      kind: 'main',
      x: [0, 100, 200, 300],
      y: [2, 6, 10, 14],
      z: [500, 500, 500, 500],
      cum: [0, 100, 200, 300],
      tracks: 1,
      elevated: false,
      len: 300,
      built: 1,
      stations: [],
      openStations: [],
    });

    const expectedPitch = Math.atan2(4, 100);
    const buf = new Float32Array(MAX_TRAIN_CARS * TRAIN_STRIDE);

    // Uphill train (dir = +1)
    rail.trains.push({ id: 910, line: lineId, kind: 'pass', s: 180, dir: 1, v: 15, vmax: 24, cars: [0, 1], dwell: 0, served: new Set(), gen: 0 });
    expect(rail.fillSnapshot(buf)).toBe(2);
    const pitchUp = buf[6];
    const yawUp = buf[3];
    expect(pitchUp).toBeCloseTo(expectedPitch, 3);
    expect(pitchUp).toBeGreaterThan(0.03);

    // Verify Three.js quaternion composition (qYaw * qPitch) lifts local front (+X) UP on uphill
    const qUp = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yawUp)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), pitchUp));
    const frontUp = new THREE.Vector3(1, 0, 0).applyQuaternion(qUp);
    expect(frontUp.y).toBeGreaterThan(0.03);
    expect(frontUp.x).toBeGreaterThan(0.99);

    // Downhill train (dir = -1)
    rail.trains.length = 0;
    rail.trains.push({ id: 911, line: lineId, kind: 'pass', s: 120, dir: -1, v: 15, vmax: 24, cars: [0, 1], dwell: 0, served: new Set(), gen: 0 });
    expect(rail.fillSnapshot(buf)).toBe(2);
    const pitchDown = buf[6];
    const yawDown = buf[3];
    expect(pitchDown).toBeCloseTo(-expectedPitch, 3);
    expect(pitchDown).toBeLessThan(-0.03);

    const qDown = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yawDown)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), pitchDown));
    const frontDown = new THREE.Vector3(1, 0, 0).applyQuaternion(qDown);
    expect(frontDown.y).toBeLessThan(-0.03);
    expect(frontDown.x).toBeLessThan(-0.99);
  });

  it('10. rigor da bancada (findFamily), PED_FLAG_WAITING em hold() e flags de identidade demográfica', () => {
    // Workbench strict family lookup
    expect(findFamily('invalida')).toBeNull();
    expect(findFamily('')).toBeNull();
    expect(findFamily(null)).toBeNull();
    expect(findFamily('vehicles')?.id).toBe('vehicles');
    expect(findFamily('rail')?.id).toBe('rail');

    // PED_FLAG_WAITING emitted for held pedestrians + demographic identity flags
    const w = makeWorld(820);
    const P = w.peds, C = w.citizens;
    clearAgents(w);
    const home = w.buildings.list[0];
    const hh = C.newHousehold(home.id, 1);

    const girl = C.add({ age: 10, sex: 1, hh: hh.id });
    const elderMan = C.add({ age: 72, sex: 0, hh: hh.id });
    const adultWoman = C.add({ age: 35, sex: 1, hh: hh.id });

    expect(C.pedIdentityFlags(girl)).toBe(PED_FLAG_FEMALE | PED_FLAG_CHILD);
    expect(C.pedIdentityFlags(elderMan)).toBe(PED_FLAG_ELDER);
    expect(C.pedIdentityFlags(adultWoman)).toBe(PED_FLAG_FEMALE);

    const ps = P.spawn([1000, 1000, 1040, 1000], girl, 1.3, C.pedIdentityFlags(girl), C.colorOf(girl));
    expect(ps).toBeGreaterThanOrEqual(0);
    // Walk 2 s, then hold() and verify 3D position stays strictly frozen over 10 s (20 ticks of 0.5 s)
    for (let k = 0; k < 4; k++) P.step(0.5);
    P.hold(ps);
    const heldX = P.x[ps], heldY = P.y[ps], heldZ = P.z[ps];
    for (let k = 0; k < 20; k++) P.step(0.5);

    const out = new Float32Array(P.max * PED_STRIDE);
    P.fillSnapshot(out, { x: heldX, z: heldZ, h: 100 });
    expect(out[ps * PED_STRIDE]).toBe(heldX);
    expect(out[ps * PED_STRIDE + 1]).toBe(heldY);
    expect(out[ps * PED_STRIDE + 2]).toBe(heldZ);
    const flags = out[ps * PED_STRIDE + 5];
    expect((flags & PED_FLAG_WAITING) !== 0).toBe(true);
    expect((flags & PED_FLAG_FEMALE) !== 0).toBe(true);
    expect((flags & PED_FLAG_CHILD) !== 0).toBe(true);
  });

  it('11. [P1-02 + P2-06] Citizens.position(cid) acompanha a ambulância em tempo real; clínica abandonada não cura e cidadão removido despawna ambulância órfã', () => {
    const w = makeWorld(821);
    const R = w.roads, T = w.traffic, C = w.citizens;
    clearAgents(w);

    const n1 = R.addNode(1000, 1600), n2 = R.addNode(1240, 1600);
    const e = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1 });
    R.invalidateRoutes();
    const makeDone = (kind: string, x: number, z: number, t: number) => {
      const b = w.buildings.create(kind, { x, z, angle: 0, edge: e.id, t, side: 1, access: n1.id, offDist: 10, total: 0, terms: {} }, { era: 1, day: 1, w: 12, d: 12, maxDensity: 2, decision: null });
      b.state = 'done'; b.progress = 1;
      return b;
    };
    const home = makeDone('res', 1020, 1615, 0.08);
    const clinic = makeDone('clinic', 1220, 1615, 0.92);

    type EvacReg = (slot: number, ev: { citizenId: number; citizenGen: number; hospitalId: number; incidentId: number; vehGen: number; retries: number; deadline: number; lastX: number; lastZ: number }) => void;
    const registerEvac = (w.incidents as unknown as { registerEvac: EvacReg }).registerEvac.bind(w.incidents);

    // Part A (P1-02): Victim position tracks moving ambulance in real time
    const hh1 = C.newHousehold(home.id, 1);
    const cidMove = C.add({ age: 31, hh: hh1.id });
    hh1.members.push(cidMove);
    C.health[cidMove] = 0.45;
    C.state[cidMove] = ST_VIRTUAL;
    C.tripDest[cidMove] = -1;
    C.vFromX[cidMove] = 1040;
    C.vFromZ[cidMove] = 1600;

    const amb = T.spawn(VType.Ambulance, [e.id * 2], 40, e.len - 10, { kind: P_INCIDENT, id: 101, aux: INC_ROLE_EVAC_HOSPITAL }, -1, clinic.id, VEH_FLAG_SIREN);
    expect(amb).toBeGreaterThanOrEqual(0);
    registerEvac(amb, {
      citizenId: cidMove,
      citizenGen: C.gen[cidMove],
      hospitalId: clinic.id,
      incidentId: 101,
      vehGen: T.gen[amb],
      retries: 0,
      deadline: w.t + 480,
      lastX: 1040,
      lastZ: 1600,
    });

    const p0 = C.position(cidMove)!;
    expect(p0).not.toBeNull();
    for (let k = 0; k < 10; k++) T.step(0.5, () => true);
    T.computePose(amb);
    const p1 = C.position(cidMove)!;
    expect(p1.x).toBeGreaterThan(p0.x + 15);
    expect(Math.hypot(p1.x - T.x[amb], p1.z - T.z[amb])).toBeLessThan(0.05);

    // Part B (P2-06a): Clinic marked abandoned mid-transport MUST NOT grant hospital cure
    clinic.abandoned = true;
    // Also mark retries=2 so it doesn't try to spawn another ambulance
    const evMap = (w.incidents as unknown as { evacs: Map<number, { retries: number }> }).evacs;
    evMap.get(amb)!.retries = 2;
    w.incidents.unitArrived(amb);
    T.despawn(amb);
    expect(C.health[cidMove]).toBeCloseTo(0.55, 2);
    expect(C.health[cidMove]).toBeLessThan(0.75);
    expect(C.loc[cidMove]).not.toBe(clinic.id);
    expect(C.act[cidMove]).not.toBe(Act.Doctor);

    // Part C (P2-06b): Citizen removed/deceased mid-evacuation despawns ambulance cleanly (no orphan)
    clinic.abandoned = false;
    const hh2 = C.newHousehold(home.id, 1);
    const cidGone = C.add({ age: 50, hh: hh2.id });
    hh2.members.push(cidGone);
    C.state[cidGone] = ST_VIRTUAL;
    const ambOrph = T.spawn(VType.Ambulance, [e.id * 2], 50, e.len - 10, { kind: P_INCIDENT, id: 102, aux: INC_ROLE_EVAC_HOSPITAL }, -1, clinic.id, VEH_FLAG_SIREN);
    expect(ambOrph).toBeGreaterThanOrEqual(0);
    registerEvac(ambOrph, {
      citizenId: cidGone,
      citizenGen: C.gen[cidGone],
      hospitalId: clinic.id,
      incidentId: 102,
      vehGen: T.gen[ambOrph],
      retries: 0,
      deadline: w.t + 480,
      lastX: 1050,
      lastZ: 1600,
    });
    C.alive[cidGone] = 0;
    w.incidents.step(0.5);
    expect(T.active[ambOrph]).toBe(0);
    expect(w.incidents.isCitizenEvacuating(cidGone)).toBe(false);
  });

  it('12. [P1-03] cancela fechada entre o sinistro e o guincho (mesmo atrás de polícia da própria ocorrência) impede arrived e towRemovals', () => {
    const w = makeWorld(822);
    const R = w.roads, T = w.traffic;
    clearAgents(w);

    const n1 = R.addNode(1000, 2000), n2 = R.addNode(1220, 2000);
    const e = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1, lanes: 1 });
    R.invalidateRoutes();

    // Incident at s = 130, closed rail crossing gate at s = 125 (t = 125/220)
    const wrecked = T.spawn(VType.Car, [e.id * 2], 130, e.len - 2, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(wrecked).toBeGreaterThanOrEqual(0);
    const inc = w.incidents.triggerBreakdown(wrecked)!;
    expect(inc).not.toBeNull();
    // Clear any auto-dispatched units and set up the exact gate-separated scenario
    for (const u of [inc.units.police, inc.units.ambulance, inc.units.fire, inc.units.tow]) {
      if (u.slot >= 0 && T.active[u.slot]) T.despawn(u.slot);
      u.slot = -1; u.arrived = false;
    }

    // Closed crossing at s = 125
    T.closedCrossings.set(e.id, [125 / e.len]);

    // Police stopped before the gate at s = 109.22 (even if tagged with inc.id)
    const pol = T.spawn(VType.Police, [e.id * 2], 109.22, 130 - 17.5, { kind: P_INCIDENT, id: inc.id, aux: INC_ROLE_POLICE });
    expect(pol).toBeGreaterThanOrEqual(0);
    T.incidentId[pol] = inc.id;
    T.v[pol] = 0;

    // Tow behind police at s = 100.02 (on the WRONG side of the closed gate at s = 125!)
    const tow = T.spawn(VType.Tow, [e.id * 2], 100.02, 130 - 8.5, { kind: P_INCIDENT, id: inc.id, aux: INC_ROLE_TOW });
    expect(tow).toBeGreaterThanOrEqual(0);
    inc.units.tow.slot = tow;
    inc.units.tow.gen = T.gen[tow];
    inc.units.tow.required = true;
    const towBefore = w.incidents.towRemovals;

    for (let k = 0; k < 20; k++) {
      T.step(0.5, () => true);
    }
    expect(inc.units.tow.arrived).toBe(false);
    expect(w.incidents.towRemovals).toBe(towBefore);
    expect(T.active[tow]).toBe(1);
    expect(T.s[tow]).toBeLessThan(120);
  });

  it('13. [P1-04a] ônibus preso a 14,8 m do terminal atrás de carro parado por >10 s NÃO dispara busArrived() nem consome renovação', () => {
    const w = makeWorld(823);
    const R = w.roads, T = w.traffic;
    clearAgents(w);
    w.budget.money = 5000;

    const n1 = R.addNode(1000, 2300), n2 = R.addNode(1220, 2300);
    const e = R.addEdge(n1.id, n2.id, RoadClass.Local, { progress: 1, lanes: 1 });
    const destS = e.len - 2;
    const line: Line = {
      id: 950, kind: 'bus', color: '#3498db', name: 'Linha Teste Terminal',
      stops: [{ id: 1, x: 1050, z: 2300, node: n1.id, edge: e.id, dir: 0, s: 50, curbX: 1050, curbZ: 2304, ux: 1, uz: 0, name: 'P1' }],
      path: [e.id * 2], startS: 5, destS, fleet: 3, vehicles: new Set(), ridersToday: 100, ridersYday: 100,
      waiting: new Map(), onboard: new Map(), edges: new Set([e.id]), headway: 120, lastSpawn: 0, pts: [],
      fleetAge: 30, fleetWear: 0.5, pendingRenewals: 1,
    };
    w.transitSys.lines.push(line);

    const blocker = T.spawn(VType.Car, [e.id * 2], destS - 4.0, destS, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(blocker).toBeGreaterThanOrEqual(0);
    T.incidentId[blocker] = 777; // stopped blocker car in the single lane

    const bus = T.spawn(VType.Bus, [e.id * 2], destS - 14.8, destS, { kind: P_BUS, id: line.id, aux: 0 });
    expect(bus).toBeGreaterThanOrEqual(0);
    line.vehicles.add(bus);
    T.v[bus] = 0;

    const renewBefore = w.transitSys.busRenewals;
    // Step 26 ticks = 13 s (> 8 s stuck threshold that civilian cars use)
    for (let k = 0; k < 26; k++) T.step(0.5, () => true);

    expect(T.active[bus]).toBe(1);
    expect(line.pendingRenewals).toBe(1);
    expect(w.transitSys.busRenewals).toBe(renewBefore);
  });

  it('14. [P1-04b] custo de $40 da renovação efetiva em busArrived() sobrevive a Transit.daily() e é debitado no caixa/despesas em CityHall.daily()', () => {
    const runCloseout = (withRenewal: boolean) => {
      const w = makeWorld(824);
      const R = w.roads, T = w.traffic;
      clearAgents(w);
      w.budget.money = 5000;
      const n1 = R.addNode(1000, 2400), n2 = R.addNode(1200, 2400);
      const e = R.addEdge(n1.id, n2.id, RoadClass.Collector, { progress: 1 });
      const bus = T.spawn(VType.Bus, [e.id * 2], 20, e.len - 2, { kind: P_BUS, id: 960, aux: 0 });
      const line: Line = {
        id: 960, kind: 'bus', color: '#2ecc71', name: 'Linha Caixa',
        stops: [], path: [e.id * 2], startS: 5, destS: e.len - 2, fleet: 4, vehicles: new Set([bus]),
        ridersToday: 0, ridersYday: 0, waiting: new Map(), onboard: new Map(), edges: new Set([e.id]),
        headway: 120, lastSpawn: 0, pts: [], fleetAge: 20, fleetWear: 0.1,
        pendingRenewals: withRenewal ? 1 : 0,
      };
      w.transitSys.lines.push(line);
      if (withRenewal) w.transitSys.busArrived(bus);
      const moneyBefore = w.budget.money;
      w.transitSys.daily();
      w.cityHall.daily();
      return {
        moneyDelta: w.budget.money - moneyBefore,
        expenses: w.budget.expenses,
        transitBreakdown: w.cityHall.breakdown.transit,
      };
    };

    const base = runCloseout(false);
    const renewed = runCloseout(true);
    expect(renewed.transitBreakdown - base.transitBreakdown).toBeCloseTo(40, 2);
    expect(renewed.expenses - base.expenses).toBeCloseTo(40, 2);
    expect(base.moneyDelta - renewed.moneyDelta).toBeCloseTo(40, 2);
  });

  it('15. [P1-07] passageiro pagante a bordo durante renovação (ônibus e BRT) mantém vínculo com a linha e continua viagem no ônibus substituto', () => {
    for (const kind of ['bus', 'brt'] as const) {
      const w = makeWorld(kind === 'bus' ? 825 : 826);
      const R = w.roads, T = w.traffic, C = w.citizens;
      clearAgents(w);
      w.budget.money = 5000;

      const n1 = R.addNode(1000, 2500), n2 = R.addNode(1220, 2500);
      const e = R.addEdge(n1.id, n2.id, RoadClass.Avenue, { progress: 1, lanes: 2 });
      e.busLane = kind === 'brt';
      const home = w.buildings.list[0];
      const dest = w.buildings.list[w.buildings.list.length - 1];
      const hh = C.newHousehold(home.id, 1);
      const rider = C.add({ age: 28, hh: hh.id });
      hh.members.push(rider);
      C.state[rider] = ST_TRANSIT;
      C.loc[rider] = home.id;

      const oldBus = T.spawn(VType.Bus, [e.id * 2], 180, e.len - 2, { kind: P_BUS, id: 970, aux: 1 });
      expect(oldBus).toBeGreaterThanOrEqual(0);
      const line: Line = {
        id: 970, kind, color: '#e74c3c', name: kind === 'brt' ? 'BRT Teste' : 'Ônibus Teste',
        stops: [{ id: 1, x: 1050, z: 2500, node: n1.id, edge: e.id, dir: 0, s: 50, curbX: 1050, curbZ: 2504, ux: 1, uz: 0, name: 'P1' }],
        path: [e.id * 2], startS: 10, destS: e.len - 2, fleet: 4, vehicles: new Set([oldBus]),
        ridersToday: 80, ridersYday: 80, waiting: new Map(), onboard: new Map([[oldBus, [rider]]]),
        edges: new Set([e.id]), headway: 120, lastSpawn: 0, pts: [],
        fleetAge: 30, fleetWear: 0.6, pendingRenewals: 1,
      };
      w.transitSys.lines.push(line);
      w.transitSys.rides.set(rider, {
        line: line.id, fromId: 1, toId: 2, gen: C.gen[rider], phase: 2, since: w.t, dest: dest.id,
      });

      w.transitSys.busArrived(oldBus);
      T.despawn(oldBus);

      // Renewal completed AND paid passenger transferred cleanly onto the brand-new replacement bus
      expect(line.pendingRenewals).toBe(0);
      expect(w.transitSys.busRenewals).toBeGreaterThanOrEqual(1);
      expect(C.state[rider]).toBe(ST_TRANSIT);
      const rideAfter = w.transitSys.rides.get(rider);
      expect(rideAfter).toBeDefined();
      expect(rideAfter!.line).toBe(line.id);
      expect(rideAfter!.phase).toBe(2);
      const newSlots = [...line.vehicles];
      expect(newSlots.length).toBe(1);
      expect(newSlots[0]).not.toBe(oldBus);
      expect(line.onboard.get(newSlots[0])).toEqual([rider]);
    }
  });

  it('16. [P2-04] metrô em via dupla mantém continuidade lateral (< 0,05 m) na inversão e durante todo o dwell, transitando suavemente após partir', () => {
    const w = makeWorld(827);
    const rail = w.rail2;
    rail.trains.length = 0;

    const lineId = rail.lines.length;
    rail.lines.push({
      id: lineId, kind: 'metro',
      x: [500, 600, 700, 800], y: [12, 12, 12, 12], z: [500, 500, 500, 500], cum: [0, 100, 200, 300],
      tracks: 2, elevated: true, len: 300, built: 1, stations: [], openStations: [],
    });
    const metro = {
      id: 980, line: lineId, kind: 'metro' as const, s: 298, dir: 1, v: 10, vmax: 19,
      cars: [5, 5, 5, 5], dwell: 0, served: new Set<number>(), gen: 0, trackSide: 1,
    };
    rail.trains.push(metro);

    const buf = new Float32Array(MAX_TRAIN_CARS * TRAIN_STRIDE);
    const getZs = () => {
      const tot = rail.fillSnapshot(buf);
      const zs: number[] = [];
      for (let i = 0; i < tot; i++) if (buf[i * TRAIN_STRIDE + 5] === metro.id) zs.push(buf[i * TRAIN_STRIDE + 2]);
      return zs;
    };

    const zsBefore = getZs();
    expect(zsBefore.length).toBe(4);
    for (const z of zsBefore) expect(z).toBeCloseTo(502.1, 2);

    // Step across reversal and full 25 s dwell: lateral z MUST NOT jump by 4.20 m (< 0.05 m delta!)
    let sawReversalDwell = false;
    let sawSmoothMidCrossover = false;
    let sawOppositeTrack = false;
    for (let tick = 0; tick < 110; tick++) {
      rail.step(0.5);
      const zsNow = getZs();
      expect(zsNow.length).toBe(4);
      if (metro.dir === -1 && metro.dwell > 0) {
        sawReversalDwell = true;
        for (let k = 0; k < 4; k++) {
          expect(Math.abs(zsNow[k] - zsBefore[k])).toBeLessThan(0.05);
        }
      } else if (metro.dir === -1 && metro.dwell <= 0) {
        if (zsNow[0] < 501.8 && zsNow[0] > 498.2) sawSmoothMidCrossover = true;
        if (Math.abs(zsNow[0] - 497.9) < 0.05) sawOppositeTrack = true;
      }
    }
    expect(sawReversalDwell).toBe(true);
    expect(sawSmoothMidCrossover).toBe(true);
    expect(sawOppositeTrack).toBe(true);
  });

  it('17. [P1-07/P2-07] recusa de saída do ônibus substituto continua viagem do ponto real de desembarque (sem salto à origem) e inversão de trem não gira vagões a 90°', () => {
    // Part A (P1-07): refused replacement bus (closed gate at start) continues rider from real bus position, never origin
    for (const kind of ['bus', 'brt'] as const) {
      const w = makeWorld(kind === 'bus' ? 828 : 829);
      const R = w.roads, T = w.traffic, C = w.citizens;
      clearAgents(w);
      w.budget.money = 5000;

      const n1 = R.addNode(1000, 2600), n2 = R.addNode(1220, 2600);
      const e = R.addEdge(n1.id, n2.id, RoadClass.Avenue, { progress: 1, lanes: 2 });
      e.busLane = kind === 'brt';
      R.invalidateRoutes();
      const home = w.buildings.list[0];
      const dest = w.buildings.list[w.buildings.list.length - 1];
      const hh = C.newHousehold(home.id, 1);
      const rider = C.add({ age: 31, hh: hh.id });
      hh.members.push(rider);
      C.state[rider] = ST_TRANSIT;
      C.loc[rider] = home.id;
      C.tripDest[rider] = dest.id;

      const oldBus = T.spawn(VType.Bus, [e.id * 2], 210, e.len - 2, { kind: P_BUS, id: 975, aux: 1 });
      expect(oldBus).toBeGreaterThanOrEqual(0);
      T.computePose(oldBus);
      const busDropX = T.x[oldBus], busDropZ = T.z[oldBus];

      const line: Line = {
        id: 975, kind, color: '#e74c3c', name: kind === 'brt' ? 'BRT Bloqueado' : 'Ônibus Bloqueado',
        stops: [{ id: 1, x: 1050, z: 2600, node: n1.id, edge: e.id, dir: 0, s: 50, curbX: 1050, curbZ: 2604, ux: 1, uz: 0, name: 'P1' }],
        path: [e.id * 2], startS: 10, destS: e.len - 2, fleet: 4, vehicles: new Set([oldBus]),
        ridersToday: 80, ridersYday: 80, waiting: new Map(), onboard: new Map([[oldBus, [rider]]]),
        edges: new Set([e.id]), headway: 120, lastSpawn: 0, pts: [],
        fleetAge: 30, fleetWear: 0.6, pendingRenewals: 1,
      };
      w.transitSys.lines.push(line);
      w.transitSys.rides.set(rider, {
        line: line.id, fromId: 1, toId: 2, gen: C.gen[rider], phase: 2, since: w.t, dest: dest.id,
      });

      // Block start edge so spawnBus(l) refuses replacement departure (-1)
      T.closedCrossings.set(e.id, [10 / e.len]);
      w.transitSys.busArrived(oldBus);
      T.despawn(oldBus);

      expect(line.pendingRenewals).toBe(1);
      expect(line.onboard.has(-1)).toBe(false);
      // Citizen continues from real bus dropoff point (busDropX, busDropZ), NOT teleported back to home!
      const posAfter = C.position(rider);
      expect(posAfter).not.toBeNull();
      const distFromDrop = Math.hypot(posAfter!.x - busDropX, posAfter!.z - busDropZ);
      const distFromHome = Math.hypot(home.x - busDropX, home.z - busDropZ);
      expect(distFromHome).toBeGreaterThan(25);
      expect(distFromDrop).toBeLessThan(12);
    }

    // Part B (P2-07): real AgentsLayer.interpolate(0.5) on ~180° metro reversal keeps all 4 cars aligned along the track
    const prevTrain = new Float32Array(4 * TRAIN_STRIDE);
    const curTrain = new Float32Array(4 * TRAIN_STRIDE);
    for (let k = 0; k < 4; k++) {
      const o = k * TRAIN_STRIDE;
      const x = 600 + k * 19.6;
      prevTrain[o] = x; prevTrain[o + 1] = 12.3; prevTrain[o + 2] = 502.1; prevTrain[o + 3] = 0; prevTrain[o + 4] = 5; prevTrain[o + 5] = 42; prevTrain[o + 6] = 0;
      curTrain[o] = x; curTrain[o + 1] = 12.3; curTrain[o + 2] = 502.1; curTrain[o + 3] = Math.PI; curTrain[o + 4] = 5; curTrain[o + 5] = 42; curTrain[o + 6] = 0;
    }
    const fakeLayer = {
      app: {
        prevSnap: { veh: new Float32Array(0), ped: new Float32Array(0), train: prevTrain, trainCount: 4 },
        curSnap: { veh: new Float32Array(0), ped: new Float32Array(0), train: curTrain, trainCount: 4 },
      },
      vPos: new Float32Array(0),
      pPos: new Float32Array(0),
      tPos: new Float32Array(4 * 4),
      tPitch: new Float32Array(4),
    };
    AgentsLayer.prototype.interpolate.call(fakeLayer, 0.5);
    for (let k = 0; k < 4; k++) {
      const hInterp = fakeLayer.tPos[k * 4 + 3];
      expect(Math.abs(Math.sin(hInterp))).toBeLessThan(1e-6);
    }
  });
});
