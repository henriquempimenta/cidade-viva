import * as THREE from 'three';
import type { SimEvent } from '../shared/protocol';

export type ShotType = 'orbit' | 'establishing' | 'crane' | 'travelling' | 'flyover' | 'chase' | 'shoulder' | 'timelapse' | 'reveal';

export interface Pose { pos: THREE.Vector3; look: THREE.Vector3 }

export interface DirectorWorld {
  groundClear(x: number, z: number): number; // max(terrain, buildings) at x,z
  mapSize: number;
  center(): THREE.Vector3;
  cityRadius(): number;
  buildingTop(id: number): number | null;
  buildingProgress(id: number): number | null;
  buildingPos(id: number): THREE.Vector3 | null;
  edgePts(id: number): number[] | null;
  edgeProgress(id: number): number;
  vehiclePos(slot: number, gen: number): { p: THREE.Vector3; h: number } | null;
  pedPos(slot: number, gen: number): { p: THREE.Vector3; h: number } | null;
  trainPos(idx: number): { p: THREE.Vector3; h: number } | null;
  citizenPos(id: number): { p: THREE.Vector3; h: number; inside: boolean } | null;
  flyPaths(): THREE.Vector3[][];
  dateLabel(): string;
}

interface Candidate { ev: SimEvent; arrived: number; score: number }

const BASE: Record<string, { shot: ShotType; w: number }> = {
  construction_start: { shot: 'crane', w: 0.7 }, building_complete: { shot: 'orbit', w: 0.8 }, road_start: { shot: 'travelling', w: 0.6 },
  road_done: { shot: 'flyover', w: 0.4 }, road_upgrade: { shot: 'travelling', w: 1.1 }, demolition: { shot: 'orbit', w: 0.9 },
  district: { shot: 'reveal', w: 1.0 }, era: { shot: 'timelapse', w: 2.0 }, fire: { shot: 'orbit', w: 1.6 }, emergency: { shot: 'chase', w: 1.3 },
  police_chase: { shot: 'chase', w: 1.6 }, crime: { shot: 'orbit', w: 0.6 }, train: { shot: 'chase', w: 0.9 }, citizen: { shot: 'shoulder', w: 0.8 },
  funeral: { shot: 'chase', w: 1.1 }, wedding: { shot: 'shoulder', w: 0.8 }, birth: { shot: 'orbit', w: 0.4 }, blackout: { shot: 'establishing', w: 1.3 },
  flood: { shot: 'establishing', w: 1.5 }, festival: { shot: 'orbit', w: 1.4 }, fireworks: { shot: 'establishing', w: 1.8 }, tourists: { shot: 'shoulder', w: 1.0 },
  line_opened: { shot: 'chase', w: 1.4 }, station: { shot: 'reveal', w: 1.2 }, gentrification: { shot: 'orbit', w: 0.9 }, reconversion: { shot: 'orbit', w: 1.0 },
  bankruptcy: { shot: 'orbit', w: 0.6 }, landmark: { shot: 'reveal', w: 2.0 }, stadium_game: { shot: 'establishing', w: 1.3 }, storm: { shot: 'establishing', w: 1.2 },
  epidemic: { shot: 'establishing', w: 1.0 }, immigration: { shot: 'chase', w: 0.9 }, megafactory: { shot: 'crane', w: 1.5 }, crisis: { shot: 'establishing', w: 1.1 },
  power_line: { shot: 'flyover', w: 0.8 }, rail_build: { shot: 'travelling', w: 1.1 }, bus_line: { shot: 'chase', w: 1.0 }, city_hall: { shot: 'orbit', w: 0.7 },
  outbreak: { shot: 'orbit', w: 0.8 }, accident: { shot: 'orbit', w: 0.8 }, police_station: { shot: 'orbit', w: 1.1 },
};

const DUR: Record<ShotType, [number, number]> = {
  orbit: [7, 15], establishing: [7, 12], crane: [10, 18], travelling: [8, 14], flyover: [12, 20], chase: [10, 18], shoulder: [10, 18], timelapse: [12, 18], reveal: [9, 12],
};

