import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BuildingView } from '../shared/protocol';
import { buildingGeometry, patchBuildingMaterial } from './buildingGeom';
import { GB } from './geomBuilder';
import type { Particles } from './particles';
import { U } from './uniforms';
import { KINDS } from '../shared/catalog';

const CHUNK = 300;

interface Entry { view: BuildingView; geo: THREE.BufferGeometry | null; chunk: string | null; smoke: number[]; blades: number[]; lights: number[] }

/** Completed buildings are merged per spatial chunk; buildings in works get individual animated visuals. */
export class BuildingsLayer {
  group = new THREE.Group();
  private entries = new Map<number, Entry>();
  private chunks = new Map<string, { mesh: THREE.Mesh | null; ids: Set<number>; dirty: boolean; ranges: { start: number; end: number; id: number }[] }>();
  private works = new Map<number, ConstructionVisual>();
  private boosting = new Map<number, { mesh: THREE.Mesh; t: number }>();
  private rotors = new Map<number, THREE.Group[]>();
  material: THREE.MeshStandardMaterial;
  private boostMat: THREE.MeshStandardMaterial;
  private uBoost = { value: 0 };
  private rotorGeo: THREE.BufferGeometry;
  private rotorMat = new THREE.MeshStandardMaterial({ color: 0xf6f6f6, roughness: 0.6 });
  beacons: THREE.InstancedMesh;
  private beaconDirty = true;
  private t = 0;

