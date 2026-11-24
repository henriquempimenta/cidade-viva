import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { computeVehicleBlinkerAnchors } from '../src/render/agentsLayer';
import type { AssetDetail } from '../src/render/meshKit';
import {
  VEHICLE_PRESETS,
  VEHICLE_PRESET_MAP,
  VTYPE_DEFAULT_PRESETS,
  buildVehicle,
  type VehicleId,
  type VehicleSpec,
} from '../src/render/vehicleGeom';
import { VTYPE_LEN, VType } from '../src/shared/constants';
import { VEHICLE_MESH_LEN } from '../src/shared/vehiclePresets';
import { getFamily } from '../src/workbench/registry';

const HEAVY_IDS = new Set<VehicleId>([
  'bus',
  'schoolbus',
  'tourbus',
  'truck',
  'garbage',
  'construction',
  'fire',
  'tow',
]);

const DETAILS: AssetDetail[] = ['high', 'med', 'low'];

describe('vehicleGeom parametric generator', () => {
  it('registers all 19 vehicle presets and maps every motorized VType (including Tow)', () => {
    expect(VEHICLE_PRESETS).toHaveLength(19);
    const ids = new Set(VEHICLE_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(19);

    const family = getFamily('vehicles');
    expect(family.id).toBe('vehicles');
    expect(family.variants()).toHaveLength(19);

    const motorized: VType[] = [
      VType.Car, VType.Taxi, VType.Moto, VType.Bus, VType.SchoolBus,
      VType.Truck, VType.Van, VType.Garbage, VType.Ambulance, VType.Police,
      VType.Fire, VType.TourBus, VType.Construction, VType.Hearse, VType.Tow,
    ];
    for (const vt of motorized) {
      const list = VTYPE_DEFAULT_PRESETS[vt];
      expect(list && list.length).toBeGreaterThan(0);
    }
    const towBuilt = buildVehicle('tow', 'high');
    towBuilt.body.computeBoundingBox();
    const tbb = towBuilt.body.boundingBox!;
    const towExtent = 2 * Math.max(Math.abs(tbb.min.x), Math.abs(tbb.max.x));
    expect(VEHICLE_MESH_LEN.tow).toBeGreaterThanOrEqual(towExtent - 0.001);
  });

  for (const preset of VEHICLE_PRESETS) {
    describe(`preset: ${preset.id}`, () => {
      it('satisfies triangle budget, LOD reduction, ground contact, dimensions, normals, aTint, and glow', () => {
        const maxBudget = preset.id === 'moto' ? 460 : HEAVY_IDS.has(preset.id) ? 620 : 480;
        const triCounts: Record<AssetDetail, number> = { high: 0, med: 0, low: 0 };

        for (const detail of DETAILS) {
          const res = buildVehicle(preset.id, detail);
          const { meta, body, glow } = res;
          triCounts[detail] = meta.triangles;

          // Triangle budget
          expect(meta.triangles, `${preset.id} (${detail}) triangles`).toBeGreaterThan(100);
          expect(meta.triangles, `${preset.id} (${detail}) triangles <= ${maxBudget}`).toBeLessThanOrEqual(maxBudget);

          // Ground contact at Y = 0
          expect(meta.minY, `${preset.id} (${detail}) minY`).toBeGreaterThanOrEqual(-0.01);
          expect(meta.minY, `${preset.id} (${detail}) minY`).toBeLessThanOrEqual(0.01);

          // Length coherent with VTYPE_LEN (allow compact hatch/pickup variation around Car 4.4m)
          const refLen = VTYPE_LEN[preset.vtype];
          const tol = preset.vtype === VType.Car ? 0.85 : 0.70;
          expect(Math.abs(meta.size[0] - refLen), `${preset.id} length ${meta.size[0]} vs ${refLen}`).toBeLessThanOrEqual(tol);

          // Symmetry around Z = 0
          body.computeBoundingBox();
          const bb = body.boundingBox!;
          expect(Math.abs(bb.min.z + bb.max.z), `${preset.id} Z symmetry`).toBeLessThan(0.08);

          // Finite unit normals
          const nor = body.getAttribute('normal');
          expect(nor.count).toBe(body.getAttribute('position').count);
          for (let i = 0; i < nor.count; i++) {
            const nx = nor.getX(i);
            const ny = nor.getY(i);
            const nz = nor.getZ(i);
            expect(Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz)).toBe(true);
            const len = Math.hypot(nx, ny, nz);
            expect(len).toBeCloseTo(1, 2);
          }

          // Both paintable (aTint=1) and fixed (aTint=0) vertices present
          const tint = body.getAttribute('aTint');
          let painted = 0;
          let fixed = 0;
          for (let i = 0; i < tint.count; i++) {
            if (tint.getX(i) > 0.5) painted++;
            else fixed++;
          }
          expect(painted, `${preset.id} (${detail}) painted verts`).toBeGreaterThan(0);
          expect(fixed, `${preset.id} (${detail}) fixed verts`).toBeGreaterThan(0);

          // Glow geometry present with finite vertices
          expect(glow, `${preset.id} (${detail}) glow geometry`).toBeDefined();
          expect(meta.glowTriangles).toBeGreaterThan(0);
        }

        // LOD monotonicity and meaningful low-detail reduction
        expect(triCounts.low).toBeLessThanOrEqual(triCounts.med);
        expect(triCounts.med).toBeLessThanOrEqual(triCounts.high);
        expect(triCounts.low, `${preset.id} low LOD reduction`).toBeLessThanOrEqual(Math.round(triCounts.high * 0.72));
        if (preset.id === 'moto') {
          expect(triCounts.low, 'moto low LOD < 260 tris').toBeLessThan(260);
        }
      });
    });
  }
});