export class Shot {
  t = 0;
  seed = Math.random() * 100;
  constructor(public type: ShotType, public focus: THREE.Vector3, public ev: SimEvent | null, public dur: number, public opts: Record<string, number> = {}) {}
}

export class Director {
  shot: Shot | null = null;
  pose: Pose = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  private from: Pose | null = null;
  private trans = 0;
  private transDur = 2.6;
  private cands: Candidate[] = [];
  private history: { type: string; x: number; z: number; shot: ShotType; time: number }[] = [];
  private shownConstruction = new Set<number>();
  private typeTimes = new Map<string, number[]>();
  private time = 0;
  caption: { text: string; t: number } | null = null;
  onCaption?: (text: string) => void;
  preferredSpeed = 10;
  private idleToggle = 0;

  constructor(private w: DirectorWorld) {}

  push(ev: SimEvent) {
    const base = BASE[ev.type];
    if (!base) return;
    this.cands.push({ ev, arrived: this.time, score: 0 });
    const arr = this.typeTimes.get(ev.type) ?? [];
    arr.push(this.time);
    while (arr.length && this.time - arr[0] > 240) arr.shift();
    this.typeTimes.set(ev.type, arr);
    if (this.cands.length > 120) this.cands.splice(0, this.cands.length - 120);
  }

  private score(c: Candidate): number {
    const ev = c.ev;
    const base = BASE[ev.type];
    const age = this.time - c.arrived;
    const novelty = Math.exp(-age / 40);
    const freq = this.typeTimes.get(ev.type)?.length ?? 1;
    const rarity = 1 / Math.sqrt(freq);
    const visual = ev.visual ?? 0.5;
    let rep = 0;
    for (const h of this.history.slice(-3)) {
      if (h.type === ev.type) rep += 0.25;
      if (Math.hypot(h.x - ev.x, h.z - ev.z) < 150) rep += 0.2;
    }
    rep = Math.min(0.9, rep);
    let narrative = 0;
    if (ev.type === 'building_complete' && ev.ref !== undefined && this.shownConstruction.has(ev.ref)) narrative = 1.2;
    if ((ev.type === 'construction_start') && ev.ref !== undefined && this.w.buildingProgress(ev.ref) === null) return 0;
    return base.w * (0.3 + ev.mag) * novelty * rarity * (0.4 + visual) * (1 - rep) + narrative;
  }

  update(dt: number) {
    this.time += dt;
    for (const c of this.cands) c.score = this.score(c);
    this.cands = this.cands.filter((c) => c.score > 0.02 && this.time - c.arrived < 150);
    let best: Candidate | null = null;
    for (const c of this.cands) if (!best || c.score > best.score) best = c;
    const s = this.shot;
    const [minD] = s ? DUR[s.type] : [0];
    const curScore = s?.ev ? 0.35 : 0.15;
    if (!s || s.t > s.dur || (s.t > minD && best && best.score > curScore * 1.4) || (s && this.shotInvalid(s))) {
      if (best && best.score > 0.18) { this.cands.splice(this.cands.indexOf(best), 1); this.start(this.makeShot(best.ev)); }
      else this.start(this.idleShot());
    }
    const sh = this.shot!;
    sh.t += dt;
    const target = this.evaluate(sh, dt);
    if (this.from && this.trans < this.transDur) {
      this.trans += dt;
      const u = Math.min(1, this.trans / this.transDur);
      const e = u * u * (3 - 2 * u);
      const dist = this.from.pos.distanceTo(target.pos);
      const lift = Math.min(160, dist * 0.22) * Math.sin(Math.PI * e);
      this.pose.pos.lerpVectors(this.from.pos, target.pos, e);
      this.pose.pos.y += lift;
      this.pose.look.lerpVectors(this.from.look, target.look, e * e * (3 - 2 * e) > 0 ? Math.min(1, e * 1.15) : e);
    } else {
      this.pose.pos.lerp(target.pos, Math.min(1, dt * 3));
      this.pose.look.lerp(target.look, Math.min(1, dt * 3));
    }
    this.clearance(this.pose.pos);
    if (this.caption && this.time - this.caption.t > 7) this.caption = null;
  }

