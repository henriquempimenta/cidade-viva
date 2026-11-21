import * as THREE from 'three';
import { LANE_WIDTH, RoadClass } from '../shared/constants';
import { CROSSWALK_INSET, edgeHalfWidth, hasEndCrosswalk, nodeRenderRadius, SIDEWALK_WIDTH } from '../shared/roadGeom';
import type { EdgeView, NodeView } from '../shared/protocol';
import { GB } from './geomBuilder';
import { U } from './uniforms';
import { bendLine, junction, type Arm } from './junctions';

export { edgeHalfWidth };

const COL = {
  asphalt: new THREE.Color(0x3d4044), asphaltOld: new THREE.Color(0x4a4c4f), dirt: new THREE.Color(0x9b7f5a), earth: new THREE.Color(0x7d6243),
  walk: new THREE.Color(0xb9b4aa), curb: new THREE.Color(0xd2cdc2), white: new THREE.Color(0xf2f2ee), yellow: new THREE.Color(0xf2c230),
  median: new THREE.Color(0x6f9e4c), bus: new THREE.Color(0x9c3b34), concrete: new THREE.Color(0xb8b3aa), tunnel: new THREE.Color(0x1d1f22), rail: new THREE.Color(0x777777),
};

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
/** vertical wall along a polyline at lateral offset o, from dy0 to dy1 above it (double-sided material) */
function wall(g: GB, pl: PL, s0: number, s1: number, o: number, dy0: number, dy1: number, c: THREE.Color, step = 8) {
  if (s1 - s0 < 0.2) return;
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  let prev = at(pl, s0);
  for (let i = 1; i <= n; i++) {
    const cur = at(pl, s0 + ((s1 - s0) * i) / n);
    const P = (q: [number, number, number, number, number], dy: number) => [q[0] - q[4] * o, q[1] + dy, q[2] + q[3] * o];
    const nx = -cur[4] * Math.sign(o || 1), nz = cur[3] * Math.sign(o || 1);
    g.quad([P(prev, dy0), P(cur, dy0), P(cur, dy1), P(prev, dy1)], [nx, 0, nz], c);
    prev = cur;
  }
}
/** parts of [s0,s1] outside the given holes */
function spans(s0: number, s1: number, holes: { s0: number; s1: number }[]): [number, number][] {
  let out: [number, number][] = [[s0, s1]];
  for (const h of holes) {
    const next: [number, number][] = [];
    for (const [a, b] of out) {
      if (h.s1 <= a || h.s0 >= b) { next.push([a, b]); continue; }
      if (h.s0 > a) next.push([a, h.s0]);
      if (h.s1 < b) next.push([h.s1, b]);
    }
    out = next;
  }
  return out.filter(([a, b]) => b - a > 0.3);
}
function dashes(g: GB, pl: PL, s0: number, s1: number, off: number, w: number, dash: number, gap: number, dy: number, c: THREE.Color) {
  for (let s = s0; s + dash <= s1; s += dash + gap) ribbon(g, pl, s, s + dash, off - w / 2, off + w / 2, dy, c, dash);
}

