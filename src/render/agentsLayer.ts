import * as THREE from 'three';
import type { App } from '../app';
import {
  MAX_PEDS,
  MAX_TRAIN_CARS,
  MAX_VEHICLES,
  PED_FLAG_FUNERAL,
  PED_FLAG_LUGGAGE,
  PED_FLAG_TOURIST,
  PED_FLAG_UMBRELLA,
  PED_FLAG_WAITING,
  PED_FLAG_WORKER,
  PED_STRIDE,
  TRAIN_STRIDE,
  VEH_FLAG_BRAKE,
  VEH_FLAG_HAZARD,
  VEH_FLAG_SIREN,
  VEH_FLAG_YIELD,
  VEH_STRIDE,
  VType,
  VTYPE_LEN,
} from '../shared/constants';
/** render budgets (instances drawn per frame); the simulation itself has no such cap */
const RENDER_PED = 6000;
import { createAssetMaterial, createGlowMaterial, type AssetDetail } from './meshKit';
import { buildVehicle, VEHICLE_PRESETS, type VehicleId } from './vehicleGeom';
import {
  RAIL_CONTAINER_PALETTE,
  RAIL_HOPPER_PALETTE,
  RAIL_LOCO_PALETTE,
  RAIL_METRO_PALETTE,
  RAIL_PASSENGER_PALETTE,
  RAIL_PRESETS,
  RAIL_TANK_PALETTE,
  buildRailCar,
} from './railGeom';
import { pickVehiclePreset } from '../shared/vehiclePresets';
import {
  BIKE_COLORS,
  CIVILIAN_PED_IDS,
  LUGGAGE_COLORS,
  PED_HAIR_PALETTE,
  PED_PRESETS,
  PED_SKIN_PALETTE,
  PED_TOP_PALETTE,
  PED_BOTTOM_PALETTE,
  UMBRELLA_COLORS,
  UMBRELLA_HAND_GRIP,
  buildBike,
  buildLuggage,
  buildPedestrian,
  buildUmbrella,
  type PedId,
} from './pedGeom';
import {
  PED_UNIFORMS,
  attachPedInstanceBuffers,
  createPedDepthMaterial,
  createPedMaterial,
  type PedInstanceBuffers,
} from './pedMaterial';
import { U } from './uniforms';

const PED_FLAG_BIKE = 256;

const PRESET_INDEX: Record<VehicleId, number> = Object.fromEntries(
  VEHICLE_PRESETS.map((p, idx) => [p.id, idx]),
) as Record<VehicleId, number>;

const PED_INDEX: Record<PedId, number> = Object.fromEntries(
  PED_PRESETS.map((p, idx) => [p.id, idx]),
) as Record<PedId, number>;

const CIVILIAN_SLOTS = CIVILIAN_PED_IDS.map((id) => PED_INDEX[id]);
const WORKER_SLOT = PED_INDEX.worker;
const FUNERAL_SLOT = PED_INDEX.funeral;
const TOURIST_SLOT = PED_INDEX.tourist;
const CYCLIST_SLOT = PED_INDEX.cyclist;

const LOD_LEVELS: AssetDetail[] = ['high', 'med', 'low'];
/** Real-time distance thresholds (meters) for 3-tier pedestrian/bike/accessory LOD. */
const LOD_HIGH_DIST_SQ = 42 * 42;
const LOD_MED_DIST_SQ = 115 * 115;
/** Real-time distance thresholds (meters) for 3-tier rolling-stock LOD. */
const RAIL_LOD_HIGH_DIST_SQ = 90 * 90;
const RAIL_LOD_MED_DIST_SQ = 220 * 220;

const CAR_COLORS = [0xf2f2f2, 0x262a30, 0x8f969c, 0xb5b9bd, 0xb83832, 0x2b558c, 0x2f6b4a, 0xd4c08a, 0x6d2b45, 0x3c6fb0, 0xd99b2a, 0x4a525c];
const OLD_COLORS = [0x5ca09b, 0xd9cba0, 0x9c3d41, 0x3f6b54, 0x6b849c, 0xc8a45a, 0x9e5a38, 0xe6decb];
const TRUCK_COLORS = [0x325d8f, 0xb83b32, 0x366e50, 0xc88228, 0x56606b, 0xdce2e8];
const VAN_COLORS = [0xeaeef3, 0xeaeef3, 0xeaeef3, 0x3c6ca8, 0xd97d2b, 0x4d825b];
const MOTO_COLORS = [0xd1302a, 0x2665a8, 0x2c3038, 0xe8a822, 0x2f8a5b];
const TYPE_COLOR: Partial<Record<VType, number>> = {
  [VType.Taxi]: 0xefb824,
  [VType.Bus]: 0x2f7fd0,
  [VType.SchoolBus]: 0xefa91a,
  [VType.Garbage]: 0x2f7d47,
  [VType.Ambulance]: 0xf2f5f8,
  [VType.Police]: 0x1f2d42,
  [VType.Fire]: 0xc92622,
  [VType.TourBus]: 0xb82e38,
  [VType.Construction]: 0xe09624,
  [VType.Hearse]: 0x242830,
  [VType.Tow]: 0xe8a317,
};

interface PedInstancedBucket {
  mesh: THREE.InstancedMesh;
  buf: PedInstanceBuffers;
  cap: number;
  count: number;
}

/**
 * Derive 4 flush outer-corner blinker anchors [fx,fy,+fz, fx,fy,-fz, rx,ry,+rz, rx,ry,-rz]
 * directly from a vehicle's real body & glow geometry so hazard blinkers always hug the mesh
 * and remain clearly visible on every variant (zero floating, zero occlusion, zero runtime alloc).
 */
