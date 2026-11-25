import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { World } from '../src/sim/world';
import { DEFAULT_PARAMS } from '../src/shared/params';
import { RoadClass, VType } from '../src/shared/constants';
import { CROSSWALK_HALF_LEN, CROSSWALK_INSET, edgeHalfWidth, hasEndCrosswalk, SIDEWALK_WIDTH } from '../src/shared/roadGeom';
import { P_CITIZEN } from '../src/sim/traffic';
import { segRectDist } from '../src/sim/geom';
import { walkPath } from '../src/sim/trips';
import { GB } from '../src/render/geomBuilder';
import { computeCornerSidewalk, fillet, junction, type Arm } from '../src/render/junctions';

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

describe('Entrega de Infraestrutura — Terraplenagem, Junções, Ferrovias, Pontes e Pedestres 3D', () => {
  it('terraplenagem determinística: conforma estradas/junções/ferrovias/edifícios, preserva água/rio e nunca rebaixa abaixo de seaLevel + 0.35', () => {
    const w1 = makeWorld(1234, { terrain: 'serra' });
    const w2 = makeWorld(1234, { terrain: 'serra' });

    // 1. Bit-for-bit determinism across two identical seeds
    expect(w1.terrain.heights.length).toBe(w2.terrain.heights.length);
    let bitDiffs = 0;
    for (let k = 0; k < w1.terrain.heights.length; k++) {
      if (w1.terrain.heights[k] !== w2.terrain.heights[k]) bitDiffs++;
    }
    expect(bitDiffs).toBe(0);

    // 2. Water/river invariants and dry-land floor invariant
    const T = w1.terrain;
    const rawWaterSnapshot = new Map<number, number>();
    for (let k = 0; k < T.heights.length; k++) {
      if (T.water[k] === 1 || T.riverDist[k] < T.riverWidth * 0.65) {
        rawWaterSnapshot.set(k, T.heights[k]);
      } else {
        expect(T.heights[k]).toBeGreaterThanOrEqual(T.seaLevel + 0.35 - 1e-4);
      }
    }

    // 3. Find a sloped dry hillside far from river and verify road, junction, building, and rail grading
    let sx = -1, sz = -1;
    for (let z = 300; z < T.size - 300 && sx < 0; z += 50) {
      for (let x = 300; x < T.size - 300; x += 50) {
        if (T.heightAt(x, z) > 12 && T.slopeAt(x, z) > 0.10 && T.distToRiver(x, z) > 140) {
          sx = x; sz = z; break;
        }
      }
    }
    expect(sx).toBeGreaterThan(0);

    // Measure cross-slope before adding a road
    const heightsBefore = T.heights.slice();
    const na = w1.roads.addNode(sx - 45, sz);
    const nb = w1.roads.addNode(sx + 45, sz);
    const road = w1.roads.addEdge(na.id, nb.id, RoadClass.Avenue, { progress: 1 });
    expect(road.alive).toBe(true);

    // Verify terrain heights actually conformed under the road footprint
    let changedRoad = 0;
    for (let k = 0; k < T.heights.length; k++) {
      if (Math.abs(T.heights[k] - heightsBefore[k]) > 1e-3) changedRoad++;
    }
    expect(changedRoad).toBeGreaterThan(0);

    // Add a 3rd arm creating a junction + grade a building pad on the slope
    const nc = w1.roads.addNode(sx, sz + 55);
    const nMid = w1.roads.splitEdge(road.id, 0.5);
    w1.roads.addEdge(nMid.id, nc.id, RoadClass.Local, { progress: 1 });

    const beforeBld = T.heights.slice();
    const bld = w1.buildings.create(
      'com',
      { x: sx + 30, z: sz + 35, angle: 0.25, edge: -1, t: 0, side: 1, access: nMid.id, offDist: 10, total: 0, terms: {} },
      { era: 1, day: 0, w: 22, d: 18, maxDensity: 2, decision: null, instant: true },
    );
    expect(bld.y).toBeGreaterThanOrEqual(T.meshY(bld.x, bld.z) - 0.01);
    let changedBld = 0;
    for (let k = 0; k < T.heights.length; k++) {
      if (Math.abs(T.heights[k] - beforeBld[k]) > 1e-3) changedBld++;
    }
    expect(changedBld).toBeGreaterThan(0);

    // 4. Bridge & elevated structures MUST NEVER grade terrain underneath
    const beforeBridge = T.heights.slice();
    const bA = w1.roads.addNode(sx - 120, sz - 90);
    const bB = w1.roads.addNode(sx - 20, sz - 90);
    w1.roads.addEdge(bA.id, bB.id, RoadClass.Collector, { progress: 1, bridge: true });
    w1.roads.addEdge(bA.id, bB.id, RoadClass.Avenue, { progress: 1, elevated: true, deck: 60 });
    for (let k = 0; k < T.heights.length; k++) {
      expect(T.heights[k]).toBe(beforeBridge[k]);
    }

    // 5. Re-check all water/river cells: 100% untouched bit-for-bit
    for (const [k, origH] of rawWaterSnapshot) {
      expect(T.heights[k]).toBe(origH);
    }
    for (let k = 0; k < T.heights.length; k++) {
      if (T.water[k] === 0 && T.riverDist[k] >= T.riverWidth * 0.65) {
        expect(T.heights[k]).toBeGreaterThanOrEqual(T.seaLevel + 0.35 - 1e-4);
      }
    }
  });

  it('WorldDiff.heights é emitido em lote uma única vez por alteração sem floodar o worker', () => {
    const w = makeWorld(42, { terrain: 'vale' });
    // Drain any initial diff
    w.collectDiff();
    const cleanDiff = w.collectDiff();
    expect(cleanDiff.heights).toBeUndefined();

    // Find a dry sloped spot and build an at-grade road + building
    const T = w.terrain;
    let x0 = 500, z0 = 500;
    for (let z = 300; z < T.size - 300; z += 40) {
      let found = false;
      for (let x = 300; x < T.size - 300; x += 40) {
        if (T.heightAt(x, z) > 8 && T.slopeAt(x, z) > 0.06 && T.distToRiver(x, z) > 120) {
          x0 = x; z0 = z; found = true; break;
        }
      }
      if (found) break;
    }
    const na = w.roads.addNode(x0 - 35, z0);
    const nb = w.roads.addNode(x0 + 35, z0);
    w.roads.addEdge(na.id, nb.id, RoadClass.Collector, { progress: 1 });
    w.buildings.create(
      'res',
      { x: x0, z: z0 + 25, angle: 0, edge: -1, t: 0, side: 1, access: na.id, offDist: 10, total: 0, terms: {} },
      { era: 0, day: 0, w: 16, d: 14, maxDensity: 2, decision: null, instant: true },
    );

    const diffAfter = w.collectDiff();
    expect(diffAfter.heights).toBeInstanceOf(Float32Array);
    expect(diffAfter.heights!.length).toBe(T.heights.length);

    // Subsequent collectDiff with no new terrain edits MUST NOT re-send heights
    const diffNext = w.collectDiff();
    expect(diffNext.heights).toBeUndefined();
  });

  it('geometria de junções: continuidade C0 em encostas, zero invasão/auto-interseção em ângulos agudos (35°, 45°, 60°) e calçadas mistas', () => {
    // 1. C0 elevation continuity on a sloped 3-way junction
    const slopedArms: Arm[] = [
      { x: 112, y: 14.0, z: 100, dx: 1, dz: 0, hw: 4.5, walk: true },
      { x: 100, y: 11.4, z: 112, dx: 0, dz: 1, hw: 4.5, walk: true },
      { x: 88, y: 12.8, z: 100, dx: -1, dz: 0, hw: 4.5, walk: true },
    ];
    for (let i = 0; i < slopedArms.length; i++) {
      const a = slopedArms[i], b = slopedArms[(i + 1) % slopedArms.length];
      const f = fillet(a, b, a.hw, b.hw, 0.01, 100, 100, 8);
      // Endpoints of fillet MUST match arm mouth elevations to <= 0.02 m
      expect(Math.abs(f[0][1] - (a.y + 0.01))).toBeLessThanOrEqual(0.02);
      expect(Math.abs(f[f.length - 1][1] - (b.y + 0.01))).toBeLessThanOrEqual(0.02);
    }

    // 2. Acute corner validation (35°, 45°, 60°): sidewalk outer points MUST NOT invade adjacent carriageway
    for (const deg of [35, 45, 60]) {
      const rad = (deg * Math.PI) / 180;
      const r = 10.5;
      const hw = 4.0;
      const A: Arm = { x: r, y: 10, z: 0, dx: 1, dz: 0, hw, walk: true };
      const B: Arm = { x: Math.cos(rad) * r, y: 10, z: Math.sin(rad) * r, dx: Math.cos(rad), dz: Math.sin(rad), hw, walk: true };
      const sw = computeCornerSidewalk(A, B, 0, 0, SIDEWALK_WIDTH, 8);

      for (const p of sw.outer) {
        const alongA = p[0] * A.dx + p[2] * A.dz;
        const distA = p[0] * (-A.dz) + p[2] * A.dx;
        if (alongA > 0) expect(distA, `${deg}° corner outer invades arm A`).toBeGreaterThanOrEqual(hw - 0.02);

        const alongB = p[0] * B.dx + p[2] * B.dz;
        const distB = p[0] * B.dz - p[2] * B.dx;
        if (alongB > 0) expect(distB, `${deg}° corner outer invades arm B`).toBeGreaterThanOrEqual(hw - 0.02);
      }

      // Verify zero segment fold-back / self-intersection between inner & outer rings
      if (sw.valid) {
        for (let k = 1; k < sw.outer.length; k++) {
          const ix = sw.inner[k][0] - sw.inner[k - 1][0], iz = sw.inner[k][2] - sw.inner[k - 1][2];
          const ox = sw.outer[k][0] - sw.outer[k - 1][0], oz = sw.outer[k][2] - sw.outer[k - 1][2];
          expect(ix * ox + iz * oz, `${deg}° corner outer folds backward`).toBeGreaterThanOrEqual(-0.05);
        }
      }
    }

    // 3. Mixed sidewalks (a.walk !== b.walk): emits clean tapered sidewalk return geometry
    const gMixed = new GB();
    const gNoWalk = new GB();
    const style = { surface: new THREE.Color(0x3d4044), walk: new THREE.Color(0xb9b4aa), curb: new THREE.Color(0xd2cdc2) };
    const armsMixed: Arm[] = [
      { x: 112, y: 5, z: 100, dx: 1, dz: 0, hw: 4.0, walk: true },
      { x: 100, y: 5, z: 112, dx: 0, dz: 1, hw: 4.0, walk: false },
      { x: 88, y: 5, z: 100, dx: -1, dz: 0, hw: 4.0, walk: false },
    ];
    const armsNone = armsMixed.map((a) => ({ ...a, walk: false }));
    junction(gMixed, 100, 5, 100, armsMixed, style, () => 4.8);
    junction(gNoWalk, 100, 5, 100, armsNone, style, () => 4.8);
    // Mixed junction has additional clean curb-return geometry compared to all-unwalked
    expect(gMixed.count).toBeGreaterThan(gNoWalk.count);
  });

  it('alinhamento da linha de parada atrás da faixa de pedestres e consistência hasEndCrosswalk em quadra curta (22 m)', () => {
    const w = makeWorld(520);
    const R = w.roads, T = w.traffic;
    // Build a 4-way signalized urban intersection at (1500, 1500)
    const c = R.addNode(1500, 1500);
    const nW = R.addNode(1410, 1500), nE = R.addNode(1590, 1500);
    const nN = R.addNode(1500, 1410), nS = R.addNode(1500, 1590);
    const eW = R.addEdge(nW.id, c.id, RoadClass.Collector, { progress: 1 });
    const eE = R.addEdge(c.id, nE.id, RoadClass.Collector, { progress: 1 });
    R.addEdge(nN.id, c.id, RoadClass.Collector, { progress: 1 });
    R.addEdge(c.id, nS.id, RoadClass.Collector, { progress: 1 });
    c.control = 2;
    w.computePhases(c);
    for (let i = 0; i < T.max; i++) if (T.active[i]) T.despawn(i);

    // Spawn a car approaching the red signal at c
    const car = T.spawn(VType.Car, [eW.id * 2, eE.id * 2], 30, eE.len - 5, { kind: P_CITIZEN, id: -1, aux: 0 });
    expect(car).toBeGreaterThanOrEqual(0);
    for (let k = 0; k < 100; k++) T.step(0.5, () => false); // held at red signal

    expect(T.active[car]).toBe(1);
    const frontBumper = T.s[car] + T.len[car] * 0.5;
    const renderR = R.nodeRenderR(c.id);
    const crosswalkOuterFromNode = renderR * 0.92 + CROSSWALK_INSET + CROSSWALK_HALF_LEN;
    const crosswalkOuterS = eW.len - crosswalkOuterFromNode;
    // First stopped vehicle's front bumper MUST remain strictly behind the painted zebra crosswalk
    expect(frontBumper).toBeLessThanOrEqual(crosswalkOuterS + 0.05);

    // Consistency of short-block crosswalk threshold (22 m > 20 m)
    const sA = R.addNode(1700, 1700), sB = R.addNode(1722, 1700);
    const sN = R.addNode(1700, 1640), sS = R.addNode(1700, 1760);
    const sShort = R.addEdge(sA.id, sB.id, RoadClass.Local, { progress: 1 });
    R.addEdge(sN.id, sA.id, RoadClass.Local, { progress: 1 });
    R.addEdge(sA.id, sS.id, RoadClass.Local, { progress: 1 });
    expect(sShort.len).toBeCloseTo(22, 1);
    expect(hasEndCrosswalk(sShort, sShort.len, 3, true, false)).toBe(true);
    const wpShort = walkPath(R, { path: [sShort.id * 2], startS: 2, destS: 20 }, { x: 1702, z: 1708 }, { x: 1720, z: 1692 });
    expect(wpShort.pts.length).toBeGreaterThanOrEqual(6);
    expect(wpShort.ys.length).toBe(wpShort.pts.length / 2);
  });

  it('pedestres e ciclistas em pontes, cabeceiras e cruzamentos em dois níveis (viaduto/túnel vs. rua em nível)', () => {
    const w = makeWorld(521, { terrain: 'vale' });
    const R = w.roads;
    const P = w.peds;

    // 1. Bridge + street approach: verify smooth elevation continuity across abutment and elevated deck over river/valley
    const n1 = R.addNode(1100, 1100);
    const n2 = R.addNode(1180, 1100);
    const n3 = R.addNode(1280, 1100);
    const n4 = R.addNode(1360, 1100);
    const eApp1 = R.addEdge(n1.id, n2.id, RoadClass.Collector, { progress: 1 });
    const eBr = R.addEdge(n2.id, n3.id, RoadClass.Collector, { progress: 1, bridge: true });
    const eApp2 = R.addEdge(n3.id, n4.id, RoadClass.Collector, { progress: 1 });
    // Set explicit elevated arched bridge deck profile matching river clearance
    const yEnd = n2.y;
    eBr.pts = [
      n2.x, yEnd, n2.z,
      n2.x + 25, yEnd + 3.5, n2.z,
      n2.x + 50, yEnd + 5.8, n2.z,
      n2.x + 75, yEnd + 3.5, n2.z,
      n3.x, n3.y, n3.z,
    ];
    R.topoVer++;

    const brPath = walkPath(
      R,
      { path: [eApp1.id * 2, eBr.id * 2, eApp2.id * 2], startS: 20, destS: 60 },
      { x: 1120, z: 1108 },
      { x: 1340, z: 1108 },
    );
    expect(brPath.ys.length).toBe(brPath.pts.length / 2);
    const pedSlot = P.spawn(brPath.pts, -1, 2.0, 0, 0, 0, brPath.ys);
    expect(pedSlot).toBeGreaterThanOrEqual(0);

    // Walk across bridge and check max vertical step and deck height at midpoint
    let prevY = P.y[pedSlot];
    let maxStepY = 0;
    let midBridgeY = -Infinity;
    for (let k = 0; k < 240 && P.active[pedSlot]; k++) {
      P.step(0.5);
      if (!P.active[pedSlot]) break;
      P.pose(pedSlot);
      const curY = P.y[pedSlot];
      maxStepY = Math.max(maxStepY, Math.abs(curY - prevY));
      prevY = curY;
      if (Math.abs(P.x[pedSlot] - (n2.x + 50)) < 5) midBridgeY = Math.max(midBridgeY, curY);
    }
    expect(midBridgeY).toBeGreaterThanOrEqual(yEnd + 5.2);
    expect(maxStepY).toBeLessThan(0.55); // smooth transition at abutments, no sudden vertical jump

    // 2. Two-level crossing: surface street passing UNDER an elevated viaduct (same XZ!)
    const sW = R.addNode(1500, 1600), sE = R.addNode(1620, 1600);
    const eSurface = R.addEdge(sW.id, sE.id, RoadClass.Local, { progress: 1 });
    const vN = R.addNode(1560, 1520), vS = R.addNode(1560, 1680);
    const eViaduct = R.addEdge(vN.id, vS.id, RoadClass.Avenue, { progress: 1, elevated: true, deck: 60 });
    // Force high deck elevation (+8 m above surface) at crossing (1560, 1600)
    const surfY = Math.max(w.terrain.meshY(1560, 1600), w.terrain.heightAt(1560, 1600), 0.3);
    eViaduct.pts = [1560, surfY + 1, 1520, 1560, surfY + 8.5, 1600, 1560, surfY + 1, 1680];
    // Also place a tunnel running UNDER the same street at x = 1585
    const tN = R.addNode(1585, 1520), tS = R.addNode(1585, 1680);
    const eTunnel = R.addEdge(tN.id, tS.id, RoadClass.Avenue, { progress: 1, tunnel: true, deck: 60 });
    eTunnel.pts = [1585, surfY - 0.5, 1520, 1585, surfY - 7.5, 1600, 1585, surfY - 0.5, 1680];
    R.topoVer++;

    // Pedestrian walking on eSurface under eViaduct and over eTunnel MUST stay at surface level (~surfY + 0.27)
    const surfPath = walkPath(R, { path: [eSurface.id * 2], startS: 10, destS: 110 }, { x: 1510, z: 1606 }, { x: 1610, z: 1606 });
    const surfPed = P.spawn(surfPath.pts, -1, 2.0, 0, 0, 0, surfPath.ys);
    expect(surfPed).toBeGreaterThanOrEqual(0);
    for (let k = 0; k < 120 && P.active[surfPed]; k++) {
      P.step(0.5);
      if (!P.active[surfPed]) break;
      P.pose(surfPed);
      const g = Math.max(w.terrain.meshY(P.x[surfPed], P.z[surfPed]), 0.2);
      // Never jumps up onto viaduct (+8.5 m) and never drops into tunnel (-7.5 m)
      expect(P.y[surfPed]).toBeLessThan(g + 2.0);
      expect(P.y[surfPed]).toBeGreaterThanOrEqual(g + 0.1);
    }

    // Pedestrian routed explicitly through eTunnel stays at tunnel floor level (~surfY - 7.5), not snapping up to surface
    const tunPath = walkPath(R, { path: [eTunnel.id * 2], startS: 20, destS: 140 }, { x: 1585, z: 1540 }, { x: 1585, z: 1660 });
    const minTunY = Math.min(...tunPath.ys);
    expect(minTunY).toBeLessThan(surfY - 5.0);

    // walkRoute excludes grade-separated decks
    expect(R.walkRoute(vN.id, vS.id)).toBeNull();
    expect(R.walkRoute(tN.id, tS.id)).toBeNull();
  });

  it('auditoria de folga terreno × infraestrutura e zero invasão edificação × via em terrain=vale (Dia 20) e terrain=serra (Dia 20)', async () => {
    for (const [terrain, days] of [['vale', 20], ['serra', 20]] as const) {
      const w = await runAsync(makeWorld(1234, { terrain }), days);
      const T = w.terrain;
      const R = w.roads;

      // 1. At-grade roads AND river bridges: every sampled centerline point clears meshY (except real carved c.under trenches)
      let roadSamples = 0, roadBuried = 0, bridgeSamples = 0;
      for (const e of R.edges) {
        if (!e.alive || e.progress < 1 || e.elevated || e.tunnel || e.deck !== undefined) continue;
        const nPts = Math.floor(e.pts.length / 3);
        for (let idx = 0; idx < nPts; idx++) {
          const i = idx * 3;
          const x = e.pts[i], y = e.pts[i + 1], z = e.pts[i + 2];
          // Excavated rail underpass trenches intentionally dip below uncarved heightmap
          if (e.underpasses?.length) {
            const s = (idx / Math.max(1, nPts - 1)) * e.len;
            if (e.underpasses.some((up) => s >= up.t * e.len - up.halfLenNeg && s <= up.t * e.len + up.halfLenPos)) {
              continue;
            }
          }
          const my = T.meshY(x, z);
          roadSamples++;
          if (e.bridge) bridgeSamples++;
          if (y < my + 0.04) roadBuried++;
        }
      }
      expect(roadSamples).toBeGreaterThan(50);
      expect(bridgeSamples).toBeGreaterThan(0);
      expect(roadBuried, `${terrain}: road/bridge vertices below meshY`).toBe(0);

      // 2. Ground-level rail: track bed clears meshY
      let railSamples = 0, railBuried = 0;
      for (const l of w.rail2.lines) {
        if (l.elevated) continue;
        for (let i = 0; i < l.x.length; i++) {
          const x = l.x[i], y = l.y[i], z = l.z[i];
          const my = T.meshY(x, z);
          if (my < T.seaLevel + 0.5) continue; // bridge over water
          railSamples++;
          if (y < my + 0.05) railBuried++;
        }
      }
      expect(railSamples).toBeGreaterThan(20);
      expect(railBuried, `${terrain}: ground rail vertices below meshY`).toBe(0);

      // 3. Buildings: pad elevation clears all footprint corners' meshY and stays within 12 m foundation plinth depth
      let bldCount = 0, bldBuried = 0, bldFloating = 0;
      for (const b of w.buildings.list) {
        if (!b.alive || b.state !== 'done') continue;
        bldCount++;
        const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
        let maxCorner = -Infinity, minCorner = Infinity;
        for (const [u, v] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, 0]]) {
          const px = b.x + ca * u * b.w - sa * v * b.d;
          const pz = b.z + sa * u * b.w + ca * v * b.d;
          const my = T.meshY(px, pz);
          if (my > maxCorner) maxCorner = my;
          if (my < minCorner) minCorner = my;
        }
        if (b.y < maxCorner - 0.15) bldBuried++;
        if (b.y - minCorner > 12.0) bldFloating++;
      }
      expect(bldCount).toBeGreaterThan(20);
      expect(bldBuried, `${terrain}: buildings buried below corner meshY`).toBe(0);
      expect(bldFloating, `${terrain}: buildings floating beyond 12m plinth`).toBe(0);

      // 3b. Zero building × road overlaps (including railStation & freightTerminal)
      let bldRoadOverlaps = 0;
      let railFacilities = 0;
      for (const b of w.buildings.list) {
        if (!b.alive) continue;
        if (b.kind === 'railStation' || b.kind === 'freightTerminal' || b.kind === 'metroStation') railFacilities++;
        const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
        const rad = Math.hypot(b.w, b.d) * 0.5 + 24;
        for (const e of R.edgesNear(b.x, b.z, rad)) {
          if (!e.alive || e.deck !== undefined) continue;
          const ea = R.nodes[e.a], eb = R.nodes[e.b];
          if (!ea || !eb) continue;
          const d = segRectDist(ea.x - b.x, ea.z - b.z, eb.x - b.x, eb.z - b.z, ca, sa, b.w * 0.5, b.d * 0.5);
          if (d < edgeHalfWidth(e) - 0.1) bldRoadOverlaps++;
        }
      }
      expect(bldRoadOverlaps, `${terrain}: buildings overlapping road carriageways`).toBe(0);
      expect(railFacilities, `${terrain}: expected rail station/terminal to be placed`).toBeGreaterThanOrEqual(1);

      // 4. Bus shelters: off water and above meshY
      for (const l of w.transitSys.lines) {
        if (l.kind !== 'bus' && l.kind !== 'brt') continue;
        for (const st of l.stops) {
          const [sx, sz] = w.transitSys.shelterPose(st);
          expect(T.isWater(sx, sz)).toBe(false);
          expect(T.meshY(sx, sz)).toBeGreaterThan(T.seaLevel);
        }
      }

      // 5. No graded dry cell was lowered below seaLevel + 0.35
      let dryTooLow = 0;
      for (let k = 0; k < T.heights.length; k++) {
        if (w.terraforming.graded[k] > 0 && T.water[k] === 0 && T.riverDist[k] >= T.riverWidth * 0.65 && T.heights[k] < T.seaLevel + 0.35 - 1e-4) dryTooLow++;
      }
      expect(dryTooLow).toBe(0);
    }
  }, 180000);
});
