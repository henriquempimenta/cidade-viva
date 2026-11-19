import * as THREE from 'three';
import { LANE_WIDTH, RoadClass } from '../shared/constants';
import type { EdgeView, NodeView } from '../shared/protocol';
import { GB } from './geomBuilder';
import { U } from './uniforms';

const COL = {
  asphalt: new THREE.Color(0x3d4044), asphaltOld: new THREE.Color(0x4a4c4f), dirt: new THREE.Color(0x9b7f5a), earth: new THREE.Color(0x7d6243),
  walk: new THREE.Color(0xb9b4aa), curb: new THREE.Color(0xd2cdc2), white: new THREE.Color(0xf2f2ee), yellow: new THREE.Color(0xf2c230),
  median: new THREE.Color(0x6f9e4c), bus: new THREE.Color(0x9c3b34), concrete: new THREE.Color(0xb8b3aa), rail: new THREE.Color(0x777777),
};

export function edgeHalfWidth(e: { cls: number; lanes: number; oneway: number }): number {
  const median = e.cls >= RoadClass.Avenue ? 1.6 : 0.15;
  const dirs = e.oneway ? 1 : 2;
  return (e.lanes * LANE_WIDTH * dirs) / 2 + median / (e.oneway ? 2 : 1) + 0.4;
}

interface PL { x: number[]; y: number[]; z: number[]; s: number[] }
function toPL(pts: number[]): PL {
  const pl: PL = { x: [], y: [], z: [], s: [] };
  let acc = 0;
  for (let i = 0; i < pts.length; i += 3) {
    if (i > 0) acc += Math.hypot(pts[i] - pts[i - 3], pts[i + 2] - pts[i - 1]);
    pl.x.push(pts[i]); pl.y.push(pts[i + 1]); pl.z.push(pts[i + 2]); pl.s.push(acc);
  }
  return pl;
}
function at(pl: PL, s: number): [number, number, number, number, number] {
  const n = pl.s.length;
  if (s <= 0) { const tx = pl.x[1] - pl.x[0], tz = pl.z[1] - pl.z[0], l = Math.hypot(tx, tz) || 1; return [pl.x[0], pl.y[0], pl.z[0], tx / l, tz / l]; }
  for (let i = 1; i < n; i++) {
    if (pl.s[i] >= s || i === n - 1) {
      const t = Math.min(1, (s - pl.s[i - 1]) / Math.max(1e-6, pl.s[i] - pl.s[i - 1]));
      const tx = pl.x[i] - pl.x[i - 1], tz = pl.z[i] - pl.z[i - 1], l = Math.hypot(tx, tz) || 1;
      return [pl.x[i - 1] + tx * t, pl.y[i - 1] + (pl.y[i] - pl.y[i - 1]) * t, pl.z[i - 1] + tz * t, tx / l, tz / l];
    }
  }
  return [pl.x[n - 1], pl.y[n - 1], pl.z[n - 1], 1, 0];
}

function ribbon(g: GB, pl: PL, s0: number, s1: number, o0: number, o1: number, dy: number, c: THREE.Color, step = 8) {
  if (s1 - s0 < 0.2) return;
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  let prev = at(pl, s0);
  for (let i = 1; i <= n; i++) {
    const cur = at(pl, s0 + ((s1 - s0) * i) / n);
    const p = (q: [number, number, number, number, number], o: number) => [q[0] - q[4] * o, q[1] + dy, q[2] + q[3] * o];
    g.quad([p(prev, o1), p(cur, o1), p(cur, o0), p(prev, o0)], [0, 1, 0], c);
    prev = cur;
  }
}
function dashes(g: GB, pl: PL, s0: number, s1: number, off: number, w: number, dash: number, gap: number, dy: number, c: THREE.Color) {
  for (let s = s0; s + dash <= s1; s += dash + gap) ribbon(g, pl, s, s + dash, off - w / 2, off + w / 2, dy, c, dash);
}

