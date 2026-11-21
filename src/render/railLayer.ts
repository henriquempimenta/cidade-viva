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

/** Build a red-and-white striped level-crossing barrier arm with counterweight stub (length 7 m along +X). */
function buildGateGeometry(): THREE.BufferGeometry {
  const g = new GB();
  const red = new THREE.Color(0xd62828);
  const white = new THREE.Color(0xf5f5f2);
  const dark = new THREE.Color(0x3a3e42);
  // Counterweight behind pivot
  g.box(-0.55, -0.05, 0, 1.1, 0.24, 0.22, dark);
  // Alternating red/white reflective barrier stripes along [0, 7]
  const segs = 10;
  const segLen = 7 / segs;
  for (let i = 0; i < segs; i++) {
    g.box((i + 0.5) * segLen, -0.02, 0, segLen + 0.005, 0.16, 0.11, i % 2 === 0 ? red : white);
  }
  return g.toGeometry(false);
}

/** Build a slim overhead catenary mast + cantilever arm (outside the train clearance envelope). */
function buildCatenaryGeometry(): THREE.BufferGeometry {
  const g = new GB();
  const steel = new THREE.Color(0x6e7378);
  const dark = new THREE.Color(0x4a4e52);
  g.box(0, 0, 0, 0.22, 6.4, 0.22, steel);
  g.box(0, 0, 0, 0.45, 0.45, 0.45, dark); // concrete mast footing
  g.box(0, 5.7, -1.65, 0.12, 0.14, 3.3, steel); // cantilever arm reaching over track
  g.box(0, 6.05, -0.95, 0.08, 0.08, 1.9, steel); // upper stay rod
  return g.toGeometry(false);
}

/** Build a dedicated concrete railway bridge/viaduct pier (unit height [0..1] in Y, scaled in X/Y/Z). */
function buildPierGeometry(): THREE.BufferGeometry {
  const g = new GB();
  const conc = new THREE.Color(0xa9a49b);
  const cap = new THREE.Color(0xbab5ac);
  g.box(0, 0, 0, 1.6, 0.92, 0.82, conc);
  g.box(0, 0.92, 0, 2.0, 0.08, 1.0, cap);
  return g.toGeometry(false);
}

