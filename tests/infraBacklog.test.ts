import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { World } from '../src/sim/world';
import { DEFAULT_PARAMS } from '../src/shared/params';
import { RoadClass, VType } from '../src/shared/constants';
import {
  combineTerrainCuts,
  computeUrbanSidewalkSet,
  edgeHalfWidth,
  hasUrbanSidewalk,
  resolveViaductPierPlacement,
  sampleCutsMinY,
  SIDEWALK_WIDTH,
  type RoadClearanceFn,
} from '../src/shared/roadGeom';
import { geotechnicalBlendWidth } from '../src/sim/terraforming';
import { BRIDGE_WATER_DECK_Y } from '../src/sim/roads';
import { P_CITIZEN } from '../src/sim/traffic';
import { walkPath } from '../src/sim/trips';
import { RoadsLayer } from '../src/render/roadsLayer';
import { buildRailUnderpassCut, RailLayer } from '../src/render/railLayer';
import { TerrainView } from '../src/render/terrainMesh';
import type { CrossingView, EdgeView, NodeView } from '../src/shared/protocol';

function makeWorld(seed = 1234, extra: Partial<typeof DEFAULT_PARAMS> = {}) {
  return new World({ ...DEFAULT_PARAMS, seed, ...extra });
}

async function runAsync(w: World, days: number) {
  const steps = Math.round(days * 4800);
  for (let i = 0; i < steps; i++) {
    w.step(0.5);
    if ((i & 2047) === 2047) await new Promise((r) => setImmediate(r));
  }
  return w;
}

/** Check whether an oriented physical pier box (from an InstancedMesh matrix & base dimensions) intrudes into a lower road strip. */
function pierBoxMinDistToSegment(
  mat: THREE.Matrix4,
  baseSizeX: number,
  baseSizeZ: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  mat.decompose(pos, quat, scale);
  const hx = (baseSizeX * Math.abs(scale.x)) * 0.5;
  const hz = (baseSizeZ * Math.abs(scale.z)) * 0.5;
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
  let minD = Infinity;
  const v = new THREE.Vector3();
  for (const sx of [-1, 0, 1]) {
    for (const sz of [-1, 0, 1]) {
      v.set(sx * hx, 0, sz * hz).applyQuaternion(quat).add(pos);
      const t = Math.max(0, Math.min(1, ((v.x - ax) * dx + (v.z - az) * dz) / l2));
      const d = Math.hypot(ax + dx * t - v.x, az + dz * t - v.z);
      if (d < minD) minD = d;
    }
  }
  return minD;
}