export class RoadsLayer {
  group = new THREE.Group();
  nodes = new Map<number, NodeView>();
  edges = new Map<number, EdgeView>();
  private mesh: THREE.Mesh | null = null;
  private bridgeMesh: THREE.Mesh | null = null;
  private dirty = false;
  private lastBuild = 0;
  private mat: THREE.MeshStandardMaterial;
  private bridgeMat: THREE.MeshStandardMaterial;
  private poles: THREE.InstancedMesh;
  private lamps: THREE.InstancedMesh;
  private pools: THREE.InstancedMesh;
  private works = new Map<number, THREE.Group>();
  private cones: THREE.InstancedMesh;
  edgeMeshIndex: { start: number; end: number; id: number }[] = [];
  signals: THREE.InstancedMesh;
  private signalSlots: { node: number; edge: number; idx: number }[] = [];
  private signalPhase = new Map<number, number>();
  private elevatedPillars: THREE.InstancedMesh;

  constructor() {
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.mat.onBeforeCompile = (sh) => {
      sh.uniforms.uRain = U.uRain; sh.uniforms.uSnow = U.uSnow;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uRain; uniform float uSnow;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.25, uRain);')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9,0.92,0.95), uSnow*0.35);');
    };
    this.bridgeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    const poleG = new THREE.CylinderGeometry(0.1, 0.14, 7, 5).translate(0, 3.5, 0);
    const armG = new THREE.BoxGeometry(1.8, 0.12, 0.12).translate(0.9, 7, 0);
    const pg = mergeSimple([poleG, armG]);
    this.poles = new THREE.InstancedMesh(pg, new THREE.MeshStandardMaterial({ color: 0x55595e, roughness: 0.6 }), 12000);
    this.poles.count = 0;
    this.lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, 0.18, 0.35), new THREE.MeshBasicMaterial({ color: 0xffd9a0 }), 12000);
    this.lamps.count = 0;
    const poolG = new THREE.CircleGeometry(7, 12).rotateX(-Math.PI / 2);
    this.pools = new THREE.InstancedMesh(poolG, new THREE.MeshBasicMaterial({ color: 0xffb860, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }), 12000);
    this.pools.count = 0;
    this.pools.renderOrder = 3;
    const coneG = new THREE.ConeGeometry(0.25, 0.7, 6).translate(0, 0.35, 0);
    this.cones = new THREE.InstancedMesh(coneG, new THREE.MeshStandardMaterial({ color: 0xff6a10 }), 3000);
    this.cones.count = 0;
    this.signals = new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffffff }), 4000);
    this.signals.count = 0;
    const pil = new THREE.BoxGeometry(1.4, 1, 1.4).translate(0, 0.5, 0);
    this.elevatedPillars = new THREE.InstancedMesh(pil, new THREE.MeshStandardMaterial({ color: 0xb0aba2 }), 6000);
    this.elevatedPillars.count = 0;
    this.group.add(this.poles, this.lamps, this.pools, this.cones, this.signals, this.elevatedPillars);
  }

  upsertNode(n: NodeView) { this.nodes.set(n.id, n); this.dirty = true; }
  upsertEdge(e: EdgeView) {
    const prev = this.edges.get(e.id);
    this.edges.set(e.id, e);
    if (!prev || prev.progress < 1 !== e.progress < 1 || prev.cls !== e.cls || prev.lanes !== e.lanes || prev.busLane !== e.busLane || prev.oneway !== e.oneway || prev.upgrading !== e.upgrading || prev.elevated !== e.elevated) this.dirty = true;
    this.updateWork(e);
  }
  removeEdge(id: number) { this.edges.delete(id); this.dirty = true; const w = this.works.get(id); if (w) { this.group.remove(w); this.works.delete(id); } }

  private nodeRCache = new Map<number, number>();
  private nodeR(id: number) {
    const n = this.nodes.get(id);
    if (!n || n.deg <= 2) return 0;
    let r = this.nodeRCache.get(id);
    if (r === undefined) {
      r = 3;
      for (const e of this.edgesAt(id)) r = Math.max(r, edgeHalfWidth(e) + 1.2);
      if (n.control === 3) r += 9;
      this.nodeRCache.set(id, r);
    }
    return r;
  }

  update(now: number, night: number, simT: number) {
    if (this.dirty && now - this.lastBuild > 700) { this.rebuild(); this.lastBuild = now; this.dirty = false; }
    (this.lamps.material as THREE.MeshBasicMaterial).color.setRGB(0.35 + 1.4 * night, 0.32 + 1.2 * night, 0.25 + 0.8 * night);
    (this.pools.material as THREE.MeshBasicMaterial).opacity = 0.18 * night;
    for (const [id, g] of this.works) {
      const e = this.edges.get(id);
      if (!e) continue;
      const paver = g.userData.paver as THREE.Object3D;
      const pl = g.userData.pl as PL;
      const len = pl.s[pl.s.length - 1];
      const p = at(pl, len * Math.min(1, e.progress));
      paver.position.set(p[0], p[1], p[2]);
      paver.rotation.y = -Math.atan2(p[4], p[3]);
      paver.position.y += Math.sin(simT * 5) * 0.03;
    }
  }

  setSignals(arr: Int32Array) {
    this.signalPhase.clear();
    for (let i = 0; i < arr.length; i += 2) this.signalPhase.set(arr[i], arr[i + 1]);
    const c = new THREE.Color();
    for (let i = 0; i < this.signalSlots.length; i++) {
      const s = this.signalSlots[i];
      const ph = this.signalPhase.get(s.node);
      if (ph === undefined) { c.setRGB(0.2, 0.2, 0.2); this.signals.setColorAt(i, c); continue; }
      // phase encodes: bit k (k = slot order) => green for that approach; >=1000 yellow
      const green = (ph >> (s.idx % 16)) & 1;
      const yellow = (ph >> 16) & 1;
      if (green && !yellow) c.setRGB(0.1, 2.2, 0.4); else if (green && yellow) c.setRGB(2.4, 1.6, 0); else c.setRGB(2.4, 0.15, 0.1);
      this.signals.setColorAt(i, c);
    }
    if (this.signals.instanceColor) this.signals.instanceColor.needsUpdate = true;
  }

  private updateWork(e: EdgeView) {
    const active = e.progress < 1 || e.upgrading;
    let g = this.works.get(e.id);
    if (!active) { if (g) { this.group.remove(g); this.works.delete(e.id); this.dirty = true; } return; }
    if (!g) {
      g = new THREE.Group();
      const pv = new GB();
      pv.box(0, 0, 0, 5, 1.6, 3, new THREE.Color(0xf0b020));
      pv.box(-1.4, 1.6, 0, 1.6, 1.6, 2, new THREE.Color(0xf0b020));
      pv.box(2.6, 0, 0, 0.6, 0.5, 3.6, new THREE.Color(0x333333));
      pv.cylinder(-1.4, 3.2, 0.8, 0.1, 0.1, 1, 4, new THREE.Color(0x222222));
      const paver = new THREE.Mesh(pv.toGeometry(false), new THREE.MeshStandardMaterial({ vertexColors: true }));
      paver.castShadow = true;
      // roller following
      const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 2.6, 10).rotateX(Math.PI / 2).translate(-7, 0.9, 0), new THREE.MeshStandardMaterial({ color: 0x777777 }));
      const rb = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.6, 2).translate(-9, 1.3, 0), new THREE.MeshStandardMaterial({ color: 0xf0b020 }));
      paver.add(roller, rb);
      g.add(paver);
      g.userData.paver = paver;
      g.userData.pl = toPL(e.pts);
      this.works.set(e.id, g);
      this.group.add(g);
      this.dirty = true;
    } else g.userData.pl = toPL(e.pts);
  }

  private rebuild() {
    this.nodeRCache.clear();
    this.edgesByNode.clear();
    for (const e of this.edges.values()) {
      if (e.progress < 1) continue;
      for (const nid of [e.a, e.b]) { let a = this.edgesByNode.get(nid); if (!a) this.edgesByNode.set(nid, (a = [])); a.push(e); }
    }
    const g = new GB();
    const bg = new GB();
    const poles: THREE.Matrix4[] = [];
    const cones: THREE.Matrix4[] = [];
    const pillars: THREE.Matrix4[] = [];
    this.signalSlots = [];
    const sigM: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    this.edgeMeshIndex = [];
    for (const e of this.edges.values()) {
      const pl = toPL(e.pts);
      const len = pl.s[pl.s.length - 1];
      const ra = this.nodeR(e.a) * 0.92, rb = this.nodeR(e.b) * 0.92;
      const s0 = Math.min(ra, len / 2), s1 = Math.max(len - rb, len / 2);
      const hw = edgeHalfWidth(e);
      const startV = g.count;
      const done = e.progress >= 1 || e.upgrading;
      const dirt = e.cls === RoadClass.Dirt;
      const surface = dirt ? COL.dirt : COL.asphalt;
      if (!done) {
        const sp = s0 + (s1 - s0) * e.progress;
        ribbon(g, pl, s0, sp, -hw, hw, 0.02, surface);
        ribbon(g, pl, sp, s1, -hw - 1, hw + 1, 0, COL.earth);
        for (let s = s0; s < s1; s += 9) {
          const p = at(pl, s);
          for (const side of [-1, 1]) { m.makeTranslation(p[0] - p[4] * (hw + 0.6) * side, p[1], p[2] + p[3] * (hw + 0.6) * side); cones.push(m.clone()); }
        }
      } else {
        ribbon(g, pl, s0, s1, -hw, hw, 0, surface);
        if (e.upgrading) for (let s = s0; s < s1; s += 7) { const p = at(pl, s); m.makeTranslation(p[0] - p[4] * (hw - 0.6), p[1], p[2] + p[3] * (hw - 0.6)); cones.push(m.clone()); }
        if (!dirt) {
          // sidewalks + curbs
          if (e.cls !== RoadClass.Highway && !e.bridge && !e.elevated) {
            ribbon(g, pl, s0, s1, hw, hw + 2.6, 0.12, COL.walk);
            ribbon(g, pl, s0, s1, -hw - 2.6, -hw, 0.12, COL.walk);
            ribbon(g, pl, s0, s1, hw, hw + 0.25, 0.14, COL.curb);
            ribbon(g, pl, s0, s1, -hw - 0.25, -hw, 0.14, COL.curb);
          }
          // markings
          const dy = 0.03;
          if (e.oneway) {
            for (let l = 1; l < e.lanes; l++) dashes(g, pl, s0 + 2, s1 - 2, -hw + 0.4 + l * LANE_WIDTH, 0.15, 3, 4, dy, COL.white);
          } else {
            if (e.cls >= RoadClass.Avenue) {
              ribbon(g, pl, s0 + 3, s1 - 3, -0.8, 0.8, 0.18, COL.median);
            } else {
              ribbon(g, pl, s0 + 2, s1 - 2, -0.2, -0.06, dy, COL.yellow);
              ribbon(g, pl, s0 + 2, s1 - 2, 0.06, 0.2, dy, COL.yellow);
            }
            const med = e.cls >= RoadClass.Avenue ? 0.8 : 0;
            for (let l = 1; l < e.lanes; l++) {
              dashes(g, pl, s0 + 2, s1 - 2, med + l * LANE_WIDTH, 0.15, 3, 4, dy, COL.white);
              dashes(g, pl, s0 + 2, s1 - 2, -med - l * LANE_WIDTH, 0.15, 3, 4, dy, COL.white);
            }
            if (e.busLane) {
              ribbon(g, pl, s0 + 1, s1 - 1, med + (e.lanes - 1) * LANE_WIDTH, med + e.lanes * LANE_WIDTH, dy * 0.6, COL.bus);
              ribbon(g, pl, s0 + 1, s1 - 1, -med - e.lanes * LANE_WIDTH, -med - (e.lanes - 1) * LANE_WIDTH, dy * 0.6, COL.bus);
            }
          }
          // crosswalks at ends (urban roads)
          if (e.cls >= RoadClass.Local && e.cls <= RoadClass.Avenue && len > 30) {
            for (const [sc, dir] of [[s0 + 2.2, 1], [s1 - 2.2, -1]] as [number, number][]) {
              for (let k = -hw + 0.6; k < hw - 0.4; k += 1.1) {
                const a0 = at(pl, sc - 1.4 * dir), a1 = at(pl, sc + 1.4 * dir);
                const p = (qq: [number, number, number, number, number], o: number) => [qq[0] - qq[4] * o, qq[1] + 0.035, qq[2] + qq[3] * o];
                const lo = Math.min(k, k + 0.55), hi = Math.max(k, k + 0.55);
                if (dir > 0) g.quad([p(a0, hi), p(a1, hi), p(a1, lo), p(a0, lo)], [0, 1, 0], COL.white);
                else g.quad([p(a1, hi), p(a0, hi), p(a0, lo), p(a1, lo)], [0, 1, 0], COL.white);
              }
            }
          }
          // streetlights
          if (e.cls !== RoadClass.Highway || e.bridge) {
            const spacing = e.cls >= RoadClass.Avenue ? 28 : 34;
            let side = 1;
            for (let s = s0 + 8; s < s1 - 4; s += spacing) {
              const p = at(pl, s);
              const off = e.cls >= RoadClass.Avenue && !e.oneway ? 0 : (hw + 1.6) * side;
              const ang = Math.atan2(p[4], p[3]);
              const yaw = -(ang + (side > 0 ? -Math.PI / 2 : Math.PI / 2));
              q.setFromAxisAngle(up, e.cls >= RoadClass.Avenue && !e.oneway ? -ang + Math.PI / 2 : yaw);
              m.compose(new THREE.Vector3(p[0] - p[4] * off, p[1], p[2] + p[3] * off), q, new THREE.Vector3(1, 1, 1));
              poles.push(m.clone());
              if (e.cls >= RoadClass.Avenue && !e.oneway) {
                q.setFromAxisAngle(up, -ang - Math.PI / 2);
                m.compose(new THREE.Vector3(p[0], p[1], p[2]), q, new THREE.Vector3(1, 1, 1));
                poles.push(m.clone());
              }
              side = -side;
            }
          }
        }
      }
      // bridge / elevated structure
      if (e.bridge || e.elevated) {
        ribbon(bg, pl, 0, len, -hw - 0.8, hw + 0.8, -1.0, COL.concrete);
        // parapets
        for (const sd of [-1, 1]) {
          const o = (hw + 0.6) * sd;
          ribbon(bg, pl, 0, len, o - 0.2, o + 0.2, 1.0, COL.concrete);
          ribbon(bg, pl, 0, len, sd > 0 ? o + 0.2 : o - 0.2, sd > 0 ? o + 0.2 : o - 0.2, 0, COL.concrete);
        }
        const nPier = Math.floor(len / 32);
        for (let i = 1; i <= nPier; i++) {
          const p = at(pl, (len * i) / (nPier + 1));
          if (!done && i / (nPier + 1) > e.progress + 0.15) continue; // piers appear span by span
          const base = e.bridge ? -5 : p[1] - 7.2;
          const h = p[1] - 1 - base;
          if (h < 0.5) continue;
          q.setFromAxisAngle(up, -Math.atan2(p[4], p[3]));
          m.compose(new THREE.Vector3(p[0], base, p[2]), q, new THREE.Vector3(hw * 1.2, h, 1.2));
          pillars.push(m.clone());
        }
        // cable-stayed signature bridge
        if (e.bridge && len > 160 && e.name.includes('Estaiada')) {
          const mid = at(pl, len / 2);
          const ang = Math.atan2(mid[4], mid[3]);
          bg.setTransform(mid[0], mid[1], mid[2], ang);
          bg.box(0, 0, 0, 3, 70, 3, COL.white);
          for (let k = 1; k <= 8; k++) {
            for (const dir of [-1, 1]) {
              const x = dir * k * (len / 2 - 10) / 8;
              const hgt = 68 - k * 4;
              bg.tri([[0, hgt, -0.1], [x, 1.5, -0.1], [x, 1.5, 0.1]], COL.white);
              bg.tri([[0, hgt, 0.1], [0, hgt, -0.1], [x, 1.5, 0.1]], COL.white);
            }
          }
          bg.setTransform(0, 0, 0, 0);
        }
      }
      this.edgeMeshIndex.push({ start: startV, end: g.count, id: e.id });
    }
    // intersections
    for (const n of this.nodes.values()) {
      if (n.deg < 2) {
        if (n.deg === 1) { // cul-de-sac / end cap
          g.setTransform(n.x, n.y, n.z, 0);
          disc(g, 0, 0.005, 0, Math.max(3, n.radius * 0.9), 12, COL.asphalt);
          g.setTransform(0, 0, 0, 0);
        }
        continue;
      }
      if (n.deg === 2) {
        // smooth joint between two segments
        const inc = this.edgesAt(n.id);
        if (inc.length) {
          g.setTransform(n.x, n.y, n.z, 0);
          disc(g, 0, 0.004, 0, Math.max(...inc.map((e) => edgeHalfWidth(e))), 14, inc.every((e) => e.cls === RoadClass.Dirt) ? COL.dirt : COL.asphalt);
          g.setTransform(0, 0, 0, 0);
        }
        continue;
      }
      if (n.interchange) {
        // viaduct: the main road passes over the junction
        const inc = this.edgesAt(n.id);
        const major = inc.reduce((a, e) => (e.cls > a.cls ? e : a), inc[0]);
        if (major) {
          const o = this.nodes.get(major.a === n.id ? major.b : major.a)!;
          const ang = Math.atan2(o.z - n.z, o.x - n.x);
          const hwv = edgeHalfWidth(major) + 1;
          const L = this.nodeR(n.id) * 2 + 40;
          bg.setTransform(n.x, n.y, n.z, ang);
          bg.box(0, 6.2, 0, L, 1.0, hwv * 2, COL.concrete, 0, { top: COL.asphalt });
          bg.box(0, 7.2, hwv - 0.2, L, 1.0, 0.4, COL.concrete); bg.box(0, 7.2, -hwv + 0.2, L, 1.0, 0.4, COL.concrete);
          for (const px of [-L / 3, 0, L / 3]) bg.box(px, 0, 0, 1.6, 6.2, hwv * 1.2, COL.concrete);
          for (let k = -2; k <= 2; k++) bg.box(k * 4, 7.22, 0, 2.5, 0.02, 0.18, COL.white);
          bg.setTransform(0, 0, 0, 0);
        }
      }
      g.setTransform(n.x, n.y, n.z, 0);
      const anyDirt = this.edgesAt(n.id).every((e) => e.cls === RoadClass.Dirt);
      const nr = this.nodeR(n.id);
      disc(g, 0, 0.01, 0, nr, 16, anyDirt ? COL.dirt : COL.asphalt);
      if (n.control === 3) {
        disc(g, 0, 0.21, 0, nr * 0.5, 16, COL.curb);
        disc(g, 0, 0.22, 0, nr * 0.45, 16, COL.median);
      }
      g.setTransform(0, 0, 0, 0);
      if (n.control === 2 || n.control === 4) {
        const inc = this.edgesAt(n.id);
        inc.forEach((e, idx) => {
          const other = this.nodes.get(e.a === n.id ? e.b : e.a);
          if (!other) return;
          const dx = other.x - n.x, dz = other.z - n.z, l = Math.hypot(dx, dz) || 1;
          const ux = dx / l, uz = dz / l;
          const r = this.nodeR(n.id) + 1;
          const px = n.x + ux * r - uz * (edgeHalfWidth(e) + 1.2), pz = n.z + uz * r + ux * (edgeHalfWidth(e) + 1.2);
          m.makeTranslation(px, n.y + 4.2, pz);
          sigM.push(m.clone());
          this.signalSlots.push({ node: n.id, edge: e.id, idx });
          q.identity();
          m.compose(new THREE.Vector3(px, n.y, pz), q, new THREE.Vector3(0.6, 0.6, 0.6));
          poles.push(m.clone());
        });
      }
    }
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.mesh = new THREE.Mesh(g.toGeometry(false), this.mat);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'roads';
    this.group.add(this.mesh);
    if (this.bridgeMesh) { this.group.remove(this.bridgeMesh); this.bridgeMesh.geometry.dispose(); }
    if (bg.count) {
      this.bridgeMesh = new THREE.Mesh(bg.toGeometry(false), this.bridgeMat);
      this.bridgeMesh.castShadow = true; this.bridgeMesh.receiveShadow = true;
      this.group.add(this.bridgeMesh);
    } else this.bridgeMesh = null;
    const setInst = (im: THREE.InstancedMesh, arr: THREE.Matrix4[]) => {
      const n = Math.min(arr.length, im.instanceMatrix.count);
      for (let i = 0; i < n; i++) im.setMatrixAt(i, arr[i]);
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
    };
    setInst(this.poles, poles);
    // lamp heads & light pools derived from poles
    const lamps: THREE.Matrix4[] = [], pools: THREE.Matrix4[] = [];
    const pos = new THREE.Vector3(), sc = new THREE.Vector3(), qq = new THREE.Quaternion();
    for (const pm of poles) {
      pm.decompose(pos, qq, sc);
      if (sc.x < 0.9) continue;
      const head = new THREE.Vector3(1.6, 6.9, 0).applyQuaternion(qq).add(pos);
      lamps.push(new THREE.Matrix4().compose(head, qq, sc));
      pools.push(new THREE.Matrix4().makeTranslation(head.x, pos.y + 0.25, head.z));
    }
    setInst(this.lamps, lamps);
    setInst(this.pools, pools);
    setInst(this.cones, cones);
    setInst(this.signals, sigM);
    setInst(this.elevatedPillars, pillars);
    this.setSignals(new Int32Array([...this.signalPhase.entries()].flat()));
  }

  private edgesByNode = new Map<number, EdgeView[]>();
  edgesAt(nid: number): EdgeView[] {
    const out = [...(this.edgesByNode.get(nid) ?? [])];
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  pickEdge(hit: THREE.Intersection): number | null {
    if (hit.object !== this.mesh || !hit.face) return null;
    const v = hit.face.a;
    for (const r of this.edgeMeshIndex) if (v >= r.start && v < r.end) return r.id;
    return null;
  }
  get mainMesh() { return this.mesh; }
}

function disc(g: GB, cx: number, y: number, cz: number, r: number, seg: number, c: THREE.Color) {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    g.tri([[cx, y, cz], [cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r], [cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r]], c);
  }
}

function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [];
  for (const g0 of geos) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    pos.push(...(g.attributes.position.array as Float32Array));
    nor.push(...(g.attributes.normal.array as Float32Array));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return out;
}