  private shotInvalid(s: Shot): boolean {
    if (s.type === 'chase' || s.type === 'shoulder') return this.subjectPos(s) === null && s.t > 1.5;
    return false;
  }

  takeOver(p: Pose) {
    this.pose.pos.copy(p.pos); this.pose.look.copy(p.look);
    this.shot = null;
  }

  private start(s: Shot) {
    this.from = { pos: this.pose.pos.clone(), look: this.pose.look.clone() };
    const firstEver = this.pose.pos.lengthSq() === 0;
    this.trans = firstEver ? this.transDur : 0;
    if (firstEver) { const p = this.evaluate(s, 0); this.pose.pos.copy(p.pos); this.pose.look.copy(p.look); }
    this.shot = s;
    if (s.ev) {
      this.history.push({ type: s.ev.type, x: s.ev.x, z: s.ev.z, shot: s.type, time: this.time });
      if (s.ev.type === 'construction_start' && s.ev.ref !== undefined) this.shownConstruction.add(s.ev.ref);
      const text = `${this.w.dateLabel()} — ${s.ev.text}`;
      this.caption = { text, t: this.time };
      this.onCaption?.(text);
    } else this.history.push({ type: 'idle', x: s.focus.x, z: s.focus.z, shot: s.type, time: this.time });
    if (this.history.length > 20) this.history.shift();
    this.preferredSpeed = { orbit: 10, establishing: 100, crane: 10, travelling: 10, flyover: 30, chase: 1, shoulder: 1, timelapse: 400, reveal: 30 }[s.type];
    if (s.type === 'crane' && s.ev?.ref !== undefined) {
      // crane shots of tall buildings need time-lapse-like speed to see floors rising
      const top = this.w.buildingTop(s.ev.ref) ?? 0;
      this.preferredSpeed = top > 30 ? 100 : 30;
    }
  }

  private makeShot(ev: SimEvent): Shot {
    const base = BASE[ev.type];
    let type = base.shot;
    const focus = new THREE.Vector3(ev.x, this.w.groundClear(ev.x, ev.z) - 10, ev.z);
    if (type === 'chase' && !ev.entity) type = 'orbit';
    if (type === 'travelling' && !(ev.entity?.kind === 'edge')) type = 'orbit';
    if (type === 'crane' && ev.entity?.kind === 'building') {
      const top = this.w.buildingTop(ev.entity.id) ?? 0;
      if (top < 12) type = 'orbit';
    }
    // vary angles between consecutive shots
    const last = this.history[this.history.length - 1];
    if (last && last.shot === type && type === 'orbit' && Math.random() < 0.5) type = 'reveal';
    const [a, b] = DUR[type];
    const s = new Shot(type, focus, ev, a + Math.random() * (b - a));
    s.opts.dir = Math.random() < 0.5 ? 1 : -1;
    s.opts.angle = Math.random() * Math.PI * 2;
    if (type === 'flyover') s.opts.path = this.pickPath(focus);
    return s;
  }

  private idleShot(): Shot {
    this.idleToggle++;
    const c = this.w.center();
    const R = this.w.cityRadius();
    const kinds: ShotType[] = ['orbit', 'flyover', 'establishing', 'orbit', 'flyover'];
    const type = kinds[this.idleToggle % kinds.length];
    const ang = Math.random() * Math.PI * 2;
    const r = Math.random() * R * 0.7;
    const focus = new THREE.Vector3(c.x + Math.cos(ang) * r, 0, c.z + Math.sin(ang) * r);
    focus.y = this.w.groundClear(focus.x, focus.z) - 10;
    const [a, b] = DUR[type];
    const s = new Shot(type, focus, null, a + Math.random() * (b - a));
    s.opts.dir = Math.random() < 0.5 ? 1 : -1;
    s.opts.angle = ang;
    if (type === 'flyover') s.opts.path = this.pickPath(focus);
    return s;
  }

