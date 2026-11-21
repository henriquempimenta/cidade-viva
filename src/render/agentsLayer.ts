import * as THREE from 'three';
import type { App } from '../app';
import { MAX_PEDS, MAX_VEHICLES, PED_FLAG_LUGGAGE, PED_FLAG_TOURIST, PED_FLAG_UMBRELLA, PED_FLAG_WORKER, PED_STRIDE, TRAIN_STRIDE, VEH_FLAG_BRAKE, VEH_FLAG_SIREN, VEH_FLAG_YIELD, VEH_STRIDE, VType, MAX_TRAIN_CARS, PED_FLAG_FUNERAL } from '../shared/constants';
/** render budgets (instances drawn per frame); the simulation itself has no such cap */
const RENDER_PED = 6000;
import { GB } from './geomBuilder';
import { createAssetMaterial, createGlowMaterial } from './meshKit';
import { buildVehicle, VEHICLE_PRESETS, type VehicleId } from './vehicleGeom';
import { U } from './uniforms';

const PED_FLAG_BIKE = 256;
const W = new THREE.Color(0xffffff), DARK = new THREE.Color(0x22262b), TIRE = new THREE.Color(0x1a1a1a);

const PRESET_INDEX: Record<VehicleId, number> = Object.fromEntries(
  VEHICLE_PRESETS.map((p, idx) => [p.id, idx]),
) as Record<VehicleId, number>;

// Deterministic archetype tables for civilian cars (modern vs Era 0 vintage)
const MODERN_CAR_POOL: number[] = [
  PRESET_INDEX.sedan, PRESET_INDEX.sedan, PRESET_INDEX.sedan, PRESET_INDEX.sedan,
  PRESET_INDEX.hatch, PRESET_INDEX.hatch, PRESET_INDEX.hatch,
  PRESET_INDEX.suv, PRESET_INDEX.suv,
  PRESET_INDEX.pickup, PRESET_INDEX.pickup,
];
const ERA0_CAR_POOL: number[] = [
  PRESET_INDEX.vintage, PRESET_INDEX.vintage, PRESET_INDEX.vintage,
  PRESET_INDEX.vintage, PRESET_INDEX.vintage, PRESET_INDEX.vintage,
  PRESET_INDEX.pickup, PRESET_INDEX.sedan,
];
const DIRECT_VTYPE_PRESET: Partial<Record<VType, number>> = {
  [VType.Taxi]: PRESET_INDEX.taxi,
  [VType.Moto]: PRESET_INDEX.moto,
  [VType.Bus]: PRESET_INDEX.bus,
  [VType.SchoolBus]: PRESET_INDEX.schoolbus,
  [VType.Truck]: PRESET_INDEX.truck,
  [VType.Van]: PRESET_INDEX.van,
  [VType.Garbage]: PRESET_INDEX.garbage,
  [VType.Ambulance]: PRESET_INDEX.ambulance,
  [VType.Police]: PRESET_INDEX.police,
  [VType.Fire]: PRESET_INDEX.fire,
  [VType.TourBus]: PRESET_INDEX.tourbus,
  [VType.Construction]: PRESET_INDEX.construction,
  [VType.Hearse]: PRESET_INDEX.hearse,
};

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
};

export class AgentsLayer {
  group = new THREE.Group();
  private veh: THREE.InstancedMesh[] = [];
  private vehGlow: (THREE.InstancedMesh | null)[] = [];
  private vehGlowMat!: THREE.MeshBasicMaterial;
  private sirens: THREE.InstancedMesh;
  private bodies: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh;
  private umbrellas: THREE.InstancedMesh;
  private bikes: THREE.InstancedMesh;
  private bags: THREE.InstancedMesh;
  private trains: THREE.InstancedMesh[] = [];
  private trainGlow: (THREE.InstancedMesh | null)[] = [];
  private trainGlowMat!: THREE.MeshBasicMaterial;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private sc = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  private col = new THREE.Color();
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private cullSphere = new THREE.Sphere(new THREE.Vector3(), 10);
  private vCounts = new Int32Array(VEHICLE_PRESETS.length);
  private vGlowCounts = new Int32Array(VEHICLE_PRESETS.length);
  private tCounts = new Int32Array(6);
  private vPos = new Float32Array(MAX_VEHICLES * 4); // interpolated x,y,z,h (grows with the sim pools)
  private pPos = new Float32Array(MAX_PEDS * 4);
  private tPos = new Float32Array(MAX_TRAIN_CARS * 4);
  private t = 0;
  lineColors = new Map<number, THREE.Color>();

