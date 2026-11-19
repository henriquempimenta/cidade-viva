import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { DAYS_PER_YEAR, DAYS_PER_SEASON, SEASONS, MAX_VEHICLES } from './shared/constants';
import type { SimParams } from './shared/params';
import type { FromWorker, SimEvent, Snapshot, Stats, ToWorker, WorldDiff, WorldInit } from './shared/protocol';
import { SceneRig } from './render/scene';
import { TerrainView } from './render/terrainMesh';
import { makeWater } from './render/water';
import { TreesView } from './render/trees';
import { RoadsLayer } from './render/roadsLayer';
import { BuildingsLayer } from './render/buildingsLayer';
import { RailLayer } from './render/railLayer';
import { Particles } from './render/particles';
import { U, makeOutageTexture } from './render/uniforms';
import { Director, type DirectorWorld } from './director/director';
import { Hud } from './ui/hud';
import { AgentsLayer } from './render/agentsLayer';
import { Effects } from './render/effects';
import { Overlays } from './render/overlays';
import { AudioEngine } from './audio/audio';

export type CamMode = 'auto' | 'free' | 'follow' | 'cinematic';

export class App {
  worker!: Worker;
  rig!: SceneRig;
  terrain!: TerrainView;
  trees!: TreesView;
  roads!: RoadsLayer;
  buildings!: BuildingsLayer;
  rail!: RailLayer;
  agents!: AgentsLayer;
  effects!: Effects;
  overlays!: Overlays;
  smoke!: Particles; glow!: Particles; dust!: Particles;
  director!: Director;
  hud!: Hud;
  audio = new AudioEngine();
  controls!: MapControls;
  init!: WorldInit;
  params!: SimParams;
  stats: Stats | null = null;
  statHistory: Stats[] = [];
  chronicle: SimEvent[] = [];
  mode: CamMode = 'auto';
  speed = 10;
  autoSpeed = false;
  private lastInput = -1e9;
  private skyline: Float32Array | null = null;
  private fieldRes = 96;
  private clock = new THREE.Clock();
  private lastCamPost = 0;
  private reqId = 1;
  private pending = new Map<number, (d: unknown) => void>();
  prevSnap: Snapshot | null = null;
  curSnap: Snapshot | null = null;
  private snapArrive = 0;
  private snapInterval = 50;
  outageTex!: THREE.DataTexture;
  follow: { kind: 'citizen' | 'vehicle' | 'ped'; id: number; gen?: number } | null = null;
  simT = 0;
  dayFrac = 0.3;
  started = false;
  fixedHour: number | null = null;
  tiltShift = 0;
  private lastSimT = 0;

  constructor(private canvas: HTMLCanvasElement, private uiRoot: HTMLElement) {}

  start(params: SimParams) {
    this.params = params;
    this.worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
    this.send({ type: 'init', params });
    this.send({ type: 'speed', speed: this.speed });
  }

  send(m: ToWorker) { this.worker.postMessage(m); }

