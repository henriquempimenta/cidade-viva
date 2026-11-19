import * as THREE from 'three';
import type { App } from '../app';
import { MAX_PEDS, MAX_VEHICLES, PED_FLAG_LUGGAGE, PED_FLAG_TOURIST, PED_FLAG_UMBRELLA, PED_FLAG_WORKER, PED_STRIDE, TRAIN_STRIDE, VEH_FLAG_BRAKE, VEH_FLAG_SIREN, VEH_FLAG_YIELD, VEH_STRIDE, VType, VTYPE_COUNT, MAX_TRAIN_CARS, PED_FLAG_FUNERAL } from '../shared/constants';
import { GB } from './geomBuilder';
import { U } from './uniforms';

const PED_FLAG_BIKE = 256;
const W = new THREE.Color(0xffffff), DARK = new THREE.Color(0x22262b), GLASS = new THREE.Color(0x2b3640), TIRE = new THREE.Color(0x1a1a1a);

function vehicleGeo(t: VType): THREE.BufferGeometry {
  const g = new GB();
  const wheels = (len: number, wid: number, r = 0.38) => {
    for (const z of [-len * 0.32, len * 0.32]) for (const x of [-wid / 2, wid / 2]) g.box(x, 0, z, 0.3, r * 2, r * 2, TIRE);
  };
  // vehicles face +x in local space -> we build along z then rotate: keep length along x
  const car = (len: number, wid: number, h: number, cabinF: number) => {
    g.box(0, 0.35, 0, len, h * 0.5, wid, W);
    g.box(-len * 0.05, 0.35 + h * 0.5, 0, len * cabinF, h * 0.42, wid * 0.86, GLASS, 0, { top: W });
  };
  switch (t) {
    case VType.Car: case VType.Taxi: case VType.Police: case VType.Hearse:
      car(4.3, 1.8, 1.45, t === VType.Hearse ? 0.7 : 0.52); wheelsX(g, 4.3, 1.8);
      if (t === VType.Taxi) g.box(0, 1.55, 0, 0.6, 0.25, 0.3, new THREE.Color(0xffe066));
      if (t === VType.Police) g.box(-0.2, 1.6, 0, 0.4, 0.2, 1.3, DARK);
      break;
    case VType.Moto:
      g.box(0, 0.45, 0, 1.9, 0.5, 0.35, W); g.box(-0.2, 0.95, 0, 0.5, 0.7, 0.4, DARK); g.box(0.2, 1.4, 0, 0.3, 0.3, 0.3, W);
      g.box(0.8, 0, 0, 0.6, 0.6, 0.12, TIRE); g.box(-0.8, 0, 0, 0.6, 0.6, 0.12, TIRE);
      break;
    case VType.Bus: case VType.TourBus: case VType.SchoolBus: {
      const L = t === VType.SchoolBus ? 9.5 : 11.8;
      g.box(0, 0.4, 0, L, 2.7, 2.5, W);
      g.box(0, 1.4, 1.26, L * 0.9, 1.1, 0.02, GLASS); g.box(0, 1.4, -1.26, L * 0.9, 1.1, 0.02, GLASS);
      g.box(L / 2 + 0.01, 1.2, 0, 0.02, 1.4, 2.2, GLASS);
      if (t === VType.TourBus) g.box(0, 3.1, 0, L * 0.6, 0.3, 2.3, GLASS);
      wheelsX(g, L, 2.5, 0.5);
      break;
    }
    case VType.Truck: case VType.Garbage: case VType.Construction: case VType.Fire: {
      const L = t === VType.Fire ? 9 : 8.5;
      g.box(L / 2 - 1.1, 0.45, 0, 2.2, 2.4, 2.4, W);
      g.box(L / 2 - 0.5, 1.6, 0, 0.9, 0.9, 2.2, GLASS);
      if (t === VType.Construction) { g.box(-1.2, 0.9, 0, 5.6, 1.6, 2.4, new THREE.Color(0xd8b040)); g.box(-1.2, 2.4, 0, 5.2, 0.4, 2.2, new THREE.Color(0x8a6a45)); }
      else if (t === VType.Garbage) g.box(-1.3, 0.6, 0, 5.8, 2.6, 2.4, new THREE.Color(0x5aa04a));
      else if (t === VType.Fire) { g.box(-1.2, 0.6, 0, 6, 2, 2.4, W); g.box(-1.3, 2.6, 0, 5.5, 0.25, 0.5, new THREE.Color(0xcccccc)); }
      else g.box(-1.4, 0.6, 0, 6, 2.8, 2.45, pickTrailer());
      wheelsX(g, L, 2.4, 0.5);
      break;
    }
    case VType.Van: case VType.Ambulance:
      g.box(0, 0.4, 0, 5.2, 2.1, 2.0, W);
      g.box(1.9, 1.3, 0, 1.2, 0.8, 1.9, GLASS);
      if (t === VType.Ambulance) { g.box(0, 2.2, 0, 0.3, 0.3, 1.6, new THREE.Color(0xff3030)); g.box(-0.3, 1.5, 1.01, 1.2, 0.3, 0.02, new THREE.Color(0xff3030)); }
      wheelsX(g, 5.2, 2.0);
      break;
    default:
      car(4.3, 1.8, 1.45, 0.5); wheelsX(g, 4.3, 1.8);
  }
  return g.toGeometry(false);
}
function wheelsX(g: GB, len: number, wid: number, r = 0.38) {
  for (const x of [-len * 0.32, len * 0.32]) for (const z of [-wid / 2, wid / 2]) g.box(x, 0, z, r * 2, r * 2, 0.3, TIRE);
}
function pickTrailer() { return W; }

