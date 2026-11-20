import * as THREE from 'three';
import type { CrossingView, RailEdgeView, RailStationView } from '../shared/protocol';
import { GB } from './geomBuilder';

function polyAt(p: number[], s: number, cum: number[]): [number, number, number, number, number] {
  const n = cum.length;
  for (let i = 1; i < n; i++) {
    if (cum[i] >= s || i === n - 1) {
      const t = Math.min(1, Math.max(0, (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1])));
      const x0 = p[(i - 1) * 3], y0 = p[(i - 1) * 3 + 1], z0 = p[(i - 1) * 3 + 2];
      const x1 = p[i * 3], y1 = p[i * 3 + 1], z1 = p[i * 3 + 2];
      const l = Math.hypot(x1 - x0, z1 - z0) || 1;
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t, (x1 - x0) / l, (z1 - z0) / l];
    }
  }
  return [p[0], p[1], p[2], 1, 0];
}
export function cumLen(p: number[]): number[] {
  const c = [0];
  for (let i = 3; i < p.length; i += 3) c.push(c[c.length - 1] + Math.hypot(p[i] - p[i - 3], p[i + 2] - p[i - 1]));
  return c;
}

/** horizontal quad wound to face up whatever order the corners come in (double-sided material: a back face lights black) */
function flatUp(g: GB, q: number[][], c: THREE.Color) {
  const cr = (q[1][2] - q[0][2]) * (q[2][0] - q[0][0]) - (q[1][0] - q[0][0]) * (q[2][2] - q[0][2]);
  g.quad(cr >= 0 ? q : [q[0], q[3], q[2], q[1]], [0, 1, 0], c);
}