export function computeVehicleBlinkerAnchors(
  body: THREE.BufferGeometry,
  glow?: THREE.BufferGeometry | null,
): Float32Array {
  const out = new Float32Array(12);
  body.computeBoundingBox();
  const bb = body.boundingBox!;
  const bPos = body.getAttribute('position');
  const gPos = glow?.getAttribute('position') ?? null;

  for (let endIdx = 0; endIdx < 2; endIdx++) {
    const signX = endIdx === 0 ? 1 : -1;
    let lampX = signX > 0 ? bb.max.x : bb.min.x;
    let lampY = Math.min(1.15, Math.max(0.55, bb.min.y + (bb.max.y - bb.min.y) * 0.38));
    let lampZ = Math.max(0.18, bb.max.z * 0.78);
    if (gPos && gPos.count > 0) {
      let bestX = -Infinity;
      for (let i = 0; i < gPos.count; i++) {
        const gx = gPos.getX(i), gy = gPos.getY(i);
        if (gx * signX <= 0 || gy > 1.65) continue;
        if (gx * signX > bestX) bestX = gx * signX;
      }
      if (bestX > 0) {
        let sumY = 0, cnt = 0, maxZ = 0;
        for (let i = 0; i < gPos.count; i++) {
          const gx = gPos.getX(i), gy = gPos.getY(i), gz = Math.abs(gPos.getZ(i));
          if (gx * signX < bestX - 0.14 || gy > 1.65) continue;
          sumY += gy; cnt++;
          if (gz > maxZ) maxZ = gz;
        }
        if (cnt > 0) {
          lampX = bestX * signX;
          lampY = sumY / cnt;
          lampZ = Math.max(0.16, maxZ);
        }
      }
    }
    let bodyX = -Infinity;
    let bodyZ = 0;
    const zMin = Math.max(0.08, lampZ * 0.55);
    for (let i = 0; i < bPos.count; i++) {
      const bx = bPos.getX(i), by = bPos.getY(i), bz = Math.abs(bPos.getZ(i));
      if (bx * signX <= 0 || Math.abs(by - lampY) > 0.22 || bz < zMin) continue;
      if (bx * signX > bodyX) bodyX = bx * signX;
    }
    if (bodyX > 0) {
      for (let i = 0; i < bPos.count; i++) {
        const bx = bPos.getX(i), by = bPos.getY(i), bz = Math.abs(bPos.getZ(i));
        if (bx * signX < bodyX - 0.22 || Math.abs(by - lampY) > 0.22) continue;
        if (bz > bodyZ) bodyZ = bz;
      }
    }
    const clampedX = bodyX > 0 ? Math.min(bodyX, Math.abs(lampX) + 0.05) : Math.abs(lampX);
    const clampedZ = bodyZ > 0 ? Math.min(bodyZ, lampZ + 0.06) : lampZ;
    const anchorX = clampedX * signX + signX * 0.015;
    const anchorZ = Math.max(0.12, clampedZ - 0.05);
    const anchorY = Math.max(0.42, Math.min(1.45, lampY));
    const base = endIdx * 6;
    out[base] = anchorX; out[base + 1] = anchorY; out[base + 2] = anchorZ;
    out[base + 3] = anchorX; out[base + 4] = anchorY; out[base + 5] = -anchorZ;
  }
  return out;
}

export class AgentsLayer {
  group = new THREE.Group();
  private veh: THREE.InstancedMesh[] = [];
  private vehGlow: (THREE.InstancedMesh | null)[] = [];
  private vehEmerg: (THREE.InstancedMesh | null)[] = [];
  private vehBlinkers: Float32Array[] = [];
  private vehGlowMat!: THREE.MeshBasicMaterial;
  private vehEmergMat!: THREE.MeshBasicMaterial;
  private blinkers: THREE.InstancedMesh;

  // 3-tier LOD buckets for pedestrians (archetype × 3 LODs) and accessories (bike, umbrella, luggage × 3 LODs)
  private pedMat: THREE.MeshStandardMaterial;
  private pedDepthMat: THREE.MeshDepthMaterial;
  private pedBuckets: PedInstancedBucket[][] = []; // [archetypeSlot][lod 0..2]
  private bikeBuckets: PedInstancedBucket[] = [];
  private bikeGlows: THREE.InstancedMesh[] = [];
  private bikeGlowCounts = new Int32Array(3);
  private umbrellaBuckets: PedInstancedBucket[] = [];
  private luggageBuckets: PedInstancedBucket[] = [];
  private umbLocalM = new THREE.Matrix4();
  private umbWorldM = new THREE.Matrix4();
  private lugLocalM = new THREE.Matrix4();

  private trains: THREE.InstancedMesh[][] = []; // [carType 0..5][lod 0..2]
  private trainGlow: (THREE.InstancedMesh | null)[][] = [];
  private trainGlowMat!: THREE.MeshBasicMaterial;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private sc = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  private col = new THREE.Color();
  private skinCol = new THREE.Color();
  private hairCol = new THREE.Color();
  private bottomCol = new THREE.Color();
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private cullSphere = new THREE.Sphere(new THREE.Vector3(), 10);
  private vCounts = new Int32Array(VEHICLE_PRESETS.length);
  private vGlowCounts = new Int32Array(VEHICLE_PRESETS.length);
  private vEmergCounts = new Int32Array(VEHICLE_PRESETS.length);
  private tCounts = new Int32Array(RAIL_PRESETS.length * 3);
  private tGlowCounts = new Int32Array(RAIL_PRESETS.length * 3);
  private vPos = new Float32Array(MAX_VEHICLES * 4); // interpolated x,y,z,h (grows with the sim pools)
  private pPos = new Float32Array(MAX_PEDS * 4);
  private tPos = new Float32Array(MAX_TRAIN_CARS * 4);
  private t = 0;
  private pedAnimT = 0;
  lineColors = new Map<number, THREE.Color>();
  metroLineColor: THREE.Color | null = null;