const CAR_COLORS = [0xf2f2f2, 0x1c1c1e, 0x8f969c, 0xb5b9bd, 0xa32b2b, 0x23467a, 0x2f6b4a, 0xd4c08a, 0x6d2b45, 0x3c6fb0, 0xe0a030, 0x4a4f55];
const OLD_COLORS = [0xd9cba0, 0x8a3a2a, 0x2f5a3a, 0x7a8a9a, 0xc8b070, 0xa05a30, 0x3a4a6a, 0xe8e0d0];
const TYPE_COLOR: Partial<Record<VType, number>> = {
  [VType.Taxi]: 0xf2c230, [VType.Bus]: 0x2f7fd0, [VType.SchoolBus]: 0xf2b705, [VType.Garbage]: 0xe8e8e8, [VType.Ambulance]: 0xffffff, [VType.Police]: 0xe8e8e8,
  [VType.Fire]: 0xd02a20, [VType.TourBus]: 0x9a3fb0, [VType.Construction]: 0xf0b020, [VType.Hearse]: 0x111111, [VType.Van]: 0xe8e8e8,
};

export class AgentsLayer {
  group = new THREE.Group();
  private veh: THREE.InstancedMesh[] = [];
  private lights: THREE.InstancedMesh;
  private sirens: THREE.InstancedMesh;
  private bodies: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh;
  private umbrellas: THREE.InstancedMesh;
  private bikes: THREE.InstancedMesh;
  private bags: THREE.InstancedMesh;
  private trains: THREE.InstancedMesh[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private sc = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  private col = new THREE.Color();
  private vPos = new Float32Array(MAX_VEHICLES * 4); // interpolated x,y,z,h
  private pPos = new Float32Array(MAX_PEDS * 4);
  private tPos = new Float32Array(MAX_TRAIN_CARS * 4);
  private t = 0;
  lineColors = new Map<number, THREE.Color>();

  constructor(private app: App) {
    const vehMat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.3 });
    for (let t = 0; t < VTYPE_COUNT; t++) {
      const im = new THREE.InstancedMesh(vehicleGeo(t as VType), vehMat, t === VType.Car ? 2600 : t === VType.Bike ? 1 : 500);
      im.count = 0; im.castShadow = true; im.frustumCulled = false;
      this.veh.push(im);
      this.group.add(im);
    }
    // head/tail lights merged: front warm white, rear red
    const lg = new GB();
    const front = new THREE.Color(1.0, 0.92, 0.75), rear = new THREE.Color(0.9, 0.05, 0.05);
    lg.box(2.18, 0.7, 0.6, 0.06, 0.18, 0.35, front); lg.box(2.18, 0.7, -0.6, 0.06, 0.18, 0.35, front);
    lg.box(-2.18, 0.75, 0.62, 0.06, 0.16, 0.3, rear); lg.box(-2.18, 0.75, -0.62, 0.06, 0.16, 0.3, rear);
    const lmat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.lights = new THREE.InstancedMesh(lg.toGeometry(false), lmat, MAX_VEHICLES);
    this.lights.count = 0; this.lights.frustumCulled = false;
    this.sirens = new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, 0.25, 1.2), new THREE.MeshBasicMaterial({ toneMapped: false }), 300);
    this.sirens.count = 0; this.sirens.frustumCulled = false;
    // pedestrians
    const pb = new GB();
    pb.box(0, 0.85, 0, 0.32, 0.65, 0.42, W); // torso
    pb.box(0, 0, 0.11, 0.18, 0.85, 0.16, new THREE.Color(0x3a4050)); pb.box(0, 0, -0.11, 0.18, 0.85, 0.16, new THREE.Color(0x3a4050)); // legs
    this.bodies = new THREE.InstancedMesh(pb.toGeometry(false), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), MAX_PEDS);
    this.bodies.count = 0; this.bodies.frustumCulled = false; this.bodies.castShadow = true;
    this.heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.17, 6, 5).translate(0, 1.68, 0), new THREE.MeshStandardMaterial({ roughness: 0.7 }), MAX_PEDS);
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
    this.group.add(this.lights, this.sirens, this.bodies, this.heads, this.umbrellas, this.bikes, this.bags);
    // trains: 0 loco, 1 passenger coach, 2 container, 3 hopper, 4 tank, 5 metro
    const tcols = [0xc03a2a, 0xd8dde2, 0x3a6ea5, 0x7a5a3a, 0x30343a, 0xe8e8ee];
    for (let k = 0; k < 6; k++) {
      const g = new GB();
      const c = new THREE.Color(tcols[k]);
      if (k === 0) { g.box(0, 0.8, 0, 16, 3.2, 2.9, c); g.box(6.5, 4, 0, 3, 0.8, 2.6, DARK); g.box(7.9, 1.6, 0, 0.1, 1.2, 2.4, GLASS); }
      else if (k === 1 || k === 5) { g.box(0, 0.8, 0, 19, 3.3, 2.9, c); g.box(0, 2.2, 1.46, 17, 1.1, 0.02, GLASS); g.box(0, 2.2, -1.46, 17, 1.1, 0.02, GLASS); if (k === 5) g.box(0, 1.2, 1.47, 18, 0.3, 0.02, new THREE.Color(0xd92b2b)); }
      else if (k === 2) { g.box(0, 0.6, 0, 17, 0.4, 2.6, DARK); g.box(-4.2, 1.0, 0, 8, 2.6, 2.5, c); g.box(4.2, 1.0, 0, 8, 2.6, 2.5, new THREE.Color(0xc94a3a)); }
      else if (k === 3) { g.box(0, 0.6, 0, 14, 0.4, 2.6, DARK); g.box(0, 1.0, 0, 13, 2.8, 2.8, c); }
      else { g.box(0, 0.6, 0, 15, 0.4, 2.6, DARK); g.cylinder(0, 1, 0, 1.4, 1.4, 0.1, 10, c); g.setTransform(0, 2.4, 0, 0); g.box(0, -1.4, 0, 14, 2.8, 2.6, c); }
      for (const x of [-5, 5]) g.box(x, 0, 0, 2.4, 0.7, 2.2, TIRE);
      const im = new THREE.InstancedMesh(g.toGeometry(false), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 }), 300);
      im.count = 0; im.castShadow = true; im.frustumCulled = false;
      this.trains.push(im);
      this.group.add(im);
    }
  }

  update(dt: number, alpha: number) {
    this.t += dt;
    const cur = this.app.curSnap, prev = this.app.prevSnap;
    if (!cur) return;
    const a = Math.min(1, Math.max(0, alpha));
    const night = U.uNight.value;
    // ---- vehicles ----
    const counts = new Array(VTYPE_COUNT).fill(0);
    let nl = 0, ns = 0;
    const cv = cur.veh, pv = prev?.veh;
    const old = (this.app.stats?.era ?? 0) === 0;
    for (let i = 0; i < MAX_VEHICLES; i++) {
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
      const im = this.veh[type];
      if (!im || counts[type] >= im.instanceMatrix.count) continue;
      this.q.setFromAxisAngle(this.up, -h);
      const flags = cv[o + 6];
      this.v.set(x, y, z);
      this.m.compose(this.v, this.q, this.sc);
      im.setMatrixAt(counts[type], this.m);
      const gen = cv[o + 5];
      const line = cv[o + 7];
      if ((type === VType.Bus) && line >= 0 && this.lineColors.has(line)) this.col.copy(this.lineColors.get(line)!);
      else if (TYPE_COLOR[type as VType] !== undefined) this.col.setHex(TYPE_COLOR[type as VType]!);
      else { const pal = old ? OLD_COLORS : CAR_COLORS; this.col.setHex(pal[(i * 7 + gen * 3) % pal.length]); }
      im.setColorAt(counts[type], this.col);
      counts[type]++;
      if (night > 0.05 && nl < MAX_VEHICLES && type !== VType.Moto) {
        const s = type === VType.Bus || type === VType.TourBus || type === VType.Truck || type === VType.Garbage || type === VType.Construction || type === VType.Fire ? 1.35 : 1;
        this.sc.set(s * (type === VType.Bus || type === VType.TourBus ? 2.7 : type >= VType.Truck && type <= VType.Garbage ? 2 : 1), s, s);
        this.m.compose(this.v, this.q, this.sc);
        this.sc.set(1, 1, 1);
        this.lights.setMatrixAt(nl++, this.m);
      }
      if (flags & VEH_FLAG_SIREN && ns < 300) {
        this.v.y += type === VType.Fire ? 3.2 : 2.25;
        this.m.compose(this.v, this.q, this.sc);
        this.sirens.setMatrixAt(ns, this.m);
        const ph = Math.sin(this.t * 14 + i) > 0;
        this.col.setRGB(ph ? 3 : 0.1, 0.1, ph ? 0.1 : 3);
        this.sirens.setColorAt(ns, this.col);
        ns++;
      }
      void VEH_FLAG_BRAKE; void VEH_FLAG_YIELD;
    }
    for (let t = 0; t < VTYPE_COUNT; t++) {
      const im = this.veh[t];
      im.count = counts[t];
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    this.lights.count = nl;
    this.lights.instanceMatrix.needsUpdate = true;
    (this.lights.material as THREE.MeshBasicMaterial).color.setScalar(0.4 + 2.2 * night);
    this.sirens.count = ns;
    this.sirens.instanceMatrix.needsUpdate = true;
    if (this.sirens.instanceColor) this.sirens.instanceColor.needsUpdate = true;

    // ---- pedestrians ----
    const cp = cur.ped, pp = prev?.ped;
    let nb = 0, nu = 0, nbk = 0, nbag = 0;
    const camP = this.app.rig.camera.position;
    const farCull = Math.max(450, camP.y * 4);
    for (let i = 0; i < MAX_PEDS; i++) {
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
      if (Math.abs(x - camP.x) > farCull || Math.abs(z - camP.z) > farCull) continue;
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
      if (bike) { this.v.y = y; this.m.compose(this.v, this.q, this.sc); this.bikes.setMatrixAt(nbk++, this.m); }
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
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }

    // ---- trains ----
    const tc = cur.train, tp = prev?.train;
    const tcount = new Array(6).fill(0);
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
      const im = this.trains[type];
      if (!im) continue;
      this.q.setFromAxisAngle(this.up, -h);
      this.v.set(x, y + 0.3, z);
      this.m.compose(this.v, this.q, this.sc);
      im.setMatrixAt(tcount[type]++, this.m);
    }
    this.trains.forEach((im, k) => { im.count = tcount[k]; im.instanceMatrix.needsUpdate = true; });
  }

  vehiclePos(slot: number, gen: number): { p: THREE.Vector3; h: number } | null {
    const c = this.app.curSnap;
    if (!c) return null;
    const o = slot * VEH_STRIDE;
    if (!c.veh[o + 4] || (gen >= 0 && c.veh[o + 5] !== gen)) return null;
    return { p: new THREE.Vector3(this.vPos[slot * 4], this.vPos[slot * 4 + 1], this.vPos[slot * 4 + 2]), h: this.vPos[slot * 4 + 3] };
  }
  pedPos(slot: number, gen: number): { p: THREE.Vector3; h: number } | null {
    const c = this.app.curSnap;
    if (!c) return null;
    const o = slot * PED_STRIDE;
    if (c.ped[o + 4] < 0 || (gen >= 0 && c.ped[o + 4] !== gen)) return null;
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
      for (let i = 0; i < MAX_PEDS; i++) { const o = i * PED_STRIDE; if (c.ped[o + 4] >= 0 && c.ped[o + 6] === id) return { p: new THREE.Vector3(this.pPos[i * 4], this.pPos[i * 4 + 1], this.pPos[i * 4 + 2]), h: this.pPos[i * 4 + 3], inside: false }; }
      for (let i = 0; i < MAX_VEHICLES; i++) { const o = i * VEH_STRIDE; if (c.veh[o + 4] && c.veh[o + 8] === id) return { p: new THREE.Vector3(this.vPos[i * 4], this.vPos[i * 4 + 1], this.vPos[i * 4 + 2]), h: this.vPos[i * 4 + 3], inside: false }; }
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
    for (let i = 0; i < MAX_PEDS; i++) {
      const o = i * PED_STRIDE;
      if (c.ped[o + 4] < 0) continue;
      p.set(this.pPos[i * 4], this.pPos[i * 4 + 1] + 1, this.pPos[i * 4 + 2]);
      const d = r.distanceSqToPoint(p);
      const along = p.clone().sub(r.origin).length();
      if (d < Math.max(2.2, along * 0.008) ** 2 && along < bd) { bd = along; best = { kind: 'ped', slot: i, gen: c.ped[o + 4], citizen: c.ped[o + 6] }; }
    }
    for (let i = 0; i < MAX_VEHICLES; i++) {
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
