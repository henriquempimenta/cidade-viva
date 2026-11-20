import * as THREE from 'three';
import type { WorldInit } from '../shared/protocol';
import { Noise2D } from '../shared/rng';
import { U } from './uniforms';

export class TerrainView {
  mesh: THREE.Mesh;
  heightTex: THREE.DataTexture;
  private hres: number;
  private step: number;
  heights: Float32Array;
  geo: THREE.BufferGeometry;
  /** fine-resolution replacement for the coarse cells crossed by road cuts (tunnel approaches, trenches) */
  private patch: THREE.Mesh | null = null;
  private fullIndex: THREE.BufferAttribute | null = null;
  private cutKey = '';

  constructor(private init: WorldInit) {
    const { size, hres, heights } = init;
    this.hres = hres;
    this.step = size / (hres - 1);
    this.heights = heights;
    const geo = new THREE.PlaneGeometry(size, size, hres - 1, hres - 1);
    geo.rotateX(-Math.PI / 2);
    geo.translate(size / 2, 0, size / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const ii = Math.round(x / this.step), jj = Math.round(z / this.step);
      pos.setY(i, heights[jj * hres + ii]);
    }
    geo.computeVertexNormals();
    this.geo = geo;
    this.colorize();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uOverlay = U.uOverlay;
      sh.uniforms.uOverlayOn = U.uOverlayOn;
      sh.uniforms.uSnow = U.uSnow;
      sh.uniforms.uRain = U.uRain;
      sh.uniforms.uMapSize = U.uMapSize;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNorm;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed,1.0)).xyz; vWNorm = normal;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWPos; varying vec3 vWNorm;
          uniform sampler2D uOverlay; uniform float uOverlayOn; uniform float uSnow; uniform float uRain; uniform float uMapSize;
          vec3 heat(float t){ t=clamp(t,0.,1.); return mix(mix(vec3(0.15,0.25,0.9),vec3(0.1,0.85,0.4),smoothstep(0.,0.4,t)), mix(vec3(1.,0.9,0.1),vec3(0.95,0.1,0.1),smoothstep(0.6,1.,t)), smoothstep(0.35,0.7,t)); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float up = clamp(vWNorm.y, 0., 1.);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93,0.95,1.0), uSnow * smoothstep(0.75, 0.95, up) * step(0.5, vWPos.y));
          diffuseColor.rgb *= 1.0 - uRain * 0.18;
          if (uOverlayOn > 0.5) {
            vec4 ov = texture2D(uOverlay, vWPos.xz / uMapSize);
            diffuseColor.rgb = mix(diffuseColor.rgb * 0.55, heat(ov.r), 0.72 * ov.a);
          }`);
    };
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'terrain';

    const ht = new Float32Array(hres * hres * 4);
    for (let i = 0; i < hres * hres; i++) ht[i * 4] = heights[i];
    this.heightTex = new THREE.DataTexture(ht, hres, hres, THREE.RGBAFormat, THREE.FloatType);
    this.heightTex.magFilter = THREE.LinearFilter;
    this.heightTex.minFilter = THREE.LinearFilter;
    this.heightTex.needsUpdate = true;
    U.uHeight.value = this.heightTex;
  }

  private colorize() {
    const { hres, heights, forest, flood, size } = this.init;
    const nz = new Noise2D(this.init.params.seed + 3);
    const pos = this.geo.attributes.position as THREE.BufferAttribute;
    const nor = this.geo.attributes.normal as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    const grass = new THREE.Color(0x7da653), grass2 = new THREE.Color(0x9bb85f), dry = new THREE.Color(0xb6b071);
    const forestC = new THREE.Color(0x4f7a3a), rock = new THREE.Color(0x8b8478), sand = new THREE.Color(0xd9c690), bed = new THREE.Color(0x8a7a5c);
    const wet = new THREE.Color(0x5f8a4a), snowC = new THREE.Color(0xf2f4f8);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const ii = Math.round(x / this.step), jj = Math.round(z / this.step);
      const k = jj * hres + ii;
      const h = heights[k];
      const ny = nor.getY(i);
      const n = nz.fbm(x / 180, z / 180, 3) * 0.5 + 0.5;
      c.copy(grass).lerp(grass2, n);
      c.lerp(dry, Math.max(0, nz.noise(x / 500 + 9, z / 500) * 0.6));
      c.lerp(forestC, forest[k] * 0.8);
      if (flood[k]) c.lerp(wet, 0.5);
      if (h < 2.2) c.lerp(sand, Math.min(1, (2.2 - h) / 1.6));
      if (h < 0) c.copy(bed);
      c.lerp(rock, Math.min(1, Math.max(0, (0.86 - ny) * 4)));
      if (h > 95) c.lerp(snowC, Math.min(1, (h - 95) / 20));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    void size;
    this.geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }

  /** height exactly as the coarse mesh draws it (planar triangles, same diagonal as PlaneGeometry) */
  meshY(x: number, z: number): number {
    const { hres, step, heights } = this;
    const fx = Math.min(hres - 1.0001, Math.max(0, x / step)), fz = Math.min(hres - 1.0001, Math.max(0, z / step));
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const ha = heights[j * hres + i], hd = heights[j * hres + i + 1], hb = heights[(j + 1) * hres + i], hc = heights[(j + 1) * hres + i + 1];
    return u + v <= 1 ? ha + (hd - ha) * u + (hb - ha) * v : hc + (hb - hc) * (1 - u) + (hd - hc) * (1 - v);
  }

  /**
   * Carve road cuts into the terrain. Each cut is a centre line with the floor height of the road and a
   * half width. The coarse cells it touches are removed from the terrain mesh and replaced by a fine patch
   * that follows the same planes at the cell borders (no cracks) and drops to the road floor inside the cut.
   */
  setCuts(cuts: { pts: number[]; hw: number }[]) {
    const key = cuts.map((c) => c.hw.toFixed(1) + ':' + c.pts.map((v) => v.toFixed(1)).join(',')).join('|');
    if (key === this.cutKey) return;
    this.cutKey = key;
    const { hres, step } = this;
    const gx = hres - 1;
    if (!this.fullIndex) this.fullIndex = (this.geo.index as THREE.BufferAttribute).clone();
    if (this.patch) { this.mesh.remove(this.patch); this.patch.geometry.dispose(); this.patch = null; }
    // 1. cells touched by any cut (with margin for the sloped edge)
    const cells = new Set<number>();
    for (const c of cuts) {
      const r = c.hw + 2;
      for (let k = 0; k + 3 < c.pts.length; k += 3) {
        const ax = c.pts[k], az = c.pts[k + 2], bx = c.pts[k + 3], bz = c.pts[k + 5];
        const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / (step * 0.25)));
        for (let t = 0; t <= n; t++) {
          const x = ax + (bx - ax) * (t / n), z = az + (bz - az) * (t / n);
          for (let i = Math.floor((x - r) / step); i <= Math.floor((x + r) / step); i++)
            for (let j = Math.floor((z - r) / step); j <= Math.floor((z + r) / step); j++)
              if (i >= 0 && j >= 0 && i < gx && j < gx) cells.add(j * gx + i);
        }
      }
    }
    // 2. terrain index without those cells
    const src = this.fullIndex.array as ArrayLike<number>;
    const idx: number[] = [];
    for (let cell = 0; cell < gx * gx; cell++) {
      if (cells.has(cell)) continue;
      for (let k = 0; k < 6; k++) idx.push(src[cell * 6 + k]);
    }
    this.geo.setIndex(cells.size ? idx : (this.fullIndex.clone()));
    if (!cells.size) return;
    // 3. fine patch
    const sub = Math.max(4, Math.ceil(step / 1.25));
    const pos: number[] = [], col: number[] = [], ind: number[] = [], carved: number[] = [];
    const nAttr = this.geo.attributes.normal as THREE.BufferAttribute;
    const norAt = (i: number, j: number, c: number) => nAttr.getComponent(Math.min(hres - 1, j) * hres + Math.min(hres - 1, i), c);
    const cAttr = this.geo.attributes.color as THREE.BufferAttribute;
    const colAt = (i: number, j: number, c: number) => cAttr.getComponent(Math.min(hres - 1, j) * hres + Math.min(hres - 1, i), c);
    const earth = [0.55, 0.47, 0.36];
    const carve = (x: number, z: number, h: number): [number, number] => {
      // returns [height, how much it was carved 0..1]
      let y = h, cut = 0;
      for (const c of cuts) {
        for (let k = 0; k + 3 < c.pts.length; k += 3) {
          const ax = c.pts[k], ay = c.pts[k + 1], az = c.pts[k + 2], bx = c.pts[k + 3], by = c.pts[k + 4], bz = c.pts[k + 5];
          const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
          const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
          if (d > c.hw + 1.6) continue;
          const floor = ay + (by - ay) * t - 0.2;
          if (floor >= h) continue;
          // flat floor inside, a steep bank just outside (hidden behind the retaining walls)
          const f = d <= c.hw ? 1 : 1 - (d - c.hw) / 1.6;
          const yy = h + (floor - h) * f;
          if (yy < y) { y = yy; cut = Math.max(cut, f); }
        }
      }
      return [y, cut];
    };
    for (const cell of cells) {
      const ci = cell % gx, cj = Math.floor(cell / gx);
      const base = pos.length / 3;
      for (let b = 0; b <= sub; b++) for (let a = 0; a <= sub; a++) {
        const x = (ci + a / sub) * step, z = (cj + b / sub) * step;
        const h = this.meshY(x, z);
        const [y, cut] = (a === 0 || b === 0 || a === sub || b === sub) ? [h, 0] : carve(x, z, h);
        pos.push(x, y, z);
        carved.push(cut);
        const u = a / sub, v = b / sub;
        for (let c = 0; c < 3; c++) {
          const g = (colAt(ci, cj, c) * (1 - u) + colAt(ci + 1, cj, c) * u) * (1 - v) + (colAt(ci, cj + 1, c) * (1 - u) + colAt(ci + 1, cj + 1, c) * u) * v;
          col.push(g + (earth[c] - g) * cut);
        }
      }
      const W = sub + 1;
      for (let b = 0; b < sub; b++) for (let a = 0; a < sub; a++) {
        const p0 = base + b * W + a, p1 = p0 + 1, p2 = p0 + W, p3 = p2 + 1;
        ind.push(p0, p2, p1, p2, p3, p1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(ind);
    g.computeVertexNormals();
    // untouched parts keep the smooth shading of the coarse terrain, so the patch doesn't show as a stain
    const nrm = g.attributes.normal as THREE.BufferAttribute;
    for (let v = 0; v < carved.length; v++) {
      const x = pos[v * 3] / step, z = pos[v * 3 + 2] / step;
      const i = Math.min(gx - 1, Math.floor(x)), j = Math.min(gx - 1, Math.floor(z)), u = x - i, w = z - j;
      const k = Math.min(1, carved[v] * 1.5);
      const sm = [0, 1, 2].map((c) => (norAt(i, j, c) * (1 - u) + norAt(i + 1, j, c) * u) * (1 - w) + (norAt(i, j + 1, c) * (1 - u) + norAt(i + 1, j + 1, c) * u) * w);
      const nx = sm[0] * (1 - k) + nrm.getX(v) * k, ny = sm[1] * (1 - k) + nrm.getY(v) * k, nz = sm[2] * (1 - k) + nrm.getZ(v) * k;
      const l = Math.hypot(nx, ny, nz) || 1;
      nrm.setXYZ(v, nx / l, ny / l, nz / l);
    }
    nrm.needsUpdate = true;
    this.patch = new THREE.Mesh(g, this.mesh.material);
    this.patch.receiveShadow = true;
    this.patch.name = 'terrain-cut';
    this.mesh.add(this.patch);
  }

  heightAt(x: number, z: number): number {
    const { hres, step, heights } = this;
    const fx = Math.min(hres - 1.001, Math.max(0, x / step)), fz = Math.min(hres - 1.001, Math.max(0, z / step));
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const k = j * hres + i;
    return (heights[k] * (1 - tx) + heights[k + 1] * tx) * (1 - tz) + (heights[k + hres] * (1 - tx) + heights[k + hres + 1] * tx) * tz;
  }

  updateHeights(h: Float32Array) {
    this.heights = h;
    this.cutKey = ''; // cuts are re-carved on the next road rebuild
    const pos = this.geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const ii = Math.round(pos.getX(i) / this.step), jj = Math.round(pos.getZ(i) / this.step);
      pos.setY(i, h[jj * this.hres + ii]);
    }
    pos.needsUpdate = true;
    this.geo.computeVertexNormals();
    const d = this.heightTex.image.data as unknown as Float32Array;
    for (let i = 0; i < h.length; i++) d[i * 4] = h[i];
    this.heightTex.needsUpdate = true;
  }
}