export class RailLayer {
  group = new THREE.Group();
  edges = new Map<number, RailEdgeView>();
  stations = new Map<number, RailStationView>();
  crossings: CrossingView[] = [];
  private mesh: THREE.Mesh | null = null;
  private sleepers: THREE.InstancedMesh;
  private gates: THREE.InstancedMesh;
  private gateBases: THREE.InstancedMesh;
  private piers: THREE.InstancedMesh;
  private dirty = false;
  private last = 0;
  private mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: THREE.DoubleSide });
  private catenary: THREE.InstancedMesh;
  /** terrain height sampler (set by the app to TerrainView.meshY) */
  ground: (x: number, z: number) => number = () => -1e9;
  /** crossing signal posts (static) and their two alternating red lamps */
  private posts: THREE.InstancedMesh;
  private lamps: THREE.InstancedMesh;
  private postMats: { m: THREE.Matrix4; c: number }[] = [];
  private gatePiv: { x: number; y: number; z: number; h: number; len: number; c: number }[] = [];

  constructor() {
    this.sleepers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 0.14, 2.6), new THREE.MeshStandardMaterial({ color: 0x6a5642, roughness: 0.92 }), 40000);
    this.sleepers.count = 0;
    this.sleepers.receiveShadow = true;
    this.sleepers.frustumCulled = false;

    this.gates = new THREE.InstancedMesh(buildGateGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45 }), 400);
    this.gates.count = 0;
    this.gates.castShadow = true;
    this.gates.frustumCulled = false;

    const baseGeo = new THREE.BoxGeometry(0.45, 1.15, 0.45).translate(0, 0.575, 0);
    this.gateBases = new THREE.InstancedMesh(baseGeo, new THREE.MeshStandardMaterial({ color: 0x52575c, roughness: 0.65 }), 400);
    this.gateBases.count = 0;
    this.gateBases.castShadow = true;
    this.gateBases.frustumCulled = false;

    this.piers = new THREE.InstancedMesh(buildPierGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), 3000);
    this.piers.count = 0;
    this.piers.castShadow = true;
    this.piers.receiveShadow = true;
    this.piers.frustumCulled = false;

    this.catenary = new THREE.InstancedMesh(buildCatenaryGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65 }), 3000);
    this.catenary.count = 0;
    this.catenary.castShadow = true;
    this.catenary.frustumCulled = false;

    const pg = new GB();
    const dark = new THREE.Color(0x2b2f31), white = new THREE.Color(0xf2f2ee), red = new THREE.Color(0xc23a32);
    pg.box(0, 0, 0, 0.18, 3.6, 0.18, dark);
    pg.box(0.12, 2.3, 0, 0.12, 0.55, 1.25, dark);
    for (const z of [-0.36, 0.36]) pg.box(0.2, 2.35, z, 0.1, 0.42, 0.42, dark);
    // St Andrew's cross
    pg.setTransform(0.1, 3.15, 0, 0);
    for (const k of [-1, 1]) for (let i = -3; i <= 3; i++) pg.box(0, i * 0.11 * k, i * 0.11, 0.05, 0.14, 0.16, i % 2 ? red : white);
    pg.setTransform(0, 0, 0, 0);
    this.posts = new THREE.InstancedMesh(pg.toGeometry(false), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }), 800);
    this.posts.count = 0; this.posts.castShadow = true; this.posts.frustumCulled = false;
    this.lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.17, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.1, 0.06), toneMapped: false }), 1600);
    this.lamps.count = 0; this.lamps.frustumCulled = false;
    this.group.add(this.sleepers, this.gates, this.gateBases, this.piers, this.catenary, this.posts, this.lamps);
  }

  /** Force an immediate rebuild on next update (e.g. after terrain heights update). */
  markDirty() { this.dirty = true; this.last = 0; }

  upsert(e: RailEdgeView) { this.edges.set(e.id, e); this.dirty = true; }
  setCrossings(c: CrossingView[]) { this.crossings = c; this.dirty = true; }
  upsertStation(s: RailStationView) { this.stations.set(s.id, s); }

  update(now: number, crossingState: Uint8Array) {
    if (this.dirty && now - this.last > 800) { this.rebuild(); this.dirty = false; this.last = now; }
    // crossing gates: striped barrier arms pivot up when open, drop across the approach lane when closed
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qr = new THREE.Quaternion();
    const Z = new THREE.Vector3(0, 0, 1), Y = new THREE.Vector3(0, 1, 0), pv = new THREE.Vector3(), sc = new THREE.Vector3();
    let n = 0;
    for (const gp of this.gatePiv) {
      const closed = crossingState[gp.c] === 1;
      q.setFromAxisAngle(Y, -gp.h);
      qr.setFromAxisAngle(Z, closed ? 0.02 : 1.38);
      q.multiply(qr);
      m.compose(pv.set(gp.x, gp.y, gp.z), q, sc.set(gp.len / 7, 1, 1));
      if (n < 400) this.gates.setMatrixAt(n++, m);
    }
    this.gates.count = n;
    this.gates.instanceMatrix.needsUpdate = true;
    // alternating red lamps while a train is near
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
    const pierMats: THREE.Matrix4[] = [];
    const baseMats: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qPitch = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0), axisZ = new THREE.Vector3(0, 0, 1);
    const bank = new THREE.Color(0x6e6958), ballast = new THREE.Color(0x5f584f);
    const steelTop = new THREE.Color(0xb0b7bf), steelSide = new THREE.Color(0x64696f);
    const conc = new THREE.Color(0xb8b3aa), concDark = new THREE.Color(0x98938a);

    for (const e of this.edges.values()) {
      const p = e.pts;
      const cum = cumLen(p);
      const len = cum[cum.length - 1] * Math.min(1, e.progress);
      if (len < 0.5) continue;
      const tracks = e.tracks;
      const spread = 4.2;
      const hw = tracks * spread / 2 + 1.4;

      /** Effective top elevation of ballast/deck at arc length `s`, smoothly clearing shoulders without V-notches at bridge transitions. */
      const liftedAt = (s: number): [number, number, number, number, number, boolean] => {
        const pt = polyAt(p, s, cum);
        const gC = this.ground(pt[0], pt[2]);
        const gL = this.ground(pt[0] + pt[4] * hw, pt[2] - pt[3] * hw);
        const gR = this.ground(pt[0] - pt[4] * hw, pt[2] + pt[3] * hw);
        const clr = pt[1] - Math.max(0, gC);
        const isDeck = e.elevated || (e.bridge && (gC < 0.35 || clr > 2.2));
        const liftW = isDeck ? 0 : Math.min(1, Math.max(0, (2.2 - clr) / 1.2));
        const shoulderLift = Math.min(0.65, Math.max(0, Math.max(gL, gR) - gC));
        const groundTop = gC + 0.18 + shoulderLift * liftW;
        const yTop = isDeck ? pt[1] : Math.max(pt[1], groundTop);
        return [pt[0], yTop, pt[2], pt[3], pt[4], isDeck];
      };

      const step = 4;
      let prevDeck = false;
      let lastPierS = -100;
      for (let s = 0; s < len; s += step) {
        const sNext = Math.min(len, s + step);
        const a = liftedAt(s), b = liftedAt(sNext);
        const deck = a[5] || b[5];
        const P = (q0: [number, number, number, number, number, boolean], o: number, dy: number) => [q0[0] - q0[4] * o, q0[1] + dy, q0[2] + q0[3] * o];

        // Transition abutment block where embankment meets bridge/viaduct deck
        if (s > 0 && deck !== prevDeck && !e.elevated) {
          const ap = a;
          const ang = Math.atan2(ap[4], ap[3]);
          const gy = this.ground(ap[0], ap[2]);
          const bot = Math.min(gy - 1.8, ap[1] - 4.0);
          const hAbut = Math.max(1.4, ap[1] - 0.04 - bot);
          g.setTransform(ap[0], bot, ap[2], ang);
          g.box(0, 0, 0, 3.6, hAbut, (hw + 0.9) * 2, concDark);
          g.setTransform(0, 0, 0, 0);
        }
        prevDeck = deck;

        // Ballast bed or concrete bridge/viaduct deck top
        const deckW = deck ? hw + 0.45 : hw;
        g.quad([P(a, deckW, 0), P(b, deckW, 0), P(b, -deckW, 0), P(a, -deckW, 0)], [0, 1, 0], deck ? conc : ballast);

        if (deck) {
          // Closed box-girder underside + side fascia + twin parapets with top coping
          g.quad([P(a, -deckW, -0.95), P(b, -deckW, -0.95), P(b, deckW, -0.95), P(a, deckW, -0.95)], [0, -1, 0], concDark);
          for (const sd of [-1, 1]) {
            const oOut = sd * deckW;
            const oIn = sd * (deckW - 0.28);
            const nx = -a[4] * sd, nz = a[3] * sd;
            // Outer fascia + parapet wall
            g.quad([P(a, oOut, -0.95), P(b, oOut, -0.95), P(b, oOut, 1.05), P(a, oOut, 1.05)], [nx, 0, nz], conc);
            // Inner parapet wall
            g.quad([P(a, oIn, 0), P(b, oIn, 0), P(b, oIn, 1.05), P(a, oIn, 1.05)], [-nx, 0, -nz], conc);
            // Parapet top coping
            g.quad(
              sd > 0
                ? [P(a, oOut, 1.05), P(b, oOut, 1.05), P(b, oIn, 1.05), P(a, oIn, 1.05)]
                : [P(a, oIn, 1.05), P(b, oIn, 1.05), P(b, oOut, 1.05), P(a, oOut, 1.05)],
              [0, 1, 0], conc,
            );
          }
          // Real structural concrete piers spaced ~26 m down to riverbed / terrain meshY
          if (s - lastPierS >= 26 && s > 6 && s < len - 6) {
            const gy = this.ground(a[0], a[2]);
            const base = gy < 0.2 ? Math.min(gy - 1.5, -4.5) : gy - 1.2;
            const hPier = (a[1] - 0.95) - base;
            if (hPier > 1.2) {
              q.setFromAxisAngle(up, -Math.atan2(a[4], a[3]));
              m.compose(new THREE.Vector3(a[0], base, a[2]), q, new THREE.Vector3(1.15, hPier, (hw + 0.3) * 1.65));
              pierMats.push(m.clone());
              lastPierS = s;
            }
          }
        } else {
          // Continuous sloped embankment shoulders on BOTH sides down to real ground whenever above terrain
          for (const sd of [-1, 1]) {
            const saX = a[0] - a[4] * sd * hw, saZ = a[2] + a[3] * sd * hw;
            const sbX = b[0] - b[4] * sd * hw, sbZ = b[2] + b[3] * sd * hw;
            const gaS = this.ground(saX, saZ), gbS = this.ground(sbX, sbZ);
            const dropA = a[1] - gaS, dropB = b[1] - gbS;
            if (Math.max(dropA, dropB) > 0.08) {
              const wa = hw + Math.max(1.3, Math.max(0, dropA) * 1.5);
              const wb = hw + Math.max(1.3, Math.max(0, dropB) * 1.5);
              const oaX = a[0] - a[4] * sd * wa, oaZ = a[2] + a[3] * sd * wa;
              const obX = b[0] - b[4] * sd * wb, obZ = b[2] + b[3] * sd * wb;
              const gaO = this.ground(oaX, oaZ), gbO = this.ground(obX, obZ);
              const A0 = P(a, sd * hw, 0), B0 = P(b, sd * hw, 0);
              const A1 = [oaX, gaO - 0.35, oaZ], B1 = [obX, gbO - 0.35, obZ];
              // Outward-tilted embankment normal for realistic slope shading
              const nx = -a[4] * sd * 0.55, ny = 0.83, nz = a[3] * sd * 0.55;
              if (sd > 0) g.quad([A0, A1, B1, B0], [nx, ny, nz], bank);
              else g.quad([B0, B1, A1, A0], [nx, ny, nz], bank);
            }
          }
        }

        // True 3D extruded steel rails seated directly on sleeper tops ([+0.13, +0.29], zero floating gap)
        const rBot = 0.13, rTop = 0.29, rHW = 0.065;
        for (let t = 0; t < tracks; t++) {
          const off = (t - (tracks - 1) / 2) * spread;
          for (const r of [-0.75, 0.75]) {
            const o = off + r;
            // Railhead top
            g.quad([P(a, o + rHW, rTop), P(b, o + rHW, rTop), P(b, o - rHW, rTop), P(a, o - rHW, rTop)], [0, 1, 0], steelTop);
            // Left and right rail webs down to sleeper top
            g.quad([P(a, o + rHW, rBot), P(b, o + rHW, rBot), P(b, o + rHW, rTop), P(a, o + rHW, rTop)], [-a[4], 0, a[3]], steelSide);
            g.quad([P(b, o - rHW, rBot), P(a, o - rHW, rBot), P(a, o - rHW, rTop), P(b, o - rHW, rTop)], [a[4], 0, -a[3]], steelSide);
          }
        }
      }

      // Sleepers with full yaw + pitch following the 3D lifted track grade (never half-buried on ramps)
      for (let s = 0; s < len; s += 1.0) {
        const a = liftedAt(s);
        const aPrev = liftedAt(Math.max(0, s - 0.5));
        const aNext = liftedAt(Math.min(len, s + 0.5));
        const dx = aNext[0] - aPrev[0], dy = aNext[1] - aPrev[1], dz = aNext[2] - aPrev[2];
        const horiz = Math.hypot(dx, dz) || 1;
        const yaw = -Math.atan2(dz, dx);
        const pitch = Math.atan2(dy, horiz);
        q.setFromAxisAngle(up, yaw);
        qPitch.setFromAxisAngle(axisZ, pitch);
        q.multiply(qPitch);
        for (let t = 0; t < tracks; t++) {
          const off = (t - (tracks - 1) / 2) * spread;
          m.compose(new THREE.Vector3(a[0] - a[4] * off, a[1] + 0.07, a[2] + a[3] * off), q, new THREE.Vector3(1, 1, 1));
          if (sl.length < 40000) sl.push(m.clone());
        }
      }

      // Clean catenary masts positioned outside the track envelope on ground or deck parapet
      if (!e.spur) {
        const spacing = e.metro ? 36 : 45;
        for (let s = 15; s < len; s += spacing) {
          const a = liftedAt(s);
          const off = hw + 0.55;
          const mx = a[0] - a[4] * off, mz = a[2] + a[3] * off;
          const my = a[5] ? a[1] : Math.max(a[1] - 0.1, this.ground(mx, mz));
          q.setFromAxisAngle(up, -Math.atan2(a[4], a[3]));
          m.compose(new THREE.Vector3(mx, my, mz), q, new THREE.Vector3(1, 1, 1));
          cat.push(m.clone());
        }
      }
    }

    // Level crossings & rail underpasses
    this.postMats = [];
    this.gatePiv = [];
    const rubber = new THREE.Color(0x4b4d4e), cut = [new THREE.Color(0x4a4d50), new THREE.Color(0x34373a), new THREE.Color(0x222426)], wall = new THREE.Color(0xa9a59b), stripe = new THREE.Color(0xeeeeea);
    this.crossings.forEach((c, ci) => {
      if (c.separated && !c.under) return;
      const hw = c.hw ?? 4, ra = c.angle, ta = c.rail ?? ra + Math.PI / 2;
      const rx = Math.cos(ra), rz = Math.sin(ra), tx = Math.cos(ta), tz = Math.sin(ta);
      const sin = Math.max(0.5, Math.abs(rx * tz - rz * tx));
      const gCenter = this.ground(c.x, c.z);
      const y = Math.max(c.y, gCenter + 0.14);
      if (c.under) {
        // Underpass trench: depressed road bands + continuous concrete retaining walls + solid rail overpass parapets
        g.setTransform(c.x, y, c.z, ra);
        for (let b = 0; b < 3; b++) { const L = 18 - b * 5; g.quad([[-L, 0.015 * b, -hw], [L, 0.015 * b, -hw], [L, 0.015 * b, hw], [-L, 0.015 * b, hw]], [0, 1, 0], cut[b]); }
        for (const sd of [-1, 1]) {
          g.box(0, -0.3, sd * (hw + 0.4), 38, 1.25, 0.6, wall);
          g.box(0, 0.95, sd * (hw + 0.4), 38, 0.1, 0.72, conc);
        }
        g.setTransform(c.x, y, c.z, ta);
        const span = hw / sin + 2.2;
        for (const sd of [-1, 1]) {
          g.box(0, 0.1, sd * 3.15, span * 2, 1.25, 0.5, wall);
          g.box(0, 1.35, sd * 3.15, span * 2, 0.1, 0.58, stripe);
        }
        g.setTransform(0, 0, 0, 0);
        return;
      }
      // Level crossing deck flush with road and just beneath railheads
      const a = hw / sin + 0.7, b = 3.2 / sin;
      const ry = Math.max(c.ry ?? y, gCenter + 0.18);
      const py = Math.max(y + 0.04, ry + 0.25);
      const P = (u: number, v: number) => [c.x + tx * u + rx * v, py, c.z + tz * u + rz * v];
      flatUp(g, [P(-a, -b), P(-a, b), P(a, b), P(a, -b)], rubber);
      // Approach ramps connecting crossing deck smoothly down to road surface
      for (const sd of [-1, 1]) {
        const bOuter = b + 2.2;
        const rY = Math.max(y + 0.02, this.ground(c.x + rx * sd * bOuter, c.z + rz * sd * bOuter) + 0.16);
        const Q0 = (u: number) => [c.x + tx * u + rx * sd * b, py, c.z + tz * u + rz * sd * b];
        const Q1 = (u: number) => [c.x + tx * u + rx * sd * bOuter, rY, c.z + tz * u + rz * sd * bOuter];
        flatUp(g, [Q0(-a), Q1(-a), Q1(a), Q0(a)], rubber);

        // Stop line across approaching lane
        const d = sd * (b + 6.2);
        const sx = c.x + rx * d, sz = c.z + rz * d;
        const sy = Math.max(y + 0.04, this.ground(sx, sz) + 0.17);
        g.setTransform(sx, sy, sz, ra);
        flatUp(g, [[-0.25, 0, 0], [0.25, 0, 0], [0.25, 0, -sd * hw], [-0.25, 0, -sd * hw]], stripe);
        g.setTransform(0, 0, 0, 0);

        // Signal post seated on real ground on the kerb of the approaching lane
        const px = c.x + rx * sd * (b + 3.4) - rz * sd * (hw + 1.25);
        const pz = c.z + rz * sd * (b + 3.4) + rx * sd * (hw + 1.25);
        const pGround = Math.max(c.y, this.ground(px, pz) + 0.12);
        q.setFromAxisAngle(up, -(ra + (sd > 0 ? 0 : Math.PI)));
        const pm = new THREE.Matrix4().compose(new THREE.Vector3(px, pGround, pz), q, new THREE.Vector3(1, 1, 1));
        this.postMats.push({ m: pm, c: ci });

        // Striped barrier arm + mechanism pedestal clearly outside both rails and carriageway
        const gx = c.x + rx * sd * (b + 2.1) - rz * sd * (hw + 1.15);
        const gz = c.z + rz * sd * (b + 2.1) + rx * sd * (hw + 1.15);
        const gGround = Math.max(c.y, this.ground(gx, gz) + 0.12);
        const gateH = Math.atan2(-rx * sd, rz * sd);
        q.setFromAxisAngle(up, -gateH);
        baseMats.push(new THREE.Matrix4().compose(new THREE.Vector3(gx, gGround, gz), q, new THREE.Vector3(1, 1, 1)));
        this.gatePiv.push({ x: gx, y: gGround + 1.05, z: gz, h: gateH, len: hw + 0.75, c: ci });
      }
    });

    this.postMats.forEach((p, i) => this.posts.setMatrixAt(i, p.m));
    this.posts.count = Math.min(800, this.postMats.length);
    this.posts.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < baseMats.length && i < 400; i++) this.gateBases.setMatrixAt(i, baseMats[i]);
    this.gateBases.count = Math.min(400, baseMats.length);
    this.gateBases.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < pierMats.length && i < 3000; i++) this.piers.setMatrixAt(i, pierMats[i]);
    this.piers.count = Math.min(3000, pierMats.length);
    this.piers.instanceMatrix.needsUpdate = true;

    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.mesh = new THREE.Mesh(g.toGeometry(false), this.mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.group.add(this.mesh);

    for (let i = 0; i < sl.length; i++) this.sleepers.setMatrixAt(i, sl[i]);
    this.sleepers.count = sl.length;
    this.sleepers.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < cat.length && i < 3000; i++) this.catenary.setMatrixAt(i, cat[i]);
    this.catenary.count = Math.min(3000, cat.length);
    this.catenary.instanceMatrix.needsUpdate = true;
  }
}