export class RailLayer {
  group = new THREE.Group();
  edges = new Map<number, RailEdgeView>();
  stations = new Map<number, RailStationView>();
  crossings: CrossingView[] = [];
  private mesh: THREE.Mesh | null = null;
  private sleepers: THREE.InstancedMesh;
  private gates: THREE.InstancedMesh;
  private dirty = false;
  private last = 0;
  private mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: THREE.DoubleSide });
  private catenary: THREE.InstancedMesh;
  /** terrain height sampler (set by the app) so decks, walls and embankments follow the real clearance */
  ground: (x: number, z: number) => number = () => -1e9;
  /** crossing signal posts (static) and their two alternating red lamps */
  private posts: THREE.InstancedMesh;
  private lamps: THREE.InstancedMesh;
  private postMats: { m: THREE.Matrix4; c: number }[] = [];
  private gatePiv: { x: number; y: number; z: number; h: number; len: number; c: number }[] = [];

  constructor() {
    this.sleepers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 0.14, 2.6), new THREE.MeshStandardMaterial({ color: 0x6a5642 }), 40000);
    this.sleepers.count = 0;
    this.sleepers.receiveShadow = true;
    this.gates = new THREE.InstancedMesh(new THREE.BoxGeometry(7, 0.18, 0.18).translate(3.5, 0, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x220000 }), 400);
    this.gates.count = 0;
    this.catenary = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 6.5, 0.2).translate(0, 3.25, 0), new THREE.MeshStandardMaterial({ color: 0x777777 }), 3000);
    this.catenary.count = 0;
    const pg = new GB();
    const dark = new THREE.Color(0x2b2f31), white = new THREE.Color(0xf2f2ee), red = new THREE.Color(0xc23a32);
    pg.box(0, 0, 0, 0.18, 3.6, 0.18, dark);
    pg.box(0.12, 2.3, 0, 0.12, 0.55, 1.25, dark); // lamp bar
    for (const z of [-0.36, 0.36]) pg.box(0.2, 2.35, z, 0.1, 0.42, 0.42, dark); // hoods
    // St Andrew's cross
    pg.setTransform(0.1, 3.15, 0, 0);
    for (const k of [-1, 1]) for (let i = -3; i <= 3; i++) pg.box(0, i * 0.11 * k + 0.0, i * 0.11, 0.05, 0.14, 0.16, i % 2 ? red : white);
    pg.setTransform(0, 0, 0, 0);
    this.posts = new THREE.InstancedMesh(pg.toGeometry(false), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }), 800);
    this.posts.count = 0; this.posts.castShadow = true;
    this.lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.17, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.1, 0.06), toneMapped: false }), 1600);
    this.lamps.count = 0; this.lamps.frustumCulled = false;
    this.group.add(this.sleepers, this.gates, this.catenary, this.posts, this.lamps);
  }

  upsert(e: RailEdgeView) { this.edges.set(e.id, e); this.dirty = true; }
  setCrossings(c: CrossingView[]) { this.crossings = c; this.dirty = true; }
  upsertStation(s: RailStationView) { this.stations.set(s.id, s); }

  update(now: number, crossingState: Uint8Array) {
    if (this.dirty && now - this.last > 800) { this.rebuild(); this.dirty = false; this.last = now; }
    // crossing gates: barrier arms pivot up when open, drop across the approach lane when closed
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qr = new THREE.Quaternion();
    const Z = new THREE.Vector3(0, 0, 1), Y = new THREE.Vector3(0, 1, 0), pv = new THREE.Vector3(), sc = new THREE.Vector3();
    let n = 0;
    for (const gp of this.gatePiv) {
      const closed = crossingState[gp.c] === 1;
      q.setFromAxisAngle(Y, -gp.h);
      qr.setFromAxisAngle(Z, closed ? 0.02 : 1.35);
      q.multiply(qr);
      m.compose(pv.set(gp.x, gp.y, gp.z), q, sc.set(gp.len / 7, 1, 1));
      if (n < 400) this.gates.setMatrixAt(n++, m);
    }
    this.gates.count = n;
    this.gates.instanceMatrix.needsUpdate = true;
    // alternating red lamps while a train is near (the classic "wig-wag")
    const phase = Math.floor(now / 480) % 2;
    const lv = new THREE.Vector3();
    let k = 0;
    for (const { m: pm, c } of this.postMats) {
      if (crossingState[c] !== 1) continue;
      const z = phase ? 0.36 : -0.36;
      lv.set(0.27, 2.56, z).applyMatrix4(pm);
      m.makeTranslation(lv.x, lv.y, lv.z);
      if (k < 1600) this.lamps.setMatrixAt(k++, m);
    }
    this.lamps.count = k;
    this.lamps.instanceMatrix.needsUpdate = true;
  }

  private rebuild() {
    const g = new GB();
    const sl: THREE.Matrix4[] = [];
    const cat: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const bank = new THREE.Color(0x6a6650), ballast = new THREE.Color(0x5f584f), steel = new THREE.Color(0x9aa0a6), conc = new THREE.Color(0xb8b3aa);
    for (const e of this.edges.values()) {
      const p = e.pts;
      const cum = cumLen(p);
      const len = cum[cum.length - 1] * Math.min(1, e.progress);
      const tracks = e.tracks;
      const spread = 4.2;
      for (let s = 0; s < len; s += 6) {
        const a = polyAt(p, s, cum), b = polyAt(p, Math.min(len, s + 6), cum);
        const hw = tracks * spread / 2 + 1.4;
        const lift = e.elevated ? 0 : 0.06;
        const P = (q0: [number, number, number, number, number], o: number, dy: number) => [q0[0] - q0[4] * o, q0[1] + dy, q0[2] + q0[3] * o];
        const clr = Math.min(a[1] - Math.max(0, this.ground(a[0], a[2])), b[1] - Math.max(0, this.ground(b[0], b[2])));
        const deck = e.elevated || (e.bridge && clr > 2.2);
        g.quad([P(a, hw, lift), P(b, hw, lift), P(b, -hw, lift), P(a, -hw, lift)], [0, 1, 0], deck ? conc : ballast);
        if (!deck && clr > 0.45) {
          // embankment: ballast shoulders sloping down to the ground
          const ga = Math.max(0, this.ground(a[0], a[2])), gb = Math.max(0, this.ground(b[0], b[2]));
          for (const sd of [-1, 1]) {
            const wa = hw + (a[1] - ga) * 1.6, wb = hw + (b[1] - gb) * 1.6;
            const A0 = P(a, sd * hw, lift), B0 = P(b, sd * hw, lift), A1 = P(a, sd * wa, 0), B1 = P(b, sd * wb, 0);
            A1[1] = ga - 0.1; B1[1] = gb - 0.1;
            if (sd > 0) g.quad([A0, A1, B1, B0], [0, 1, 0], bank); else g.quad([B0, B1, A1, A0], [0, 1, 0], bank);
          }
        }
        for (let t = 0; t < tracks; t++) {
          const off = (t - (tracks - 1) / 2) * spread;
          for (const r of [-0.75, 0.75]) {
            const o = off + r;
            g.quad([P(a, o + 0.07, 0.3), P(b, o + 0.07, 0.3), P(b, o - 0.07, 0.3), P(a, o - 0.07, 0.3)], [0, 1, 0], steel);
          }
        }
        if (deck) {
          for (const sd of [-1, 1]) g.quad([P(a, sd * hw, lift), P(b, sd * hw, lift), P(b, sd * hw, lift + 1.1), P(a, sd * hw, lift + 1.1)], [-a[4] * sd, 0, a[3] * sd], conc);
        }
      }
      for (let s = 0; s < len; s += 1.0) {
        const a = polyAt(p, s, cum);
        for (let t = 0; t < tracks; t++) {
          const off = (t - (tracks - 1) / 2) * spread;
          q.setFromAxisAngle(up, -Math.atan2(a[4], a[3]));
          m.compose(new THREE.Vector3(a[0] - a[4] * off, a[1] + 0.15, a[2] + a[3] * off), q, new THREE.Vector3(1, 1, 1));
          if (sl.length < 40000) sl.push(m.clone());
        }
      }
      if (e.metro || e.elevated) {
        for (let s = 10; s < len; s += 30) {
          const a = polyAt(p, s, cum);
          const base = a[1] - 8;
          q.setFromAxisAngle(up, -Math.atan2(a[4], a[3]));
          if (e.elevated) { m.compose(new THREE.Vector3(a[0], base, a[2]), q, new THREE.Vector3(8, 1.25, 7)); cat.push(m.clone()); }
        }
      } else if (!e.spur) {
        for (let s = 15; s < len; s += 45) {
          const a = polyAt(p, s, cum);
          m.makeTranslation(a[0] - a[4] * (tracks * 2.1 + 2), a[1], a[2] + a[3] * (tracks * 2.1 + 2));
          cat.push(m.clone());
        }
      }
    }
    // crossings: rubber panel + signal posts for level crossings, a dug cut with parapets for underpasses
    this.postMats = [];
    this.gatePiv = [];
    const rubber = new THREE.Color(0x4b4d4e), cut = [new THREE.Color(0x4a4d50), new THREE.Color(0x34373a), new THREE.Color(0x222426)], wall = new THREE.Color(0xa9a59b), stripe = new THREE.Color(0xeeeeea);
    this.crossings.forEach((c, ci) => {
      if (c.separated && !c.under) return;
      const hw = c.hw ?? 4, ra = c.angle, ta = c.rail ?? ra + Math.PI / 2;
      const rx = Math.cos(ra), rz = Math.sin(ra), tx = Math.cos(ta), tz = Math.sin(ta);
      const sin = Math.max(0.5, Math.abs(rx * tz - rz * tx));
      const y = c.y + 0.1;
      if (c.under) {
        // road ramps down under the track: darker bands toward the centre, retaining walls, track parapets
        g.setTransform(c.x, y, c.z, ra);
        for (let b = 0; b < 3; b++) { const L = 16 - b * 5; g.quad([[-L, 0.01 * b, -hw], [L, 0.01 * b, -hw], [L, 0.01 * b, hw], [-L, 0.01 * b, hw]], [0, 1, 0], cut[b]); }
        for (const sd of [-1, 1]) g.box(0, -0.1, sd * (hw + 0.35), 34, 0.9, 0.5, wall);
        g.setTransform(c.x, y, c.z, ta);
        const span = hw / sin + 1.5;
        for (const sd of [-1, 1]) { g.box(0, 0.25, sd * 3.1, span * 2, 1.1, 0.45, wall); g.box(0, 1.35, sd * 3.1, span * 2, 0.08, 0.5, stripe); }
        g.setTransform(0, 0, 0, 0);
        return;
      }
      const a = hw / sin + 0.6, b = 3.4 / sin; // parallelogram along rail (a) and road (b)
      const py = Math.max(y + 0.02, (c.ry ?? y) + 0.24); // over the ballast, just under the rail heads
      const P = (u: number, v: number) => [c.x + tx * u + rx * v, py, c.z + tz * u + rz * v];
      flatUp(g, [P(-a, -b), P(-a, b), P(a, b), P(a, -b)], rubber);
      for (const sd of [-1, 1]) {
        // stop line across the approaching lane
        const d = sd * (b + 6);
        g.setTransform(c.x + rx * d, y + 0.03, c.z + rz * d, ra);
        flatUp(g, [[-0.25, 0, 0], [0.25, 0, 0], [0.25, 0, -sd * hw], [-0.25, 0, -sd * hw]], stripe);
        g.setTransform(0, 0, 0, 0);
        // post on the kerb of the approaching lane, facing the drivers
        const px = c.x + rx * sd * (b + 3) - rz * sd * (hw + 1.1), pz = c.z + rz * sd * (b + 3) + rx * sd * (hw + 1.1);
        q.setFromAxisAngle(up, -(ra + (sd > 0 ? 0 : Math.PI)));
        const pm = new THREE.Matrix4().compose(new THREE.Vector3(px, c.y, pz), q, new THREE.Vector3(1, 1, 1));
        this.postMats.push({ m: pm, c: ci });
        // barrier arm pivots beside the post and spans the approaching lane
        const gx = c.x + rx * sd * (b + 1.6) - rz * sd * (hw + 0.9), gz = c.z + rz * sd * (b + 1.6) + rx * sd * (hw + 0.9);
        this.gatePiv.push({ x: gx, y: c.y + 1.05, z: gz, h: Math.atan2(-rx * sd, rz * sd), len: hw + 0.6, c: ci });
      }
    });
    this.postMats.forEach((p, i) => this.posts.setMatrixAt(i, p.m));
    this.posts.count = Math.min(800, this.postMats.length);
    this.posts.instanceMatrix.needsUpdate = true;
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.mesh = new THREE.Mesh(g.toGeometry(false), this.mat);
    this.mesh.receiveShadow = true;
    this.group.add(this.mesh);
    for (let i = 0; i < sl.length; i++) this.sleepers.setMatrixAt(i, sl[i]);
    this.sleepers.count = sl.length;
    this.sleepers.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < cat.length && i < 3000; i++) this.catenary.setMatrixAt(i, cat[i]);
    this.catenary.count = Math.min(3000, cat.length);
    this.catenary.instanceMatrix.needsUpdate = true;
  }
}
