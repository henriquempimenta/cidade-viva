import * as THREE from 'three';
import { LANE_WIDTH, RoadClass } from '../shared/constants';
import { CROSSWALK_HALF_LEN, CROSSWALK_INSET, edgeHalfWidth, hasEndCrosswalk, nodeRenderRadius, SIDEWALK_WIDTH, STOP_LINE_GAP } from '../shared/roadGeom';
import type { EdgeView, NodeView } from '../shared/protocol';
import { GB } from './geomBuilder';
import { U } from './uniforms';
import { bendLine, junction, type Arm } from './junctions';

export { edgeHalfWidth };

const COL = {
  asphalt: new THREE.Color(0x3d4044), asphaltOld: new THREE.Color(0x4a4c4f), dirt: new THREE.Color(0x9b7f5a), earth: new THREE.Color(0x7d6243),
  walk: new THREE.Color(0xb9b4aa), curb: new THREE.Color(0xd2cdc2), retain: new THREE.Color(0x8e8980),
  white: new THREE.Color(0xf2f2ee), yellow: new THREE.Color(0xf2c230),
  median: new THREE.Color(0x6f9e4c), bus: new THREE.Color(0x9c3b34), concrete: new THREE.Color(0xb8b3aa), concreteDark: new THREE.Color(0x969188),
  tunnel: new THREE.Color(0x1d1f22), rail: new THREE.Color(0x777777),
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

/** Lift a polyline's center heights so the full carriageway [-hw, +hw] clears the exact triangle meshY. */
function liftSurfacePL(pl: PL, hw: number, ground: (x: number, z: number) => number, step = 4, onlyEnds = false): PL {
  const len = pl.s[pl.s.length - 1];
  const n = Math.max(1, Math.ceil(len / step));
  const out: PL = { x: [], y: [], z: [], s: [] };
  for (let i = 0; i <= n; i++) {
    const s = (len * i) / n;
    const q = at(pl, s);
    let y = q[1];
    if (!onlyEnds || s <= 14 || s >= len - 14) {
      const gC = ground(q[0], q[2]);
      const gL = ground(q[0] + q[4] * hw, q[2] - q[3] * hw);
      const gR = ground(q[0] - q[4] * hw, q[2] + q[3] * hw);
      y = Math.max(y, gC + 0.14, gL + 0.14, gR + 0.14);
    }
    out.x.push(q[0]); out.y.push(y); out.z.push(q[2]); out.s.push(s);
  }
  return out;
}

function ribbon(
  g: GB, pl: PL, s0: number, s1: number, o0: number, o1: number, dy: number, c: THREE.Color, step = 4,
  ground?: (x: number, z: number) => number, minClear = 0.16,
) {
  if (s1 - s0 < 0.2) return;
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  let prev = at(pl, s0);
  const pt = (q: [number, number, number, number, number], o: number): [number, number, number] => {
    const x = q[0] - q[4] * o, z = q[2] + q[3] * o;
    const y = ground ? Math.max(q[1] + dy, ground(x, z) + minClear) : q[1] + dy;
    return [x, y, z];
  };
  for (let i = 1; i <= n; i++) {
    const cur = at(pl, s0 + ((s1 - s0) * i) / n);
    g.quad([pt(prev, o1), pt(cur, o1), pt(cur, o0), pt(prev, o0)], [0, 1, 0], c);
    prev = cur;
  }
}

/** Vertical retaining/curb skirt along offset `o` from lifted top down to ground (when top - ground > threshold). */
function groundSkirt(
  g: GB, pl: PL, s0: number, s1: number, o: number, dy: number, c: THREE.Color,
  ground: (x: number, z: number) => number, minClear = 0.16, thresh = 0.12, step = 4,
) {
  if (s1 - s0 < 0.2) return;
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  let prev = at(pl, s0);
  const sd = Math.sign(o || 1);
  for (let i = 1; i <= n; i++) {
    const cur = at(pl, s0 + ((s1 - s0) * i) / n);
    const ax = prev[0] - prev[4] * o, az = prev[2] + prev[3] * o;
    const bx = cur[0] - cur[4] * o, bz = cur[2] + cur[3] * o;
    const ga = ground(ax, az), gb = ground(bx, bz);
    const ya = Math.max(prev[1] + dy, ga + minClear);
    const yb = Math.max(cur[1] + dy, gb + minClear);
    if (ga > -1e8 && gb > -1e8 && (ya - ga > thresh || yb - gb > thresh)) {
      const nx = -cur[4] * sd, nz = cur[3] * sd;
      g.quad([[ax, ga - 0.35, az], [bx, gb - 0.35, bz], [bx, yb, bz], [ax, ya, az]], [nx, 0, nz], c);
    }
    prev = cur;
  }
}

/** vertical wall along a polyline at lateral offset o, from dy0 to dy1 above it (double-sided material) */
function wall(g: GB, pl: PL, s0: number, s1: number, o: number, dy0: number, dy1: number, c: THREE.Color, step = 6) {
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
  /** terrain height sampler (set by the app to TerrainView.meshY) so roads & junctions never sink under triangles */
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
    this.poles.count = 0; this.poles.frustumCulled = false;
    this.lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, 0.18, 0.35), new THREE.MeshBasicMaterial({ color: 0xffd9a0 }), 12000);
    this.lamps.count = 0; this.lamps.frustumCulled = false;
    const poolG = new THREE.CircleGeometry(7, 12).rotateX(-Math.PI / 2);
    this.pools = new THREE.InstancedMesh(poolG, new THREE.MeshBasicMaterial({ color: 0xffb860, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }), 12000);
    this.pools.count = 0; this.pools.frustumCulled = false;
    this.pools.renderOrder = 3;
    const coneG = new THREE.ConeGeometry(0.25, 0.7, 6).translate(0, 0.35, 0);
    this.cones = new THREE.InstancedMesh(coneG, new THREE.MeshStandardMaterial({ color: 0xff6a10 }), 3000);
    this.cones.count = 0; this.cones.frustumCulled = false;
    this.signals = new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffffff }), 4000);
    this.signals.count = 0; this.signals.frustumCulled = false;
    const pil = new THREE.BoxGeometry(1.4, 1, 1.4).translate(0, 0.5, 0);
    this.elevatedPillars = new THREE.InstancedMesh(pil, new THREE.MeshStandardMaterial({ color: 0xb0aba2 }), 6000);
    this.elevatedPillars.count = 0;
    this.elevatedPillars.castShadow = true;
    this.elevatedPillars.receiveShadow = true;
    this.elevatedPillars.frustumCulled = false;
    this.group.add(this.poles, this.lamps, this.pools, this.cones, this.signals, this.elevatedPillars);
  }

  /** Force an immediate rebuild on next update (e.g. after terrain heights update). */
  markDirty() { this.dirty = true; this.lastBuild = 0; }

  upsertNode(n: NodeView) { this.nodes.set(n.id, n); this.dirty = true; }
  upsertEdge(e: EdgeView) {
    const prev = this.edges.get(e.id);
    this.edges.set(e.id, e);
    const ptsMoved = !prev || prev.pts.length !== e.pts.length
      || Math.abs((prev.pts[1] ?? 0) - (e.pts[1] ?? 0)) > 0.02
      || Math.abs((prev.pts[prev.pts.length - 2] ?? 0) - (e.pts[e.pts.length - 2] ?? 0)) > 0.02;
    if (ptsMoved || prev.progress < 1 !== e.progress < 1 || prev.cls !== e.cls || prev.lanes !== e.lanes || prev.busLane !== e.busLane || prev.oneway !== e.oneway || prev.upgrading !== e.upgrading || prev.elevated !== e.elevated || prev.hole !== e.hole || prev.deck !== e.deck) this.dirty = true;
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
    const plCache = new Map<number, PL>();
    const plOf = (e: EdgeView) => {
      let p = plCache.get(e.id);
      if (!p) {
        const raw = toPL(e.pts);
        const hw = edgeHalfWidth(e);
        if (!e.bridge && !e.elevated && !e.tunnel && e.deck === undefined) {
          p = liftSurfacePL(raw, hw, this.ground, 4, false);
        } else if (e.bridge && !e.elevated && e.deck === undefined) {
          // Over water ground < 0 so the water arch is untouched; over riverbank approaches both carriageway and walkways clear meshY
          p = liftSurfacePL(raw, hw + 1.45, this.ground, 4, false);
        } else {
          p = raw;
        }
        plCache.set(e.id, p);
      }
      return p;
    };
    const edgeHasWalk = (e: EdgeView): boolean => {
      if (e.cls === RoadClass.Dirt || e.bridge || e.elevated || e.tunnel || e.deck !== undefined) return false;
      if (e.cls !== RoadClass.Highway) return true;
      const na = this.nodes.get(e.a), nb = this.nodes.get(e.b);
      return (!!na && this.rdeg(na) >= 3 && !na.interchange) || (!!nb && this.rdeg(nb) >= 3 && !nb.interchange);
    };
    const armOf = (nid: number, e: EdgeView, r: number): Arm => {
      const pl = plOf(e), len = pl.s[pl.s.length - 1];
      const fromA = e.a === nid;
      const q0 = at(pl, fromA ? Math.min(r, len) : Math.max(0, len - r));
      const walk = edgeHasWalk(e);
      return { x: q0[0], y: q0[1], z: q0[2], dx: fromA ? q0[3] : -q0[3], dz: fromA ? q0[4] : -q0[4], hw: edgeHalfWidth(e), walk };
    };
    const bendR = new Map<number, number>();
    for (const n of this.nodes.values()) {
      if (this.rdeg(n) !== 2) continue;
      const inc = this.edgesAt(n.id);
      if (inc.length !== 2) continue;
      // Do not cut bridge mouths with a curved bend (keep crisp abutment seam + walkway taper instead)
      if (inc.some((e) => e.bridge || e.elevated || e.deck !== undefined)) continue;
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
      const pl = plOf(e), len = pl.s[pl.s.length - 1], hwT = edgeHalfWidth(e) + 0.35;
      for (const r of this.cutRuns(e, pl, len)) {
        const pts: number[] = [];
        for (let s = r.s0; s <= r.s1 + 0.01; s += 2) { const q0 = at(pl, Math.min(s, r.s1)); pts.push(q0[0], q0[1], q0[2]); }
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
      const isAtGrade = !e.bridge && !e.elevated && !e.tunnel && e.deck === undefined;
      const surfG = isAtGrade ? this.ground : undefined;
      if (!done && e.deck !== undefined) {
        ribbon(bg, pl, s0, s0 + (s1 - s0) * e.progress, -hw - 0.8, hw + 0.8, 0, COL.concrete, 6);
      } else if (!done) {
        const sp = s0 + (s1 - s0) * e.progress;
        ribbon(g, pl, s0, sp, -hw, hw, 0.02, surface, 4, surfG, 0.14);
        ribbon(g, pl, sp, s1, -hw - 1, hw + 1, 0, COL.earth, 4, surfG, 0.12);
        for (let s = s0; s < s1; s += 9) {
          const p = at(pl, s);
          for (const side of [-1, 1]) { m.makeTranslation(p[0] - p[4] * (hw + 0.6) * side, p[1], p[2] + p[3] * (hw + 0.6) * side); cones.push(m.clone()); }
        }
      } else {
        const holes = e.hole ? this.holesOn(e, pl) : [];
        for (const [a0, a1] of spans(s0, s1, holes)) ribbon(g, pl, a0, a1, -hw, hw, 0, surface, 4, surfG, 0.14);
        for (const h of holes) {
          const h0 = Math.max(s0, h.s0), h1 = Math.min(s1, h.s1), inner = h.hw + 0.55;
          if (h1 - h0 < 0.5 || inner >= hw - 1) continue;
          ribbon(g, pl, h0, h1, inner, hw, 0, surface, 4, surfG, 0.14);
          ribbon(g, pl, h0, h1, -hw, -inner, 0, surface, 4, surfG, 0.14);
          dashes(g, pl, h0, h1, inner + 0.25, 0.15, 3, 4, 0.03, COL.white);
          dashes(g, pl, h0, h1, -inner - 0.25, 0.15, 3, 4, 0.03, COL.white);
        }
        if (e.upgrading) for (let s = s0; s < s1; s += 7) { const p = at(pl, s); m.makeTranslation(p[0] - p[4] * (hw - 0.6), p[1], p[2] + p[3] * (hw - 0.6)); cones.push(m.clone()); }
        if (!dirt) {
          if (edgeHasWalk(e)) {
            ribbon(g, pl, s0, s1, hw, hw + SIDEWALK_WIDTH, 0.12, COL.walk, 4, surfG, 0.26);
            ribbon(g, pl, s0, s1, -hw - SIDEWALK_WIDTH, -hw, 0.12, COL.walk, 4, surfG, 0.26);
            ribbon(g, pl, s0, s1, hw, hw + 0.25, 0.14, COL.curb, 4, surfG, 0.28);
            ribbon(g, pl, s0, s1, -hw - 0.25, -hw, 0.14, COL.curb, 4, surfG, 0.28);
            // vertical curb risers between carriageway and raised sidewalk
            wall(g, pl, s0, s1, hw, 0, 0.13, COL.curb, 4);
            wall(g, pl, s0, s1, -hw, 0, 0.13, COL.curb, 4);
            // downhill retaining walls sealing sidewalk edges cleanly to the ground
            if (isAtGrade) {
              groundSkirt(g, pl, s0, s1, hw + SIDEWALK_WIDTH, 0.12, COL.retain, this.ground, 0.26, 0.12, 4);
              groundSkirt(g, pl, s0, s1, -(hw + SIDEWALK_WIDTH), 0.12, COL.retain, this.ground, 0.26, 0.12, 4);
            }
          } else if (isAtGrade) {
            groundSkirt(g, pl, s0, s1, hw, 0, COL.retain, this.ground, 0.14, 0.14, 4);
            groundSkirt(g, pl, s0, s1, -hw, 0, COL.retain, this.ground, 0.14, 0.14, 4);
          }
          // check which ends have painted crosswalks so longitudinal lines never overlap the zebra stripes
          const cwEnds: [number, number, number][] = [];
          let hasCwA = false, hasCwB = false;
          for (const [nid, sc, dir] of [[e.a, s0 + CROSSWALK_INSET, 1], [e.b, s1 - CROSSWALK_INSET, -1]] as [number, number, number][]) {
            const nd = this.nodes.get(nid);
            const deg = nd ? this.rdeg(nd) : 0;
            const inc = this.edgesAt(nid);
            const hasUrban = inc.some((q0) => q0.cls >= RoadClass.Local && q0.cls <= RoadClass.Avenue);
            if (hasEndCrosswalk(e, len, deg, hasUrban, !!nd?.interchange)) {
              cwEnds.push([nid, sc, dir]);
              if (dir > 0) hasCwA = true; else hasCwB = true;
            }
          }
          // markings (trimmed behind painted crosswalks and not over a trench opening)
          const cwMargin = CROSSWALK_INSET + CROSSWALK_HALF_LEN + 0.5;
          const markS0 = hasCwA ? Math.min(s1, s0 + cwMargin) : s0;
          const markS1 = hasCwB ? Math.max(markS0, s1 - cwMargin) : s1;
          const dy = 0.03;
          for (const [m0, m1] of spans(markS0, markS1, holes)) {
            const pad0 = hasCwA && m0 <= markS0 + 0.05 ? 0.35 : 2;
            const pad1 = hasCwB && m1 >= markS1 - 0.05 ? 0.35 : 2;
            const l0 = m0 + pad0, l1 = m1 - pad1;
            if (l1 <= l0 + 0.4) continue;
            if (e.oneway) {
              for (let l = 1; l < e.lanes; l++) dashes(g, pl, l0, l1, -hw + 0.4 + l * LANE_WIDTH, 0.15, 3, 4, dy, COL.white);
            } else {
              if (e.cls >= RoadClass.Avenue) {
                const med0 = hasCwA && m0 <= markS0 + 0.05 ? m0 + 0.5 : m0 + 3;
                const med1 = hasCwB && m1 >= markS1 - 0.05 ? m1 - 0.5 : m1 - 3;
                if (med1 > med0 + 0.5) ribbon(g, pl, med0, med1, -0.8, 0.8, 0.18, COL.median, 4);
              } else {
                ribbon(g, pl, l0, l1, -0.2, -0.06, dy, COL.yellow, 4);
                ribbon(g, pl, l0, l1, 0.06, 0.2, dy, COL.yellow, 4);
              }
              const med = e.cls >= RoadClass.Avenue ? 0.8 : 0;
              for (let l = 1; l < e.lanes; l++) {
                dashes(g, pl, l0, l1, med + l * LANE_WIDTH, 0.15, 3, 4, dy, COL.white);
                dashes(g, pl, l0, l1, -med - l * LANE_WIDTH, 0.15, 3, 4, dy, COL.white);
              }
              if (e.busLane) {
                ribbon(g, pl, m0 + (hasCwA && m0 <= markS0 + 0.05 ? 0.2 : 1), m1 - (hasCwB && m1 >= markS1 - 0.05 ? 0.2 : 1), med + (e.lanes - 1) * LANE_WIDTH, med + e.lanes * LANE_WIDTH, dy * 0.6, COL.bus, 4);
                ribbon(g, pl, m0 + (hasCwA && m0 <= markS0 + 0.05 ? 0.2 : 1), m1 - (hasCwB && m1 >= markS1 - 0.05 ? 0.2 : 1), -med - e.lanes * LANE_WIDTH, -med - (e.lanes - 1) * LANE_WIDTH, dy * 0.6, COL.bus, 4);
              }
            }
          }
          // crosswalks + aligned white stop bars at ends
          for (const [, sc, dir] of cwEnds) {
            for (let k = -hw + 0.6; k < hw - 0.4; k += 1.1) {
              const a0 = at(pl, sc - CROSSWALK_HALF_LEN * dir), a1 = at(pl, sc + CROSSWALK_HALF_LEN * dir);
              const p = (qq: [number, number, number, number, number], o: number) => [qq[0] - qq[4] * o, qq[1] + 0.035, qq[2] + qq[3] * o];
              const lo = Math.min(k, k + 0.55), hi = Math.max(k, k + 0.55);
              if (dir > 0) g.quad([p(a0, hi), p(a1, hi), p(a1, lo), p(a0, lo)], [0, 1, 0], COL.white);
              else g.quad([p(a1, hi), p(a0, hi), p(a0, lo), p(a1, lo)], [0, 1, 0], COL.white);
            }
            // Crisp white stop line right behind the zebra on the approaching half of the carriageway
            if (len > 30) {
              const sBar = sc + (CROSSWALK_HALF_LEN + STOP_LINE_GAP * 0.65) * dir;
              if (sBar > 1 && sBar < len - 1) {
                // dir > 0 means approaching e.a (travelling b -> a, occupying negative lateral offset);
                // dir < 0 means approaching e.b (travelling a -> b, occupying positive lateral offset).
                const loOff = e.oneway ? -hw + 0.35 : (dir > 0 ? -hw + 0.35 : 0.25);
                const hiOff = e.oneway ? hw - 0.35 : (dir > 0 ? -0.25 : hw - 0.35);
                ribbon(g, pl, sBar - 0.18, sBar + 0.18, loOff, hiOff, 0.038, COL.white, 0.5);
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
              const px = p[0] - p[4] * off, pz = p[2] + p[3] * off;
              const py = isAtGrade ? Math.max(p[1] + 0.12, this.ground(px, pz) + 0.24) : p[1];
              m.compose(new THREE.Vector3(px, py, pz), q, new THREE.Vector3(1, 1, 1));
              poles.push(m.clone());
              if (e.cls >= RoadClass.Avenue && !e.oneway) {
                q.setFromAxisAngle(up, -ang - Math.PI / 2);
                m.compose(new THREE.Vector3(p[0], p[1], p[2]), q, new THREE.Vector3(1, 1, 1));
                poles.push(m.clone());
              }
              side = -side;
            }
          }
        } else if (isAtGrade) {
          // Dirt road embankment skirts on slopes
          groundSkirt(g, pl, s0, s1, hw, 0, COL.earth, this.ground, 0.14, 0.14, 4);
          groundSkirt(g, pl, s0, s1, -hw, 0, COL.earth, this.ground, 0.14, 0.14, 4);
        }
      }
      // bridge / elevated structure
      if (e.bridge || e.elevated) {
        const hasWalkway = !!e.bridge && !e.elevated && e.deck === undefined;
        const deckPad = hasWalkway ? 1.9 : 0.8;
        const paraOff = hasWalkway ? hw + 1.65 : hw + 0.6;
        // Trim bridge deck, walkways, and parapets to junction mouths [s0, s1] so parapets never poke into T-junctions
        const bS0 = Math.max(0, s0);
        const bS1 = Math.min(len, s1);
        const pS0 = bS0 > 0.5 ? Math.min(bS1, bS0 + 0.6) : 0;
        const pS1 = bS1 < len - 0.5 ? Math.max(pS0, bS1 - 0.6) : len;
        if (bS1 > bS0 + 0.5) {
          // closed concrete deck underside + top edge slab
          ribbon(bg, pl, bS0, bS1, -hw - deckPad, hw + deckPad, -1.0, COL.concreteDark, 6);
          if (hasWalkway && done) {
            // dedicated raised pedestrian walkways on both sides of the bridge deck inside the parapets
            ribbon(g, pl, bS0, bS1, hw, hw + 1.45, 0.12, COL.walk, 4);
            ribbon(g, pl, bS0, bS1, -hw - 1.45, -hw, 0.12, COL.walk, 4);
            ribbon(g, pl, bS0, bS1, hw, hw + 0.22, 0.14, COL.curb, 4);
            ribbon(g, pl, bS0, bS1, -hw - 0.22, -hw, 0.14, COL.curb, 4);
            wall(g, pl, bS0, bS1, hw, 0, 0.13, COL.curb, 6);
            wall(g, pl, bS0, bS1, -hw, 0, 0.13, COL.curb, 6);
          }
          // parapets: real walls with a top, plus the deck fascia down to the slab underside
          for (const sd of [-1, 1]) {
            const o = paraOff * sd;
            ribbon(bg, pl, pS0, pS1, o - 0.2, o + 0.2, 1.0, COL.concrete, 6);
            wall(bg, pl, pS0, pS1, o + 0.2 * sd, -1.0, 1.0, COL.concrete, 6);
            wall(bg, pl, pS0, pS1, o - 0.2 * sd, 0, 1.0, COL.concrete, 6);
          }
        }
        // Closed concrete abutments & wing walls at both ends of bridges (seals deck-to-bank transition cleanly)
        if (e.bridge && !e.elevated && bS1 > bS0 + 1) {
          for (const [endS, paraEndS, inward, atJunc] of [[bS0, pS0, 1, bS0 > 0.5], [bS1, pS1, -1, bS1 < len - 0.5]] as [number, number, number, boolean][]) {
            const ep = at(pl, endS);
            const pp = at(pl, paraEndS);
            const ang = Math.atan2(ep[4], ep[3]);
            const gy = this.ground(ep[0], ep[2]);
            const bot = Math.min(gy - 2.2, ep[1] - 4.5);
            const hAbut = Math.max(1.5, ep[1] - 0.05 - bot);
            bg.setTransform(ep[0], bot, ep[2], ang);
            // Solid abutment headwall tucked cleanly beneath the approach slab
            bg.box(inward * 1.4, 0, 0, 3.6, hAbut, (hw + deckPad + 0.25) * 2, COL.concreteDark);
            bg.setTransform(0, 0, 0, 0);
            // Parapet end-posts at the exact parapet termination; add wing walls only when NOT inside a junction mouth
            bg.setTransform(pp[0], pp[1] - 0.05, pp[2], ang);
            for (const sd of [-1, 1]) {
              bg.box(inward * 0.25, 0, sd * paraOff, 0.7, 1.08, 0.52, COL.concrete);
              if (!atJunc) {
                bg.box(-inward * 2.2, -3.0, sd * (hw + deckPad + 0.35), 4.2, 3.15, 0.6, COL.concreteDark);
              }
            }
            bg.setTransform(0, 0, 0, 0);
          }
        }
        // Elevated viaduct lower ramp side walls (where clearance is too low for piers)
        if (e.elevated && e.deck !== undefined) {
          for (let s = 0; s < len; s += 4) {
            const sNext = Math.min(len, s + 4);
            const a0 = at(pl, s), a1 = at(pl, sNext);
            const g0 = this.ground(a0[0], a0[2]), g1 = this.ground(a1[0], a1[2]);
            const h0 = a0[1] - g0, h1 = a1[1] - g1;
            if (Math.min(h0, h1) < 2.8 && Math.max(h0, h1) > 0.25) {
              for (const sd of [-1, 1]) {
                const o = (hw + deckPad) * sd;
                const nx = -a0[4] * sd, nz = a0[3] * sd;
                const ax = a0[0] - a0[4] * o, az = a0[2] + a0[3] * o;
                const bx = a1[0] - a1[4] * o, bz = a1[2] + a1[3] * o;
                bg.quad([
                  [ax, g0 - 0.8, az], [bx, g1 - 0.8, bz], [bx, a1[1], bz], [ax, a0[1], az],
                ], [nx, 0, nz], COL.concreteDark);
              }
            }
          }
        }
        // Bridge & viaduct piers extending to real riverbed / meshY ground + pier cap beams
        const nPier = Math.floor(len / (e.deck !== undefined ? 26 : 30));
        for (let i = 1; i <= nPier; i++) {
          const p = at(pl, (len * i) / (nPier + 1));
          if (!done && i / (nPier + 1) > e.progress + 0.15) continue;
          const gy = this.ground(p[0], p[2]);
          const base = gy < 0.2 ? Math.min(gy - 1.5, -4.5) : gy - 1.2;
          const topY = p[1] - 1.0;
          const h = topY - base;
          if (h < (e.deck !== undefined ? 2.2 : 0.8)) continue;
          const ang = Math.atan2(p[4], p[3]);
          q.setFromAxisAngle(up, -ang);
          m.compose(new THREE.Vector3(p[0], base, p[2]), q, new THREE.Vector3(1.3, h, hw * 1.15));
          pillars.push(m.clone());
          // Concrete pier cap beam supporting the full deck width
          bg.setTransform(p[0], topY - 0.55, p[2], ang);
          bg.box(0, 0, 0, 2.2, 0.65, (hw + deckPad - 0.2) * 2, COL.concrete);
          bg.setTransform(0, 0, 0, 0);
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
    // intersections & smooth bends
    for (const n of this.nodes.values()) {
      const deg = this.rdeg(n);
      if (deg < 2) {
        if (deg === 1) {
          const inc1 = this.edgesAt(n.id);
          const y1 = inc1.length ? armOf(n.id, inc1[0], 0).y : Math.max(n.y, this.ground(n.x, n.z) + 0.14);
          g.setTransform(n.x, y1, n.z, 0);
          disc(g, 0, 0.005, 0, Math.max(3, n.radius * 0.9), 12, inc1.every((e) => e.cls === RoadClass.Dirt) ? COL.dirt : COL.asphalt);
          g.setTransform(0, 0, 0, 0);
        }
        continue;
      }
      if (deg === 2) {
        const inc = this.edgesAt(n.id);
        const br = bendR.get(n.id);
        if (br !== undefined && inc.length === 2) {
          const [e1, e2] = inc;
          const A = armOf(n.id, e1, br), B = armOf(n.id, e2, br);
          const ny = Math.max(n.y, this.ground(n.x, n.z) + 0.14, (A.y + B.y) * 0.5);
          const rawBpl = toPL(bendLine(A, B, n.x, ny, n.z));
          const hw = Math.max(A.hw, B.hw);
          const bpl = liftSurfacePL(rawBpl, hw, this.ground, 3, false);
          const L = bpl.s[bpl.s.length - 1];
          const dirt = e1.cls === RoadClass.Dirt && e2.cls === RoadClass.Dirt;
          ribbon(g, bpl, 0, L, -hw, hw, 0.004, dirt ? COL.dirt : COL.asphalt, 3, this.ground, 0.14);
          if (A.walk && B.walk) {
            ribbon(g, bpl, 0, L, hw, hw + SIDEWALK_WIDTH, 0.12, COL.walk, 3, this.ground, 0.26);
            ribbon(g, bpl, 0, L, -hw - SIDEWALK_WIDTH, -hw, 0.12, COL.walk, 3, this.ground, 0.26);
            ribbon(g, bpl, 0, L, hw, hw + 0.25, 0.14, COL.curb, 3, this.ground, 0.28);
            ribbon(g, bpl, 0, L, -hw - 0.25, -hw, 0.14, COL.curb, 3, this.ground, 0.28);
            wall(g, bpl, 0, L, hw, 0, 0.13, COL.curb, 3);
            wall(g, bpl, 0, L, -hw, 0, 0.13, COL.curb, 3);
            groundSkirt(g, bpl, 0, L, hw + SIDEWALK_WIDTH, 0.12, COL.retain, this.ground, 0.26, 0.12, 3);
            groundSkirt(g, bpl, 0, L, -(hw + SIDEWALK_WIDTH), 0.12, COL.retain, this.ground, 0.26, 0.12, 3);
          } else if (A.walk !== B.walk) {
            // Taper sidewalk smoothly across the bend where urban road meets unpaved/highway
            const segs = 4;
            for (let k = 0; k < segs; k++) {
              const sA = (L * k) / segs, sB = (L * (k + 1)) / segs;
              const wMid = SIDEWALK_WIDTH * (A.walk ? 1 - (k + 0.5) / segs : (k + 0.5) / segs);
              if (wMid > 0.2) {
                ribbon(g, bpl, sA, sB, hw, hw + wMid, 0.12, COL.walk, 2, this.ground, 0.26);
                ribbon(g, bpl, sA, sB, -hw - wMid, -hw, 0.12, COL.walk, 2, this.ground, 0.26);
              }
            }
          } else {
            groundSkirt(g, bpl, 0, L, hw, 0, dirt ? COL.earth : COL.retain, this.ground, 0.14, 0.14, 3);
            groundSkirt(g, bpl, 0, L, -hw, 0, dirt ? COL.earth : COL.retain, this.ground, 0.14, 0.14, 3);
          }
          if (!dirt && !e1.oneway && !e2.oneway) {
            if (e1.cls >= RoadClass.Avenue && e2.cls >= RoadClass.Avenue) ribbon(g, bpl, 0, L, -0.8, 0.8, 0.18, COL.median, 3);
            else if (e1.cls !== RoadClass.Highway) { ribbon(g, bpl, 0, L, -0.2, -0.06, 0.03, COL.yellow, 3); ribbon(g, bpl, 0, L, 0.06, 0.2, 0.03, COL.yellow, 3); }
          }
        } else if (inc.length === 2 && inc.some((e) => e.bridge) && inc.some((e) => !e.bridge && edgeHasWalk(e))) {
          // Clean sidewalk-to-bridge-walkway transition where an urban street joins a bridge abutment
          const street = inc.find((e) => !e.bridge)!;
          const stArm = armOf(n.id, street, 0);
          const hw = stArm.hw;
          const y0 = stArm.y;
          const ang = Math.atan2(stArm.dz, stArm.dx);
          g.setTransform(stArm.x, y0, stArm.z, ang);
          for (const sd of [-1, 1]) {
            const yW = 0.125;
            // Trapezoid tapering smoothly from street sidewalk (hw + 2.6 at x=4) to bridge walkway (hw + 1.45 at x=0)
            const a0 = [0, yW, sd * hw], a1 = [4.0, yW, sd * hw];
            const b1 = [4.0, yW, sd * (hw + SIDEWALK_WIDTH)], b0 = [0, yW, sd * (hw + 1.45)];
            g.quad(sd > 0 ? [a0, a1, b1, b0] : [a0, b0, b1, a1], [0, 1, 0], COL.walk);
          }
          g.setTransform(0, 0, 0, 0);
          g.setTransform(n.x, y0, n.z, 0);
          disc(g, 0, 0.004, 0, Math.max(...inc.map((e) => edgeHalfWidth(e))), 14, COL.asphalt);
          g.setTransform(0, 0, 0, 0);
        } else if (inc.length) {
          const yMax = Math.max(...inc.map((e) => armOf(n.id, e, 0).y));
          g.setTransform(n.x, yMax, n.z, 0);
          disc(g, 0, 0.004, 0, Math.max(...inc.map((e) => edgeHalfWidth(e))), 14, inc.every((e) => e.cls === RoadClass.Dirt) ? COL.dirt : COL.asphalt);
          g.setTransform(0, 0, 0, 0);
        }
        continue;
      }
      if (n.interchange) {
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
          for (const px of [-L / 3, 0, L / 3]) bg.box(px, -1.0, 0, 1.6, 7.2, hwv * 1.2, COL.concrete);
          for (let k = -2; k <= 2; k++) bg.box(k * 4, 7.22, 0, 2.5, 0.02, 0.18, COL.white);
          bg.setTransform(0, 0, 0, 0);
        }
      }
      const anyDirt = this.edgesAt(n.id).every((e) => e.cls === RoadClass.Dirt);
      const nr = this.nodeR(n.id);
      if (n.control === 3) {
        const yRb = Math.max(n.y, this.ground(n.x, n.z) + 0.16);
        g.setTransform(n.x, yRb, n.z, 0);
        disc(g, 0, 0.01, 0, nr, 24, anyDirt ? COL.dirt : COL.asphalt);
        disc(g, 0, 0.21, 0, nr * 0.5, 20, COL.curb);
        disc(g, 0, 0.22, 0, nr * 0.45, 20, COL.median);
        g.setTransform(0, 0, 0, 0);
      } else {
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
          const py = Math.max(n.y, this.ground(px, pz) + 0.24);
          m.makeTranslation(px, py + 4.2, pz);
          sigM.push(m.clone());
          this.signalSlots.push({ node: n.id, edge: e.id, idx });
          q.identity();
          m.compose(new THREE.Vector3(px, py, pz), q, new THREE.Vector3(0.6, 0.6, 0.6));
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
   * Tunnels: open stretches are ordinary road; in the cut the road runs at its true depth between continuous
   * retaining walls with wide coping & backfill lips sealing cleanly against `TerrainView.setCuts()`, and
   * deeper stretches enter a solid concrete portal headwall.
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
      if (!inRun(mid) || d < 0.25) continue;
      ribbon(g, pl, s, s1, -0.08, 0.08, 0.03, COL.yellow, step);
      const A = at(pl, s), B = at(pl, s1);
      for (const sd of [-1, 1]) {
        const oIn = (hw + 0.25) * sd;
        const oOut = (hw + 0.95) * sd;
        const topY = (q0: [number, number, number, number, number]) => {
          const x = q0[0] - q0[4] * oIn, z = q0[2] + q0[3] * oIn;
          return Math.max(0.3, this.ground(x, z)) + 0.95;
        };
        const tA = topY(A), tB = topY(B);
        const P = (q0: [number, number, number, number, number], o: number, y: number) => [q0[0] - q0[4] * o, y, q0[2] + q0[3] * o];
        // Inner retaining wall down below the road floor
        bg.quad([P(A, oIn, A[1] - 0.35), P(B, oIn, B[1] - 0.35), P(B, oIn, tB), P(A, oIn, tA)], [-A[4] * sd, 0, A[3] * sd], wallC);
        // Wide concrete coping spanning over the cut bank edge (seals TerrainView.setCuts border)
        bg.quad([P(A, oIn, tA), P(B, oIn, tB), P(B, oOut, tB), P(A, oOut, tA)], [0, 1, 0], wallC);
        // Outer backfill lip dropping into the carved earth bank so zero cracks appear
        bg.quad([P(A, oOut, tA - 1.4), P(B, oOut, tB - 1.4), P(B, oOut, tB), P(A, oOut, tA)], [A[4] * sd, 0, -A[3] * sd], COL.concreteDark);
      }
    }
    // portals: where the cut meets the underground part
    for (const r of runs) for (const [sp, inward] of [[r.s0, -1], [r.s1, 1]] as [number, number][]) {
      if (sp <= 0.5 || sp >= built - 0.5) continue;
      const q0 = at(pl, sp), ang = Math.atan2(q0[4], q0[3]);
      if (this.depthAt(pl, sp + inward * 3).d < RoadsLayer.PORTAL_D - 0.5) continue;
      const gy = Math.max(0.3, this.ground(q0[0], q0[2])) + 1.5;
      const H = Math.max(6.5, gy - q0[1]);
      bg.setTransform(q0[0], q0[1], q0[2], ang);
      // Wide solid headwall, wing walls, lintel and dark tunnel mouth
      bg.box(0, -0.4, -hw - 1.1, 1.4, H + 0.4, 2.0, wallC);
      bg.box(0, -0.4, hw + 1.1, 1.4, H + 0.4, 2.0, wallC);
      bg.box(0, 5.4, 0, 1.4, H - 5.2, hw * 2 + 4.4, wallC);
      bg.box(inward * 0.9, -0.1, 0, 0.7, 5.6, hw * 2 + 0.4, dark);
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