  constructor(private smokeP: Particles, private glowP: Particles, private dustP: Particles) {
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05 });
    patchBuildingMaterial(this.material, U as unknown as Record<string, THREE.IUniform>);
    this.boostMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05 });
    this.boostMat.defines = { USE_BOOST: 1 };
    patchBuildingMaterial(this.boostMat, U as unknown as Record<string, THREE.IUniform>, { uLitBoost: this.uBoost });
    const rg = new GB();
    for (let i = 0; i < 3; i++) {
      rg.setTransform(0, 0, 0, 0);
      const a = (i / 3) * Math.PI * 2;
      // blade in the XY plane
      const c = Math.cos(a), s = Math.sin(a);
      const L = 1, W = 0.06;
      const p = [[-W * s * 0 + 0, 0, 0], [c * L - s * W, s * L + c * W, 0], [c * L + s * W, s * L - c * W, 0]];
      rg.tri(p as number[][], new THREE.Color(0xf6f6f6));
      rg.tri([p[0], p[2], p[1]] as number[][], new THREE.Color(0xf6f6f6));
    }
    this.rotorGeo = rg.toGeometry(false);
    const bg = new THREE.SphereGeometry(0.7, 6, 4);
    this.beacons = new THREE.InstancedMesh(bg, new THREE.MeshBasicMaterial({ color: 0xff3020 }), 2000);
    this.beacons.count = 0;
    this.group.add(this.beacons);
  }

  get(id: number) { return this.entries.get(id)?.view; }
  all() { return [...this.entries.values()].map((e) => e.view); }

  upsert(v: BuildingView) {
    let e = this.entries.get(v.id);
    const prev = e?.view;
    if (!e) { e = { view: v, geo: null, chunk: null, smoke: [], blades: [], lights: [] }; this.entries.set(v.id, e); }
    e.view = v;
    if (v.state === 'done') {
      const needGeo = !e.geo || !prev || prev.abandoned !== v.abandoned || prev.decay !== v.decay || prev.squatted !== v.squatted || prev.state !== 'done' || prev.variant !== v.variant || prev.heritage !== v.heritage;
      const wasWork = this.works.get(v.id);
      if (wasWork) { wasWork.dispose(this.group); this.works.delete(v.id); }
      if (needGeo) {
        const r = buildingGeometry(v);
        e.geo?.dispose();
        e.geo = r.geo; e.smoke = r.smoke; e.blades = r.blades; e.lights = r.lights;
        this.beaconDirty = true;
        this.setRotors(v.id, r.blades);
        if (prev && prev.state !== 'done') {
          // lights turning on: show individually for a moment before merging
          const m = new THREE.Mesh(e.geo, this.boostMat);
          m.castShadow = true; m.receiveShadow = true;
          this.group.add(m);
          this.boosting.set(v.id, { mesh: m, t: 0 });
          this.removeFromChunk(v.id);
          return;
        }
        this.placeInChunk(v.id);
      }
    } else {
      this.removeFromChunk(v.id);
      let w = this.works.get(v.id);
      if (!w) { w = new ConstructionVisual(v, this.material); this.works.set(v.id, w); this.group.add(w.group); }
      w.view = v;
      if (v.state === 'demolishing' && !w.demo) w.startDemolition(e.geo ?? buildingGeometry({ ...v, state: 'done' }).geo, this.material);
    }
  }

  remove(id: number) {
    this.removeFromChunk(id);
    const w = this.works.get(id);
    if (w) { w.dispose(this.group); this.works.delete(id); }
    const bo = this.boosting.get(id);
    if (bo) { this.group.remove(bo.mesh); this.boosting.delete(id); }
    this.setRotors(id, []);
    const e = this.entries.get(id);
    e?.geo?.dispose();
    this.entries.delete(id);
    this.beaconDirty = true;
  }

  private setRotors(id: number, blades: number[]) {
    const old = this.rotors.get(id);
    if (old) for (const r of old) this.group.remove(r);
    this.rotors.delete(id);
    if (!blades.length) return;
    const arr: THREE.Group[] = [];
    for (let i = 0; i < blades.length; i += 4) {
      const g = new THREE.Group();
      const m = new THREE.Mesh(this.rotorGeo, this.rotorMat);
      m.scale.setScalar(blades[i + 3]);
      g.add(m);
      g.position.set(blades[i], blades[i + 1], blades[i + 2]);
      g.rotation.y = this.entries.get(id)!.view.angle;
      this.group.add(g);
      arr.push(g);
    }
    this.rotors.set(id, arr);
  }

  private key(v: BuildingView) { return `${Math.floor(v.x / CHUNK)},${Math.floor(v.z / CHUNK)}`; }
  private placeInChunk(id: number) {
    const e = this.entries.get(id)!;
    const k = this.key(e.view);
    if (e.chunk && e.chunk !== k) this.removeFromChunk(id);
    let c = this.chunks.get(k);
    if (!c) { c = { mesh: null, ids: new Set(), dirty: true, ranges: [] }; this.chunks.set(k, c); }
    c.ids.add(id); c.dirty = true; e.chunk = k;
  }
  private removeFromChunk(id: number) {
    const e = this.entries.get(id);
    if (!e || !e.chunk) return;
    const c = this.chunks.get(e.chunk);
    if (c) { c.ids.delete(id); c.dirty = true; }
    e.chunk = null;
  }

  private rebuildChunk(c: { mesh: THREE.Mesh | null; ids: Set<number>; dirty: boolean; ranges: { start: number; end: number; id: number }[] }) {
    c.dirty = false;
    if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh = null; }
    const geos: THREE.BufferGeometry[] = [];
    c.ranges = [];
    let v = 0;
    for (const id of c.ids) {
      const e = this.entries.get(id);
      if (!e?.geo) continue;
      geos.push(e.geo);
      const n = e.geo.attributes.position.count;
      c.ranges.push({ start: v, end: v + n, id });
      v += n;
    }
    if (!geos.length) return;
    const merged = mergeGeometries(geos, false);
    if (!merged) return;
    const m = new THREE.Mesh(merged, this.material);
    m.castShadow = true; m.receiveShadow = true;
    m.userData.chunk = c;
    m.name = 'bchunk';
    this.group.add(m);
    c.mesh = m;
  }

  /** returns building id for a raycast hit on a chunk/construction mesh */
  pick(hit: THREE.Intersection): number | null {
    const obj = hit.object as THREE.Mesh;
    if (obj.userData.chunk && hit.face) {
      const c = obj.userData.chunk as { ranges: { start: number; end: number; id: number }[] };
      const vi = hit.face.a;
      for (const r of c.ranges) if (vi >= r.start && vi < r.end) return r.id;
    }
    let o: THREE.Object3D | null = obj;
    while (o) { if (o.userData.bid) return o.userData.bid; o = o.parent; }
    for (const [id, b] of this.boosting) if (b.mesh === obj) return id;
    return null;
  }

  pickables(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const c of this.chunks.values()) if (c.mesh) out.push(c.mesh);
    for (const w of this.works.values()) out.push(w.group);
    for (const b of this.boosting.values()) out.push(b.mesh);
    return out;
  }

  update(dt: number, simDt: number, night: number) {
    this.t += dt;
    let rebuilt = 0;
    for (const c of this.chunks.values()) if (c.dirty && rebuilt < 2) { this.rebuildChunk(c); rebuilt++; }
    for (const [id, b] of this.boosting) {
      b.t += dt;
      this.uBoost.value = Math.min(1, b.t / 2.5);
      if (b.t > 3) { this.group.remove(b.mesh); this.boosting.delete(id); this.placeInChunk(id); }
    }
    for (const w of this.works.values()) w.update(dt, this.t, this.dustP);
    // rotors
    for (const arr of this.rotors.values()) for (const r of arr) r.children[0].rotation.z += dt * (0.8 + U.uWind.value * 1.5) * Math.min(4, 1 + simDt);
    // smoke from active chimneys + fires
    for (const e of this.entries.values()) {
      const v = e.view;
      if (v.state === 'done' && !v.abandoned && e.smoke.length) {
        const rate = KINDS[v.kind].cat === 'power' || KINDS[v.kind].cat === 'ind' ? 1 : 0.4;
        for (let i = 0; i < e.smoke.length; i += 3) {
          if (Math.random() < dt * 3 * rate) {
            const sh = 0.6 + Math.random() * 0.25;
            const big = v.kind === 'thermalPlant' || v.kind === 'nuclearPlant';
            this.smokeP.emit(e.smoke[i], e.smoke[i + 1], e.smoke[i + 2], (Math.random() - 0.5) * 0.6, 2 + Math.random(), (Math.random() - 0.5) * 0.6, 14, big ? 9 : 4, sh, sh, sh * 1.02, big ? 0.55 : 0.4, big ? 2.2 : 1.1);
          }
        }
      }
      if (v.fire > 0) {
        const top = v.y + v.height;
        for (let k = 0; k < 3; k++) {
          if (Math.random() < dt * 20 * v.fire) {
            const ox = (Math.random() - 0.5) * v.w * 0.6, oz = (Math.random() - 0.5) * v.d * 0.6;
            this.glowP.emit(v.x + ox, top * (0.6 + Math.random() * 0.4), v.z + oz, 0, 3 + Math.random() * 3, 0, 1.2, 4 + Math.random() * 3, 1, 0.45 + Math.random() * 0.3, 0.1, 0.9, -1.5);
            this.smokeP.emit(v.x + ox, top + 2, v.z + oz, 0, 4, 0, 10, 6, 0.18, 0.17, 0.16, 0.6, 2.5);
          }
        }
      }
    }
    if (this.beaconDirty) this.rebuildBeacons();
    (this.beacons.material as THREE.MeshBasicMaterial).color.setRGB(1, 0.2 * (1 - night), 0.1).multiplyScalar(0.3 + 0.7 * (Math.sin(this.t * 3) > 0 ? 1 : 0.2));
  }

  private rebuildBeacons() {
    this.beaconDirty = false;
    const m = new THREE.Matrix4();
    let n = 0;
    for (const e of this.entries.values()) {
      for (let i = 0; i < e.lights.length && n < 2000; i += 3) { m.makeTranslation(e.lights[i], e.lights[i + 1], e.lights[i + 2]); this.beacons.setMatrixAt(n++, m); }
    }
    this.beacons.count = n;
    this.beacons.instanceMatrix.needsUpdate = true;
  }

  heightAtBuilding(id: number): number {
    const v = this.entries.get(id)?.view;
    return v ? v.y + v.height : 0;
  }
}

