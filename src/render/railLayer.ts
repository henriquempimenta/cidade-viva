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

  constructor() {
    this.sleepers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 0.14, 2.6), new THREE.MeshStandardMaterial({ color: 0x6a5642 }), 40000);
    this.sleepers.count = 0;
    this.sleepers.receiveShadow = true;
    this.gates = new THREE.InstancedMesh(new THREE.BoxGeometry(7, 0.18, 0.18).translate(3.5, 0, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x220000 }), 400);
    this.gates.count = 0;
    this.catenary = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 6.5, 0.2).translate(0, 3.25, 0), new THREE.MeshStandardMaterial({ color: 0x777777 }), 3000);
    this.catenary.count = 0;
    this.group.add(this.sleepers, this.gates, this.catenary);
  }

  upsert(e: RailEdgeView) { this.edges.set(e.id, e); this.dirty = true; }
  setCrossings(c: CrossingView[]) { this.crossings = c; this.dirty = true; }
  upsertStation(s: RailStationView) { this.stations.set(s.id, s); }

  update(now: number, crossingState: Uint8Array) {
    if (this.dirty && now - this.last > 800) { this.rebuild(); this.dirty = false; this.last = now; }
    // crossing gates: rotate down when closed
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    let n = 0;
    this.crossings.forEach((c, i) => {
      if (c.separated) return;
      const closed = crossingState[i] === 1;
      for (const side of [-1, 1]) {
        const a = c.angle + (side > 0 ? 0 : Math.PI);
        const px = c.x + Math.cos(a + Math.PI / 2) * 6 * side, pz = c.z + Math.sin(a + Math.PI / 2) * 6 * side;
        e.set(0, -a, closed ? 0 : Math.PI / 2.4);
        q.setFromEuler(e);
        m.compose(new THREE.Vector3(px, c.y + 1, pz), q, new THREE.Vector3(1, 1, 1));
        if (n < 400) this.gates.setMatrixAt(n++, m);
      }
    });
    this.gates.count = n;
    this.gates.instanceMatrix.needsUpdate = true;
  }

  private rebuild() {
    const g = new GB();
    const sl: THREE.Matrix4[] = [];
    const cat: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const ballast = new THREE.Color(0x8c8273), steel = new THREE.Color(0x9aa0a6), conc = new THREE.Color(0xb8b3aa);
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
        g.quad([P(a, hw, lift), P(b, hw, lift), P(b, -hw, lift), P(a, -hw, lift)], [0, 1, 0], e.elevated || e.bridge ? conc : ballast);
        for (let t = 0; t < tracks; t++) {
          const off = (t - (tracks - 1) / 2) * spread;
          for (const r of [-0.75, 0.75]) {
            const o = off + r;
            g.quad([P(a, o + 0.07, 0.3), P(b, o + 0.07, 0.3), P(b, o - 0.07, 0.3), P(a, o - 0.07, 0.3)], [0, 1, 0], steel);
          }
        }
        if (e.elevated || e.bridge) {
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