describe('Onda 2 — Pendências Pós-Infraestrutura e Correções da Rodada 1', () => {
  it('1. Terraplenagem geotécnica: largura de talude proporcional ao desnível, corte vs aterro e preservação de água/rio/flood', () => {
    expect(geotechnicalBlendWidth(0.2, false)).toBe(6);
    expect(geotechnicalBlendWidth(0.2, true)).toBe(6);
    const wMildCut = geotechnicalBlendWidth(2.0, false);
    const wSteepCut = geotechnicalBlendWidth(8.0, false);
    const wSteepFill = geotechnicalBlendWidth(8.0, true);
    expect(wSteepCut).toBeGreaterThan(wMildCut);
    expect(wSteepFill).toBeGreaterThan(wSteepCut);
    expect(geotechnicalBlendWidth(25.0, true)).toBe(26);

    const wFlat = makeWorld(2025, { terrain: 'vale' });
    const wSteep = makeWorld(2025, { terrain: 'serra' });

    const findSpot = (w: World, minSlope: number, maxSlope: number) => {
      const T = w.terrain;
      for (let z = 320; z < T.size - 320; z += 40) {
        for (let x = 320; x < T.size - 320; x += 40) {
          const h = T.heightAt(x, z);
          const sl = T.slopeAt(x, z);
          if (h > 10 && sl >= minSlope && sl <= maxSlope && T.distToRiver(x, z) > 160) {
            return { x, z };
          }
        }
      }
      return null;
    };

    const flatSpot = findSpot(wFlat, 0.005, 0.035);
    const steepSpot = findSpot(wSteep, 0.14, 0.45);
    expect(flatSpot).not.toBeNull();
    expect(steepSpot).not.toBeNull();

    const measureRoadSpread = (w: World, x: number, z: number) => {
      const T = w.terrain;
      const before = T.heights.slice();
      const na = w.roads.addNode(x - 40, z);
      const nb = w.roads.addNode(x + 40, z);
      w.roads.addEdge(na.id, nb.id, RoadClass.Collector, { progress: 1 });
      let maxLatDist = 0;
      let changedCount = 0;
      for (let j = 0; j < T.hres; j++) {
        for (let i = 0; i < T.hres; i++) {
          const k = j * T.hres + i;
          if (Math.abs(T.heights[k] - before[k]) > 0.02) {
            changedCount++;
            const gx = i * T.step, gz = j * T.step;
            if (gx >= x - 40 && gx <= x + 40) {
              maxLatDist = Math.max(maxLatDist, Math.abs(gz - z));
            }
          }
        }
      }
      return { maxLatDist, changedCount };
    };

    const flatRes = measureRoadSpread(wFlat, flatSpot!.x, flatSpot!.z);
    const steepRes = measureRoadSpread(wSteep, steepSpot!.x, steepSpot!.z);
    expect(steepRes.changedCount).toBeGreaterThan(0);
    expect(steepRes.maxLatDist).toBeGreaterThan(flatRes.maxLatDist);

    for (const w of [wFlat, wSteep]) {
      const T = w.terrain;
      for (let k = 0; k < T.heights.length; k++) {
        if (w.terraforming.graded[k] > 0 && T.water[k] === 0 && T.riverDist[k] >= T.riverWidth * 0.65) {
          expect(T.heights[k]).toBeGreaterThanOrEqual(T.seaLevel + 0.35 - 1e-4);
        }
        if (T.heights[k] >= 2.4 && w.terraforming.graded[k] > 0) {
          expect(T.flood[k]).toBe(0);
        }
      }
    }
  });

  it('2. [P1-02] Continuidade única de calçadas (local → rodovia × 3 → local) + desgaste diário e recapeamento orçamentário', () => {
    expect(hasUrbanSidewalk({ cls: RoadClass.Local })).toBe(true);
    expect(hasUrbanSidewalk({ cls: RoadClass.Dirt })).toBe(false);
    expect(hasUrbanSidewalk({ cls: RoadClass.Highway }, { degA: 2, degB: 2, urbanEdgesA: 0, urbanEdgesB: 0 })).toBe(false);
    expect(hasUrbanSidewalk({ cls: RoadClass.Highway }, { degA: 2, degB: 2, urbanEdgesA: 1, urbanEdgesB: 0 })).toBe(true);
    expect(hasUrbanSidewalk({ cls: RoadClass.Highway }, { degA: 2, degB: 2, bridgedBetweenUrban: true })).toBe(true);

    // P1-02: Corridor local -> highway -> highway -> highway -> local MUST agree 100% between RoadsLayer and trips.ts!
    const w = makeWorld(1234, { terrain: 'vale' });
    const R = w.roads;
    const T = w.terrain;
    // Flat dry area
    const yBase = 20;
    T.heights.fill(yBase);
    T.water.fill(0);
    const n0 = R.addNode(800, 1200);
    const n1 = R.addNode(870, 1200);
    const n2 = R.addNode(940, 1200);
    const n3 = R.addNode(1010, 1200);
    const n4 = R.addNode(1080, 1200);
    const n5 = R.addNode(1150, 1200);
    const eL1 = R.addEdge(n0.id, n1.id, RoadClass.Local, { progress: 1 });
    const eH1 = R.addEdge(n1.id, n2.id, RoadClass.Highway, { progress: 1 });
    const eH2 = R.addEdge(n2.id, n3.id, RoadClass.Highway, { progress: 1 });
    const eH3 = R.addEdge(n3.id, n4.id, RoadClass.Highway, { progress: 1 });
    const eL2 = R.addEdge(n4.id, n5.id, RoadClass.Local, { progress: 1 });

    // Shared classifier classifies ALL 3 highway stretches (including central eH2!) as urban sidewalked
    expect(R.hasSidewalk(eL1.id)).toBe(true);
    expect(R.hasSidewalk(eH1.id)).toBe(true);
    expect(R.hasSidewalk(eH2.id)).toBe(true);
    expect(R.hasSidewalk(eH3.id)).toBe(true);
    expect(R.hasSidewalk(eL2.id)).toBe(true);

    const rlCorr = new RoadsLayer();
    rlCorr.ground = () => yBase;
    for (const nd of [n0, n1, n2, n3, n4, n5]) rlCorr.upsertNode(R.nodeView(nd));
    for (const ed of [eL1, eH1, eH2, eH3, eL2]) rlCorr.upsertEdge(R.edgeView(ed));
    const renderWalkSet = computeUrbanSidewalkSet(rlCorr.edges.values(), rlCorr.nodes);
    expect(renderWalkSet.has(eH2.id)).toBe(true);
    rlCorr.update(2000, 0, 0);

    // Pedestrian walking along central eH2 MUST match rendered sidewalk elevation (~20.30 m) to < 0.02 m
    const wp = walkPath(
      R,
      { path: [eH2.id * 2], startS: 5, destS: 65 },
      { x: 945, z: 1200 + edgeHalfWidth(eH2) + 1.3 },
      { x: 1005, z: 1200 + edgeHalfWidth(eH2) + 1.3 },
    );
    const midPedY = wp.ys[Math.floor(wp.ys.length / 2)];
    expect(Math.abs(midPedY - (yBase + 0.30))).toBeLessThan(0.02);

    // [P1-02 Round 2] Full corridor walkPath (local -> highway x3 -> local): 0 of 350 samples ever step on asphalt!
    const wpFull = walkPath(
      R,
      { path: [eL1.id * 2, eH1.id * 2, eH2.id * 2, eH3.id * 2, eL2.id * 2], startS: 10, destS: 60 },
      { x: 810, z: 1200 + edgeHalfWidth(eL1) + 1.3 },
      { x: 1140, z: 1200 + edgeHalfWidth(eL2) + 1.3 },
    );
    const cumFull = [0];
    for (let i = 1; i < wpFull.ys.length; i++) {
      cumFull.push(cumFull[i - 1] + Math.hypot(wpFull.pts[i * 2] - wpFull.pts[i * 2 - 2], wpFull.pts[i * 2 + 1] - wpFull.pts[i * 2 - 1]));
    }
    const totFull = cumFull[cumFull.length - 1];
    const rcCorr = new THREE.Raycaster();
    const downCorr = new THREE.Vector3(0, -1, 0);
    let asphaltSamples = 0;
    for (let k = 0; k < 350; k++) {
      const d = (totFull * (k + 0.5)) / 350;
      let idx = 0;
      while (idx < cumFull.length - 2 && cumFull[idx + 1] < d) idx++;
      const frac = (d - cumFull[idx]) / Math.max(1e-6, cumFull[idx + 1] - cumFull[idx]);
      const px = wpFull.pts[idx * 2] + (wpFull.pts[idx * 2 + 2] - wpFull.pts[idx * 2]) * frac;
      const pz = wpFull.pts[idx * 2 + 1] + (wpFull.pts[idx * 2 + 3] - wpFull.pts[idx * 2 + 1]) * frac;
      rcCorr.set(new THREE.Vector3(px, 100, pz), downCorr);
      const hits = rcCorr.intersectObject(rlCorr.mainMesh!, false);
      expect(hits.length).toBeGreaterThan(0);
      if (hits[0].point.y < yBase + 0.26) asphaltSamples++;
    }
    expect(asphaltSamples, 'Pedestrian stepped onto asphalt during local <-> highway width transitions').toBe(0);

    // [P1-02 Round 3] Start & end INSIDE width-taper zones (70 m edges, startS = 67, destS = 3, both dirs & sides)
    let taperStartEndAsphalt = 0;
    const corrEdges = [eL1, eH1, eH2, eH3, eL2];
    for (const rev of [false, true]) {
      for (const sd of [-1, 1]) {
        const path = rev ? corrEdges.slice().reverse().map((ed) => ed.id * 2 + 1) : corrEdges.map((ed) => ed.id * 2);
        const xFrom = rev ? 1150 - 67 : 800 + 67;
        const xTo = rev ? 870 - 3 : 1080 + 3;
        const wpT = walkPath(R, { path, startS: 67, destS: 3 }, { x: xFrom, z: 1200 + sd * 10 }, { x: xTo, z: 1200 + sd * 10 });
        const cumT = [0];
        for (let i = 2; i < wpT.ys.length - 1; i++) {
          cumT.push(cumT[cumT.length - 1] + Math.hypot(wpT.pts[i * 2] - wpT.pts[(i - 1) * 2], wpT.pts[i * 2 + 1] - wpT.pts[(i - 1) * 2 + 1]));
        }
        const totT = cumT[cumT.length - 1];
        for (let k = 0; k < 300; k++) {
          const d = (totT * (k + 0.5)) / 300;
          let idx = 0;
          while (idx < cumT.length - 2 && cumT[idx + 1] < d) idx++;
          const frac = (d - cumT[idx]) / Math.max(1e-6, cumT[idx + 1] - cumT[idx]);
          const p0 = idx + 1, p1 = idx + 2;
          const px = wpT.pts[p0 * 2] + (wpT.pts[p1 * 2] - wpT.pts[p0 * 2]) * frac;
          const pz = wpT.pts[p0 * 2 + 1] + (wpT.pts[p1 * 2 + 1] - wpT.pts[p0 * 2 + 1]) * frac;
          rcCorr.set(new THREE.Vector3(px, 100, pz), downCorr);
          const hits = rcCorr.intersectObject(rlCorr.mainMesh!, false);
          if (!hits.length || hits[0].point.y < yBase + 0.26) taperStartEndAsphalt++;
        }
      }
    }
    expect(taperStartEndAsphalt, 'Pedestrian stepped onto asphalt when startS=67 / destS=3 inside width taper').toBe(0);

    // Daily wear accumulation, diff throttling & budget-linked resurfacing
    const paved = R.addEdge(R.addNode(1200, 1200).id, R.addNode(1290, 1200).id, RoadClass.Avenue, { progress: 1 });
    const dirt = R.addEdge(R.addNode(1290, 1200).id, R.addNode(1380, 1200).id, RoadClass.Dirt, { progress: 1 });
    expect(paved.wear).toBe(0);
    R.dirtyEdges.clear();
    R.dayTick(0);
    expect(paved.wear).toBeGreaterThanOrEqual(0.004);
    expect(dirt.wear).toBe(0);
    expect(R.dirtyEdges.has(paved.id)).toBe(false);

    let triggeredDirty = false;
    for (let d = 0; d < 10; d++) {
      paved.peakVC = 1.1;
      paved.sndMean = new Float32Array([4, 1, 7, 10, 1]);
      R.dayTick(0.9);
      if (R.dirtyEdges.has(paved.id)) triggeredDirty = true;
    }
    expect(triggeredDirty).toBe(true);
    expect(paved.wear).toBeGreaterThan(0.18);

    paved.wear = 0.62;
    paved.sentWear = 0.62;
    w.budget.money = 150;
    w.cityHall.daily();
    expect(paved.wear).toBeGreaterThanOrEqual(0.62);

    w.budget.money = 8500;
    w.events.drain();
    R.dirtyEdges.clear();
    w.cityHall.daily();
    expect(paved.wear).toBeCloseTo(0.05, 5);
    expect(R.dirtyEdges.has(paved.id)).toBe(true);
    expect(w.cityHall.ledger.some((l) => l.text.includes('Recapeamento'))).toBe(true);
    expect(w.events.drain().some((ev) => ev.type === 'road_maintenance')).toBe(true);
  });

  it('3. [P0-02] Pilares e pórticos: 0 invasões da seção física a 30° e sobre 3 avenidas paralelas + base alcança terreno abaixo de setCuts', () => {
    const sampleStraight = (s: number): [number, number, number, number, number] => [s, 8.5, 0, 1, 0];

    // Case A: open ground
    const open = resolveViaductPierPlacement(50, 10, 120, sampleStraight, 6, () => ({ blocked: false }), 1.6);
    expect(open.kind).toBe('single');

    // Case B: perpendicular cross street -> longitudinal shift
    const crossClearance: RoadClearanceFn = (x, _z, r) => (
      Math.abs(x - 50) < 4.5 + r ? { blocked: true, clearHalfW: 6.1, ux: 0, uz: 1 } : { blocked: false }
    );
    const shifted = resolveViaductPierPlacement(50, 10, 120, sampleStraight, 6, crossClearance, 1.6);
    expect(shifted.kind).toBe('single');
    if (shifted.kind === 'single') {
      expect(shifted.shifted).toBe(true);
      expect(crossClearance(shifted.x, shifted.z, 1.6).blocked).toBe(false);
    }

    // Case C (P0-02 #1): Oblique 30° crossing — FULL PHYSICAL BOX of EVERY road & rail pier must clear lower carriageway!
    const roads30 = new RoadsLayer();
    roads30.ground = () => 5;
    const rad = Math.PI / 6; // 30 degrees
    const ax30 = 100 - Math.cos(rad) * 140, az30 = -Math.sin(rad) * 140;
    const bx30 = 100 + Math.cos(rad) * 140, bz30 = Math.sin(rad) * 140;
    roads30.upsertNode({ id: 1, x: ax30, z: az30, y: 5.18, control: 0, deg: 1, radius: 4, interchange: false });
    roads30.upsertNode({ id: 2, x: bx30, z: bz30, y: 5.18, control: 0, deg: 1, radius: 4, interchange: false });
    const lower30: EdgeView = {
      id: 1, a: 1, b: 2, cls: RoadClass.Avenue, lanes: 2, oneway: 0,
      bridge: false, tunnel: false, elevated: false, busLane: false,
      progress: 1, upgrading: false, pts: [ax30, 5.18, az30, bx30, 5.18, bz30], name: 'Av. 30°',
    };
    roads30.upsertEdge(lower30);
    roads30.upsertNode({ id: 3, x: 0, z: 0, y: 13, control: 0, deg: 1, radius: 4, interchange: false });
    roads30.upsertNode({ id: 4, x: 200, z: 0, y: 13, control: 0, deg: 1, radius: 4, interchange: false });
    roads30.upsertEdge({
      id: 2, a: 3, b: 4, cls: RoadClass.Avenue, lanes: 2, oneway: 0,
      bridge: false, tunnel: false, elevated: true, deck: 40, busLane: false,
      progress: 1, upgrading: false, pts: [0, 5.2, 0, 40, 13.2, 0, 160, 13.2, 0, 200, 5.2, 0], name: 'Elevado 30°',
    });
    roads30.update(2000, 0, 0);

    const hw30 = edgeHalfWidth(lower30);
    const matBuf = new THREE.Matrix4();
    const roadPiers30 = (roads30 as unknown as { elevatedPillars: THREE.InstancedMesh }).elevatedPillars;
    expect(roadPiers30.count).toBeGreaterThan(0);
    for (let i = 0; i < roadPiers30.count; i++) {
      roadPiers30.getMatrixAt(i, matBuf);
      const minD = pierBoxMinDistToSegment(matBuf, 1.4, 1.4, ax30, az30, bx30, bz30);
      expect(minD, `Road pier ${i} physical box invades 30° avenue`).toBeGreaterThan(hw30 + 0.1);
    }

    const rail30 = new RailLayer();
    rail30.ground = () => 5;
    rail30.roadClearance = (x, z, r) => roads30.queryRoadClearance(x, z, r);
    rail30.upsert({
      id: 1, pts: [0, 13.5, 0, 200, 13.5, 0],
      tracks: 2, progress: 1, bridge: false, elevated: true, metro: true, spur: false,
    });
    rail30.update(2000, new Uint8Array(0));
    const railPiers30 = (rail30 as unknown as { piers: THREE.InstancedMesh }).piers;
    expect(railPiers30.count).toBeGreaterThan(0);
    for (let i = 0; i < railPiers30.count; i++) {
      railPiers30.getMatrixAt(i, matBuf);
      const minD = pierBoxMinDistToSegment(matBuf, 1.6, 0.82, ax30, az30, bx30, bz30);
      expect(minD, `Rail pier ${i} physical box invades 30° avenue`).toBeGreaterThan(hw30 + 0.1);
    }

    // Case D (P0-02 #2): 3 parallel avenues (at z = -22, 0, +22) — 0 road or rail columns on ANY of the 3 avenues!
    const roads3 = new RoadsLayer();
    roads3.ground = () => 5;
    const aveZs = [-22, 0, 22];
    const aveEdges: EdgeView[] = [];
    aveZs.forEach((az, idx) => {
      const aId = idx * 2 + 1, bId = idx * 2 + 2;
      roads3.upsertNode({ id: aId, x: 0, z: az, y: 5.18, control: 0, deg: 1, radius: 4, interchange: false });
      roads3.upsertNode({ id: bId, x: 220, z: az, y: 5.18, control: 0, deg: 1, radius: 4, interchange: false });
      const ev: EdgeView = {
        id: idx + 1, a: aId, b: bId, cls: RoadClass.Avenue, lanes: 2, oneway: 0,
        bridge: false, tunnel: false, elevated: false, busLane: false,
        progress: 1, upgrading: false, pts: [0, 5.18, az, 220, 5.18, az], name: `Av. Paralela ${idx + 1}`,
      };
      aveEdges.push(ev);
      roads3.upsertEdge(ev);
    });
    const hwAve = edgeHalfWidth(aveEdges[0]);
    roads3.upsertNode({ id: 20, x: 0, z: 0, y: 13, control: 0, deg: 1, radius: 4, interchange: false });
    roads3.upsertNode({ id: 21, x: 220, z: 0, y: 13, control: 0, deg: 1, radius: 4, interchange: false });
    roads3.upsertEdge({
      id: 99, a: 20, b: 21, cls: RoadClass.Avenue, lanes: 2, oneway: 0,
      bridge: false, tunnel: false, elevated: true, deck: 40, busLane: false,
      progress: 1, upgrading: false, pts: [0, 5.2, 0, 40, 13.2, 0, 180, 13.2, 0, 220, 5.2, 0], name: 'Elevado 3 Avenidas',
    });
    roads3.update(2000, 0, 0);

    const piers3R = (roads3 as unknown as { elevatedPillars: THREE.InstancedMesh }).elevatedPillars;
    expect(piers3R.count).toBeGreaterThan(0);
    for (let i = 0; i < piers3R.count; i++) {
      piers3R.getMatrixAt(i, matBuf);
      for (const az of aveZs) {
        const minD = pierBoxMinDistToSegment(matBuf, 1.4, 1.4, 0, az, 220, az);
        expect(minD, `Road pier ${i} invades parallel avenue z=${az}`).toBeGreaterThan(hwAve + 0.1);
      }
    }

    const rail3 = new RailLayer();
    rail3.ground = () => 5;
    rail3.roadClearance = (x, z, r) => roads3.queryRoadClearance(x, z, r);
    rail3.upsert({
      id: 1, pts: [0, 13.5, 0, 220, 13.5, 0],
      tracks: 2, progress: 1, bridge: false, elevated: true, metro: true, spur: false,
    });
    rail3.update(2000, new Uint8Array(0));
    const piers3Rail = (rail3 as unknown as { piers: THREE.InstancedMesh }).piers;
    expect(piers3Rail.count).toBeGreaterThan(0);
    for (let i = 0; i < piers3Rail.count; i++) {
      piers3Rail.getMatrixAt(i, matBuf);
      for (const az of aveZs) {
        const minD = pierBoxMinDistToSegment(matBuf, 1.6, 0.82, 0, az, 220, az);
        expect(minD, `Rail pier ${i} invades parallel avenue z=${az}`).toBeGreaterThan(hwAve + 0.1);
      }
    }

    // Case E (P0-02 #3): Pier standing over a setCuts trench extends footing BELOW carved floor (0 floating bases!)
    const cut = { pts: [40, 10, 0, 100, 5, 0, 160, 10, 0], hw: 8 };
    const railCut = new RailLayer();
    railCut.ground = () => 10;
    railCut.cutGround = (x, z) => sampleCutsMinY(x, z, 10, [cut]);
    railCut.upsert({
      id: 1, pts: [20, 18, 0, 180, 18, 0],
      tracks: 1, progress: 1, bridge: false, elevated: true, metro: false, spur: false,
    });
    railCut.update(2000, new Uint8Array(0));
    const cutPiers = (railCut as unknown as { piers: THREE.InstancedMesh }).piers;
    expect(cutPiers.count).toBeGreaterThan(0);
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), sc = new THREE.Vector3();
    for (let i = 0; i < cutPiers.count; i++) {
      cutPiers.getMatrixAt(i, matBuf);
      matBuf.decompose(pos, quat, sc);
      const carvedFloor = sampleCutsMinY(pos.x, pos.z, 10, [cut]);
      // Pier base Y MUST be embedded strictly below carved terrain floor (never suspended!)
      expect(pos.y).toBeLessThanOrEqual(carvedFloor - 0.5);
    }

    // Case F (P0-02 Round 2): 3-arm roundabout carriageway MUST block piers & keep rail viaduct piers outside the roundabout!
    const roadsRb = new RoadsLayer();
    roadsRb.ground = () => 5;
    roadsRb.upsertNode({ id: 1, x: 550, z: 550, y: 5.18, control: 3, deg: 3, radius: 16, interchange: false });
    roadsRb.upsertNode({ id: 2, x: 550, z: 450, y: 5.18, control: 0, deg: 1, radius: 4, interchange: false });
    roadsRb.upsertNode({ id: 3, x: 460, z: 600, y: 5.18, control: 0, deg: 1, radius: 4, interchange: false });
    roadsRb.upsertNode({ id: 4, x: 640, z: 600, y: 5.18, control: 0, deg: 1, radius: 4, interchange: false });
    roadsRb.upsertEdge({ id: 1, a: 1, b: 2, cls: RoadClass.Avenue, lanes: 2, oneway: 0, bridge: false, tunnel: false, elevated: false, busLane: false, progress: 1, upgrading: false, pts: [550, 5.18, 550, 550, 5.18, 450], name: 'R1' });
    roadsRb.upsertEdge({ id: 2, a: 1, b: 3, cls: RoadClass.Avenue, lanes: 2, oneway: 0, bridge: false, tunnel: false, elevated: false, busLane: false, progress: 1, upgrading: false, pts: [550, 5.18, 550, 460, 5.18, 600], name: 'R2' });
    roadsRb.upsertEdge({ id: 3, a: 1, b: 4, cls: RoadClass.Avenue, lanes: 2, oneway: 0, bridge: false, tunnel: false, elevated: false, busLane: false, progress: 1, upgrading: false, pts: [550, 5.18, 550, 640, 5.18, 600], name: 'R3' });
    roadsRb.update(2000, 0, 0);
    expect(roadsRb.queryRoadClearance(550, 538, 1.6).blocked).toBe(true);

    const railRb = new RailLayer();
    railRb.ground = () => 5;
    railRb.roadClearance = (x, z, r) => roadsRb.queryRoadClearance(x, z, r);
    railRb.upsert({ id: 1, pts: [450, 14, 538, 650, 14, 538], tracks: 2, progress: 1, bridge: false, elevated: true, metro: true, spur: false });
    railRb.update(2000, new Uint8Array(0));
    const rbPiers = (railRb as unknown as { piers: THREE.InstancedMesh }).piers;
    expect(rbPiers.count).toBeGreaterThan(0);
    for (let i = 0; i < rbPiers.count; i++) {
      rbPiers.getMatrixAt(i, matBuf);
      matBuf.decompose(pos, quat, sc);
      expect(Math.hypot(pos.x - 550, pos.z - 550), `Rail pier ${i} landed inside roundabout pavement`).toBeGreaterThan(16);
    }

    // Case G (P0-02 Round 3): 2-arm curved bend (380,500)-(500,500)-(500,620) + rail viaduct (480,512)-(608,512)
    const roadsBend = new RoadsLayer();
    roadsBend.ground = () => 5;
    roadsBend.upsertNode({ id: 1, x: 380, z: 500, y: 5.18, control: 0, deg: 1, radius: 4, interchange: false });
    roadsBend.upsertNode({ id: 2, x: 500, z: 500, y: 5.18, control: 0, deg: 2, radius: 4, interchange: false });
    roadsBend.upsertNode({ id: 3, x: 500, z: 620, y: 5.18, control: 0, deg: 1, radius: 4, interchange: false });
    roadsBend.upsertEdge({ id: 1, a: 1, b: 2, cls: RoadClass.Avenue, lanes: 2, oneway: 0, bridge: false, tunnel: false, elevated: false, busLane: false, progress: 1, upgrading: false, pts: [380, 5.18, 500, 500, 5.18, 500], name: 'B1' });
    roadsBend.upsertEdge({ id: 2, a: 2, b: 3, cls: RoadClass.Avenue, lanes: 2, oneway: 0, bridge: false, tunnel: false, elevated: false, busLane: false, progress: 1, upgrading: false, pts: [500, 5.18, 500, 500, 5.18, 620], name: 'B2' });
    roadsBend.update(2000, 0, 0);
    expect(roadsBend.queryRoadClearance(488, 512, 1.6).blocked).toBe(true);

    const railBend = new RailLayer();
    railBend.ground = () => 5;
    railBend.roadClearance = (x, z, r) => roadsBend.queryRoadClearance(x, z, r);
    railBend.upsert({ id: 1, pts: [480, 14, 512, 608, 14, 512], tracks: 2, progress: 1, bridge: false, elevated: true, metro: true, spur: false });
    railBend.update(2000, new Uint8Array(0));
    const bendPiers = (railBend as unknown as { piers: THREE.InstancedMesh }).piers;
    const rcBend = new THREE.Raycaster();
    const downBend = new THREE.Vector3(0, -1, 0);
    expect(bendPiers.count).toBeGreaterThan(0);
    for (let i = 0; i < bendPiers.count; i++) {
      bendPiers.getMatrixAt(i, matBuf);
      matBuf.decompose(pos, quat, sc);
      rcBend.set(new THREE.Vector3(pos.x, 100, pos.z), downBend);
      expect(rcBend.intersectObject(roadsBend.mainMesh!, false).length, `Rail pier ${i} landed on deg=2 bend asphalt`).toBe(0);
    }
  });

  it('4. [P0-01 + P1-01 + P1-03] Trincheira c.under: pedestres já em viagem + rotas novas/caminhão (|dy| < 0,15 m), degrau lateral < 0,03 m e 0 intrusões em setCuts()', () => {
    // 4a. P1-01: 25% hillside slope + widened street (hw = 6.95 m, walk = true) -> 0.00 m mouth step & real width + wide cut margin
    const slopeGround = (x: number, _z: number) => 20 + 0.25 * (x - 500);
    const wideCrossing: CrossingView = {
      x: 500, z: 500, y: 20.18, angle: 0, closed: false, separated: true, under: true,
      hw: 6.95, walk: true, rail: Math.PI / 2, ry: 20.30, halfLenNeg: 28, halfLenPos: 28,
    };
    const cutWide = buildRailUnderpassCut(wideCrossing, slopeGround);
    expect(cutWide.roadHW).toBeCloseTo(6.95, 2);
    expect(cutWide.hw).toBeCloseTo(6.95 + SIDEWALK_WIDTH + 1.5, 2);
    const nPtsW = Math.floor(cutWide.pts.length / 3);
    const startX = cutWide.pts[0], startY = cutWide.pts[1];
    const endX = cutWide.pts[(nPtsW - 1) * 3], endY = cutWide.pts[(nPtsW - 1) * 3 + 1];
    // Downhill mouth (~13.18 m) and uphill mouth (~27.18 m) MUST match exact road surface with 0.00 m step!
    expect(Math.abs(startY - (slopeGround(startX, 500) + 0.18))).toBeLessThan(0.05);
    expect(Math.abs(endY - (slopeGround(endX, 500) + 0.18))).toBeLessThan(0.05);
    const midIdxW = Math.floor(nPtsW / 2);
    const midYW = cutWide.pts[midIdxW * 3 + 1];
    expect(wideCrossing.ry! - midYW).toBeGreaterThanOrEqual(4.5);

    // 4b. Real World (vale AND serra): mid-trip ped reprojection, full-ramp truck & ped accuracy, mouth transverse step < 0.03 m, and 0 setCuts() intrusions
    const rc = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const nearestHitY = (obj: THREE.Object3D, x: number, z: number, refY: number): number | null => {
      rc.set(new THREE.Vector3(x, 400, z), down);
      const hits = rc.intersectObject(obj, false);
      if (!hits.length) return null;
      let best = hits[0].point.y, bestD = Math.abs(best - refY);
      for (let i = 1; i < hits.length; i++) {
        const d = Math.abs(hits[i].point.y - refY);
        if (d < bestD) { bestD = d; best = hits[i].point.y; }
      }
      return best;
    };

    for (const [terrain, sCands] of [['vale', [460, 580, 620]], ['serra', [340, 540, 660]]] as const) {
      for (const pickS of sCands) {
        const w = makeWorld(1234, { terrain });
        const R = w.roads;
        const main = w.rail2.lines[0];
        const rp = w.rail2.at(main, pickS);
        const roadAng = rp[3] + Math.PI / 2;
        const rx = Math.cos(roadAng), rz = Math.sin(roadAng);
        const nx = -rz, nz = rx;
        const na = R.addNode(rp[0] - rx * 65, rp[2] - rz * 65);
        const nb = R.addNode(rp[0] + rx * 65, rp[2] + rz * 65);
        const e = R.addEdge(na.id, nb.id, RoadClass.Collector, { progress: 1, lanes: 2 });
        w.rail2.computeCrossings();
        const cr = w.rail2.crossings.find((c) => c.edge === e.id);
        expect(cr).toBeDefined();

        const hw = edgeHalfWidth(e);
        const swOff = hw + SIDEWALK_WIDTH * 0.5;
        // Spawn a pedestrian ALREADY WALKING across this road BEFORE Rail.underpass() opens!
        const preWP = walkPath(
          R,
          { path: [e.id * 2], startS: 5, destS: e.len - 5 },
          { x: na.x + rx * 5 + nx * swOff, z: na.z + rz * 5 + nz * swOff },
          { x: nb.x - rx * 5 + nx * swOff, z: nb.z - rz * 5 + nz * swOff },
        );
        const prePed = w.peds.spawn(preWP.pts, 1, 1.4, 0, 0, 0, preWP.ys);
        expect(prePed).toBeGreaterThanOrEqual(0);

        // Open rail underpass while prePed is actively in transit
        (w.rail2 as unknown as { underpass: (c: typeof cr) => boolean }).underpass(cr!);
        const cView = w.rail2.crossingViews().find((cv) => Math.hypot(cv.x - cr!.x, cv.z - cr!.z) < 2)!;
        expect(cView.under).toBe(true);
        expect(cView.hw).toBeCloseTo(hw, 2);
        expect(cView.walk).toBe(true);

        // Build real TerrainView + RoadsLayer + RailLayer meshes to test rendered geometry
        const tv = new TerrainView(w.initMessage());
        const roads = new RoadsLayer();
        roads.ground = (x, z) => tv.meshY(x, z);
        roads.cutGround = (x, z) => tv.cutY(x, z);
        const rail = new RailLayer();
        rail.ground = (x, z) => tv.meshY(x, z);
        rail.cutGround = (x, z) => tv.cutY(x, z);
        let roadCuts: { pts: number[]; hw: number }[] = [];
        let railCuts: { pts: number[]; hw: number }[] = [];
        roads.onCuts = (c) => { roadCuts = c; tv.setCuts(combineTerrainCuts(roadCuts, railCuts)); };
        rail.onCuts = (c) => { railCuts = c; roads.setExternalCuts(c); tv.setCuts(combineTerrainCuts(roadCuts, railCuts)); };
        for (const n of R.nodes) if (n.alive) roads.upsertNode(R.nodeView(n));
        for (const ed of R.edges) if (ed.alive) roads.upsertEdge(R.edgeView(ed));
        for (const re of w.rail2.railViews()) rail.upsert(re);
        rail.setCrossings(w.rail2.crossingViews());
        rail.update(2000, new Uint8Array(w.rail2.crossings.length));
        roads.update(2000, 0, 0);
        roads.update(4000, 0, 0);

        const railMesh = (rail as unknown as { mesh: THREE.Mesh }).mesh;
        const roadMesh = roads.mainMesh!;
        const cutPatch = tv.cutPatch!;
        expect(cutPatch).not.toBeNull();
        const cut = buildRailUnderpassCut(cView, (x, z) => tv.meshY(x, z));

        // 1) Truck accuracy across ENTIRE ramp [-halfLenNeg, +halfLenPos] (< 0.15 m)
        const crossS = cr!.t * e.len;
        const truck = w.traffic.spawn(VType.Truck, [e.id * 2], Math.max(5, crossS - 20), e.len - 5, { kind: P_CITIZEN, id: -1, aux: 0 });
        expect(truck).toBeGreaterThanOrEqual(0);
        let maxTruckErr = 0;
        for (let u = -cut.halfLenNeg; u <= cut.halfLenPos; u += 1.0) {
          w.traffic.s[truck] = crossS + u;
          w.traffic.computePose(truck);
          const sx = cr!.x + rx * u, sz = cr!.z + rz * u;
          const surfY = nearestHitY(railMesh, sx, sz, w.traffic.y[truck]);
          if (surfY !== null) maxTruckErr = Math.max(maxTruckErr, Math.abs(w.traffic.y[truck] - surfY));
        }
        expect(maxTruckErr, `${terrain} s=${pickS}: truck error along c.under ramp`).toBeLessThan(0.15);

        // 2) Already-walking pedestrian reprojected across ENTIRE ramp + mouth approaches (< 0.15 m)
        const pedLen = w.peds.cum[prePed]![w.peds.cum[prePed]!.length - 1];
        let maxPrePedErr = 0, preUnderSamples = 0;
        for (let d = 0; d <= pedLen; d += 1.0) {
          w.peds.time = w.peds.t0[prePed] + d / w.peds.speed[prePed];
          w.peds.pose(prePed);
          const u = (w.peds.x[prePed] - cr!.x) * rx + (w.peds.z[prePed] - cr!.z) * rz;
          if (u >= -cut.halfLenNeg - 2 && u <= cut.halfLenPos + 2) {
            preUnderSamples++;
            const obj = u >= -cut.halfLenNeg && u <= cut.halfLenPos ? railMesh : roadMesh;
            const surfY = nearestHitY(obj, w.peds.x[prePed], w.peds.z[prePed], w.peds.y[prePed]);
            if (surfY !== null) maxPrePedErr = Math.max(maxPrePedErr, Math.abs(w.peds.y[prePed] - surfY));
          }
        }
        expect(preUnderSamples).toBeGreaterThan(20);
        expect(maxPrePedErr, `${terrain} s=${pickS}: mid-trip ped error on c.under`).toBeLessThan(0.15);

        // 3) New pedestrian walking opposite direction across ENTIRE ramp (< 0.15 m)
        const wpU = walkPath(
          R,
          { path: [e.id * 2 + 1], startS: 5, destS: e.len - 5 },
          { x: nb.x - rx * 5 - nx * swOff, z: nb.z - rz * 5 - nz * swOff },
          { x: na.x + rx * 5 - nx * swOff, z: na.z + rz * 5 - nz * swOff },
        );
        let maxNewPedErr = 0;
        for (let k = 0; k < wpU.ys.length; k++) {
          const px = wpU.pts[k * 2], py = wpU.ys[k], pz = wpU.pts[k * 2 + 1];
          const u = (px - cr!.x) * rx + (pz - cr!.z) * rz;
          if (u >= -cut.halfLenNeg && u <= cut.halfLenPos) {
            const lat = Math.abs((px - cr!.x) * nx + (pz - cr!.z) * nz);
            expect(lat).toBeLessThan(cut.hw - 0.3);
            const surfY = nearestHitY(railMesh, px, pz, py);
            if (surfY !== null) maxNewPedErr = Math.max(maxNewPedErr, Math.abs(py - surfY));
          }
        }
        expect(maxNewPedErr, `${terrain} s=${pickS}: new ped error along c.under ramp`).toBeLessThan(0.15);

        // 4) [P1-01] Dense transverse & longitudinal mouth continuity (< 0.03 m across ENTIRE road + both sidewalks at ±1 mm)
        let maxMouthStep = 0;
        const maxLat = hw + SIDEWALK_WIDTH - 0.05;
        for (const endU of [-cut.halfLenNeg, cut.halfLenPos]) {
          const sgn = endU < 0 ? -1 : 1;
          for (let lat = -maxLat; lat <= maxLat + 1e-6; lat += 0.25) {
            if (Math.abs(Math.abs(lat) - hw) < 0.08) continue; // skip vertical curb riser face itself
            const xIn = cr!.x + rx * (endU - sgn * 0.001) + nx * lat, zIn = cr!.z + rz * (endU - sgn * 0.001) + nz * lat;
            const xOut = cr!.x + rx * (endU + sgn * 0.001) + nx * lat, zOut = cr!.z + rz * (endU + sgn * 0.001) + nz * lat;
            rc.set(new THREE.Vector3(xOut, 400, zOut), down);
            const hOut = rc.intersectObject(roadMesh, false)[0];
            if (hOut) {
              const yIn = nearestHitY(railMesh, xIn, zIn, hOut.point.y);
              if (yIn !== null) maxMouthStep = Math.max(maxMouthStep, Math.abs(yIn - hOut.point.y));
            }
          }
        }
        expect(maxMouthStep, `${terrain} s=${pickS}: dense transverse mouth step on sidewalk/road >= 0.03 m`).toBeLessThan(0.03);

        // 5) [P1-03] Real TerrainView.setCuts() triangle mesh MUST have 0 intrusions > 0.03 m over asphalt & internal walkways!
        let cutIntrusions = 0, maxCutInt = 0;
        for (let u = -cut.halfLenNeg + 0.5; u <= cut.halfLenPos - 0.5; u += 2.0) {
          for (const lat of [-hw - SIDEWALK_WIDTH + 0.05, -hw - 1.3, -hw, 0, hw, hw + 1.3, hw + SIDEWALK_WIDTH - 0.05]) {
            const px = cr!.x + rx * u + nx * lat, pz = cr!.z + rz * u + nz * lat;
            rc.set(new THREE.Vector3(px, 400, pz), down);
            const hCut = rc.intersectObject(cutPatch, false)[0];
            rc.set(new THREE.Vector3(px, cView.ry! - 1.2, pz), down);
            const hSurf = rc.intersectObject(railMesh, false)[0] ?? (() => { rc.set(new THREE.Vector3(px, 400, pz), down); return rc.intersectObject(railMesh, false)[0]; })();
            if (hCut && hSurf) {
              const diff = hCut.point.y - hSurf.point.y;
              if (diff > 0.03) { cutIntrusions++; if (diff > maxCutInt) maxCutInt = diff; }
            }
          }
        }
        expect(cutIntrusions, `${terrain} s=${pickS}: setCuts() patch intrudes > 0.03 m over underpass walkways (max=${maxCutInt.toFixed(3)} m)`).toBe(0);

        // 6) [P1-R5-01] Sloped railway overpass deck MUST NEVER bury steel railheads above the underpass crossing
        const rPos = railMesh.geometry.attributes.position as THREE.BufferAttribute;
        const rCol = railMesh.geometry.attributes.color as THREE.BufferAttribute;
        const rNor = railMesh.geometry.attributes.normal as THREE.BufferAttribute;
        let railheadTrisChecked = 0;
        let buriedRailheads = 0;
        let worstBurial = 0;
        for (let ti = 0; ti + 2 < rPos.count; ti += 3) {
          if (rNor.getY(ti) < 0.9) continue;
          // steelTop = 0xb0b7bf -> blue channel clearly higher than red (concrete/wall/ballast have r >= b)
          const rC = rCol.getX(ti), bC = rCol.getZ(ti);
          if (bC - rC < 0.03) continue;
          const cx = (rPos.getX(ti) + rPos.getX(ti + 1) + rPos.getX(ti + 2)) / 3;
          const cy = (rPos.getY(ti) + rPos.getY(ti + 1) + rPos.getY(ti + 2)) / 3;
          const cz = (rPos.getZ(ti) + rPos.getZ(ti + 1) + rPos.getZ(ti + 2)) / 3;
          if (Math.hypot(cx - cr!.x, cz - cr!.z) > 25) continue;
          railheadTrisChecked++;
          rc.set(new THREE.Vector3(cx, 400, cz), down);
          const hits = rc.intersectObject(railMesh, false);
          if (hits.length && hits[0].point.y > cy + 0.01) {
            buriedRailheads++;
            worstBurial = Math.max(worstBurial, hits[0].point.y - cy);
          }
        }
        expect(railheadTrisChecked).toBeGreaterThan(20);
        expect(buriedRailheads, `${terrain} s=${pickS}: overpass deck buries ${buriedRailheads} railhead tris (max=${worstBurial.toFixed(3)} m)`).toBe(0);
      }
    }
  }, 30000);

  it('5. [P2-01] Nó intermediário sobre água entre pontes: mantém >= 6,5 m e rebaixa + marca diff ao remover 1 dos 2 vãos', () => {
    const w = makeWorld(1234, { terrain: 'vale' });
    const T = w.terrain;
    const R = w.roads;

    const midIdx = Math.floor(T.river.length * 0.5);
    const rp = T.river[midIdx];
    const rpNext = T.river[Math.min(T.river.length - 1, midIdx + 2)];
    const tx = rpNext.x - rp.x, tz = rpNext.z - rp.z;
    const tl = Math.hypot(tx, tz) || 1;
    const nx = -tz / tl, nz = tx / tl;

    const nBankA = R.addNode(rp.x - nx * 85, rp.z - nz * 85);
    const nWaterMid = R.addNode(rp.x, rp.z);
    const nBankB = R.addNode(rp.x + nx * 85, rp.z + nz * 85);

    const br1 = R.addEdge(nBankA.id, nWaterMid.id, RoadClass.Highway, { progress: 1, bridge: true });
    const br2 = R.addEdge(nWaterMid.id, nBankB.id, RoadClass.Highway, { progress: 1, bridge: true });

    expect(R.isWaterBridgeNode(nWaterMid)).toBe(true);
    expect(nWaterMid.y).toBeGreaterThanOrEqual(BRIDGE_WATER_DECK_Y);
    expect(Math.abs(br1.pts[br1.pts.length - 2] - br2.pts[1])).toBeLessThan(0.05);

    // Drain diff, then remove ONE of the two bridge spans: nWaterMid MUST drop back and BOTH node + remaining edge MUST appear in the same diff!
    w.collectDiff();
    R.removeEdge(br2.id);
    expect(R.isWaterBridgeNode(nWaterMid)).toBe(false);
    expect(nWaterMid.y).toBeLessThan(1.0);
    expect(br1.pts[br1.pts.length - 2]).toBeLessThan(1.0);

    const diff = w.collectDiff();
    expect(diff.nodes?.some((nv) => nv.id === nWaterMid.id && nv.y < 1.0)).toBe(true);
    expect(diff.edges?.some((ev) => ev.id === br1.id && ev.pts[ev.pts.length - 2] < 1.0)).toBe(true);
    expect(diff.removedEdges).toContain(br2.id);
  });

  it('6. [P1-03] Sonda de malha no Dia 40 (vale e serra): 0 pontos de terreno > 0,03 m acima de asfalto, faixas, junções ou calçadas', async () => {
    for (const terrain of ['vale', 'serra'] as const) {
      const w = await runAsync(makeWorld(1234, { terrain }), 40);
      const init = w.initMessage();
      const tv = new TerrainView(init);
      const roads = new RoadsLayer();
      roads.ground = (x, z) => tv.meshY(x, z);
      roads.cutGround = (x, z) => tv.cutY(x, z);
      const rail = new RailLayer();
      rail.ground = (x, z) => tv.meshY(x, z);
      rail.cutGround = (x, z) => tv.cutY(x, z);

      let roadCuts: { pts: number[]; hw: number }[] = [];
      let railCuts: { pts: number[]; hw: number }[] = [];
      roads.onCuts = (c) => { roadCuts = c; tv.setCuts(combineTerrainCuts(roadCuts, railCuts)); };
      rail.onCuts = (c) => { railCuts = c; roads.setExternalCuts(c); tv.setCuts(combineTerrainCuts(roadCuts, railCuts)); };

      for (const n of w.roads.nodes) if (n.alive) roads.upsertNode(w.roads.nodeView(n));
      for (const e of w.roads.edges) if (e.alive) roads.upsertEdge(w.roads.edgeView(e));
      for (const re of w.rail2.railViews()) rail.upsert(re);
      rail.setCrossings(w.rail2.crossingViews());

      rail.update(2000, new Uint8Array(w.rail2.crossings.length));
      roads.update(2000, 0, 0);
      // Rebuild once more if rail cuts arrived after first build
      roads.update(4000, 0, 0);

      const allCuts = combineTerrainCuts(roadCuts, railCuts);
      const inCut = (x: number, z: number): boolean => {
        for (const c of allCuts) {
          const r = c.hw + 2.6;
          for (let k = 0; k + 3 < c.pts.length; k += 3) {
            const ax = c.pts[k], az = c.pts[k + 2], bx = c.pts[k + 3], bz = c.pts[k + 5];
            const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
            if (Math.hypot(ax + dx * t - x, az + dz * t - z) < r) return true;
          }
        }
        return false;
      };

      const mesh = roads.mainMesh!;
      expect(mesh).toBeDefined();
      const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
      const nor = mesh.geometry.attributes.normal as THREE.BufferAttribute;
      // [P1-04] Adaptive subdivision triangle & memory budget on vale Day 40 (<= 450k tris, <= 60 MiB)
      if (terrain === 'vale') {
        const totalTris = pos.count / 3;
        let geoBytes = 0;
        for (const key of Object.keys(mesh.geometry.attributes)) {
          geoBytes += (mesh.geometry.attributes[key] as THREE.BufferAttribute).array.byteLength;
        }
        expect(totalTris, `vale Dia 40 triangle regression: ${totalTris} > 450000`).toBeLessThanOrEqual(450000);
        expect(geoBytes / (1024 * 1024), `vale Dia 40 memory regression`).toBeLessThanOrEqual(60);
      }

      // [P1-03 Round 3] Explicit raycast verification at reported ridge points in vale and serra
      const rcRidge = new THREE.Raycaster();
      const downRidge = new THREE.Vector3(0, -1, 0);
      const [rxQ, rzQ] = terrain === 'vale' ? [2387.503, 1408.331] : [415.989, 771.509];
      rcRidge.set(new THREE.Vector3(rxQ, 400, rzQ), downRidge);
      const ridgeHits = rcRidge.intersectObject(mesh, false);
      if (ridgeHits.length) {
        expect(tv.meshY(rxQ, rzQ) - ridgeHits[0].point.y, `${terrain} ridge raycast at (${rxQ}, ${rzQ})`).toBeLessThanOrEqual(0.03);
      }

      let checkedTris = 0;
      let pokingPoints = 0;
      let maxIntrusion = 0;

      for (let i = 0; i + 2 < pos.count; i += 3) {
        // Inspect every upward-facing paved/sidewalk/crosswalk/junction triangle (skip vertical curb/retaining skirts)
        if (nor.getY(i) < 0.85) continue;
        const x0 = pos.getX(i), y0 = pos.getY(i), z0 = pos.getZ(i);
        const x1 = pos.getX(i + 1), y1 = pos.getY(i + 1), z1 = pos.getZ(i + 1);
        const x2 = pos.getX(i + 2), y2 = pos.getY(i + 2), z2 = pos.getZ(i + 2);
        const cx = (x0 + x1 + x2) / 3, cz = (z0 + z1 + z2) / 3;
        if (inCut(cx, cz)) continue;
        checkedTris++;
        const pts: [number, number, number][] = [
          [x0, y0, z0], [x1, y1, z1], [x2, y2, z2],
          [cx, (y0 + y1 + y2) / 3, cz],
          [(x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5],
          [(x1 + x2) * 0.5, (y1 + y2) * 0.5, (z1 + z2) * 0.5],
          [(x2 + x0) * 0.5, (y2 + y0) * 0.5, (z2 + z0) * 0.5],
          [x0 * 0.5 + x1 * 0.25 + x2 * 0.25, y0 * 0.5 + y1 * 0.25 + y2 * 0.25, z0 * 0.5 + z1 * 0.25 + z2 * 0.25],
          [x0 * 0.25 + x1 * 0.5 + x2 * 0.25, y0 * 0.25 + y1 * 0.5 + y2 * 0.25, z0 * 0.25 + z1 * 0.5 + z2 * 0.25],
          [x0 * 0.25 + x1 * 0.25 + x2 * 0.5, y0 * 0.25 + y1 * 0.25 + y2 * 0.5, z0 * 0.25 + z1 * 0.25 + z2 * 0.5],
        ];
        for (const [px, py, pz] of pts) {
          const g = tv.meshY(px, pz);
          const diff = g - py;
          if (diff > 0.03) {
            pokingPoints++;
            if (diff > maxIntrusion) maxIntrusion = diff;
          }
        }
      }

      expect(checkedTris).toBeGreaterThan(2000);
      expect(
        pokingPoints,
        `${terrain} Dia 40: ${pokingPoints} pontos de terreno > 0.03 m acima do pavimento (max=${maxIntrusion.toFixed(3)} m)`,
      ).toBe(0);
    }
  }, 240000);
});