  constructor(private app: App) {
    const vehMat = createAssetMaterial();
    this.vehGlowMat = createGlowMaterial();
    for (const preset of VEHICLE_PRESETS) {
      const built = buildVehicle(preset.id, 'high');
      const cap = preset.vtype === VType.Car ? 2500 : 900;
      const im = new THREE.InstancedMesh(built.body, vehMat, cap);
      im.count = 0; im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false;
      this.veh.push(im);
      this.group.add(im);
      if (built.glow) {
        const gm = new THREE.InstancedMesh(built.glow, this.vehGlowMat, cap);
        gm.count = 0; gm.frustumCulled = false;
        this.vehGlow.push(gm);
        this.group.add(gm);
      } else {
        this.vehGlow.push(null);
      }
    }
    this.sirens = new THREE.InstancedMesh(new THREE.BoxGeometry(0.36, 0.20, 1.15), new THREE.MeshBasicMaterial({ toneMapped: false }), 300);
    this.sirens.count = 0; this.sirens.frustumCulled = false;
    // pedestrians
    const pb = new GB();
    pb.box(0, 0.85, 0, 0.32, 0.65, 0.42, W); // torso
    pb.box(0, 0, 0.11, 0.18, 0.85, 0.16, new THREE.Color(0x3a4050)); pb.box(0, 0, -0.11, 0.18, 0.85, 0.16, new THREE.Color(0x3a4050)); // legs
    this.bodies = new THREE.InstancedMesh(pb.toGeometry(false), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), RENDER_PED);
    this.bodies.count = 0; this.bodies.frustumCulled = false; this.bodies.castShadow = true;
    this.heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.17, 6, 5).translate(0, 1.68, 0), new THREE.MeshStandardMaterial({ roughness: 0.7 }), RENDER_PED);
    this.heads.count = 0; this.heads.frustumCulled = false;
    const ug = new THREE.ConeGeometry(0.7, 0.35, 8).translate(0, 2.15, 0);
    this.umbrellas = new THREE.InstancedMesh(ug, new THREE.MeshStandardMaterial({ roughness: 0.6 }), 2000);
    this.umbrellas.count = 0; this.umbrellas.frustumCulled = false;
    const bk = new GB();
    bk.box(0, 0, 0, 1.6, 0.6, 0.06, DARK); bk.box(0.6, 0, 0, 0.6, 0.6, 0.08, TIRE); bk.box(-0.6, 0, 0, 0.6, 0.6, 0.08, TIRE);
    this.bikes = new THREE.InstancedMesh(bk.toGeometry(false), new THREE.MeshStandardMaterial({ vertexColors: true }), 1500);
    this.bikes.count = 0; this.bikes.frustumCulled = false;
    this.bags = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.45, 0.2).translate(-0.35, 0.22, 0.3), new THREE.MeshStandardMaterial({ color: 0x8a3fb0 }), 1500);
    this.bags.count = 0; this.bags.frustumCulled = false;
    this.group.add(this.sirens, this.bodies, this.heads, this.umbrellas, this.bikes, this.bags);
    // trains: 0 loco, 1 passenger coach, 2 container flat, 3 hopper, 4 tank, 5 metro
    // (rolling stock with bogies and wheels, after the v14 build; lit windows/headlamps live in a glow twin)
    const C = (h: number) => new THREE.Color(h);
    const frame = C(0x2c3234), steelC = C(0x8a8f8a), roofC = C(0x6f7a77), glassC = C(0x2f474c);
    const bogies = (g: GB, half: number) => {
      for (const bx of [-half, half]) {
        g.box(bx, 0.32, 0, 2.9, 0.42, 2.25, frame);
        for (const ax of [-0.85, 0.85]) for (const z of [-1.2, 1.2]) { g.box(bx + ax, 0.0, z, 0.78, 0.78, 0.14, TIRE); g.box(bx + ax, 0.27, z * 1.1, 0.26, 0.26, 0.06, steelC); }
      }
    };
    const glowCol = C(0xffd9a0), lampCol = C(0xfff4d6);
    const geos: [GB, GB | null][] = [];
    for (let k = 0; k < 6; k++) {
      const g = new GB();
      let glow: GB | null = null;
      if (k === 0) {
        const red = C(0xb8432f), band = C(0xe3b23c);
        bogies(g, 5.3);
        g.box(0, 0.78, 0, 16.2, 0.4, 2.9, frame);
        g.box(-1.6, 1.18, 0, 12.4, 2.4, 2.5, red, 0, { top: roofC });
        g.box(5.4, 1.18, 0, 4.4, 2.95, 3.0, red, 0, { top: roofC });
        g.box(0, 1.5, 0, 16.0, 0.22, 3.04, band);
        g.box(7.62, 2.55, 0, 0.06, 0.95, 2.4, glassC);
        for (const z of [-1.51, 1.51]) g.box(5.6, 2.6, z, 1.8, 0.8, 0.04, glassC);
        g.box(-3, 3.55, 0, 2.2, 0.35, 1.2, frame);
        glow = new GB();
        for (const z of [-0.9, 0.9]) glow.box(7.66, 1.55, z, 0.08, 0.3, 0.42, lampCol);
        glow.box(7.66, 3.45, 0, 0.08, 0.28, 0.5, lampCol);
      } else if (k === 1 || k === 5) {
        const metro = k === 5;
        const len = metro ? 18.2 : 19.2, body = metro ? C(0xe9ecef) : C(0xc9cfd2), stripe = metro ? C(0x2e8a62) : C(0x2f6a9a);
        bogies(g, len / 2 - 3);
        g.box(0, 0.78, 0, len, 0.35, 2.9, frame);
        g.box(0, 1.1, 0, len, 2.95, 3.0, body, 0, { top: roofC });
        g.box(0, 1.35, 0, len + 0.02, 0.3, 3.04, stripe);
        for (const z of [-1.51, 1.51]) {
          for (let x = -len / 2 + 2.4; x < len / 2 - 1.5; x += 2.6) g.box(x, 2.25, z, 1.9, 1.0, 0.04, glassC);
          for (const x of metro ? [-len / 4, len / 4] : [-len / 2 + 1.1, len / 2 - 1.1]) g.box(x, 1.2, z * 1.005, 1.25, 2.55, 0.04, stripe);
        }
        g.box(0, 4.05, 0, len - 2, 0.25, 2.2, roofC);
        glow = new GB();
        for (const z of [-1.53, 1.53]) for (let x = -len / 2 + 2.4; x < len / 2 - 1.5; x += 2.6) glow.box(x, 2.3, z, 1.75, 0.85, 0.03, glowCol);
      } else if (k === 2) {
        bogies(g, 5.4);
        g.box(0, 0.78, 0, 16.2, 0.35, 2.7, frame);
        g.box(-4.05, 1.13, 0, 7.8, 2.55, 2.45, C(0x3b6f9e));
        g.box(4.05, 1.13, 0, 7.8, 2.55, 2.45, C(0xb4533e));
        for (const x of [-7.9, -0.2, 0.2, 7.9]) g.box(x, 1.13, 0, 0.08, 2.55, 2.5, C(0x5a5a52));
      } else if (k === 3) {
        bogies(g, 4.6);
        g.box(0, 0.78, 0, 14.2, 0.35, 2.7, frame);
        g.box(0, 1.15, 0, 12.6, 1.0, 2.2, C(0x6a5440));
        g.box(0, 2.1, 0, 13.6, 1.6, 3.0, C(0x7f6447), 0, { top: C(0x3a3027) });
        for (const z of [-1.52, 1.52]) for (let x = -6; x <= 6; x += 2) g.box(x, 2.1, z, 0.16, 1.6, 0.06, C(0x5c4733));
      } else {
        const tank = C(0x9fa79c), ring = C(0x6e7a74);
        bogies(g, 4.9);
        g.box(0, 0.78, 0, 15.2, 0.35, 2.7, frame);
        // rounded tank from overlapping prisms (reads as a cylinder at city scale)
        g.box(0, 1.35, 0, 14.4, 2.3, 2.1, tank);
        g.box(0, 1.6, 0, 14.4, 1.8, 2.85, tank);
        g.box(0, 1.15, 0, 14.4, 2.75, 1.25, tank, 0, { top: tank });
        for (const x of [-4.2, 4.2]) g.box(x, 1.12, 0, 0.18, 2.83, 2.95, ring);
        g.box(0, 3.88, 0, 1.0, 0.4, 1.0, ring);
      }
      geos.push([g, glow]);
    }
    const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.trainGlowMat = glowMat;
    for (const [g, glow] of geos) {
      const im = new THREE.InstancedMesh(g.toGeometry(false), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 }), 300);
      im.count = 0; im.castShadow = true; im.frustumCulled = false;
      this.trains.push(im);
      this.group.add(im);
      if (glow) {
        const gm = new THREE.InstancedMesh(glow.toGeometry(false), glowMat, 300);
        gm.count = 0; gm.frustumCulled = false;
        this.trainGlow.push(gm); this.group.add(gm);
      } else this.trainGlow.push(null);
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
    counts.fill(0);
    gCounts.fill(0);
    let ns = 0;
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
      const hash = ((i * 7 + gen * 13) >>> 0);
      let slot: number;
      if (type === VType.Car) {
        const pool = old ? ERA0_CAR_POOL : MODERN_CAR_POOL;
        slot = pool[hash % pool.length];
      } else {
        const direct = DIRECT_VTYPE_PRESET[type];
        if (direct === undefined) continue;
        slot = direct;
      }
      const im = this.veh[slot];
      if (!im || counts[slot] >= im.instanceMatrix.count) continue;
      this.q.setFromAxisAngle(this.up, -h);
      const flags = cv[o + 6];
      this.v.set(x, y, z);
      this.m.compose(this.v, this.q, this.sc);
      im.setMatrixAt(counts[slot], this.m);
      const line = cv[o + 7];
      if (type === VType.Bus && line >= 0 && this.lineColors.has(line)) this.col.copy(this.lineColors.get(line)!);
      else if (TYPE_COLOR[type] !== undefined) this.col.setHex(TYPE_COLOR[type]!);
      else if (type === VType.Truck) this.col.setHex(TRUCK_COLORS[hash % TRUCK_COLORS.length]);
      else if (type === VType.Van) this.col.setHex(VAN_COLORS[hash % VAN_COLORS.length]);
      else if (type === VType.Moto) this.col.setHex(MOTO_COLORS[hash % MOTO_COLORS.length]);
      else { const pal = old ? OLD_COLORS : CAR_COLORS; this.col.setHex(pal[(i * 7 + gen * 3) % pal.length]); }
      im.setColorAt(counts[slot], this.col);
      counts[slot]++;
      const gm = this.vehGlow[slot];
      if (gm && (night > 0.05 || (flags & VEH_FLAG_SIREN)) && gCounts[slot] < gm.instanceMatrix.count) {
        gm.setMatrixAt(gCounts[slot]++, this.m);
      }
      if (flags & VEH_FLAG_SIREN && ns < 300) {
        const fwd = type === VType.Fire ? 3.55 : type === VType.Ambulance ? 1.35 : -0.15;
        const dy = type === VType.Fire ? 2.94 : type === VType.Ambulance ? 2.16 : 1.56;
        this.v.set(x + Math.cos(h) * fwd, y + dy, z + Math.sin(h) * fwd);
        this.m.compose(this.v, this.q, this.sc);
        this.sirens.setMatrixAt(ns, this.m);
        const ph = Math.sin(this.t * 14 + i) > 0;
        this.col.setRGB(ph ? 3 : 0.1, 0.1, ph ? 0.1 : 3);
        this.sirens.setColorAt(ns, this.col);
        ns++;
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
    }
    const prevNs = this.sirens.count;
    this.sirens.count = ns;
    if (ns > 0 || prevNs > 0) {
      this.sirens.instanceMatrix.needsUpdate = true;
      if (this.sirens.instanceColor) this.sirens.instanceColor.needsUpdate = true;
    }

    // ---- pedestrians ----
    const cp = cur.ped;
    let nb = 0, nu = 0, nbk = 0, nbag = 0;
    const farCull = Math.max(450, camP.y * 4);
    const NP = cp.length / PED_STRIDE;
    for (let i = 0; i < NP; i++) {
      const o = i * PED_STRIDE;
      if (cp[o + 4] < 0) continue;
      const x = this.pPos[i * 4], y = this.pPos[i * 4 + 1], z = this.pPos[i * 4 + 2], h = this.pPos[i * 4 + 3];
      if (nb >= RENDER_PED || Math.abs(x - camP.x) > farCull || Math.abs(z - camP.z) > farCull) continue;
      sphere.center.set(x + sOffPX, y + 1, z + sOffPZ);
      sphere.radius = rPed;
      if (!this.frustum.intersectsSphere(sphere)) continue;
      const flags = cp[o + 5];
      const cid = cp[o + 6];
      const bike = (flags & PED_FLAG_BIKE) !== 0;
      const bob = bike ? 0.55 : Math.abs(Math.sin(this.t * 7 + i)) * 0.06;
      this.q.setFromAxisAngle(this.up, -h);
      this.v.set(x, y + bob, z);
      this.m.compose(this.v, this.q, this.sc);
      this.bodies.setMatrixAt(nb, this.m);
      this.heads.setMatrixAt(nb, this.m);
      const seed = cid >= 0 ? cid : i + 7777;
      if (flags & PED_FLAG_WORKER) this.col.setHex(0xff8a1a);
      else if (flags & PED_FLAG_FUNERAL) this.col.setHex(0x151515);
      else this.col.setHSL(((seed * 0.61803) % 1), 0.45 + ((seed * 7) % 10) / 30, 0.38 + ((seed * 13) % 10) / 40);
      this.bodies.setColorAt(nb, this.col);
      if (flags & PED_FLAG_WORKER) this.col.setHex(0xffd21a);
      else this.col.setHSL(0.07, 0.4 + ((seed * 3) % 10) / 40, 0.25 + ((seed * 11) % 10) / 22);
      this.heads.setColorAt(nb, this.col);
      nb++;
      if (bike && nbk < 1500) { this.v.y = y; this.m.compose(this.v, this.q, this.sc); this.bikes.setMatrixAt(nbk++, this.m); }
      if (flags & PED_FLAG_UMBRELLA && nu < 2000) {
        this.v.y = y + bob;
        this.m.compose(this.v, this.q, this.sc);
        this.umbrellas.setMatrixAt(nu, this.m);
        this.col.setHSL(((seed * 0.31) % 1), 0.6, 0.45);
        this.umbrellas.setColorAt(nu, this.col);
        nu++;
      }
      if ((flags & (PED_FLAG_LUGGAGE | PED_FLAG_TOURIST)) && nbag < 1500) { this.v.y = y; this.m.compose(this.v, this.q, this.sc); this.bags.setMatrixAt(nbag++, this.m); }
    }
    for (const [im, n] of [[this.bodies, nb], [this.heads, nb], [this.umbrellas, nu], [this.bikes, nbk], [this.bags, nbag]] as [THREE.InstancedMesh, number][]) {
      const prevC = im.count;
      im.count = n;
      if (n > 0 || prevC > 0) {
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    }

    // ---- trains ----
    const tnight = U.uNight.value;
    const tc = cur.train;
    const tcount = this.tCounts;
    tcount.fill(0);
    for (let i = 0; i < cur.trainCount; i++) {
      const o = i * TRAIN_STRIDE;
      const x = this.tPos[i * 4], y = this.tPos[i * 4 + 1], z = this.tPos[i * 4 + 2], h = this.tPos[i * 4 + 3];
      const type = tc[o + 4];
      const im = this.trains[type];
      if (!im) continue;
      this.q.setFromAxisAngle(this.up, -h);
      this.v.set(x, y + 0.3, z);
      this.m.compose(this.v, this.q, this.sc);
      const glow = this.trainGlow[type];
      if (glow && tnight > 0.08) glow.setMatrixAt(tcount[type], this.m);
      im.setMatrixAt(tcount[type]++, this.m);
    }
    this.trains.forEach((im, k) => {
      const prevC = im.count;
      im.count = tcount[k];
      if (tcount[k] > 0 || prevC > 0) im.instanceMatrix.needsUpdate = true;
    });
    this.trainGlowMat.color.setScalar(0.3 + 1.9 * tnight);
    this.trainGlow.forEach((gm, k) => {
      if (!gm) return;
      const prevC = gm.count;
      const nc = tnight > 0.08 ? tcount[k] : 0;
      gm.count = nc;
      if (nc > 0 || prevC > 0) gm.instanceMatrix.needsUpdate = true;
    });
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
