import * as THREE from 'three';
import type { CrossingView, RailEdgeView, RailStationView } from '../shared/protocol';
import {
  resolveViaductPierPlacement, sampleCutsMinY, sampleRoadSurfaceY, sampleUnderpassWalkY, sampleUnderpassY, underpassBlend,
  SIDEWALK_WIDTH, UNDERPASS_DEPTH, UNDERPASS_FLAT_HALF, UNDERPASS_HALF_LEN,
  type RoadClearanceFn, type TerrainCut,
} from '../shared/roadGeom';
import { GB } from './geomBuilder';

export interface RailUnderpassCut extends TerrainCut {
  halfLenNeg: number;
  halfLenPos: number;
  flatHalf: number;
  depth: number;
  hw: number;
  roadHW: number;
  walk: boolean;
  railY: number;
  us: number[];
  surfYs: number[];
}

/**
 * Build a real terrain cut polyline for a railway underpass trench (`c.under === true`).
 * Anchors BOTH mouths smoothly to the actual road surface elevation (`sampleRoadSurfaceY`, never clamped to center `c.y`)
 * so steep hillsides (25%+) have 0.00 m step at both ends, matches actual road width (`c.hw` + sidewalk if `c.walk`),
 * and widens the flat terrain cut (`totalHW + 1.5 m`) so `TerrainView.setCuts()` bank triangles never intrude over internal walkways.
 */
