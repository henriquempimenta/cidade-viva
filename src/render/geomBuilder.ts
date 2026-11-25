import * as THREE from 'three';

/** Small immediate-mode geometry builder: everything procedural is assembled with it. */
export class GB {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  win: number[] = []; // floorH, spacing, seed, type
  // current transform (rotation about Y + translation)
  private ca = 1; private sa = 0; private tx = 0; private ty = 0; private tz = 0;
  winParams: [number, number, number] = [3.2, 3, 0];

  setTransform(x: number, y: number, z: number, angle: number) {
    this.tx = x; this.ty = y; this.tz = z; this.ca = Math.cos(angle); this.sa = Math.sin(angle);
  }
  private v(x: number, y: number, z: number) {
    // rotation by angle about Y, mapping local x->world along angle
    this.pos.push(this.tx + x * this.ca - z * this.sa, this.ty + y, this.tz + x * this.sa + z * this.ca);
  }
  private n(x: number, y: number, z: number) { this.nor.push(x * this.ca - z * this.sa, y, x * this.sa + z * this.ca); }

  /** Zero-allocation upward-facing quad in world coordinates (fast path for road ribbons & junctions). */
  quadUp(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    c: THREE.Color,
  ) {
    const pos = this.pos, nor = this.nor, col = this.col, uv = this.uv, win = this.win;
    const r = c.r, g = c.g, b = c.b;
    const w0 = this.winParams[0], w1 = this.winParams[1], w2 = this.winParams[2];
    if (this.tx === 0 && this.ty === 0 && this.tz === 0 && this.ca === 1 && this.sa === 0) {
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz);
    } else {
      const ca = this.ca, sa = this.sa, tx = this.tx, ty = this.ty, tz = this.tz;
      const axw = tx + ax * ca - az * sa, azw = tz + ax * sa + az * ca, ayw = ty + ay;
      const bxw = tx + bx * ca - bz * sa, bzw = tz + bx * sa + bz * ca, byw = ty + by;
      const cxw = tx + cx * ca - cz * sa, czw = tz + cx * sa + cz * ca, cyw = ty + cy;
      const dxw = tx + dx * ca - dz * sa, dzw = tz + dx * sa + dz * ca, dyw = ty + dy;
      pos.push(axw, ayw, azw, bxw, byw, bzw, cxw, cyw, czw, axw, ayw, azw, cxw, cyw, czw, dxw, dyw, dzw);
    }
    nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    col.push(r, g, b, r, g, b, r, g, b, r, g, b, r, g, b, r, g, b);
    uv.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    win.push(w0, w1, w2, 0, w0, w1, w2, 0, w0, w1, w2, 0, w0, w1, w2, 0, w0, w1, w2, 0, w0, w1, w2, 0);
  }

  /** Zero-allocation upward-facing single triangle in world coordinates. */
  triUp(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    c: THREE.Color,
  ) {
    const pos = this.pos, nor = this.nor, col = this.col, uv = this.uv, win = this.win;
    const r = c.r, g = c.g, b = c.b;
    const w0 = this.winParams[0], w1 = this.winParams[1], w2 = this.winParams[2];
    if (this.tx === 0 && this.ty === 0 && this.tz === 0 && this.ca === 1 && this.sa === 0) {
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    } else {
      const ca = this.ca, sa = this.sa, tx = this.tx, ty = this.ty, tz = this.tz;
      pos.push(
        tx + ax * ca - az * sa, ty + ay, tz + ax * sa + az * ca,
        tx + bx * ca - bz * sa, ty + by, tz + bx * sa + bz * ca,
        tx + cx * ca - cz * sa, ty + cy, tz + cx * sa + cz * ca,
      );
    }
    nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    col.push(r, g, b, r, g, b, r, g, b);
    uv.push(0, 0, 0, 0, 0, 0);
    win.push(w0, w1, w2, 0, w0, w1, w2, 0, w0, w1, w2, 0);
  }

  /** triangle-pair quad, p0..p3 counter-clockwise seen from outside */
  quad(p: number[][], normal: number[], c: THREE.Color, wtype = 0, uvs?: number[][]) {
    const idx = [0, 1, 2, 0, 2, 3];
    for (const i of idx) {
      this.v(p[i][0], p[i][1], p[i][2]);
      this.n(normal[0], normal[1], normal[2]);
      this.col.push(c.r, c.g, c.b);
      const u = uvs ? uvs[i] : [0, 0];
      this.uv.push(u[0], u[1]);
      this.win.push(this.winParams[0], this.winParams[1], this.winParams[2], wtype);
    }
  }
  tri(p: number[][], c: THREE.Color) {
    const a = p[0], b = p[1], d = p[2];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (const q of p) {
      this.v(q[0], q[1], q[2]); this.n(nx, ny, nz); this.col.push(c.r, c.g, c.b); this.uv.push(0, 0);
      this.win.push(0, 0, 0, 0);
    }
  }

  /** axis-aligned (local) box. wtype applies to the 4 side faces. */
  box(cx: number, y0: number, cz: number, w: number, h: number, d: number, c: THREE.Color, wtype = 0, opts: { top?: THREE.Color; noBottom?: boolean; sideWin?: [number, number, number, number] } = {}) {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, y1 = y0 + h;
    const sw = opts.sideWin ?? [wtype, wtype, wtype, wtype];
    // +z face
    this.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], c, sw[0], [[0, 0], [w, 0], [w, h], [0, h]]);
    // -z
    this.quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], c, sw[1], [[0, 0], [w, 0], [w, h], [0, h]]);
    // +x
    this.quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], c, sw[2], [[0, 0], [d, 0], [d, h], [0, h]]);
    // -x
    this.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], c, sw[3], [[0, 0], [d, 0], [d, h], [0, h]]);
    // top
    this.quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], opts.top ?? c, 0);
    if (!opts.noBottom && y0 > 0.5) this.quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], c, 0);
  }

  /** gable roof along local x */
  gable(cx: number, y0: number, cz: number, w: number, d: number, h: number, c: THREE.Color, gableC?: THREE.Color) {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, ym = y0 + h;
    const sl = Math.hypot(h, d / 2);
    const ny = (d / 2) / sl, nz = h / sl;
    this.quad([[x0, y0, z1], [x1, y0, z1], [x1, ym, cz], [x0, ym, cz]], [0, ny, nz], c);
    this.quad([[x1, y0, z0], [x0, y0, z0], [x0, ym, cz], [x1, ym, cz]], [0, ny, -nz], c);
    const g = gableC ?? c;
    this.tri([[x1, y0, z1], [x1, y0, z0], [x1, ym, cz]], g);
    this.tri([[x0, y0, z0], [x0, y0, z1], [x0, ym, cz]], g);
  }

  pyramid(cx: number, y0: number, cz: number, w: number, d: number, h: number, c: THREE.Color) {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, t = [cx, y0 + h, cz];
    this.tri([[x0, y0, z1], [x1, y0, z1], t], c);
    this.tri([[x1, y0, z1], [x1, y0, z0], t], c);
    this.tri([[x1, y0, z0], [x0, y0, z0], t], c);
    this.tri([[x0, y0, z0], [x0, y0, z1], t], c);
  }

  cylinder(cx: number, y0: number, cz: number, r0: number, r1: number, h: number, seg: number, c: THREE.Color, wtype = 0, cap = true) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const am = (a0 + a1) / 2;
      const arc = (Math.PI * 2 * r0) / seg;
      this.quad([[cx + c0 * r0, y0, cz + s0 * r0], [cx + c1 * r0, y0, cz + s1 * r0], [cx + c1 * r1, y0 + h, cz + s1 * r1], [cx + c0 * r1, y0 + h, cz + s0 * r1]], [Math.cos(am), (r0 - r1) / h, Math.sin(am)], c, wtype, [[i * arc, 0], [(i + 1) * arc, 0], [(i + 1) * arc, h], [i * arc, h]]);
      if (cap && r1 > 0.01) this.tri([[cx, y0 + h, cz], [cx + c1 * r1, y0 + h, cz + s1 * r1], [cx + c0 * r1, y0 + h, cz + s0 * r1]], c);
    }
  }

  /** surface of revolution from a profile [r, y] */
  lathe(cx: number, y0: number, cz: number, prof: [number, number][], seg: number, c: THREE.Color) {
    for (let k = 0; k < prof.length - 1; k++) {
      const [ra, ya] = prof[k], [rb, yb] = prof[k + 1];
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
        const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        this.quad([[cx + c0 * ra, y0 + ya, cz + s0 * ra], [cx + c1 * ra, y0 + ya, cz + s1 * ra], [cx + c1 * rb, y0 + yb, cz + s1 * rb], [cx + c0 * rb, y0 + yb, cz + s0 * rb]], [Math.cos(am), (ra - rb) / Math.max(0.1, yb - ya), Math.sin(am)], c);
      }
    }
  }

  /** flat oriented rectangle on ground (local coords) */
  flat(cx: number, y: number, cz: number, w: number, d: number, c: THREE.Color) {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    this.quad([[x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]], [0, 1, 0], c);
  }

  get count() { return this.pos.length / 3; }

  toGeometry(withWin = true): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (withWin) g.setAttribute('aWin', new THREE.Float32BufferAttribute(this.win, 4));
    g.computeBoundingSphere();
    return g;
  }
}