interface TriSample {
  cx: number;
  cy: number;
  cz: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  nx: number;
  ny: number;
  nz: number;
  r: number;
  g: number;
  b: number;
  roughness: number;
  metalness: number;
}

function extractTriangles(geo: THREE.BufferGeometry): TriSample[] {
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const col = geo.getAttribute('color');
  const mat = geo.getAttribute('aMat');
  const tris: TriSample[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    const x0 = pos.getX(i), y0 = pos.getY(i), z0 = pos.getZ(i);
    const x1 = pos.getX(i + 1), y1 = pos.getY(i + 1), z1 = pos.getZ(i + 1);
    const x2 = pos.getX(i + 2), y2 = pos.getY(i + 2), z2 = pos.getZ(i + 2);
    tris.push({
      cx: (x0 + x1 + x2) / 3,
      cy: (y0 + y1 + y2) / 3,
      cz: (z0 + z1 + z2) / 3,
      minX: Math.min(x0, x1, x2),
      maxX: Math.max(x0, x1, x2),
      minY: Math.min(y0, y1, y2),
      maxY: Math.max(y0, y1, y2),
      minZ: Math.min(z0, z1, z2),
      maxZ: Math.max(z0, z1, z2),
      nx: nor.getX(i),
      ny: nor.getY(i),
      nz: nor.getZ(i),
      r: col.getX(i),
      g: col.getY(i),
      b: col.getZ(i),
      roughness: mat ? mat.getX(i) : 0,
      metalness: mat ? mat.getY(i) : 0,
    });
  }
  return tris;
}