  constructor(private app: App) {
    const vehMat = createAssetMaterial();
    this.vehGlowMat = createGlowMaterial();
    this.vehEmergMat = createGlowMaterial();
    for (const preset of VEHICLE_PRESETS) {
      const built = buildVehicle(preset.id, 'high');
      const cap = preset.vtype === VType.Car ? 2500 : 900;
      const im = new THREE.InstancedMesh(built.body, vehMat, cap);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      im.count = 0; im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false;
      this.veh.push(im);
      this.vehBlinkers.push(computeVehicleBlinkerAnchors(built.body, built.glow));
      this.group.add(im);
      if (built.glow) {
        const gm = new THREE.InstancedMesh(built.glow, this.vehGlowMat, cap);
        gm.count = 0; gm.frustumCulled = false;
        this.vehGlow.push(gm);
        this.group.add(gm);
      } else {
        this.vehGlow.push(null);
      }
      if (built.emergencyGlow) {
        const em = new THREE.InstancedMesh(built.emergencyGlow, this.vehEmergMat, cap);
        em.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        em.count = 0; em.frustumCulled = false;
        this.vehEmerg.push(em);
        this.group.add(em);
      } else {
        this.vehEmerg.push(null);
      }
    }
    // Discrete 4-corner amber hazard flashers for disabled/crashed civilian vehicles without a roof emergency lightbar
    this.blinkers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.20, 0.14, 0.20), new THREE.MeshBasicMaterial({ toneMapped: false }), 600);
    this.blinkers.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(600 * 3), 3);
    this.blinkers.count = 0; this.blinkers.frustumCulled = false;

    // ---- Parametric Pedestrians, Cyclists & Accessories with 3-tier Real-Time LOD ----
    this.pedMat = createPedMaterial();
    this.pedDepthMat = createPedDepthMaterial();

    const makeBucket = (geo: THREE.BufferGeometry, cap: number, castShadow: boolean, receiveShadow: boolean): PedInstancedBucket => {
      const mesh = new THREE.InstancedMesh(geo, this.pedMat, cap);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      if (castShadow) mesh.customDepthMaterial = this.pedDepthMat;
      const buf = attachPedInstanceBuffers(mesh, cap);
      this.group.add(mesh);
      return { mesh, buf, cap, count: 0 };
    };

    for (const preset of PED_PRESETS) {
      const isSpecial = preset.id === 'worker' || preset.id === 'funeral' || preset.id === 'tourist' || preset.id === 'cyclist';
      const caps = isSpecial ? [320, 600, 1200] : [350, 750, 1600];
      const lods: PedInstancedBucket[] = [];
      for (let l = 0; l < 3; l++) {
        const built = buildPedestrian(preset.id, LOD_LEVELS[l]);
        lods.push(makeBucket(built.body, caps[l], l < 2, l === 0));
      }
      this.pedBuckets.push(lods);
    }

    // Bicycles (+ paired night headlight/taillight glow)
    const bikeCaps = [250, 500, 1200];
    for (let l = 0; l < 3; l++) {
      const built = buildBike(LOD_LEVELS[l]);
      this.bikeBuckets.push(makeBucket(built.body, bikeCaps[l], l < 2, l === 0));
      const gm = new THREE.InstancedMesh(built.glow!, this.vehGlowMat, bikeCaps[l]);
      gm.count = 0; gm.frustumCulled = false;
      this.bikeGlows.push(gm);
      this.group.add(gm);
    }

    // Umbrellas (anchored to raised right hand) & Rolling Luggage (resting on ground beside tourist)
    const umbCaps = [300, 600, 1500];
    const lugCaps = [250, 500, 1000];
    for (let l = 0; l < 3; l++) {
      const uBuilt = buildUmbrella(LOD_LEVELS[l]);
      this.umbrellaBuckets.push(makeBucket(uBuilt.body, umbCaps[l], l === 0, false));
      const lBuilt = buildLuggage(LOD_LEVELS[l]);
      this.luggageBuckets.push(makeBucket(lBuilt.body, lugCaps[l], l < 2, l === 0));
    }

    // Precompute local umbrella hand-grip matrix (places gripY inside right hand & tilts canopy over head)
    const uDir = new THREE.Vector3(...UMBRELLA_HAND_GRIP.dir).normalize();
    const uQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), uDir);
    const uPos = new THREE.Vector3(...UMBRELLA_HAND_GRIP.offset).addScaledVector(uDir, -UMBRELLA_HAND_GRIP.gripY);
    this.umbLocalM.compose(uPos, uQ, new THREE.Vector3(1, 1, 1));
    // Precompute local rolling luggage offset (beside tourist's left side, wheels at Y = 0.00)
    this.lugLocalM.makeTranslation(-0.14, 0, -0.36);

    this.group.add(this.blinkers);

    // ---- Parametric Railway Rolling Stock & Metro with 3-tier Real-Time LOD ----
    // Indices 0..5 match src/sim/rail.ts: 0 loco, 1 passenger, 2 container, 3 hopper, 4 tank, 5 metro
    const railMat = createAssetMaterial();
    this.trainGlowMat = createGlowMaterial();
    const railCaps = [120, 200, 300];
    for (const preset of RAIL_PRESETS) {
      const lodMeshes: THREE.InstancedMesh[] = [];
      const lodGlows: (THREE.InstancedMesh | null)[] = [];
      for (let l = 0; l < 3; l++) {
        const built = buildRailCar(preset.id, LOD_LEVELS[l]);
        const cap = railCaps[l];
        const im = new THREE.InstancedMesh(built.body, railMat, cap);
        im.count = 0;
        im.castShadow = l < 2;
        im.receiveShadow = l < 2;
        im.frustumCulled = false;
        lodMeshes.push(im);
        this.group.add(im);
        if (built.glow) {
          const gm = new THREE.InstancedMesh(built.glow, this.trainGlowMat, cap);
          gm.count = 0;
          gm.frustumCulled = false;
          lodGlows.push(gm);
          this.group.add(gm);
        } else {
          lodGlows.push(null);
        }
      }
      this.trains.push(lodMeshes);
      this.trainGlow.push(lodGlows);
    }
  }

  /** stage 1 (before camera update): interpolate agent world positions so Director & Follow read current poses */
  interpolate(alpha: number) {
    const cur = this.app.curSnap, prev = this.app.prevSnap;
    if (!cur) return;
    const a = Math.min(1, Math.max(0, alpha));
    // ---- vehicles ----
    const cv = cur.veh, pv = prev?.veh;
    const NV = cv.length / VEH_STRIDE;
    if (this.vPos.length < NV * 4) this.vPos = new Float32Array(NV * 8);
    for (let i = 0; i < NV; i++) {
      const o = i * VEH_STRIDE;
      const type = cv[o + 4];
      if (!type) continue;
      let x = cv[o], y = cv[o + 1], z = cv[o + 2], h = cv[o + 3];
      if (pv && pv[o + 4] === type && pv[o + 5] === cv[o + 5]) {
        const d = Math.hypot(cv[o] - pv[o], cv[o + 2] - pv[o + 2]);
        if (d < 60) {
          x = pv[o] + (cv[o] - pv[o]) * a; y = pv[o + 1] + (cv[o + 1] - pv[o + 1]) * a; z = pv[o + 2] + (cv[o + 2] - pv[o + 2]) * a;
          let dh = cv[o + 3] - pv[o + 3];
          while (dh > Math.PI) dh -= Math.PI * 2;
          while (dh < -Math.PI) dh += Math.PI * 2;
          h = pv[o + 3] + dh * a;
        }
      }
      this.vPos[i * 4] = x; this.vPos[i * 4 + 1] = y; this.vPos[i * 4 + 2] = z; this.vPos[i * 4 + 3] = h;
    }
    // ---- pedestrians ----
    const cp = cur.ped, pp = prev?.ped;
    const NP = cp.length / PED_STRIDE;
    if (this.pPos.length < NP * 4) this.pPos = new Float32Array(NP * 8);
    for (let i = 0; i < NP; i++) {
      const o = i * PED_STRIDE;
      if (cp[o + 4] < 0) continue;
      let x = cp[o], y = cp[o + 1], z = cp[o + 2], h = cp[o + 3];
      if (pp && pp[o + 4] === cp[o + 4]) {
        const d = Math.hypot(cp[o] - pp[o], cp[o + 2] - pp[o + 2]);
        if (d < 30) {
          x = pp[o] + (cp[o] - pp[o]) * a; y = pp[o + 1] + (cp[o + 1] - pp[o + 1]) * a; z = pp[o + 2] + (cp[o + 2] - pp[o + 2]) * a;
          let dh = cp[o + 3] - pp[o + 3];
          while (dh > Math.PI) dh -= Math.PI * 2;
          while (dh < -Math.PI) dh += Math.PI * 2;
          h = pp[o + 3] + dh * a;
        }
      }
      this.pPos[i * 4] = x; this.pPos[i * 4 + 1] = y; this.pPos[i * 4 + 2] = z; this.pPos[i * 4 + 3] = h;
    }
    // ---- trains ----
    const tc = cur.train, tp = prev?.train;
    for (let i = 0; i < cur.trainCount; i++) {
      const o = i * TRAIN_STRIDE;
      let x = tc[o], y = tc[o + 1], z = tc[o + 2], h = tc[o + 3];
      const type = tc[o + 4];
      if (tp && prev && i < prev.trainCount && tp[o + 4] === type && tp[o + 5] === tc[o + 5]) {
        const d = Math.hypot(tc[o] - tp[o], tc[o + 2] - tp[o + 2]);
        if (d < 80) {
          x = tp[o] + (tc[o] - tp[o]) * a; y = tp[o + 1] + (tc[o + 1] - tp[o + 1]) * a; z = tp[o + 2] + (tc[o + 2] - tp[o + 2]) * a;
          let dh = tc[o + 3] - tp[o + 3];
          while (dh > Math.PI) dh -= Math.PI * 2;
          while (dh < -Math.PI) dh += Math.PI * 2;
          h = tp[o + 3] + dh * a;
        }
      }
      this.tPos[i * 4] = x; this.tPos[i * 4 + 1] = y; this.tPos[i * 4 + 2] = z; this.tPos[i * 4 + 3] = h;
    }
  }

  /** stage 2 (after camera & environment update): cull against the exact rendered camera + projected sun shadows, and upload GPU instances */
  syncMeshes(dt: number) {
    this.t += dt;
    if (this.app.speed > 0) this.pedAnimT += dt;
    PED_UNIFORMS.uPedTime.value = this.pedAnimT;

    const cur = this.app.curSnap;
    if (!cur) return;
    const night = U.uNight.value;
    const cam = this.app.rig.camera;
    cam.updateMatrixWorld();
    this.projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const camP = cam.position;
    const farVeh = Math.max(1400, camP.y * 6);
    const sphere = this.cullSphere;
    // extend culling spheres along the sun-shadow projection during daytime so shadows cast from just outside the frustum never pop
    const sunDir = U.uSunDir.value;
    const castSun = night < 0.95 && sunDir.y > 0.02;
    const sLenV = castSun ? Math.min(35, 3.5 / Math.max(0.1, sunDir.y)) : 0;
    const sOffVX = -sunDir.x * sLenV * 0.5, sOffVZ = -sunDir.z * sLenV * 0.5, rVeh = 12 + sLenV * 0.5;
    const sLenP = castSun ? Math.min(20, 1.9 / Math.max(0.1, sunDir.y)) : 0;
    const sOffPX = -sunDir.x * sLenP * 0.5, sOffPZ = -sunDir.z * sLenP * 0.5, rPed = 4 + sLenP * 0.5;

    // ---- vehicles ----
    const counts = this.vCounts;
    const gCounts = this.vGlowCounts;
    const eCounts = this.vEmergCounts;
    counts.fill(0);
    gCounts.fill(0);
    eCounts.fill(0);
    let nbl = 0;
    const cv = cur.veh;
    const old = (this.app.stats?.era ?? 0) === 0;
    const NV = cv.length / VEH_STRIDE;
    for (let i = 0; i < NV; i++) {
      const o = i * VEH_STRIDE;
      const type = cv[o + 4] as VType;
      if (!type || type === VType.Bike) continue;
      const x = this.vPos[i * 4], y = this.vPos[i * 4 + 1], z = this.vPos[i * 4 + 2], h = this.vPos[i * 4 + 3];
      if (Math.abs(x - camP.x) > farVeh || Math.abs(z - camP.z) > farVeh) continue;
      sphere.center.set(x + sOffVX, y + 1.5, z + sOffVZ);
      sphere.radius = rVeh;
      if (!this.frustum.intersectsSphere(sphere)) continue;
      const gen = cv[o + 5];
      const lineOrVar = cv[o + 7];
      const carVar = type === VType.Car && lineOrVar >= 0 ? lineOrVar : -1;
      const hash = ((i * 7 + gen * 13) >>> 0);
      const presetId = pickVehiclePreset(type, i, gen, old ? 0 : 1, carVar);
      if (!presetId) continue;
      const slot = PRESET_INDEX[presetId];
      const im = this.veh[slot];
      if (!im || counts[slot] >= im.instanceMatrix.count) continue;
      this.q.setFromAxisAngle(this.up, -h);
      const flags = cv[o + 6];
      this.v.set(x, y, z);
      this.m.compose(this.v, this.q, this.sc);
      im.setMatrixAt(counts[slot], this.m);
      const line = lineOrVar;
      if (type === VType.Bus && line >= 0 && this.lineColors.has(line)) this.col.copy(this.lineColors.get(line)!);
      else if (TYPE_COLOR[type] !== undefined) this.col.setHex(TYPE_COLOR[type]!);
      else if (type === VType.Truck) this.col.setHex(TRUCK_COLORS[hash % TRUCK_COLORS.length]);
      else if (type === VType.Van) this.col.setHex(VAN_COLORS[hash % VAN_COLORS.length]);
      else if (type === VType.Moto) this.col.setHex(MOTO_COLORS[hash % MOTO_COLORS.length]);
      else {
        const useOld = carVar === 0 || (carVar < 0 && old);
        const pal = useOld ? OLD_COLORS : CAR_COLORS;
        const cIdx = carVar >= 0 ? (i * 7 + carVar * 5) : (i * 7 + gen * 3);
        this.col.setHex(pal[cIdx % pal.length]);
      }
      im.setColorAt(counts[slot], this.col);
      counts[slot]++;
      const gm = this.vehGlow[slot];
      if (gm && night > 0.05 && gCounts[slot] < gm.instanceMatrix.count) {
        gm.setMatrixAt(gCounts[slot]++, this.m);
      }
      const em = this.vehEmerg[slot];
      if (em && eCounts[slot] < em.instanceMatrix.count) {
        const eIdx = eCounts[slot]++;
        em.setMatrixAt(eIdx, this.m);
        const emergencyOn = (flags & VEH_FLAG_SIREN) !== 0
          || (type === VType.Tow && (flags & VEH_FLAG_HAZARD) !== 0);
        if (emergencyOn) {
          // Vivid HDR emissive strobe day & night whenever siren/emergency is active (single source of truth; no legacy box)
          const pulse = 2.0 + 1.15 * Math.sin(this.t * 14 + i * 1.3);
          this.col.setScalar(pulse);
        } else if (type === VType.Garbage || type === VType.Construction) {
          // Service warning beacons remain visibly lit during daytime work and brighter at night
          const pulse = (0.95 + 0.65 * night) + 0.55 * Math.max(0, Math.sin(this.t * 6 + i * 1.7));
          this.col.setScalar(pulse);
        } else {
          // Unlit colored lenses remain physically visible on roof when siren is off (no pulse)
          this.col.setScalar(0.52 + 0.28 * night);
        }
        em.setColorAt(eIdx, this.col);
      }
      const canHaveBumperHazard = !em || type === VType.Garbage || type === VType.Construction;
      if (canHaveBumperHazard && (flags & VEH_FLAG_HAZARD) !== 0 && nbl + 4 <= 600) {
        // Discrete 4-corner amber hazard blinkers anchored to each variant's exact body/lamp geometry
        const anchors = this.vehBlinkers[slot];
        const ch = Math.cos(h), sh = Math.sin(h);
        const on = Math.sin(this.t * 10 + i * 1.7) > -0.1;
        this.col.setRGB(on ? 3.0 : 0.22, on ? 1.55 : 0.10, on ? 0.05 : 0.01);
        for (let k = 0; k < 4; k++) {
          const ax = anchors[k * 3], ay = anchors[k * 3 + 1], az = anchors[k * 3 + 2];
          this.v.set(x + ch * ax - sh * az, y + ay, z + sh * ax + ch * az);
          this.m.compose(this.v, this.q, this.sc);
          this.blinkers.setMatrixAt(nbl, this.m);
          this.blinkers.setColorAt(nbl, this.col);
          nbl++;
        }
      }
      void VEH_FLAG_BRAKE; void VEH_FLAG_YIELD;
    }
    this.vehGlowMat.color.setScalar(0.4 + 2.2 * night);
    for (let s = 0; s < this.veh.length; s++) {
      const im = this.veh[s];
      const prevC = im.count;
      im.count = counts[s];
      if (counts[s] > 0 || prevC > 0) {
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
      const gm = this.vehGlow[s];
      if (gm) {
        const prevG = gm.count;
        gm.count = gCounts[s];
        if (gCounts[s] > 0 || prevG > 0) gm.instanceMatrix.needsUpdate = true;
      }
      const em = this.vehEmerg[s];
      if (em) {
        const prevE = em.count;
        em.count = eCounts[s];
        if (eCounts[s] > 0 || prevE > 0) {
          em.instanceMatrix.needsUpdate = true;
          if (em.instanceColor) em.instanceColor.needsUpdate = true;
        }
      }
    }
    const prevNbl = this.blinkers.count;
    this.blinkers.count = nbl;
    if (nbl > 0 || prevNbl > 0) {
      this.blinkers.instanceMatrix.needsUpdate = true;
      if (this.blinkers.instanceColor) this.blinkers.instanceColor.needsUpdate = true;
    }

    // ---- pedestrians, cyclists & accessories (3-tier real-time distance LOD) ----
    for (let a = 0; a < this.pedBuckets.length; a++) {
      const row = this.pedBuckets[a];
      row[0].count = 0; row[1].count = 0; row[2].count = 0;
    }
    for (let l = 0; l < 3; l++) {
      this.bikeBuckets[l].count = 0;
      this.bikeGlowCounts[l] = 0;
      this.umbrellaBuckets[l].count = 0;
      this.luggageBuckets[l].count = 0;
    }

    const cp = cur.ped;
    let totalDrawnPeds = 0;
    const farCull = Math.max(450, camP.y * 4);
    const followedCid = this.app.followedCitizen;
    const followedPedSlot = this.app.follow?.kind === 'ped' ? this.app.follow.id : -1;
    const NP = cp.length / PED_STRIDE;

    for (let i = 0; i < NP; i++) {
      const o = i * PED_STRIDE;
      if (cp[o + 4] < 0) continue;
      if (totalDrawnPeds >= RENDER_PED) break;
      const x = this.pPos[i * 4], y = this.pPos[i * 4 + 1], z = this.pPos[i * 4 + 2], h = this.pPos[i * 4 + 3];
      const dxC = x - camP.x, dzC = z - camP.z;
      if (Math.abs(dxC) > farCull || Math.abs(dzC) > farCull) continue;
      sphere.center.set(x + sOffPX, y + 1, z + sOffPZ);
      sphere.radius = rPed;
      if (!this.frustum.intersectsSphere(sphere)) continue;

      const flags = cp[o + 5];
      const cid = cp[o + 6];
      const seed = (cid >= 0 ? cid : i + 7777) >>> 0;
      const isBike = (flags & PED_FLAG_BIKE) !== 0;
      const isWorker = (flags & PED_FLAG_WORKER) !== 0;
      const isFuneral = (flags & PED_FLAG_FUNERAL) !== 0;
      const isTourist = (flags & PED_FLAG_TOURIST) !== 0;
      const isWaiting = (flags & PED_FLAG_WAITING) !== 0;
      const hasUmbrella = !isBike && (flags & PED_FLAG_UMBRELLA) !== 0;
      const hasLuggage = !isBike && (flags & PED_FLAG_LUGGAGE) !== 0;

      // Distance-based LOD selection (force `high` for followed citizen when reasonably close)
      const dyC = y - camP.y;
      const distSq = dxC * dxC + dyC * dyC + dzC * dzC;
      const isFollowed = (cid >= 0 && cid === followedCid) || i === followedPedSlot;
      let lod = distSq < LOD_HIGH_DIST_SQ ? 0 : distSq < LOD_MED_DIST_SQ ? 1 : 2;
      if (isFollowed && distSq < 120 * 120) lod = 0;

      // Archetype selection
      const archSlot = isBike
        ? CYCLIST_SLOT
        : isWorker
          ? WORKER_SLOT
          : isFuneral
            ? FUNERAL_SLOT
            : isTourist
              ? TOURIST_SLOT
              : CIVILIAN_SLOTS[seed % CIVILIAN_SLOTS.length];

      // Pick LOD bucket (fall back to coarser LOD if fine bucket reaches capacity)
      let bucket = this.pedBuckets[archSlot][lod];
      if (bucket.count >= bucket.cap && lod < 2) {
        lod = Math.min(2, lod + 1);
        bucket = this.pedBuckets[archSlot][lod];
      }
      if (bucket.count >= bucket.cap) continue;

      const idx = bucket.count;
      this.q.setFromAxisAngle(this.up, -h);
      this.v.set(x, y, z);
      this.m.compose(this.v, this.q, this.sc);
      bucket.mesh.setMatrixAt(idx, this.m);

      // Multi-zone realistic colors per citizen
      const h1 = ((seed * 2654435761) >>> 0);
      const h2 = ((seed * 2246822519 + 17) >>> 0);
      if (isWorker) {
        this.col.setHex(0xe67319);
        this.bottomCol.setHex(0x2d3440);
      } else if (isFuneral) {
        this.col.setHex(0x1e2126);
        this.bottomCol.setHex(0x181a1f);
      } else {
        this.col.setHex(PED_TOP_PALETTE[h1 % PED_TOP_PALETTE.length]);
        this.bottomCol.setHex(PED_BOTTOM_PALETTE[(h2 >>> 4) % PED_BOTTOM_PALETTE.length]);
      }
      this.skinCol.setHex(PED_SKIN_PALETTE[(h1 >>> 8) % PED_SKIN_PALETTE.length]);
      this.hairCol.setHex(PED_HAIR_PALETTE[(h2 >>> 12) % PED_HAIR_PALETTE.length]);

      bucket.mesh.setColorAt(idx, this.col);
      const i3 = idx * 3;
      const bBuf = bucket.buf;
      bBuf.skin[i3] = this.skinCol.r; bBuf.skin[i3 + 1] = this.skinCol.g; bBuf.skin[i3 + 2] = this.skinCol.b;
      bBuf.hair[i3] = this.hairCol.r; bBuf.hair[i3 + 1] = this.hairCol.g; bBuf.hair[i3 + 2] = this.hairCol.b;
      bBuf.bottom[i3] = this.bottomCol.r; bBuf.bottom[i3 + 1] = this.bottomCol.g; bBuf.bottom[i3 + 2] = this.bottomCol.b;

      // GPU vertex animation parameters: (phase, strideAmp, mode, umbrellaLift)
      const i4 = idx * 4;
      const phase = ((seed * 1.6180339) % 1) * Math.PI * 2;
      const mode = isBike ? 2.0 : isWaiting ? 0.0 : 1.0;
      const amp = isWaiting ? 0.0 : isBike ? 1.0 : 0.88 + ((seed % 5) * 0.04);
      bBuf.anim[i4] = phase;
      bBuf.anim[i4 + 1] = amp;
      bBuf.anim[i4 + 2] = mode;
      bBuf.anim[i4 + 3] = hasUmbrella ? 1.0 : 0.0;

      bucket.count++;
      totalDrawnPeds++;

      // Paired bicycle (+ night headlight/taillight glow)
      if (isBike) {
        const bk = this.bikeBuckets[lod];
        if (bk.count < bk.cap) {
          const bi = bk.count;
          bk.mesh.setMatrixAt(bi, this.m);
          this.col.setHex(BIKE_COLORS[(h2 >>> 2) % BIKE_COLORS.length]);
          bk.mesh.setColorAt(bi, this.col);
          const bi4 = bi * 4;
          bk.buf.anim[bi4] = phase;
          bk.buf.anim[bi4 + 1] = isWaiting ? 0.0 : 1.0;
          bk.buf.anim[bi4 + 2] = 0.0;
          bk.buf.anim[bi4 + 3] = 0.0;
          bk.count++;
          if (night > 0.05 && this.bikeGlowCounts[lod] < bk.cap) {
            this.bikeGlows[lod].setMatrixAt(this.bikeGlowCounts[lod]++, this.m);
          }
        }
      }

      // Paired umbrella positioned inside the raised right hand
      if (hasUmbrella) {
        const ub = this.umbrellaBuckets[lod];
        if (ub.count < ub.cap) {
          const ui = ub.count;
          this.umbWorldM.multiplyMatrices(this.m, this.umbLocalM);
          ub.mesh.setMatrixAt(ui, this.umbWorldM);
          this.col.setHex(UMBRELLA_COLORS[(h1 >>> 3) % UMBRELLA_COLORS.length]);
          ub.mesh.setColorAt(ui, this.col);
          const ui4 = ui * 4;
          ub.buf.anim[ui4] = 0; ub.buf.anim[ui4 + 1] = 0; ub.buf.anim[ui4 + 2] = 0; ub.buf.anim[ui4 + 3] = 0;
          ub.count++;
        }
      }

      // Paired rolling suitcase beside tourist (wheels flush on ground Y = 0)
      if (hasLuggage) {
        const lb = this.luggageBuckets[lod];
        if (lb.count < lb.cap) {
          const li = lb.count;
          this.umbWorldM.multiplyMatrices(this.m, this.lugLocalM);
          lb.mesh.setMatrixAt(li, this.umbWorldM);
          this.col.setHex(LUGGAGE_COLORS[(h2 >>> 6) % LUGGAGE_COLORS.length]);
          lb.mesh.setColorAt(li, this.col);
          const li4 = li * 4;
          lb.buf.anim[li4] = 0; lb.buf.anim[li4 + 1] = 0; lb.buf.anim[li4 + 2] = 0; lb.buf.anim[li4 + 3] = 0;
          lb.count++;
        }
      }
    }

    for (let a = 0; a < this.pedBuckets.length; a++) {
      const row = this.pedBuckets[a];
      this.flushBucket(row[0]); this.flushBucket(row[1]); this.flushBucket(row[2]);
    }
    for (let l = 0; l < 3; l++) {
      this.flushBucket(this.bikeBuckets[l]);
      this.flushBucket(this.umbrellaBuckets[l]);
      this.flushBucket(this.luggageBuckets[l]);
      const gm = this.bikeGlows[l];
      const prevG = gm.count;
      gm.count = this.bikeGlowCounts[l];
      if (gm.count > 0 || prevG > 0) gm.instanceMatrix.needsUpdate = true;
    }

    // ---- trains (3-tier real-time distance LOD, exact railhead seating & per-car livery colors) ----
    const tnight = U.uNight.value;
    const tc = cur.train;
    const tcount = this.tCounts;
    const tgcount = this.tGlowCounts;
    tcount.fill(0);
    tgcount.fill(0);
    const terrain = this.app.terrain;
    for (let i = 0; i < cur.trainCount; i++) {
      const o = i * TRAIN_STRIDE;
      const x = this.tPos[i * 4], y = this.tPos[i * 4 + 1], z = this.tPos[i * 4 + 2], h = this.tPos[i * 4 + 3];
      const type = tc[o + 4];
      const lodRow = this.trains[type];
      if (!lodRow) continue;

      const dxC = x - camP.x, dyC = y - camP.y, dzC = z - camP.z;
      const distSq = dxC * dxC + dyC * dyC + dzC * dzC;
      let lod = distSq < RAIL_LOD_HIGH_DIST_SQ ? 0 : distSq < RAIL_LOD_MED_DIST_SQ ? 1 : 2;
      let slotIdx = type * 3 + lod;
      let im = lodRow[lod];
      if (tcount[slotIdx] >= im.instanceMatrix.count && lod < 2) {
        lod = Math.min(2, lod + 1);
        slotIdx = type * 3 + lod;
        im = lodRow[lod];
      }
      if (tcount[slotIdx] >= im.instanceMatrix.count) continue;

      // Exact railhead top alignment: sim snapshot emits p[1] + 0.30; railLayer draws railhead top at yTop + 0.29
      const railBase = y - 0.30;
      const gC = terrain ? terrain.meshY(x, z) : -1e9;
      const clr = railBase - Math.max(0, gC);
      const yTop = (gC > 0.35 && clr < 2.2) ? Math.max(railBase, gC + 0.18) : railBase;
      const railHeadY = yTop + 0.29;

      this.q.setFromAxisAngle(this.up, -h);
      this.v.set(x, railHeadY, z);
      this.m.compose(this.v, this.q, this.sc);

      // Deterministic realistic livery & line color via aTint = 1
      const trainId = tc[o + 5] | 0;
      const carHash = ((trainId * 31 + i * 17) >>> 0);
      if (type === 5) {
        if (this.metroLineColor) this.col.copy(this.metroLineColor);
        else this.col.setHex(RAIL_METRO_PALETTE[0]);
      } else if (type === 2) {
        this.col.setHex(RAIL_CONTAINER_PALETTE[carHash % RAIL_CONTAINER_PALETTE.length]);
      } else if (type === 0) {
        this.col.setHex(RAIL_LOCO_PALETTE[(trainId >>> 0) % RAIL_LOCO_PALETTE.length]);
      } else if (type === 1) {
        this.col.setHex(RAIL_PASSENGER_PALETTE[(trainId >>> 0) % RAIL_PASSENGER_PALETTE.length]);
      } else if (type === 3) {
        this.col.setHex(RAIL_HOPPER_PALETTE[carHash % RAIL_HOPPER_PALETTE.length]);
      } else {
        this.col.setHex(RAIL_TANK_PALETTE[carHash % RAIL_TANK_PALETTE.length]);
      }

      const idx = tcount[slotIdx]++;
      im.setMatrixAt(idx, this.m);
      im.setColorAt(idx, this.col);

      const glow = this.trainGlow[type][lod];
      if (glow && tnight > 0.05 && tgcount[slotIdx] < glow.instanceMatrix.count) {
        glow.setMatrixAt(tgcount[slotIdx]++, this.m);
      }
    }
    this.trainGlowMat.color.setScalar(0.4 + 2.2 * tnight);
    for (let k = 0; k < this.trains.length; k++) {
      for (let l = 0; l < 3; l++) {
        const slotIdx = k * 3 + l;
        const im = this.trains[k][l];
        const prevC = im.count;
        im.count = tcount[slotIdx];
        if (tcount[slotIdx] > 0 || prevC > 0) {
          im.instanceMatrix.needsUpdate = true;
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
        }
        const gm = this.trainGlow[k][l];
        if (gm) {
          const prevG = gm.count;
          gm.count = tgcount[slotIdx];
          if (tgcount[slotIdx] > 0 || prevG > 0) gm.instanceMatrix.needsUpdate = true;
        }
      }
    }
  }

  private flushBucket(b: PedInstancedBucket) {
    const prevC = b.mesh.count;
    b.mesh.count = b.count;
    if (b.count > 0 || prevC > 0) {
      b.mesh.instanceMatrix.needsUpdate = true;
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
      b.buf.markUpdated();
    }
  }

  update(dt: number, alpha: number) {
    this.interpolate(alpha);
    this.syncMeshes(dt);
  }

  vehiclePos(slot: number, gen: number): { p: THREE.Vector3; h: number } | null {
    const c = this.app.curSnap;
    if (!c) return null;
    const o = slot * VEH_STRIDE;
    if (o >= c.veh.length || !c.veh[o + 4] || (gen >= 0 && c.veh[o + 5] !== gen)) return null;
    return { p: new THREE.Vector3(this.vPos[slot * 4], this.vPos[slot * 4 + 1], this.vPos[slot * 4 + 2]), h: this.vPos[slot * 4 + 3] };
  }
  pedPos(slot: number, gen: number): { p: THREE.Vector3; h: number } | null {
    const c = this.app.curSnap;
    if (!c) return null;
    const o = slot * PED_STRIDE;
    if (o >= c.ped.length || !(c.ped[o + 4] >= 0) || (gen >= 0 && c.ped[o + 4] !== gen)) return null;
    return { p: new THREE.Vector3(this.pPos[slot * 4], this.pPos[slot * 4 + 1], this.pPos[slot * 4 + 2]), h: this.pPos[slot * 4 + 3] };
  }
  trainPos(id: number): { p: THREE.Vector3; h: number } | null {
    const c = this.app.curSnap;
    if (!c) return null;
    let i = -1;
    for (let k = 0; k < c.trainCount; k++) if (c.train[k * TRAIN_STRIDE + 5] === id) { i = k; break; }
    if (i < 0) return null;
    return { p: new THREE.Vector3(this.tPos[i * 4], this.tPos[i * 4 + 1], this.tPos[i * 4 + 2]), h: this.tPos[i * 4 + 3] };
  }
  private fpPrev: number[] | null = null;
  private fpSmooth = new THREE.Vector3();
  citizenPos(id: number): { p: THREE.Vector3; h: number; inside: boolean } | null {
    const c = this.app.curSnap;
    if (!c?.follow || this.app.followedCitizen !== id) return null;
    const f = c.follow;
    // prefer the interpolated physical agent if visible
    if (!f[4]) {
      for (let i = 0; i < c.ped.length / PED_STRIDE; i++) { const o = i * PED_STRIDE; if (c.ped[o + 4] >= 0 && c.ped[o + 6] === id) return { p: new THREE.Vector3(this.pPos[i * 4], this.pPos[i * 4 + 1], this.pPos[i * 4 + 2]), h: this.pPos[i * 4 + 3], inside: false }; }
      for (let i = 0; i < c.veh.length / VEH_STRIDE; i++) { const o = i * VEH_STRIDE; if (c.veh[o + 4] && c.veh[o + 8] === id) return { p: new THREE.Vector3(this.vPos[i * 4], this.vPos[i * 4 + 1], this.vPos[i * 4 + 2]), h: this.vPos[i * 4 + 3], inside: false }; }
    }
    const target = new THREE.Vector3(f[0], f[1], f[2]);
    if (this.fpSmooth.lengthSq() === 0 || this.fpSmooth.distanceTo(target) > 80) this.fpSmooth.copy(target);
    this.fpSmooth.lerp(target, 0.2);
    this.fpPrev = f;
    return { p: this.fpSmooth.clone(), h: f[3], inside: !!f[4] };
  }

  /** ray picking against moving agents (generous radius) */
  pickAgent(ray: THREE.Raycaster): { kind: 'ped' | 'vehicle'; slot: number; gen: number; citizen: number } | null {
    const c = this.app.curSnap;
    if (!c) return null;
    let best: { kind: 'ped' | 'vehicle'; slot: number; gen: number; citizen: number } | null = null, bd = Infinity;
    const r = ray.ray;
    const p = new THREE.Vector3();
    for (let i = 0; i < c.ped.length / PED_STRIDE; i++) {
      const o = i * PED_STRIDE;
      if (c.ped[o + 4] < 0) continue;
      p.set(this.pPos[i * 4], this.pPos[i * 4 + 1] + 1, this.pPos[i * 4 + 2]);
      const d = r.distanceSqToPoint(p);
      const along = p.clone().sub(r.origin).length();
      if (d < Math.max(2.2, along * 0.008) ** 2 && along < bd) { bd = along; best = { kind: 'ped', slot: i, gen: c.ped[o + 4], citizen: c.ped[o + 6] }; }
    }
    for (let i = 0; i < c.veh.length / VEH_STRIDE; i++) {
      const o = i * VEH_STRIDE;
      if (!c.veh[o + 4]) continue;
      p.set(this.vPos[i * 4], this.vPos[i * 4 + 1] + 1, this.vPos[i * 4 + 2]);
      const d = r.distanceSqToPoint(p);
      const along = p.clone().sub(r.origin).length();
      if (d < Math.max(3.5, along * 0.01) ** 2 && along < bd) { bd = along; best = { kind: 'vehicle', slot: i, gen: c.veh[o + 5], citizen: c.veh[o + 8] }; }
    }
    return best;
  }
}