export class RoadsLayer {
  group = new THREE.Group();
  /** terrain height sampler (set by the app) so junction surfaces never sink under the ground */
  ground: (x: number, z: number) => number = () => -1e9;
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
    this.bridgeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide });
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
    if (!prev || prev.progress < 1 !== e.progress < 1 || prev.cls !== e.cls || prev.lanes !== e.lanes || prev.busLane !== e.busLane || prev.oneway !== e.oneway || prev.upgrading !== e.upgrading || prev.elevated !== e.elevated || prev.hole !== e.hole || prev.deck !== e.deck) this.dirty = true;
    this.updateWork(e);
  }
  removeEdge(id: number) { this.edges.delete(id); this.dirty = true; const w = this.works.get(id); if (w) { this.group.remove(w); this.works.delete(id); } }

  private nodeRCache = new Map<number, number>();
  private nodeR(id: number) {
    const n = this.nodes.get(id);
    if (!n || this.rdeg(n) <= 2) return 0;
    let r = this.nodeRCache.get(id);
    if (r === undefined) {
      r = nodeRenderRadius(n.control, this.edgesAt(id));
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
    this.deckAt.clear();
    for (const e of this.edges.values()) {
      if (e.deck !== undefined && (e.tunnel || e.progress < 1)) { for (const nid of [e.a, e.b]) this.deckAt.set(nid, (this.deckAt.get(nid) ?? 0) + 1); continue; }
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
    // smooth bends: deg-2 nodes where the road turns get a curved joint instead of a sharp vertex
    const plCache = new Map<number, PL>();
    const plOf = (e: EdgeView) => { let p = plCache.get(e.id); if (!p) plCache.set(e.id, (p = toPL(e.pts))); return p; };
    const armOf = (nid: number, e: EdgeView, r: number): Arm => {
      const pl = plOf(e), len = pl.s[pl.s.length - 1];
      const fromA = e.a === nid;
      const q = at(pl, fromA ? Math.min(r, len) : Math.max(0, len - r));
      const walk = e.cls !== RoadClass.Dirt && e.cls !== RoadClass.Highway && !e.bridge && !e.elevated;
      return { x: q[0], y: q[1], z: q[2], dx: fromA ? q[3] : -q[3], dz: fromA ? q[4] : -q[4], hw: edgeHalfWidth(e), walk };
    };
    const bendR = new Map<number, number>();
    for (const n of this.nodes.values()) {
      if (this.rdeg(n) !== 2) continue;
      const inc = this.edgesAt(n.id);
      if (inc.length !== 2) continue;
      const A = armOf(n.id, inc[0], 0), B = armOf(n.id, inc[1], 0);
      const turn = Math.acos(Math.max(-1, Math.min(1, -(A.dx * B.dx + A.dz * B.dz))));
      if (turn < 0.1) continue;
      const lenA = plOf(inc[0]).s.at(-1)!, lenB = plOf(inc[1]).s.at(-1)!;
      const hw = Math.max(A.hw, B.hw);
      bendR.set(n.id, Math.min(hw * (1 + turn) + 3, lenA * 0.35, lenB * 0.35));
    }
    const trimAt = (nid: number) => this.nodeR(nid) * 0.92 || (bendR.get(nid) ?? 0);
    // tunnel cuts first: streets above need to know where the openings are
    this.cuts = [];
    for (const e of this.edges.values()) {
      if (!e.tunnel || e.deck === undefined) continue;
      const pl = plOf(e), len = pl.s[pl.s.length - 1], hwT = edgeHalfWidth(e) + 0.4;
      for (const r of this.cutRuns(e, pl, len)) {
        const pts: number[] = [];
        for (let s = r.s0; s <= r.s1 + 0.01; s += 2) { const q = at(pl, Math.min(s, r.s1)); pts.push(q[0], q[1], q[2]); }
        if (pts.length >= 6) this.cuts.push({ pts, hw: hwT });
      }
    }
    for (const e of this.edges.values()) {
      const pl = plOf(e);
      const len = pl.s[pl.s.length - 1];
      if (e.tunnel && e.deck !== undefined) { this.tunnel(g, bg, e, pl, len); continue; }
      const ra = e.deck !== undefined && e.progress < 1 ? 0 : trimAt(e.a), rb = e.deck !== undefined && e.progress < 1 ? 0 : trimAt(e.b);
      const s0 = Math.min(ra, len / 2), s1 = Math.max(len - rb, len / 2);
      const hw = edgeHalfWidth(e);
      const startV = g.count;
      const done = e.progress >= 1 || e.upgrading;
      const dirt = e.cls === RoadClass.Dirt;
      const surface = dirt ? COL.dirt : COL.asphalt;
      if (!done && e.deck !== undefined) {
        // a structure grows span by span: deck slab only, no earthworks in mid-air
        ribbon(bg, pl, s0, s0 + (s1 - s0) * e.progress, -hw - 0.8, hw + 0.8, 0, COL.concrete);
      } else if (!done) {
        const sp = s0 + (s1 - s0) * e.progress;
        ribbon(g, pl, s0, sp, -hw, hw, 0.02, surface);
        ribbon(g, pl, sp, s1, -hw - 1, hw + 1, 0, COL.earth);
        for (let s = s0; s < s1; s += 9) {
          const p = at(pl, s);
          for (const side of [-1, 1]) { m.makeTranslation(p[0] - p[4] * (hw + 0.6) * side, p[1], p[2] + p[3] * (hw + 0.6) * side); cones.push(m.clone()); }
        }
      } else {
        // a street over a central trench: full surface outside the openings, side lanes only along them
        const holes = e.hole ? this.holesOn(e, pl) : [];
        for (const [a0, a1] of spans(s0, s1, holes)) ribbon(g, pl, a0, a1, -hw, hw, 0, surface);
        for (const h of holes) {
          const h0 = Math.max(s0, h.s0), h1 = Math.min(s1, h.s1), inner = h.hw + 0.55;
          if (h1 - h0 < 0.5 || inner >= hw - 1) continue;
          ribbon(g, pl, h0, h1, inner, hw, 0, surface);
          ribbon(g, pl, h0, h1, -hw, -inner, 0, surface);
          dashes(g, pl, h0, h1, inner + 0.25, 0.15, 3, 4, 0.03, COL.white);
          dashes(g, pl, h0, h1, -inner - 0.25, 0.15, 3, 4, 0.03, COL.white);
        }
        if (e.upgrading) for (let s = s0; s < s1; s += 7) { const p = at(pl, s); m.makeTranslation(p[0] - p[4] * (hw - 0.6), p[1], p[2] + p[3] * (hw - 0.6)); cones.push(m.clone()); }
        if (!dirt) {
          // sidewalks + curbs
          if (e.cls !== RoadClass.Highway && !e.bridge && !e.elevated) {
            ribbon(g, pl, s0, s1, hw, hw + SIDEWALK_WIDTH, 0.12, COL.walk);
            ribbon(g, pl, s0, s1, -hw - SIDEWALK_WIDTH, -hw, 0.12, COL.walk);
            ribbon(g, pl, s0, s1, hw, hw + 0.25, 0.14, COL.curb);
            ribbon(g, pl, s0, s1, -hw - 0.25, -hw, 0.14, COL.curb);
          }
          // markings (not over a trench opening)
          const dy = 0.03;
          for (const [m0, m1] of spans(s0, s1, holes)) {
            if (e.oneway) {
              for (let l = 1; l < e.lanes; l++) dashes(g, pl, m0 + 2, m1 - 2, -hw + 0.4 + l * LANE_WIDTH, 0.15, 3, 4, dy, COL.white);
            } else {
              if (e.cls >= RoadClass.Avenue) {
                ribbon(g, pl, m0 + 3, m1 - 3, -0.8, 0.8, 0.18, COL.median);
              } else {
                ribbon(g, pl, m0 + 2, m1 - 2, -0.2, -0.06, dy, COL.yellow);
                ribbon(g, pl, m0 + 2, m1 - 2, 0.06, 0.2, dy, COL.yellow);
              }
              const med = e.cls >= RoadClass.Avenue ? 0.8 : 0;
              for (let l = 1; l < e.lanes; l++) {
                dashes(g, pl, m0 + 2, m1 - 2, med + l * LANE_WIDTH, 0.15, 3, 4, dy, COL.white);
                dashes(g, pl, m0 + 2, m1 - 2, -med - l * LANE_WIDTH, 0.15, 3, 4, dy, COL.white);
              }
              if (e.busLane) {
                ribbon(g, pl, m0 + 1, m1 - 1, med + (e.lanes - 1) * LANE_WIDTH, med + e.lanes * LANE_WIDTH, dy * 0.6, COL.bus);
                ribbon(g, pl, m0 + 1, m1 - 1, -med - e.lanes * LANE_WIDTH, -med - (e.lanes - 1) * LANE_WIDTH, dy * 0.6, COL.bus);
              }
            }
          }
          // crosswalks at ends (urban roads + at-grade highway arms entering urban junctions)
          for (const [nid, sc, dir] of [[e.a, s0 + CROSSWALK_INSET, 1], [e.b, s1 - CROSSWALK_INSET, -1]] as [number, number, number][]) {
            const nd = this.nodes.get(nid);
            const deg = nd ? this.rdeg(nd) : 0;
            const inc = this.edgesAt(nid);
            const hasUrban = inc.some((q) => q.cls >= RoadClass.Local && q.cls <= RoadClass.Avenue);
            if (!hasEndCrosswalk(e, len, deg, hasUrban, !!nd?.interchange)) continue;
            for (let k = -hw + 0.6; k < hw - 0.4; k += 1.1) {
              const a0 = at(pl, sc - 1.4 * dir), a1 = at(pl, sc + 1.4 * dir);
              const p = (qq: [number, number, number, number, number], o: number) => [qq[0] - qq[4] * o, qq[1] + 0.035, qq[2] + qq[3] * o];
              const lo = Math.min(k, k + 0.55), hi = Math.max(k, k + 0.55);
              if (dir > 0) g.quad([p(a0, hi), p(a1, hi), p(a1, lo), p(a0, lo)], [0, 1, 0], COL.white);
              else g.quad([p(a1, hi), p(a0, hi), p(a0, lo), p(a1, lo)], [0, 1, 0], COL.white);
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
        // parapets: real walls with a top, plus the deck fascia down to the slab underside
        for (const sd of [-1, 1]) {
          const o = (hw + 0.6) * sd;
          ribbon(bg, pl, 0, len, o - 0.2, o + 0.2, 1.0, COL.concrete);
          wall(bg, pl, 0, len, o + 0.2 * sd, -1.0, 1.0, COL.concrete);
          wall(bg, pl, 0, len, o - 0.2 * sd, 0, 1.0, COL.concrete);
        }
        const nPier = Math.floor(len / (e.deck !== undefined ? 26 : 32));
        for (let i = 1; i <= nPier; i++) {
          const p = at(pl, (len * i) / (nPier + 1));
          if (!done && i / (nPier + 1) > e.progress + 0.15) continue; // piers appear span by span
          const base = e.bridge ? -5 : e.deck !== undefined ? Math.max(0, this.ground(p[0], p[2])) : p[1] - 7.2;
          const h = p[1] - 1 - base;
          if (h < (e.deck !== undefined ? 2.2 : 0.5)) continue;
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
      const deg = this.rdeg(n);
      if (deg < 2) {
        if (deg === 1) { // cul-de-sac / end cap
          g.setTransform(n.x, n.y, n.z, 0);
          disc(g, 0, 0.005, 0, Math.max(3, n.radius * 0.9), 12, COL.asphalt);
          g.setTransform(0, 0, 0, 0);
        }
        continue;
      }
      if (deg === 2) {
        // smooth joint between two segments
        const inc = this.edgesAt(n.id);
        const br = bendR.get(n.id);
        if (br !== undefined && inc.length === 2) {
          const [e1, e2] = inc;
          const A = armOf(n.id, e1, br), B = armOf(n.id, e2, br);
          const bpl = toPL(bendLine(A, B, n.x, n.y, n.z));
          const L = bpl.s[bpl.s.length - 1];
          const hw = Math.max(A.hw, B.hw);
          const dirt = e1.cls === RoadClass.Dirt && e2.cls === RoadClass.Dirt;
          ribbon(g, bpl, 0, L, -hw, hw, 0.004, dirt ? COL.dirt : COL.asphalt, 3);
          if (A.walk && B.walk) {
            ribbon(g, bpl, 0, L, hw, hw + 2.6, 0.12, COL.walk, 3);
            ribbon(g, bpl, 0, L, -hw - 2.6, -hw, 0.12, COL.walk, 3);
            ribbon(g, bpl, 0, L, hw, hw + 0.25, 0.14, COL.curb, 3);
            ribbon(g, bpl, 0, L, -hw - 0.25, -hw, 0.14, COL.curb, 3);
          }
          if (!dirt && !e1.oneway && !e2.oneway) {
            if (e1.cls >= RoadClass.Avenue && e2.cls >= RoadClass.Avenue) ribbon(g, bpl, 0, L, -0.8, 0.8, 0.18, COL.median, 3);
            else if (e1.cls !== RoadClass.Highway) { ribbon(g, bpl, 0, L, -0.2, -0.06, 0.03, COL.yellow, 3); ribbon(g, bpl, 0, L, 0.06, 0.2, 0.03, COL.yellow, 3); }
          }
        } else if (inc.length) {
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
      const anyDirt = this.edgesAt(n.id).every((e) => e.cls === RoadClass.Dirt);
      const nr = this.nodeR(n.id);
      if (n.control === 3) {
        g.setTransform(n.x, n.y, n.z, 0);
        disc(g, 0, 0.01, 0, nr, 24, anyDirt ? COL.dirt : COL.asphalt);
        disc(g, 0, 0.21, 0, nr * 0.5, 20, COL.curb);
        disc(g, 0, 0.22, 0, nr * 0.45, 20, COL.median);
        g.setTransform(0, 0, 0, 0);
      } else {
        // filleted junction: kerbs curve from one road mouth to the next
        const arms = this.edgesAt(n.id).map((e) => armOf(n.id, e, Math.min(nr * 0.92, plOf(e).s.at(-1)! / 2)));
        junction(g, n.x, n.y, n.z, arms, { surface: anyDirt ? COL.dirt : COL.asphalt, walk: COL.walk, curb: COL.curb }, this.ground);
      }
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
    this.onCuts?.(this.cuts);
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
  /** open cuts of all tunnels (centre line with road height, half width); sent to the terrain to be carved */
  cuts: { pts: number[]; hw: number }[] = [];
  onCuts: ((c: { pts: number[]; hw: number }[]) => void) | null = null;
  private static PORTAL_D = 6.5;

  /** depth of a tunnel road below the surface at arc length s */
  private depthAt(pl: PL, s: number) { const p = at(pl, s); return { p, d: Math.max(0.3, this.ground(p[0], p[2])) + 0.12 - p[1] }; }

  /** the stretches of a tunnel that run in an open cut (between the surface and the portal) */
  private cutRuns(e: EdgeView, pl: PL, len: number): { s0: number; s1: number }[] {
    const built = e.progress >= 1 ? len : len * e.progress;
    const runs: { s0: number; s1: number }[] = [];
    let cur: { s0: number; s1: number } | null = null;
    for (let s = 0; s <= built; s += 2) {
      const { d } = this.depthAt(pl, s);
      const open = d > 0.3 && d < RoadsLayer.PORTAL_D;
      if (open) { if (!cur) runs.push(cur = { s0: Math.max(0, s - 2), s1: s }); cur.s1 = Math.min(built, s + 2); } else cur = null;
    }
    return runs;
  }

  /** where a street above has trench openings (in its own arc length), with the trench half width */
  private holesOn(e: EdgeView, pl: PL): { s0: number; s1: number; hw: number }[] {
    const out: { s0: number; s1: number; hw: number }[] = [];
    const ax = pl.x[0], az = pl.z[0], bx = pl.x[pl.x.length - 1], bz = pl.z[pl.z.length - 1];
    const L = Math.hypot(bx - ax, bz - az) || 1, ux = (bx - ax) / L, uz = (bz - az) / L;
    for (const c of this.cuts) {
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < c.pts.length; k += 3) {
        const rx = c.pts[k] - ax, rz = c.pts[k + 2] - az;
        const t = rx * ux + rz * uz, d = Math.abs(rx * uz - rz * ux);
        if (d < 2.5 && t > -2 && t < L + 2) { lo = Math.min(lo, t); hi = Math.max(hi, t); }
      }
      if (hi > lo) out.push({ s0: lo - 1, s1: hi + 1, hw: c.hw });
    }
    return out;
  }

  /**
   * Tunnels: open stretches are ordinary road; in the cut the road runs at its true depth between retaining
   * walls (the terrain is carved around it); deeper it is underground — with a concrete portal at the mouth.
   */
  private tunnel(g: GB, bg: GB, e: EdgeView, pl: PL, len: number) {
    const hw = edgeHalfWidth(e);
    const built = e.progress >= 1 ? len : len * e.progress;
    const wallC = COL.concrete, dark = COL.tunnel;
    const runs = this.cutRuns(e, pl, len);
    const inRun = (s: number) => runs.some((r) => s >= r.s0 && s <= r.s1);
    const step = 2;
    for (let s = 0; s < built - 0.05; s += step) {
      const s1 = Math.min(built, s + step), mid = (s + s1) / 2;
      const { d } = this.depthAt(pl, mid);
      if (d >= RoadsLayer.PORTAL_D) continue; // underground
      ribbon(g, pl, s, s1, -hw, hw, 0, COL.asphalt, step);
      if (!inRun(mid) || d < 0.3) continue;
      ribbon(g, pl, s, s1, -0.08, 0.08, 0.03, COL.yellow, step);
      // retaining walls from the road up to just above the surface, continuous along the cut
      const A = at(pl, s), B = at(pl, s1);
      for (const sd of [-1, 1]) {
        const o = (hw + 0.3) * sd;
        const P = (q: [number, number, number, number, number], top: boolean) => {
          const x = q[0] - q[4] * o, z = q[2] + q[3] * o;
          return [x, top ? Math.max(0.3, this.ground(x, z)) + 0.9 : q[1] - 0.3, z];
        };
        bg.quad([P(A, false), P(B, false), P(B, true), P(A, true)], [-A[4] * sd, 0, A[3] * sd], wallC);
        // coping on top of the wall
        const Q = (q: [number, number, number, number, number], oo: number) => { const x = q[0] - q[4] * oo, z = q[2] + q[3] * oo; return [x, Math.max(0.3, this.ground(q[0] - q[4] * o, q[2] + q[3] * o)) + 0.9, z]; };
        bg.quad([Q(A, o - 0.25), Q(B, o - 0.25), Q(B, o + 0.25), Q(A, o + 0.25)], [0, 1, 0], wallC);
      }
    }
    // portals: where the cut meets the underground part
    for (const r of runs) for (const [sp, inward] of [[r.s0, -1], [r.s1, 1]] as [number, number][]) {
      if (sp <= 0.5 || sp >= built - 0.5) continue;
      const q = at(pl, sp), ang = Math.atan2(q[4], q[3]);
      if (this.depthAt(pl, sp + inward * 3).d < RoadsLayer.PORTAL_D - 0.5) continue; // not going underground here
      const gy = Math.max(0.3, this.ground(q[0], q[2])) + 1.2;
      const H = Math.max(6.2, gy - q[1]);
      bg.setTransform(q[0], q[1], q[2], ang);
      // headwall facing the cut: two jambs, a lintel up to the surface, and the dark mouth behind
      bg.box(0, -0.3, -hw - 1.0, 1.2, H + 0.3, 1.6, wallC);
      bg.box(0, -0.3, hw + 1.0, 1.2, H + 0.3, 1.6, wallC);
      bg.box(0, 5.4, 0, 1.2, H - 5.4, hw * 2 + 3.6, wallC);
      bg.box(inward * 0.9, -0.1, 0, 0.6, 5.6, hw * 2 + 0.4, dark);
      bg.setTransform(0, 0, 0, 0);
    }
  }

  /** decks/tunnels leave from the middle of a street: they don't make a node a junction visually */
  private deckAt = new Map<number, number>();
  private rdeg(n: NodeView) { return n.deg - (this.deckAt.get(n.id) ?? 0); }
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