describe('vehicleGeom TODO 1 visual & structural polish', () => {
  it('ambulance: rear red stripe is recessed behind plate/bezels/taillights with zero coplanarity', () => {
    const spec = VEHICLE_PRESET_MAP.ambulance.spec as VehicleSpec;
    const xRear = -spec.length * 0.5;
    const built = buildVehicle('ambulance', 'high');
    const bodyTris = extractTriangles(built.body);
    const glowTris = extractTriangles(built.glow!);

    const rearGlowTaillights = glowTris.filter((t) => t.nx < -0.9 && t.cy < 1.2);
    expect(rearGlowTaillights.length).toBeGreaterThanOrEqual(4);
    for (const tl of rearGlowTaillights) {
      expect(tl.cx).toBeCloseTo(xRear - 0.012, 3);
    }

    // Find red rear stripe triangles (paintFixed red: r > 0.6, g < 0.1, b < 0.1, facing -X)
    const rearRedStripe = bodyTris.filter(
      (t) => t.nx < -0.9 && t.r > 0.5 && t.g < 0.1 && t.b < 0.1 && t.cy > 0.65 && t.cy < 1.0,
    );
    expect(rearRedStripe.length).toBe(2);
    for (const st of rearRedStripe) {
      // Recessed at xRear - 0.004: strictly behind plate (-0.008), bezels (-0.006), and glow (-0.012)
      expect(st.cx).toBeCloseTo(xRear - 0.004, 3);
      expect(st.cx).toBeGreaterThan(xRear - 0.006 + 0.001);
      // Segmented strictly between the left/right taillight bezels and glow lenses
      const minTaillightInnerZ = Math.min(
        ...rearGlowTaillights.map((tl) => Math.min(Math.abs(tl.minZ), Math.abs(tl.maxZ))),
      );
      expect(Math.max(Math.abs(st.minZ), Math.abs(st.maxZ))).toBeLessThan(minTaillightInnerZ - 0.02);
    }
  });

  it('fire: rear standing platform connects solidly to apparatus with gussets and wheel wells sit in front of fire-stripe', () => {
    const spec = VEHICLE_PRESET_MAP.fire.spec as VehicleSpec;
    const halfL = spec.length * 0.5;
    const appRearX = -halfL + 0.06 + 0.22;
    const appBotY = spec.groundClearance + 0.18;
    const built = buildVehicle('fire', 'high');
    const bodyTris = extractTriangles(built.body);

    // 1. Apparatus rear wall reaches all the way down to appBotY (zero air gap above tailboard)
    const rearWallTris = bodyTris.filter(
      (t) => t.nx < -0.9 && Math.abs(t.cx - appRearX) < 0.01 && t.maxY > 2.5,
    );
    expect(rearWallTris.length).toBeGreaterThan(0);
    expect(Math.min(...rearWallTris.map((t) => t.minY))).toBeCloseTo(appBotY, 2);

    // 2. Steel support gussets brace tailboard top (appBotY + 0.14) up onto the apparatus rear wall
    const gussetTris = bodyTris.filter(
      (t) => t.metalness > 0.4 && t.maxX <= appRearX + 0.01 && t.minX < appRearX - 0.10 && t.maxY > appBotY + 0.30,
    );
    expect(gussetTris.length).toBeGreaterThanOrEqual(4);

    // 3. Front cab wheel arch sits strictly proud of cab fire-stripe (using cabWall, not buried in appHalfW)
    const frontAxle = spec.axles[spec.axles.length - 1];
    const frontArchDark = bodyTris.filter(
      (t) => t.nz > 0.9 && t.roughness > 0.85 && t.r < 0.0115 && t.cz > 1.1 && Math.abs(t.cx - frontAxle) < 0.65 && t.maxY > 0.92,
    );
    const cabWhiteStripe = bodyTris.filter(
      (t) => t.nz > 0.9 && t.roughness < 0.5 && t.r > 0.85 && t.g > 0.85 && t.b > 0.85 && t.cz > 1.1 && t.minX > 1.9 && t.cy > 0.9 && t.cy < 1.15,
    );
    expect(frontArchDark.length).toBeGreaterThan(0);
    expect(cabWhiteStripe.length).toBeGreaterThan(0);
    // Compare arch upper crown (maxZ, in the stripe Y band) against cab stripe maxZ
    const archCrownZ = Math.max(...frontArchDark.map((t) => t.maxZ));
    const maxCabStripeZ = Math.max(...cabWhiteStripe.map((t) => t.maxZ));
    expect(archCrownZ).toBeGreaterThan(maxCabStripeZ + 0.004);

    // 4. Rear tandem bogie wheel well sits strictly proud of apparatus fire-stripe
    const bogieDark = bodyTris.filter(
      (t) => t.nz > 0.9 && t.roughness > 0.85 && t.r < 0.0115 && t.cz > 1.1 && t.minX < -3.4 && t.maxX > -1.4 && t.cy > 0.5 && t.cy < 1.1,
    );
    const appWhiteStripe = bodyTris.filter(
      (t) => t.nz > 0.9 && t.roughness < 0.5 && t.r > 0.85 && t.g > 0.85 && t.b > 0.85 && t.cz > 1.1 && t.maxX < 1.95 && t.minX < -3.5 && t.cy > 0.9 && t.cy < 1.15,
    );
    expect(bogieDark.length).toBeGreaterThan(0);
    expect(appWhiteStripe.length).toBeGreaterThan(0);
    expect(Math.min(...bogieDark.map((t) => t.minZ))).toBeGreaterThan(Math.max(...appWhiteStripe.map((t) => t.maxZ)) + 0.004);
  });

  it('bus & tourbus: dark wheel wells sit cleanly in front of side livery stripes, and tourbus has intermediate handrail stanchions', () => {
    for (const id of ['bus', 'tourbus'] as const) {
      const spec = VEHICLE_PRESET_MAP[id].spec as VehicleSpec;
      const built = buildVehicle(id, 'high');
      const bodyTris = extractTriangles(built.body);

      // Side livery stripe on +Z side (long quad spanning nearly full body length at belt/mid height)
      const stripeTris = bodyTris.filter(
        (t) => t.nz > 0.9 && t.cz > spec.width * 0.45 && (t.maxX - t.minX) > 6 && t.cy > 0.7 && t.cy < 1.1,
      );
      expect(stripeTris.length, `${id} side stripe`).toBeGreaterThanOrEqual(2);
      const stripeMinY = Math.min(...stripeTris.map((t) => t.minY));
      const stripeMaxY = Math.max(...stripeTris.map((t) => t.maxY));
      const stripeZBot = Math.max(...stripeTris.map((t) => t.maxZ));
      const stripeZTop = Math.min(...stripeTris.map((t) => t.minZ));
      const stripeZAt = (y: number) => {
        const u = Math.max(0, Math.min(1, (y - stripeMinY) / Math.max(1e-4, stripeMaxY - stripeMinY)));
        return stripeZBot + (stripeZTop - stripeZBot) * u;
      };

      // Dark wheel wells on +Z side over both axles (DARK_UNDER r < 0.0115, excluding tire sidewall)
      for (const ax of spec.axles) {
        const wellTris = bodyTris.filter(
          (t) => t.nz > 0.9 && t.roughness > 0.85 && t.r < 0.0115 && t.cz > spec.width * 0.45 && Math.abs(t.cx - ax) < 0.65 && t.maxY > 0.8,
        );
        expect(wellTris.length, `${id} axle ${ax} wheel well`).toBeGreaterThan(0);
        const overlappingWells = wellTris.filter((t) => t.cy >= stripeMinY && t.cy <= stripeMaxY);
        expect(overlappingWells.length, `${id} axle ${ax} wheel well overlapping stripe`).toBeGreaterThan(0);
        for (const wt of overlappingWells) {
          expect(wt.cz, `${id} axle ${ax} wheel well proud of stripe at y=${wt.cy.toFixed(2)}`).toBeGreaterThan(stripeZAt(wt.cy) + 0.005);
        }
      }
    }

    // Tourbus upper deck intermediate vertical chrome handrail stanchions: closed outer + inner faces in high & med, budget <= 620
    for (const detail of ['high', 'med'] as const) {
      const tourBuilt = buildVehicle('tourbus', detail);
      expect(tourBuilt.meta.triangles, `tourbus (${detail}) budget <= 620`).toBeLessThanOrEqual(620);
      const tourTris = extractTriangles(tourBuilt.body);
      const isStanchion = (t: TriSample) =>
        t.metalness > 0.4 && Math.abs(t.cz) > 1.1 && t.minY > 3.20 && t.maxY < 3.45
        && (t.maxX - t.minX) < 0.12 && (t.maxY - t.minY) > 0.12;
      const posOuterXs = new Set(
        tourTris.filter((t) => isStanchion(t) && t.cz > 0 && t.nz > 0.9).map((t) => Math.round(t.cx * 10) / 10),
      );
      const posInnerXs = new Set(
        tourTris.filter((t) => isStanchion(t) && t.cz > 0 && t.nz < -0.9).map((t) => Math.round(t.cx * 10) / 10),
      );
      const negOuterXs = new Set(
        tourTris.filter((t) => isStanchion(t) && t.cz < 0 && t.nz < -0.9).map((t) => Math.round(t.cx * 10) / 10),
      );
      const negInnerXs = new Set(
        tourTris.filter((t) => isStanchion(t) && t.cz < 0 && t.nz > 0.9).map((t) => Math.round(t.cx * 10) / 10),
      );
      expect(posOuterXs.size, `tourbus (${detail}) +Z outer stanchion faces`).toBeGreaterThanOrEqual(3);
      expect(posInnerXs.size, `tourbus (${detail}) +Z inner stanchion faces`).toBeGreaterThanOrEqual(3);
      expect(negOuterXs.size, `tourbus (${detail}) -Z outer stanchion faces`).toBeGreaterThanOrEqual(3);
      expect(negInnerXs.size, `tourbus (${detail}) -Z inner stanchion faces`).toBeGreaterThanOrEqual(3);
    }
  });

  it('emergency/warning vehicles expose dedicated emergencyGlow separated from regular night headlights', () => {
    const emergencyIds: VehicleId[] = ['police', 'ambulance', 'fire', 'tow', 'garbage', 'construction'];
    const emergencySet = new Set<VehicleId>(emergencyIds);

    for (const preset of VEHICLE_PRESETS) {
      const built = buildVehicle(preset.id, 'high');
      if (emergencySet.has(preset.id)) {
        expect(built.emergencyGlow, `${preset.id} emergencyGlow`).toBeDefined();
        expect(built.meta.emergencyGlowTriangles, `${preset.id} emergencyGlowTriangles`).toBeGreaterThan(0);
        expect(built.glow, `${preset.id} regular glow`).toBeDefined();
        expect(built.meta.glowTriangles, `${preset.id} regular glowTriangles`).toBeGreaterThan(0);
      } else {
        expect(built.emergencyGlow, `${preset.id} should not have emergencyGlow`).toBeUndefined();
        expect(built.meta.emergencyGlowTriangles ?? 0, `${preset.id} emergencyGlowTriangles === 0`).toBe(0);
      }
    }

    // For core emergency units (police, ambulance, fire), roof lightbars must live in emergencyGlow, not regular glow
    for (const id of ['police', 'ambulance', 'fire'] as const) {
      const spec = VEHICLE_PRESET_MAP[id].spec as VehicleSpec;
      const built = buildVehicle(id, 'high');
      const regGlowBox = built.glow!.boundingBox!;
      const emergBox = built.emergencyGlow!.boundingBox!;
      expect(emergBox.max.y, `${id} emergencyGlow reaches roof lightbar`).toBeGreaterThan(spec.roofY - 0.35);
      if (id !== 'fire') {
        expect(regGlowBox.max.y, `${id} regular glow stays below roof lightbar`).toBeLessThan(spec.roofY - 0.35);
      }
    }
  });

  it('hazard blinkers hug every vehicle mesh (<= 1 cm) and remain visible from outside views', () => {
    const rc = new THREE.Raycaster();
    const tri = new THREE.Triangle();
    const pA = new THREE.Vector3(), pB = new THREE.Vector3(), pC = new THREE.Vector3();
    const q = new THREE.Vector3(), c = new THREE.Vector3();

    for (const preset of VEHICLE_PRESETS) {
      const built = buildVehicle(preset.id, 'high');
      const anchors = computeVehicleBlinkerAnchors(built.body, built.glow);
      expect(anchors.length).toBe(12);
      const pos = built.body.getAttribute('position');
      const idx = built.body.index;
      const nTri = idx ? idx.count / 3 : pos.count / 3;
      const bodyMesh = new THREE.Mesh(built.body, new THREE.MeshBasicMaterial());
      bodyMesh.updateMatrixWorld(true);

      for (let k = 0; k < 4; k++) {
        const ax = anchors[k * 3], ay = anchors[k * 3 + 1], az = anchors[k * 3 + 2];
        const box = new THREE.Box3(
          new THREE.Vector3(ax - 0.10, ay - 0.07, az - 0.10),
          new THREE.Vector3(ax + 0.10, ay + 0.07, az + 0.10),
        );
        let minD = Infinity;
        for (let t = 0; t < nTri; t++) {
          const i0 = idx ? idx.getX(t * 3) : t * 3;
          const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
          const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
          pA.fromBufferAttribute(pos, i0); pB.fromBufferAttribute(pos, i1); pC.fromBufferAttribute(pos, i2);
          tri.set(pA, pB, pC);
          if (box.intersectsTriangle(tri)) { minD = 0; break; }
          tri.closestPointToPoint(c.set(ax, ay, az), q);
          const d = Math.hypot(
            Math.max(0, Math.abs(q.x - ax) - 0.10),
            Math.max(0, Math.abs(q.y - ay) - 0.07),
            Math.max(0, Math.abs(q.z - az) - 0.10),
          );
          if (d < minD) minD = d;
        }
        expect(minD, `${preset.id} blinker[${k}] contact distance`).toBeLessThanOrEqual(0.01);

        const sx = ax >= 0 ? 1 : -1;
        const sz = az >= 0 ? 1 : -1;
        const outerPt = new THREE.Vector3(ax + sx * 0.095, ay, az + sz * 0.095);
        let vis = 0;
        for (const dir of [
          new THREE.Vector3(sx, 0, 0),
          new THREE.Vector3(0, 0, sz),
          new THREE.Vector3(sx, 0.4, sz).normalize(),
        ]) {
          const orig = outerPt.clone().addScaledVector(dir, 10);
          rc.set(orig, dir.clone().negate());
          const hits = rc.intersectObject(bodyMesh, false);
          if (hits.length === 0 || hits[0].distance >= orig.distanceTo(outerPt) - 0.01) vis++;
        }
        expect(vis, `${preset.id} blinker[${k}] external visibility`).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