export function buildRailUnderpassCut(
  c: CrossingView,
  ground: (x: number, z: number) => number,
): RailUnderpassCut {
  const roadHW = c.hw ?? 4;
  const walk = !!c.walk;
  const totalHW = roadHW + (walk ? SIDEWALK_WIDTH : 0);
  // Wide flat excavation margin beyond outer sidewalk + retaining wall so setCuts() side slopes start strictly outside walkways
  const hw = totalHW + 1.5;
  const ra = c.angle;
  const rx = Math.cos(ra), rz = Math.sin(ra);
  const nx = -rz, nz = rx;
  const halfLenNeg = c.halfLenNeg ?? UNDERPASS_HALF_LEN;
  const halfLenPos = c.halfLenPos ?? UNDERPASS_HALF_LEN;
  const flatHalf = UNDERPASS_FLAT_HALF;
  const depth = UNDERPASS_DEPTH;

  const surfAt = (sx: number, sz: number): number => sampleRoadSurfaceY(sx, sz, nx, nz, roadHW, ground, c.y);
  const railY = c.ry ?? Math.max(c.y, surfAt(c.x, c.z));

  const us: number[] = [];
  for (let u = -halfLenNeg; u < halfLenPos - 0.05; u += 0.5) us.push(u);
  us.push(halfLenPos);

  const pts: number[] = [];
  const surfYs: number[] = [];
  for (const u of us) {
    const sx = c.x + rx * u;
    const sz = c.z + rz * u;
    const surfY = surfAt(sx, sz);
    const py = sampleUnderpassY(u, surfY, railY, halfLenNeg, halfLenPos, flatHalf, depth);
    pts.push(sx, py, sz);
    surfYs.push(surfY);
  }
  return { pts, hw, roadHW, walk, railY, halfLenNeg, halfLenPos, flatHalf, depth, us, surfYs };
}

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
  /** carved terrain height sampler including all active `setCuts` trenches (set by App to TerrainView.cutY) */
  cutGround?: (x: number, z: number) => number;
  /** road clearance query (set by the app to RoadsLayer.queryRoadClearance) so rail viaduct piers never block streets below */
  roadClearance?: RoadClearanceFn;
  /** active terrain cuts for rail underpass trenches (`c.under`) */
  cuts: TerrainCut[] = [];
  /** callback invoked whenever `cuts` changes so App can combine road + rail terrain cuts */
  onCuts: ((cuts: TerrainCut[]) => void) | null = null;

  private pierGroundY(x: number, z: number): number {
    let y = this.ground(x, z);
    if (this.cutGround) y = Math.min(y, this.cutGround(x, z));
    if (this.cuts.length) y = Math.min(y, sampleCutsMinY(x, z, y, this.cuts));
    return y;
  }
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
  /** True if any rail edge is elevated or a bridge (used to refresh pier clearance when streets change underneath). */
  hasElevatedOrBridge(): boolean {
    for (const e of this.edges.values()) if (e.elevated || e.bridge) return true;
    return false;
  }

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

    // Collect rail underpass cuts & sloped bridge deck spans first so tracks, decks, and piers share one 3D profile
    this.cuts = [];
    const underpassByIdx = new Map<number, RailUnderpassCut>();
    const wall = new THREE.Color(0xa9a59b), stripe = new THREE.Color(0xeeeeea);
    interface UnderpassBridgeSpan {
      ci: number;
      cx: number;
      cz: number;
      halfSpan: number;
      covered: boolean;
      samples: { x: number; y: number; z: number }[];
    }
    const underpassSpans: UnderpassBridgeSpan[] = [];
    const underpassSpanByIdx = new Map<number, UnderpassBridgeSpan>();
    this.crossings.forEach((c, ci) => {
      if (c.under) {
        const cutData = buildRailUnderpassCut(c, this.ground);
        underpassByIdx.set(ci, cutData);
        this.cuts.push({ pts: cutData.pts, hw: cutData.hw });
        const ra = c.angle, ta = c.rail ?? ra + Math.PI / 2;
        const rx = Math.cos(ra), rz = Math.sin(ra), tx = Math.cos(ta), tz = Math.sin(ta);
        const sin = Math.max(0.5, Math.abs(rx * tz - rz * tx));
        const cosSkew = Math.abs(rx * tx + rz * tz);
        const totalHW = cutData.roadHW + (cutData.walk ? SIDEWALK_WIDTH : 0);
        const deckHalfW = (c.tracks ?? 2) * 4.2 / 2 + 1.85;
        const span: UnderpassBridgeSpan = {
          ci,
          cx: c.x,
          cz: c.z,
          halfSpan: (totalHW + 1.0 + deckHalfW * cosSkew) / sin + 2.4,
          covered: false,
          samples: [],
        };
        underpassSpans.push(span);
        underpassSpanByIdx.set(ci, span);
      }
    });

    for (const e of this.edges.values()) {
      const p = e.pts;
      const cum = cumLen(p);
      const len = cum[cum.length - 1] * Math.min(1, e.progress);
      if (len < 0.5) continue;
      const tracks = e.tracks;
      const spread = 4.2;
      const hw = tracks * spread / 2 + 1.4;

      // Project any c.under overpass crossings that lie on this rail edge so the concrete deck follows exact 3D rail grade/curve
      const edgeUnderSpans: { s0: number; s1: number; us: UnderpassBridgeSpan }[] = [];
      for (const us of underpassSpans) {
        let bestDist2 = Infinity;
        let bestS = 0;
        for (let k = 0; k + 3 < p.length; k += 3) {
          const ax = p[k], az = p[k + 2], bx = p[k + 3], bz = p[k + 5];
          const dx = bx - ax, dz = bz - az;
          const segLen2 = dx * dx + dz * dz;
          const t = segLen2 > 1e-8 ? Math.max(0, Math.min(1, ((us.cx - ax) * dx + (us.cz - az) * dz) / segLen2)) : 0;
          const px = ax + dx * t, pz = az + dz * t;
          const d2 = (us.cx - px) * (us.cx - px) + (us.cz - pz) * (us.cz - pz);
          if (d2 < bestDist2) {
            bestDist2 = d2;
            const segIdx = k / 3;
            bestS = cum[segIdx] + t * (cum[segIdx + 1] - cum[segIdx]);
          }
        }
        if (bestDist2 <= (hw + 1.5) * (hw + 1.5)) {
          const s0 = Math.max(0, bestS - us.halfSpan);
          const s1 = Math.min(len, bestS + us.halfSpan);
          if (s1 - s0 > 0.2) {
            edgeUnderSpans.push({ s0, s1, us });
            us.covered = true;
          }
        }
      }
      const findUnderSpan = (sMid: number) => {
        for (const es of edgeUnderSpans) if (sMid >= es.s0 && sMid <= es.s1) return es;
        return null;
      };

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
      const rawMarks: number[] = [];
      for (let s = 0; s < len; s += step) rawMarks.push(s);
      rawMarks.push(len);
      for (const es of edgeUnderSpans) {
        rawMarks.push(es.s0, es.s1);
        for (let sm = es.s0 + 2; sm < es.s1 - 0.1; sm += 2) rawMarks.push(sm);
      }
      rawMarks.sort((u, v) => u - v);
      const sMarks: number[] = [rawMarks[0]];
      for (let i = 1; i < rawMarks.length; i++) {
        if (rawMarks[i] - sMarks[sMarks.length - 1] > 0.05) sMarks.push(rawMarks[i]);
      }
      if (sMarks[sMarks.length - 1] < len) sMarks[sMarks.length - 1] = len;

      let prevDeck = false;
      let lastPierS = -100;
      for (let mi = 0; mi + 1 < sMarks.length; mi++) {
        const s = sMarks[mi], sNext = sMarks[mi + 1];
        const a = liftedAt(s), b = liftedAt(sNext);
        const uSpan = findUnderSpan(0.5 * (s + sNext));
        const deck = a[5] || b[5];
        const underDeck = !!uSpan && !deck;
        if (uSpan) {
          uSpan.us.samples.push({ x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] });
        }
        const P = (q0: [number, number, number, number, number, boolean], o: number, dy: number) => [q0[0] - q0[4] * o, q0[1] + dy, q0[2] + q0[3] * o];

        // Transition abutment block where embankment meets bridge/viaduct deck
        if (s > 0 && deck !== prevDeck && !e.elevated) {
          const ap = a;
          const ang = Math.atan2(ap[4], ap[3]);
          const gy = this.ground(ap[0], ap[2]);
          const bot = Math.min(gy - 1.8, ap[1] - 4.0);
          const hAbut = Math.max(1.0, ap[1] - 0.90 - bot);
          g.setTransform(ap[0], bot, ap[2], ang);
          g.box(0, 0, 0, 3.6, hAbut, (hw + 0.9) * 2, concDark);
          g.setTransform(0, 0, 0, 0);
        }
        prevDeck = deck;

        // Ballast bed or concrete bridge/viaduct/underpass overpass deck top (always flush at dy = 0 below sleepers/rails)
        const deckW = deck || underDeck ? hw + 0.45 : hw;
        g.quad([P(a, deckW, 0), P(b, deckW, 0), P(b, -deckW, 0), P(a, -deckW, 0)], [0, 1, 0], deck || underDeck ? conc : ballast);

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
          // Real structural concrete piers spaced ~26 m down to riverbed / carved terrain — physical cross-section NEVER intrudes on roads below!
          if (s - lastPierS >= 26 && s > 6 && s < len - 6) {
            const shaftW = Math.min((hw + 0.3) * 1.05, 3.0);
            const placement = resolveViaductPierPlacement(
              s,
              Math.max(4, lastPierS + 10),
              len - 4,
              (sp) => {
                const lp = liftedAt(sp);
                return [lp[0], lp[1], lp[2], lp[3], lp[4]];
              },
              deckW,
              this.roadClearance,
              1.6,
              {
                pierHalfLen: 0.95,
                pierHalfWidth: shaftW * 0.5 + 0.25,
                colRadius: 0.95,
                safetyMargin: 0.6,
                maxPortalSpan: 65,
              },
            );
            if (placement.kind === 'skip') {
              lastPierS = s;
            } else {
              const topY = placement.y - 0.95;
              const pAng = Math.atan2(placement.tz, placement.tx);
              if (placement.kind === 'single') {
                const gy = this.pierGroundY(placement.x, placement.z);
                const base = gy < 0.2 ? Math.min(gy - 2.0, -5.0) : gy - 2.0;
                const hPier = topY - base;
                if (hPier > 1.2) {
                  q.setFromAxisAngle(up, -pAng);
                  // Pier geometry base is 1.6 (X) × 0.82 (Z) -> scale cleanly to 1.52 m × shaftW
                  m.compose(new THREE.Vector3(placement.x, base, placement.z), q, new THREE.Vector3(0.95, hPier, shaftW / 0.82));
                  pierMats.push(m.clone());
                  // Pier cap beam supporting full rail deck width overhead
                  g.setTransform(placement.x, topY - 0.55, placement.z, pAng);
                  g.box(0, 0, 0, 2.0, 0.6, (deckW - 0.1) * 2, conc);
                  g.setTransform(0, 0, 0, 0);
                  lastPierS = Math.max(s, placement.s);
                }
              } else {
                // Portal frame spanning cleanly across ALL lower carriageway(s) + horizontal concrete crossbeam
                const gL = this.pierGroundY(placement.left.x, placement.left.z);
                const gR = this.pierGroundY(placement.right.x, placement.right.z);
                const baseL = gL < 0.2 ? Math.min(gL - 2.0, -5.0) : gL - 2.0;
                const baseR = gR < 0.2 ? Math.min(gR - 2.0, -5.0) : gR - 2.0;
                const hL = topY - baseL, hR = topY - baseR;
                if (Math.max(hL, hR) > 1.2) {
                  q.setFromAxisAngle(up, -pAng);
                  // Sleek 1.20 m × 1.15 m portal side columns (circumscribed radius ~0.83 m < checked colRadius 0.95 m)
                  if (hL > 1.0) {
                    m.compose(new THREE.Vector3(placement.left.x, baseL, placement.left.z), q, new THREE.Vector3(0.75, hL, 1.4));
                    pierMats.push(m.clone());
                  }
                  if (hR > 1.0) {
                    m.compose(new THREE.Vector3(placement.right.x, baseR, placement.right.z), q, new THREE.Vector3(0.75, hR, 1.4));
                    pierMats.push(m.clone());
                  }
                  const midLat = (placement.rightSpan - placement.leftSpan) * 0.5;
                  const beamSpan = placement.leftSpan + placement.rightSpan + 1.6;
                  g.setTransform(placement.x, topY - 0.85, placement.z, pAng);
                  g.box(0, 0, midLat, 1.9, 0.9, beamSpan, conc);
                  g.setTransform(0, 0, 0, 0);
                  lastPierS = Math.max(s, placement.s);
                }
              }
            }
          }
        } else if (underDeck && uSpan) {
          // Sloped concrete overpass bridge deck & parapets following exact 3D railway grade (never burying rails or sleepers)
          g.quad([P(a, -deckW, -0.85), P(b, -deckW, -0.85), P(b, deckW, -0.85), P(a, deckW, -0.85)], [0, -1, 0], concDark);
          for (const sd of [-1, 1]) {
            const oOut = sd * deckW;
            const oIn = sd * (deckW - 0.45);
            const nx = -a[4] * sd, nz = a[3] * sd;
            // Outer fascia + parapet wall
            g.quad([P(a, oOut, -0.85), P(b, oOut, -0.85), P(b, oOut, 1.05), P(a, oOut, 1.05)], [nx, 0, nz], wall);
            // Inner parapet wall
            g.quad([P(a, oIn, 0), P(b, oIn, 0), P(b, oIn, 1.05), P(a, oIn, 1.05)], [-nx, 0, -nz], wall);
            // Parapet white coping band (sides + top)
            g.quad([P(a, oOut, 1.05), P(b, oOut, 1.05), P(b, oOut, 1.15), P(a, oOut, 1.15)], [nx, 0, nz], stripe);
            g.quad([P(a, oIn, 1.05), P(b, oIn, 1.05), P(b, oIn, 1.15), P(a, oIn, 1.15)], [-nx, 0, -nz], stripe);
            g.quad(
              sd > 0
                ? [P(a, oOut, 1.15), P(b, oOut, 1.15), P(b, oIn, 1.15), P(a, oIn, 1.15)]
                : [P(a, oIn, 1.15), P(b, oIn, 1.15), P(b, oOut, 1.15), P(a, oOut, 1.15)],
              [0, 1, 0], stripe,
            );
          }
          // Solid end-caps at bridge entry/exit (below track + parapet ends only, never across rails)
          if (s <= uSpan.s0 + 0.06) {
            const en = [-a[3], 0, -a[4]];
            g.quad([P(a, -deckW, -0.85), P(a, deckW, -0.85), P(a, deckW, 0), P(a, -deckW, 0)], en, concDark);
            for (const sd of [-1, 1]) {
              const oOut = sd * deckW, oIn = sd * (deckW - 0.45);
              g.quad([P(a, oIn, 0), P(a, oOut, 0), P(a, oOut, 1.05), P(a, oIn, 1.05)], en, wall);
              g.quad([P(a, oIn, 1.05), P(a, oOut, 1.05), P(a, oOut, 1.15), P(a, oIn, 1.15)], en, stripe);
            }
          }
          if (sNext >= uSpan.s1 - 0.06) {
            const en = [b[3], 0, b[4]];
            g.quad([P(b, -deckW, -0.85), P(b, deckW, -0.85), P(b, deckW, 0), P(b, -deckW, 0)], en, concDark);
            for (const sd of [-1, 1]) {
              const oOut = sd * deckW, oIn = sd * (deckW - 0.45);
              g.quad([P(b, oIn, 0), P(b, oOut, 0), P(b, oOut, 1.05), P(b, oIn, 1.05)], en, wall);
              g.quad([P(b, oIn, 1.05), P(b, oOut, 1.05), P(b, oOut, 1.15), P(b, oIn, 1.15)], en, stripe);
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
          const my = a[5] || findUnderSpan(s) ? a[1] : Math.max(a[1] - 0.1, this.ground(mx, mz));
          q.setFromAxisAngle(up, -Math.atan2(a[4], a[3]));
          m.compose(new THREE.Vector3(mx, my, mz), q, new THREE.Vector3(1, 1, 1));
          cat.push(m.clone());
        }
      }
    }

    // Level crossings & rail underpasses (with real terrain cuts via TerrainView.setCuts)
    this.postMats = [];
    this.gatePiv = [];
    const rubber = new THREE.Color(0x4b4d4e), asphalt = new THREE.Color(0x3d4044), yellow = new THREE.Color(0xf2c230), walkCol = new THREE.Color(0xb9b4aa), curbCol = new THREE.Color(0xd2cdc2);
    this.crossings.forEach((c, ci) => {
      if (c.separated && !c.under) return;
      const hw = c.hw ?? 4, ra = c.angle, ta = c.rail ?? ra + Math.PI / 2;
      const rx = Math.cos(ra), rz = Math.sin(ra), tx = Math.cos(ta), tz = Math.sin(ta);
      const sin = Math.max(0.5, Math.abs(rx * tz - rz * tx));
      const gCenter = this.ground(c.x, c.z);
      const y = Math.max(c.y, gCenter + 0.14);
      if (c.under) {
        // Real carved railway underpass trench: C0-matched mouths + actual road width (+ raised walkways when urban) + retaining walls + rail overpass
        const cutData = underpassByIdx.get(ci) ?? buildRailUnderpassCut(c, this.ground);
        const underSpan = underpassSpanByIdx.get(ci);
        const pts = cutData.pts;
        const surfYs = cutData.surfYs;
        const roadHW = cutData.roadHW;
        const totalHW = roadHW + (cutData.walk ? SIDEWALK_WIDTH : 0);
        const nx = -rz, nz = rx;
        const nSeg = Math.floor(pts.length / 3) - 1;
        const ry = Math.max(c.ry ?? y, y + 0.1);
        const deckTopYAt = (px: number, pz: number): number => {
          const samples = underSpan?.samples;
          if (!samples || !samples.length) return ry;
          let bestY = ry, bestD2 = Infinity;
          for (let i = 0; i < samples.length; i++) {
            const dx = px - samples[i].x, dz = pz - samples[i].z;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD2) { bestD2 = d2; bestY = samples[i].y; }
          }
          return bestY;
        };
        const tracks = c.tracks ?? 2;
        const railHalfW = tracks * 4.2 / 2 + 1.4;
        const deckHalfW = railHalfW + 0.45;
        const bridgeZone = deckHalfW + 0.25;
        const distRail = (px: number, pz: number) => Math.abs((px - c.x) * (-tz) + (pz - c.z) * tx);
        for (let k = 0; k < nSeg; k++) {
          const ax = pts[k * 3], ay = pts[k * 3 + 1], az = pts[k * 3 + 2];
          const bx = pts[(k + 1) * 3], by = pts[(k + 1) * 3 + 1], bz = pts[(k + 1) * 3 + 2];
          const uA = cutData.us[k], uB = cutData.us[k + 1];
          const P = (x0: number, y0: number, z0: number, o: number) => [x0 + nx * o, y0, z0 + nz * o];
          const fA = underpassBlend(uA, cutData.halfLenNeg, cutData.halfLenPos, cutData.flatHalf);
          const fB = underpassBlend(uB, cutData.halfLenNeg, cutData.halfLenPos, cutData.flatHalf);
          const roadYAt = (baseY: number, surfY: number, fVal: number, cx0: number, cz0: number, off: number) => {
            if (fVal >= 1) return baseY;
            const gLoc = this.ground(cx0 + nx * off, cz0 + nz * off);
            const lift = gLoc > -1e8 ? Math.max(0, gLoc + 0.18 - surfY) : 0;
            return baseY + (1 - fVal) * lift;
          };
          // Depressed road asphalt floor in 8 transverse strips matching RoadsLayer's exact mouth profile (< 0.015 m seam across full width)
          const rStrip = roadHW * 0.25;
          for (let j = 0; j < 8; j++) {
            const o0 = -roadHW + j * rStrip;
            const o1 = -roadHW + (j + 1) * rStrip;
            const y0A = roadYAt(ay, surfYs[k], fA, ax, az, o0);
            const y0B = roadYAt(by, surfYs[k + 1], fB, bx, bz, o0);
            const y1A = roadYAt(ay, surfYs[k], fA, ax, az, o1);
            const y1B = roadYAt(by, surfYs[k + 1], fB, bx, bz, o1);
            flatUp(g, [P(ax, y1A, az, o1), P(bx, y1B, bz, o1), P(bx, y0B, bz, o0), P(ax, y0A, az, o0)], asphalt);
          }
          // Matching double center yellow stripes along sunken trench roadway (recessed 1 m from mouths to align cleanly with RoadsLayer pad)
          if (k >= 2 && k < nSeg - 2) {
            const yC0A = roadYAt(ay, surfYs[k], fA, ax, az, 0) + 0.03;
            const yC0B = roadYAt(by, surfYs[k + 1], fB, bx, bz, 0) + 0.03;
            flatUp(g, [P(ax, yC0A, az, -0.06), P(bx, yC0B, bz, -0.06), P(bx, yC0B, bz, -0.2), P(ax, yC0A, az, -0.2)], yellow);
            flatUp(g, [P(ax, yC0A, az, 0.2), P(bx, yC0B, bz, 0.2), P(bx, yC0B, bz, 0.06), P(ax, yC0A, az, 0.06)], yellow);
          }
          // Raised pedestrian walkways in 4 transverse strips (0.65 m wide) matching RoadsLayer's exact mouth vertices (< 0.01 m seam)
          if (cutData.walk) {
            const walkAt = (uVal: number, surfY: number, cx0: number, cz0: number, off: number) => sampleUnderpassWalkY(
              uVal, surfY, this.ground(cx0 + nx * off, cz0 + nz * off), cutData.railY,
              cutData.halfLenNeg, cutData.halfLenPos, cutData.flatHalf, cutData.depth, true,
            );
            const swStrip = SIDEWALK_WIDTH * 0.25;
            for (const sd of [-1, 1]) {
              const wIn = sd * roadHW;
              const cOut = sd * (roadHW + 0.25);
              const yInA = walkAt(uA, surfYs[k], ax, az, wIn);
              const yInB = walkAt(uB, surfYs[k + 1], bx, bz, wIn);
              const yCOutA = walkAt(uA, surfYs[k], ax, az, cOut);
              const yCOutB = walkAt(uB, surfYs[k + 1], bx, bz, cOut);
              for (let j = 0; j < 4; j++) {
                const o0 = sd * (roadHW + j * swStrip);
                const o1 = sd * (roadHW + (j + 1) * swStrip);
                const y0A = walkAt(uA, surfYs[k], ax, az, o0);
                const y0B = walkAt(uB, surfYs[k + 1], bx, bz, o0);
                const y1A = walkAt(uA, surfYs[k], ax, az, o1);
                const y1B = walkAt(uB, surfYs[k + 1], bx, bz, o1);
                flatUp(g, [P(ax, y0A, az, o0), P(bx, y0B, bz, o0), P(bx, y1B, bz, o1), P(ax, y1A, az, o1)], walkCol);
              }
              flatUp(g, [P(ax, yInA + 0.02, az, wIn), P(bx, yInB + 0.02, bz, wIn), P(bx, yCOutB + 0.02, bz, cOut), P(ax, yCOutA + 0.02, az, cOut)], curbCol);
              const yEdgeA = roadYAt(ay, surfYs[k], fA, ax, az, wIn);
              const yEdgeB = roadYAt(by, surfYs[k + 1], fB, bx, bz, wIn);
              g.quad([P(ax, yEdgeA, az, wIn), P(bx, yEdgeB, bz, wIn), P(bx, yInB + 0.01, bz, wIn), P(ax, yInA + 0.01, az, wIn)], [-nx * sd, 0, -nz * sd], curbCol);
            }
          }
          // Retaining walls + coping: stop cleanly at bridge deck underside under tracks, fade flush to grade at mouths
          const cutDepthA = Math.max(0, surfYs[k] - ay);
          const cutDepthB = Math.max(0, surfYs[k + 1] - by);
          if (Math.max(cutDepthA, cutDepthB) > 0.08) {
            const paraA = Math.min(0.35, Math.max(0, cutDepthA - 0.55) * 0.22);
            const paraB = Math.min(0.35, Math.max(0, cutDepthB - 0.55) * 0.22);
            for (const sd of [-1, 1]) {
              const oIn = sd * (totalHW + 0.2);
              const oOut = sd * (totalHW + 1.65);
              const wxA = ax + nx * oIn, wzA = az + nz * oIn;
              const wxB = bx + nx * oIn, wzB = bz + nz * oIn;
              const dRA = distRail(wxA, wzA);
              const dRB = distRail(wxB, wzB);
              const inBridgeA = dRA < bridgeZone;
              const inBridgeB = dRB < bridgeZone;
              const gWA = this.ground(wxA, wzA);
              const gWB = this.ground(wxB, wzB);
              const rimA = Math.max(ay + 0.14, (gWA > -1e8 ? gWA + 0.08 : surfYs[k]) + paraA);
              const rimB = Math.max(by + 0.14, (gWB > -1e8 ? gWB + 0.08 : surfYs[k + 1]) + paraB);
              // Under the railway bridge deck, cap the abutment wall at sloped deck underside so it NEVER slices tracks
              const sA = inBridgeA ? Math.min(rimA, deckTopYAt(wxA, wzA) - 0.85) : rimA;
              const sB = inBridgeB ? Math.min(rimB, deckTopYAt(wxB, wzB) - 0.85) : rimB;
              // Inner retaining wall down below depressed floor
              g.quad([P(ax, ay - 0.45, az, oIn), P(bx, by - 0.45, bz, oIn), P(bx, sB, bz, oIn), P(ax, sA, az, oIn)], [-nx * sd, 0, -nz * sd], wall);
              // Top coping + outer backfill lip ONLY outside the railway bridge corridor
              if (!inBridgeA && !inBridgeB) {
                flatUp(g, [P(ax, sA, az, oIn), P(bx, sB, bz, oIn), P(bx, sB, bz, oOut), P(ax, sA, az, oOut)], conc);
                g.quad([P(ax, sA - Math.max(1.2, paraA + 0.8), az, oOut), P(bx, sB - Math.max(1.2, paraB + 0.8), bz, oOut), P(bx, sB, bz, oOut), P(ax, sA, az, oOut)], [nx * sd, 0, nz * sd], concDark);
              }
            }
          }
        }
        // Fallback concrete overpass deck ONLY when no rail edge covered this crossing (e.g. edge-less unit tests)
        if (!underSpan?.covered) {
          g.setTransform(c.x, ry, c.z, ta);
          const span = (totalHW + 1.0) / sin + 2.4;
          g.box(0, -0.85, 0, span * 2, 0.85, deckHalfW * 2, concDark);
          for (const sd of [-1, 1]) {
            g.box(0, -0.1, sd * (deckHalfW - 0.25), span * 2, 1.15, 0.45, wall);
            g.box(0, 1.05, sd * (deckHalfW - 0.25), span * 2, 0.1, 0.52, stripe);
          }
          g.setTransform(0, 0, 0, 0);
        }
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

    this.onCuts?.(this.cuts);
  }
}
