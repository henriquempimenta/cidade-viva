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

  heightAt(x: number, z: number): number {
    const { hres, step, heights } = this;
    const fx = Math.min(hres - 1.001, Math.max(0, x / step)), fz = Math.min(hres - 1.001, Math.max(0, z / step));
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const k = j * hres + i;
    return (heights[k] * (1 - tx) + heights[k + 1] * tx) * (1 - tz) + (heights[k + hres] * (1 - tx) + heights[k + hres + 1] * tx) * tz;
  }

  updateHeights(h: Float32Array) {
    this.heights = h;
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