  restart(params: SimParams) {
    this.worker.terminate();
    location.search = '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  }

  inspect<T>(kind: 'building' | 'citizen' | 'edge' | 'vehicle' | 'ped' | 'node', id: number): Promise<T> {
    const reqId = this.reqId++;
    return new Promise((res) => { this.pending.set(reqId, res as (d: unknown) => void); this.send({ type: 'inspect', kind, id, reqId }); });
  }

  private onMessage(m: FromWorker) {
    if (m.type === 'init') this.setup(m.world);
    else if (m.type === 'diff') this.applyDiff(m);
    else if (m.type === 'snap') {
      const now = performance.now();
      if (this.curSnap) this.snapInterval = this.snapInterval * 0.8 + (now - this.snapArrive) * 0.2;
      this.prevSnap = this.curSnap;
      this.curSnap = m;
      this.snapArrive = now;
      this.simT = m.t;
      this.dayFrac = m.dayFrac;
      this.roads?.setSignals(m.signals);
    } else if (m.type === 'inspect') {
      const cb = this.pending.get(m.reqId);
      if (cb) { this.pending.delete(m.reqId); cb(m.data); }
    }
  }

  private setup(init: WorldInit) {
    this.init = init;
    this.fieldRes = init.fieldRes;
    this.rig = new SceneRig(this.canvas, init.size);
    const scene = this.rig.scene;
    this.terrain = new TerrainView(init);
    scene.add(this.terrain.mesh);
    scene.add(makeWater(init.size, init.seaLevel));
    this.trees = new TreesView(init.trees);
    scene.add(this.trees.group);
    this.roads = new RoadsLayer();
    scene.add(this.roads.group);
    this.rail = new RailLayer();
    scene.add(this.rail.group);
    this.smoke = new Particles(6000, false);
    this.glow = new Particles(5000, true);
    this.dust = new Particles(3000, false);
    scene.add(this.smoke.points, this.glow.points, this.dust.points);
    this.buildings = new BuildingsLayer(this.smoke, this.glow, this.dust);
    scene.add(this.buildings.group);
    this.agents = new AgentsLayer(this);
    scene.add(this.agents.group);
    this.effects = new Effects(this);
    scene.add(this.effects.group);
    this.overlays = new Overlays(this);
    scene.add(this.overlays.group);
    this.outageTex = makeOutageTexture(init.fieldRes);
    U.uOutage.value = this.outageTex;

    this.controls = new MapControls(this.rig.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 4000;
    this.controls.enabled = false;
    const markInput = () => {
      this.lastInput = performance.now();
      if (this.mode === 'auto' || this.mode === 'cinematic') this.enterFree(true);
    };
    this.canvas.addEventListener('pointerdown', markInput);
    this.canvas.addEventListener('wheel', markInput, { passive: true });
    window.addEventListener('keydown', (e) => { if (['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) markInput(); });
    this.canvas.addEventListener('pointermove', () => { if (this.mode === 'free') this.lastInput = performance.now(); });

    const app = this;
    const dw: DirectorWorld = {
      mapSize: init.size,
      groundClear: (x, z) => this.groundClear(x, z),
      center: () => new THREE.Vector3(this.cityCenter.x, 0, this.cityCenter.z),
      cityRadius: () => this.cityRadius,
      buildingTop: (id) => { const v = app.buildings.get(id); return v ? v.y + v.height : null; },
      buildingProgress: (id) => { const v = app.buildings.get(id); return v ? (v.state === 'done' ? 1 : v.progress) : null; },
      buildingPos: (id) => { const v = app.buildings.get(id); return v ? new THREE.Vector3(v.x, v.y, v.z) : null; },
      edgePts: (id) => app.roads.edges.get(id)?.pts ?? null,
      edgeProgress: (id) => app.roads.edges.get(id)?.progress ?? 1,
      vehiclePos: (slot, gen) => app.agents.vehiclePos(slot, gen),
      pedPos: (slot, gen) => app.agents.pedPos(slot, gen),
      trainPos: (i) => app.agents.trainPos(i),
      citizenPos: (id) => app.agents.citizenPos(id),
      flyPaths: () => this.flyPaths(),
      dateLabel: () => this.dateLabel(),
    };
    this.director = new Director(dw);
    this.director.onCaption = (t) => this.hud.caption(t);
    this.hud = new Hud(this, this.uiRoot);
    const c = this.cityCenter;
    this.rig.camera.position.set(c.x + 300, 220, c.z + 300);
    this.controls.target.set(c.x, 0, c.z);
    this.started = true;
    document.getElementById('loading')!.style.opacity = '0';
    setTimeout(() => document.getElementById('loading')?.remove(), 1200);
    this.loop();
  }

  cityCenter = { x: 0, z: 0 };
  cityRadius = 200;

  private applyDiff(d: WorldDiff) {
    if (!this.started) return;
    d.nodes?.forEach((n) => this.roads.upsertNode(n));
    d.edges?.forEach((e) => this.roads.upsertEdge(e));
    d.removedEdges?.forEach((id) => this.roads.removeEdge(id));
    if (d.buildings) {
      for (const b of d.buildings) this.buildings.upsert(b);
      this.updateCityExtent();
    }
    d.removedBuildings?.forEach((id) => this.buildings.remove(id));
    if (d.treesRemoved) this.trees.remove(d.treesRemoved);
    d.rail?.forEach((r) => this.rail.upsert(r));
    d.stations?.forEach((s) => this.rail.upsertStation(s));
    if (d.crossings) this.rail.setCrossings(d.crossings);
    d.lines?.forEach((l) => this.overlays.upsertLine(l));
    d.removedLines?.forEach((id) => this.overlays.removeLine(id));
    d.powerLines?.forEach((p) => this.effects.upsertPowerLine(p));
    if (d.skyline) this.skyline = d.skyline;
    if (d.outage) {
      const data = this.outageTex.image.data as Uint8Array;
      for (let i = 0; i < d.outage.length; i++) data[i * 4] = d.outage[i] * 255;
      this.outageTex.needsUpdate = true;
    }
    if (d.fields) this.overlays.setField(d.fields.name, d.fields.data, d.fields.max);
    if (d.heights) this.terrain.updateHeights(d.heights);
    if (d.floodLevel !== undefined) this.effects.setFlood(d.floodLevel);
    if (d.dikes) this.effects.setDikes(d.dikes);
    if (d.stats) {
      this.stats = d.stats;
      this.statHistory.push(d.stats);
      if (this.statHistory.length > 600) this.statHistory.splice(0, this.statHistory.length - 600);
      this.hud.updateStats(d.stats);
    }
    if (d.events) for (const ev of d.events) {
      this.director.push(ev);
      this.effects.onEvent(ev);
      this.audio.onEvent(ev);
      if (ev.headline) { this.chronicle.push(ev); this.hud.addChronicle(ev); }
      if (ev.type === 'era' || ev.type === 'landmark' || ev.type === 'district') this.hud.toast(ev.text);
    }
  }

  private updateCityExtent() {
    const all = this.buildings.all();
    if (!all.length) return;
    let sx = 0, sz = 0;
    for (const b of all) { sx += b.x; sz += b.z; }
    const cx = sx / all.length, cz = sz / all.length;
    let r = 0;
    for (const b of all) r += Math.hypot(b.x - cx, b.z - cz);
    this.cityCenter = { x: cx, z: cz };
    this.cityRadius = Math.max(150, (r / all.length) * 1.6);
  }

  groundClear(x: number, z: number): number {
    let h = Math.max(0, this.terrain.heightAt(x, z));
    if (this.skyline) {
      const G = this.fieldRes, c = this.init.size / G;
      const i = Math.floor(x / c), j = Math.floor(z / c);
      if (i >= 0 && j >= 0 && i < G && j < G) h = Math.max(h, this.skyline[j * G + i]);
    }
    return h + 6;
  }

  flyPaths(): THREE.Vector3[][] {
    const paths: THREE.Vector3[][] = [];
    // major roads chains
    const edges = [...this.roads.edges.values()].filter((e) => e.cls >= 2 && e.progress >= 1);
    const used = new Set<number>();
    for (const e of edges) {
      if (used.has(e.id)) continue;
      const chain: THREE.Vector3[] = [];
      let cur = e;
      for (let k = 0; k < 12 && cur; k++) {
        used.add(cur.id);
        for (let i = 0; i < cur.pts.length; i += 9) chain.push(new THREE.Vector3(cur.pts[i], cur.pts[i + 1], cur.pts[i + 2]));
        const nxt = edges.find((o) => !used.has(o.id) && (o.a === cur.b || o.b === cur.b));
        if (!nxt) break;
        cur = nxt;
      }
      if (chain.length > 6) paths.push(chain);
    }
    // river
    const r = this.init.river;
    const c = this.cityCenter;
    const riv: THREE.Vector3[] = [];
    for (let i = 0; i < r.length; i += 2) if (Math.hypot(r[i] - c.x, r[i + 1] - c.z) < this.cityRadius * 2 + 400) riv.push(new THREE.Vector3(r[i], 2, r[i + 1]));
    if (riv.length > 4) paths.push(riv);
    // railway
    for (const re of this.rail.edges.values()) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < re.pts.length; i += 3) pts.push(new THREE.Vector3(re.pts[i], re.pts[i + 1], re.pts[i + 2]));
      if (pts.length > 4 && Math.hypot(pts[0].x - c.x, pts[0].z - c.z) < this.cityRadius * 2 + 300) paths.push(pts);
    }
    return paths;
  }

  dateLabel(): string {
    const s = this.stats;
    if (!s) return '';
    return `Ano ${s.year} · ${SEASONS[s.season]}`;
  }
  timeLabel(): string {
    const h = this.dayFrac * 24;
    return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
  }
  dayInSeason(): number { return this.stats ? (this.stats.day % DAYS_PER_YEAR) % DAYS_PER_SEASON + 1 : 1; }

  setSpeed(s: number) {
    this.speed = s;
    this.send({ type: 'speed', speed: s });
    this.hud?.refreshSpeed();
  }

  setMode(m: CamMode) {
    this.mode = m;
    this.controls.enabled = m === 'free';
    if (m === 'auto' || m === 'cinematic') {
      this.director.takeOver({ pos: this.rig.camera.position.clone(), look: this.controls.target.clone() });
    }
    this.rig.bokeh.enabled = m === 'cinematic';
    this.rig.tilt.uniforms.uLetter.value = m === 'cinematic' ? 0.09 : 0;
    this.uiRoot.classList.toggle('letterbox', m === 'cinematic');
    if (m !== 'follow') this.follow = null;
    this.hud?.refreshMode();
  }

  enterFree(fromInput = false) {
    if (this.mode === 'free') return;
    // keep current view as the start for free control
    const dir = new THREE.Vector3();
    this.rig.camera.getWorldDirection(dir);
    const t = this.rig.camera.position.clone().addScaledVector(dir, Math.max(60, this.rig.camera.position.y * 1.2));
    t.y = Math.max(0, this.terrain.heightAt(t.x, t.z));
    this.controls.target.copy(t);
    this.prevMode = fromInput ? this.mode : 'free';
    this.setMode('free');
  }
  private prevMode: CamMode = 'auto';

  followEntity(f: { kind: 'citizen' | 'vehicle' | 'ped'; id: number; gen?: number }) {
    this.follow = f;
    this.setMode('follow');
    if (f.kind === 'citizen') this.send({ type: 'follow', citizen: f.id });
  }

  private loop = () => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, this.clock.getDelta());
    const now = performance.now();
    U.uTime.value += dt;
    // auto-resume director after inactivity
    if (this.mode === 'free' && this.prevMode !== 'free' && now - this.lastInput > 7000) this.setMode(this.prevMode);
    const cam = this.rig.camera;
    const alpha = this.curSnap ? Math.min(1.2, (now - this.snapArrive) / Math.max(16, this.snapInterval)) : 0;
    this.agents.update(dt, alpha);
    const simDt = this.simT - this.lastSimT;
    this.lastSimT = this.simT;
    if (this.mode === 'auto' || this.mode === 'cinematic') {
      this.director.update(dt);
      cam.position.copy(this.director.pose.pos);
      cam.lookAt(this.director.pose.look);
      if (this.autoSpeed) {
        const want = this.director.preferredSpeed;
        if (want !== this.speed) this.setSpeed(want);
      }
      if (this.mode === 'cinematic') (this.rig.bokeh.uniforms as Record<string, { value: number }>)['focus'].value = cam.position.distanceTo(this.director.pose.look);
    } else if (this.mode === 'follow') {
      this.updateFollow(dt);
    } else {
      this.controls.update();
      // clearance in free mode as well
      const g = this.groundClear(cam.position.x, cam.position.z) - 3;
      if (cam.position.y < g) cam.position.y = g;
    }
    const look = this.mode === 'free' ? this.controls.target : this.director.pose.look;
    const df = this.fixedHour !== null ? this.fixedHour / 24 : this.dayFrac;
    U.uRain.value = this.stats?.rain ?? 0;
    U.uSnow.value += ((this.stats?.snow ?? 0) - U.uSnow.value) * Math.min(1, dt);
    U.uWind.value = this.curSnap?.turbine ?? 0.6;
    this.rig.updateEnvironment(df, U.uRain.value, this.stats?.fog ?? 0, U.uSnow.value, look.clone(), dt);
    this.rig.tilt.uniforms.uAmount.value = this.tiltShift;
    this.roads.update(now, this.rig.night, U.uTime.value);
    this.rail.update(now, this.curSnap?.crossings ?? new Uint8Array(0));
    this.buildings.update(dt, simDt, this.rig.night);
    this.effects.update(dt, simDt);
    this.overlays.update(dt);
    this.smoke.update(dt, -0.05, 0.05);
    this.glow.update(dt, 2, 0.3);
    this.dust.update(dt, 0.2, 0.6);
    const scale = window.innerHeight / (2 * Math.tan((cam.fov * Math.PI) / 360));
    this.smoke.setScale(scale); this.glow.setScale(scale); this.dust.setScale(scale);
    this.audio.update(cam.position, this);
    this.hud.frame(dt);
    if (now - this.lastCamPost > 400) {
      this.lastCamPost = now;
      this.send({ type: 'camera', x: cam.position.x, z: cam.position.z, h: cam.position.y });
    }
    this.rig.render();
  };

  private followPos = new THREE.Vector3();
  private updateFollow(dt: number) {
    const f = this.follow;
    const cam = this.rig.camera;
    if (!f) { this.setMode('auto'); return; }
    let p: { p: THREE.Vector3; h: number; inside?: boolean } | null = null;
    if (f.kind === 'citizen') p = this.agents.citizenPos(f.id);
    else if (f.kind === 'vehicle') p = this.agents.vehiclePos(f.id, f.gen ?? -1);
    else p = this.agents.pedPos(f.id, f.gen ?? -1);
    if (!p) return;
    const inside = !!p.inside;
    const back = inside ? 60 : f.kind === 'vehicle' ? 18 : 8;
    const up = inside ? 40 : f.kind === 'vehicle' ? 8 : 3.5;
    const t = U.uTime.value;
    const hh = inside ? t * 0.15 : p.h + Math.PI;
    const desired = new THREE.Vector3(p.p.x + Math.cos(hh) * back, p.p.y + up, p.p.z + Math.sin(hh) * back);
    if (this.followPos.lengthSq() === 0) this.followPos.copy(desired);
    this.followPos.lerp(desired, Math.min(1, dt * 2.5));
    const g = this.groundClear(this.followPos.x, this.followPos.z) - 2;
    if (this.followPos.y < g) this.followPos.y = g;
    cam.position.copy(this.followPos);
    cam.lookAt(p.p.x, p.p.y + (inside ? 8 : 1.3), p.p.z);
    this.director.takeOver({ pos: cam.position.clone(), look: p.p.clone() });
  }

  maxVehicles() { return MAX_VEHICLES; }
}