  private pathCache: THREE.Vector3[][] = [];
  private pickPath(near: THREE.Vector3): number {
    this.pathCache = this.w.flyPaths();
    if (!this.pathCache.length) return -1;
    let bi = 0, bd = Infinity;
    this.pathCache.forEach((p, i) => {
      const d = Math.min(...p.map((q) => q.distanceTo(near))) + Math.random() * 300;
      if (d < bd) { bd = d; bi = i; }
    });
    return bi;
  }

  private subjectPos(s: Shot): { p: THREE.Vector3; h: number } | null {
    const e = s.ev?.entity;
    if (!e) return null;
    if (e.kind === 'vehicle') return this.w.vehiclePos(e.id, e.gen ?? -1);
    if (e.kind === 'ped') return this.w.pedPos(e.id, e.gen ?? -1);
    if (e.kind === 'train') return this.w.trainPos(e.id);
    if (e.kind === 'citizen') {
      const c = this.w.citizenPos(e.id);
      return c;
    }
    return null;
  }

  private evaluate(s: Shot, dt: number): Pose {
    const t = s.t;
    const f = s.focus;
    const dir = s.opts.dir ?? 1;
    const pos = new THREE.Vector3(), look = new THREE.Vector3();
    switch (s.type) {
      case 'orbit': {
        const R = 70 + 30 * Math.sin(t * 0.13 + s.seed) + (s.ev ? 0 : 120);
        const H = 45 + 20 * Math.sin(t * 0.09 + s.seed * 2) + (s.ev ? 0 : 80);
        const a = (s.opts.angle ?? 0) + dir * t * 0.09;
        if (s.ev?.entity?.kind === 'building') {
          const top = this.w.buildingTop(s.ev.entity.id);
          if (top !== null) f.y = top * 0.6 + (f.y + 10) * 0.4;
        }
        pos.set(f.x + Math.cos(a) * R, f.y + H, f.z + Math.sin(a) * R);
        look.copy(f);
        break;
      }
      case 'establishing': {
        const c = this.w.center();
        const R = this.w.cityRadius() * 1.7 + 300;
        const a = (s.opts.angle ?? 0) + dir * t * 0.025;
        pos.set(c.x + Math.cos(a) * R, R * 0.55 + 120, c.z + Math.sin(a) * R);
        look.set(f.x * 0.3 + c.x * 0.7, 10, f.z * 0.3 + c.z * 0.7);
        break;
      }
      case 'timelapse': {
        const c = this.w.center();
        const R = this.w.cityRadius() * 1.2 + 250;
        const a = (s.opts.angle ?? 0) + dir * t * 0.04;
        pos.set(c.x + Math.cos(a) * R, 70 + R * 0.25, c.z + Math.sin(a) * R);
        look.set(c.x, 40, c.z);
        break;
      }
      case 'crane': {
        const id = s.ev?.entity?.id ?? -1;
        const top = this.w.buildingTop(id) ?? f.y + 30;
        const prog = this.w.buildingProgress(id);
        const bp = this.w.buildingPos(id) ?? f;
        const curTop = bp.y + Math.max(4, (top - bp.y) * Math.min(1, Math.max(0.1, ((prog ?? 1) - 0.15) / 0.8)));
        const a = (s.opts.angle ?? 0) + dir * t * 0.06;
        const R = Math.max(45, (top - bp.y) * 0.9);
        pos.set(bp.x + Math.cos(a) * R, curTop + 6, bp.z + Math.sin(a) * R);
        look.set(bp.x, curTop - 2, bp.z);
        break;
      }
      case 'travelling': {
        const id = s.ev?.entity?.id ?? -1;
        const pts = this.w.edgePts(id);
        if (!pts || pts.length < 6) { pos.set(f.x + 60, f.y + 40, f.z + 60); look.copy(f); break; }
        const n = pts.length / 3;
        const prog = Math.min(1, this.w.edgeProgress(id));
        const k = Math.min(n - 1, Math.floor(prog * (n - 1)));
        const px = pts[k * 3], py = pts[k * 3 + 1], pz = pts[k * 3 + 2];
        const ax = pts[3] - pts[0], az = pts[5] - pts[2];
        const l = Math.hypot(ax, az) || 1;
        const nx = -az / l, nz = ax / l;
        const back = 22 - t * 1.2;
        pos.set(px + nx * 26 * dir - (ax / l) * back, py + 14, pz + nz * 26 * dir - (az / l) * back);
        look.set(px, py + 1, pz);
        break;
      }
      case 'flyover': {
        const path = this.pathCache[s.opts.path ?? -1];
        if (!path || path.length < 2) { pos.set(f.x + 100, f.y + 90, f.z); look.copy(f); break; }
        const total = path.length - 1;
        const u = Math.min(total - 0.001, (t / s.dur) * total);
        const i = Math.floor(u), fr = u - i;
        const p = path[i].clone().lerp(path[i + 1], fr);
        const ahead = path[Math.min(total, i + 2)].clone();
        pos.set(p.x, p.y + 55 + Math.sin(t * 0.3) * 10, p.z);
        look.set(ahead.x, ahead.y, ahead.z);
        break;
      }
      case 'chase': case 'shoulder': {
        const sp = this.subjectPos(s);
        if (!sp) { pos.copy(this.pose.pos); look.copy(this.pose.look); break; }
        const near = s.type === 'shoulder';
        const back = near ? 7 : 22, up = near ? 3.2 : 11;
        const swing = Math.sin(t * 0.2 + s.seed) * (near ? 0.6 : 0.8);
        const hh = sp.h + Math.PI + swing;
        const cx = sp.p.x + Math.cos(hh) * back, cz = sp.p.z + Math.sin(hh) * back;
        const desired = new THREE.Vector3(cx, sp.p.y + up, cz);
        // smooth following
        const prev = (s.opts as unknown as { _p?: THREE.Vector3 })._p as THREE.Vector3 | undefined;
        const smoothed = prev ? prev.lerp(desired, Math.min(1, dt * 2.5)) : desired.clone();
        (s.opts as unknown as { _p: THREE.Vector3 })._p = smoothed;
        pos.copy(smoothed);
        look.set(sp.p.x + Math.cos(sp.h) * (near ? 4 : 10), sp.p.y + (near ? 1.4 : 1), sp.p.z + Math.sin(sp.h) * (near ? 4 : 10));
        f.copy(sp.p);
        break;
      }
      case 'reveal': {
        const u = Math.min(1, t / s.dur);
        const e = u * u * (3 - 2 * u);
        const a = (s.opts.angle ?? 0) + dir * t * 0.05;
        const R = 25 + e * (this.w.cityRadius() * 1.3 + 200);
        const H = 10 + e * (this.w.cityRadius() * 0.7 + 150);
        pos.set(f.x + Math.cos(a) * R, f.y + H, f.z + Math.sin(a) * R);
        const c = this.w.center();
        look.set(f.x + (c.x - f.x) * e * 0.6, f.y * (1 - e) + 10 * e, f.z + (c.z - f.z) * e * 0.6);
        break;
      }
    }
    // keep inside a sane map region
    pos.x = Math.max(-1500, Math.min(this.w.mapSize + 1500, pos.x));
    pos.z = Math.max(-1500, Math.min(this.w.mapSize + 1500, pos.z));
    return { pos, look };
  }

  /** keep the camera above terrain and roofs, even mid-transition */
  clearance(p: THREE.Vector3) {
    let g = 0;
    for (const [ox, oz] of [[0, 0], [12, 0], [-12, 0], [0, 12], [0, -12]]) g = Math.max(g, this.w.groundClear(p.x + ox, p.z + oz));
    const min = g + 4;
    if (p.y < min) p.y += (min - p.y) * 0.5 + 0.01;
    if (p.y < min - 2) p.y = min - 2;
  }

  /** debug info for UI */
  status(): string {
    const s = this.shot;
    if (!s) return '—';
    return `${s.type}${s.ev ? ' · ' + s.ev.type : ' · livre'} (${s.t.toFixed(0)}/${s.dur.toFixed(0)}s)`;
  }
}