/** Animated construction site: lot staking, earthwork, foundation, floor-by-floor structure with tower crane, facade, lights. */
class ConstructionVisual {
  group = new THREE.Group();
  view: BuildingView;
  private skeleton: THREE.Mesh;
  private skelMat: THREE.MeshStandardMaterial;
  private facade: THREE.Mesh;
  private facadeMat: THREE.MeshStandardMaterial;
  private scaffold: THREE.Mesh;
  private site: THREE.Mesh;
  private crane: THREE.Group | null = null;
  private jib: THREE.Group | null = null;
  private hook: THREE.Mesh | null = null;
  private load: THREE.Mesh | null = null;
  private mast: THREE.Mesh | null = null;
  private slab: THREE.Mesh;
  private skelPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  private facPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  demo: { mesh: THREE.Mesh; debris: THREE.Mesh } | null = null;
  private digger: THREE.Mesh;
  private flH: number;

  constructor(v: BuildingView, baseMat: THREE.MeshStandardMaterial) {
    this.view = v;
    this.group.userData.bid = v.id;
    const ca = Math.cos(v.angle), sa = Math.sin(v.angle);
    void ca; void sa;
    // lot / earthwork
    const sg = new GB();
    sg.setTransform(v.x, v.y, v.z, v.angle);
    sg.flat(0, 0.05, 0, v.w + 1, v.d + 1, new THREE.Color(0x9a7a55));
    const tape = new THREE.Color(0xff7a1a);
    sg.box(0, 0, -v.d / 2 - 0.6, v.w + 1.2, 0.9, 0.08, tape); sg.box(0, 0, v.d / 2 + 0.6, v.w + 1.2, 0.9, 0.08, tape);
    sg.box(-v.w / 2 - 0.6, 0, 0, 0.08, 0.9, v.d + 1.2, tape); sg.box(v.w / 2 + 0.6, 0, 0, 0.08, 0.9, v.d + 1.2, tape);
    for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) sg.box(px * (v.w / 2 + 0.6), 0, pz * (v.d / 2 + 0.6), 0.2, 1.4, 0.2, new THREE.Color(0xffffff));
    sg.box(v.w / 2 - 2, 0, v.d / 2 - 2, 2.4, 2.6, 4.5, new THREE.Color(0xe8e2d0)); // site office
    sg.pyramid(-v.w / 3, 0, v.d / 3, 5, 5, 2.2, new THREE.Color(0x8a6a45)); // dirt pile
    this.site = new THREE.Mesh(sg.toGeometry(false), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    this.site.receiveShadow = true;
    this.group.add(this.site);
    // digger
    const dg = new GB();
    dg.box(0, 0, 0, 2.4, 1.6, 3.4, new THREE.Color(0xf0b020));
    dg.box(0, 1.6, -0.4, 1.8, 1.4, 1.8, new THREE.Color(0xf0b020));
    dg.box(0, 1.4, 2.6, 0.4, 0.4, 3, new THREE.Color(0xd09010));
    this.digger = new THREE.Mesh(dg.toGeometry(false), new THREE.MeshStandardMaterial({ vertexColors: true }));
    this.digger.castShadow = true;
    this.group.add(this.digger);
    // slab
    const slabG = new THREE.BoxGeometry(v.w - 1, 1, v.d - 1);
    slabG.translate(0, 0.5, 0);
    this.slab = new THREE.Mesh(slabG, new THREE.MeshStandardMaterial({ color: 0xa8a49c, roughness: 0.9 }));
    this.slab.position.set(v.x, v.y, v.z);
    this.slab.rotation.y = -v.angle;
    this.slab.scale.y = 0.01;
    this.group.add(this.slab);
    // skeleton: slabs + columns for every floor
    this.flH = v.height / Math.max(1, v.floors);
    const kg = new GB();
    kg.setTransform(v.x, v.y, v.z, v.angle);
    const conc = new THREE.Color(0xb9b5ad), rebar = new THREE.Color(0x6a5a50);
    const fw = Math.max(4, v.w * 0.8), fd = Math.max(4, v.d * 0.75);
    const isBig = KINDS[v.kind].cat === 'ind' || v.w > 40;
    const nCol = isBig ? 5 : 3;
    for (let f = 0; f < Math.max(1, v.floors); f++) {
      const y = f * this.flH;
      for (let i = 0; i < nCol; i++) for (let k = 0; k < nCol; k++) {
        kg.box(-fw / 2 + (i * fw) / (nCol - 1), y, -fd / 2 + (k * fd) / (nCol - 1), 0.5, this.flH, 0.5, f % 2 ? conc : rebar);
      }
      kg.box(0, y + this.flH - 0.3, 0, fw + 0.4, 0.3, fd + 0.4, conc);
    }
    this.skelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, clippingPlanes: [this.skelPlane] });
    this.skeleton = new THREE.Mesh(kg.toGeometry(false), this.skelMat);
    this.skeleton.castShadow = true;
    this.group.add(this.skeleton);
    // final facade (revealed bottom-up)
    this.facadeMat = baseMat.clone();
    this.facadeMat.onBeforeCompile = baseMat.onBeforeCompile;
    this.facadeMat.clippingPlanes = [this.facPlane];
    this.facade = new THREE.Mesh(buildingGeometry({ ...v, state: 'done' }).geo, this.facadeMat);
    this.facade.castShadow = true;
    this.group.add(this.facade);
    // scaffold (semi-transparent net)
    const scG = new THREE.BoxGeometry(fw + 2.4, 1, fd + 2.4);
    scG.translate(0, 0.5, 0);
    this.scaffold = new THREE.Mesh(scG, new THREE.MeshStandardMaterial({ color: 0x3fa04a, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
    this.scaffold.position.set(v.x, v.y, v.z);
    this.scaffold.rotation.y = -v.angle;
    this.group.add(this.scaffold);
    // tower crane for taller buildings
    if (v.height > 9) this.makeCrane(v);
  }

  private makeCrane(v: BuildingView) {
    const crane = new THREE.Group();
    const yellow = new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.6 });
    const mastG = new THREE.BoxGeometry(1.6, 1, 1.6); mastG.translate(0, 0.5, 0);
    this.mast = new THREE.Mesh(mastG, yellow);
    this.mast.castShadow = true;
    crane.add(this.mast);
    const jib = new THREE.Group();
    const L = Math.max(22, Math.max(v.w, v.d) * 1.1);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(L, 1.1, 1.1).translate(L / 2 - 6, 0, 0), yellow);
    const counter = new THREE.Mesh(new THREE.BoxGeometry(3, 2, 2).translate(-6, -0.6, 0), new THREE.MeshStandardMaterial({ color: 0x777777 }));
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2).translate(0, -1.5, 1.6), new THREE.MeshStandardMaterial({ color: 0xffffff }));
    const apex = new THREE.Mesh(new THREE.ConeGeometry(0.9, 5, 4).translate(0, 3, 0), yellow);
    jib.add(arm, counter, cab, apex);
    arm.castShadow = true;
    const hook = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1, 0.15).translate(0, -0.5, 0), new THREE.MeshBasicMaterial({ color: 0x222222 }));
    hook.position.x = L * 0.5;
    const load = new THREE.Mesh(new THREE.BoxGeometry(3, 0.6, 1.2), new THREE.MeshStandardMaterial({ color: 0x8a6a45 }));
    jib.add(hook, load);
    this.hook = hook;
    this.load = load;
    crane.add(jib);
    this.jib = jib;
    const ca = Math.cos(v.angle), sa = Math.sin(v.angle);
    const ox = v.w / 2 + 3, oz = -v.d / 2 + 2;
    crane.position.set(v.x + ox * ca - oz * sa, v.y, v.z + ox * sa + oz * ca);
    this.crane = crane;
    this.group.add(crane);
  }

  startDemolition(geo: THREE.BufferGeometry, mat: THREE.Material) {
    this.group.clear();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    const v = this.view;
    const debG = new GB();
    debG.setTransform(v.x, v.y, v.z, v.angle);
    for (let i = 0; i < 5; i++) debG.pyramid((i - 2) * v.w / 6, 0, ((i * 7) % 5 - 2) * v.d / 8, v.w / 2.5, v.d / 2.5, 1 + Math.min(6, v.height / 8), new THREE.Color([0x9a948a, 0x8a8478, 0xa8a094][i % 3]));
    const debris = new THREE.Mesh(debG.toGeometry(false), new THREE.MeshStandardMaterial({ vertexColors: true }));
    debris.scale.y = 0.01;
    this.group.add(mesh, debris);
    this.demo = { mesh, debris };
  }

  update(dt: number, t: number, dust: Particles) {
    const v = this.view;
    if (this.demo) {
      const p = v.progress;
      const fall = Math.min(1, Math.max(0, (p - 0.15) / 0.6));
      const m = this.demo.mesh;
      m.scale.y = Math.max(0.02, 1 - fall * fall);
      m.position.y = v.y * (1 - m.scale.y);
      m.position.x = (Math.random() - 0.5) * 0.3 * (fall > 0 && fall < 1 ? 1 : 0);
      this.demo.debris.scale.y = Math.min(1, fall * 1.3);
      this.demo.debris.position.y = v.y * (1 - this.demo.debris.scale.y);
      if (fall > 0 && fall < 1 && Math.random() < dt * 40) {
        const r = Math.max(v.w, v.d) * 0.6;
        dust.emit(v.x + (Math.random() - 0.5) * r, v.y + Math.random() * v.height * (1 - fall), v.z + (Math.random() - 0.5) * r, (Math.random() - 0.5) * 3, 1 + Math.random() * 2, (Math.random() - 0.5) * 3, 6, 6 + Math.random() * 6, 0.75, 0.7, 0.62, 0.5, 3);
      }
      return;
    }
    const p = v.progress;
    const H = v.height;
    const sitePhase = p < 0.22;
    this.digger.visible = sitePhase;
    if (sitePhase) {
      const ang = t * 0.5;
      const ca = Math.cos(v.angle), sa = Math.sin(v.angle);
      const lx = Math.cos(ang) * v.w * 0.25, lz = Math.sin(ang * 1.3) * v.d * 0.25;
      this.digger.position.set(v.x + lx * ca - lz * sa, v.y + 0.1, v.z + lx * sa + lz * ca);
      this.digger.rotation.y = -v.angle + ang;
      if (Math.random() < dt * 4) dust.emit(this.digger.position.x, v.y + 0.5, this.digger.position.z, (Math.random() - 0.5), 0.8, (Math.random() - 0.5), 3, 3, 0.65, 0.55, 0.42, 0.45, 1.5);
    }
    this.slab.scale.y = Math.max(0.01, Math.min(1, (p - 0.08) / 0.14));
    this.slab.visible = p > 0.08;
    // structure grows one floor at a time
    const sFrac = Math.min(1, Math.max(0, (p - 0.22) / 0.5));
    const floorsUp = Math.ceil(sFrac * v.floors);
    const structTop = v.y + floorsUp * this.flH;
    this.skelPlane.constant = sFrac <= 0 ? v.y - 1 : structTop + 0.01;
    this.skeleton.visible = p > 0.22;
    const fFrac = Math.min(1, Math.max(0, (p - 0.72) / 0.28));
    this.facPlane.constant = fFrac <= 0 ? v.y - 50 : v.y + H * 1.15 * fFrac;
    this.facade.visible = p > 0.72;
    const scH = Math.max(0.1, (p < 0.72 ? floorsUp * this.flH : H * (1 - fFrac * 0.7)) + 1.5);
    this.scaffold.scale.y = scH;
    this.scaffold.visible = p > 0.22 && fFrac < 0.95;
    if (this.crane && this.mast && this.jib && this.hook) {
      const top = Math.max(12, (p < 0.72 ? floorsUp * this.flH : H) + 10);
      this.mast.scale.y = top;
      this.jib.position.y = top;
      this.jib.rotation.y = Math.sin(t * 0.25 + v.id) * 1.6;
      const hl = 4 + (Math.sin(t * 0.7 + v.id * 3) * 0.5 + 0.5) * (top - 6);
      this.hook.scale.y = hl;
      this.hook.position.x = 8 + (Math.sin(t * 0.3 + v.id) * 0.5 + 0.5) * 12;
      if (this.load) this.load.position.set(this.hook.position.x, -hl - 0.4, 0);
      // a stalled site loses its crane: just the bare skeleton and rusting scaffold remain
      this.crane.visible = fFrac < 0.9 && !v.stalled;
      if (v.stalled) this.jib.rotation.y = 0.4;
    }
  }

  dispose(parent: THREE.Group) {
    parent.remove(this.group);
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry && m !== this.demo?.mesh) m.geometry.dispose(); });
  }
}
