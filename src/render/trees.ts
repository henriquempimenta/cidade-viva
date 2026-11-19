import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { U } from './uniforms';

function colored(g: THREE.BufferGeometry, c: number): THREE.BufferGeometry {
  const col = new THREE.Color(c);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g.toNonIndexed();
}

export function treeGeometries(): THREE.BufferGeometry[] {
  const trunk = () => colored(new THREE.CylinderGeometry(0.25, 0.35, 2.4, 5).translate(0, 1.2, 0), 0x6b4a2f);
  const broad = mergeGeometries([
    trunk(),
    colored(new THREE.IcosahedronGeometry(2.4, 0).translate(0, 4.2, 0), 0x4e8a3a),
    colored(new THREE.IcosahedronGeometry(1.7, 0).translate(0.9, 5.4, 0.4), 0x5f9a44),
  ]);
  const conifer = mergeGeometries([
    trunk(),
    colored(new THREE.ConeGeometry(2.2, 4, 6).translate(0, 4, 0), 0x2f5f37),
    colored(new THREE.ConeGeometry(1.6, 3.2, 6).translate(0, 6.2, 0), 0x386b3e),
  ]);
  const palm = mergeGeometries([
    colored(new THREE.CylinderGeometry(0.18, 0.3, 6, 5).translate(0, 3, 0), 0x8a6a45),
    ...[0, 1, 2, 3, 4].map((i) => colored(new THREE.BoxGeometry(3.6, 0.12, 0.8).translate(1.6, 0, 0).rotateZ(-0.35).rotateY((i * Math.PI * 2) / 5).translate(0, 6, 0), 0x5a9a3c)),
  ]);
  return [broad, conifer, palm];
}

export function swayMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.uTime;
    sh.uniforms.uWind = U.uWind;
    sh.uniforms.uSnow = U.uSnow;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uWind; varying float vH;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vH = position.y;
        #ifdef USE_INSTANCING
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float ph = ip.x * 0.11 + ip.z * 0.07;
          float k = max(0.0, position.y - 1.5) * 0.045 * uWind;
          transformed.x += sin(uTime * 1.7 + ph) * k + sin(uTime * 4.1 + ph * 3.0) * k * 0.3;
          transformed.z += cos(uTime * 1.3 + ph) * k * 0.6;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSnow; varying float vH;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92,0.94,0.98), uSnow * 0.6 * step(3.0, vH));');
  };
  return m;
}

export class TreesView {
  meshes: THREE.InstancedMesh[] = [];
  private map: { mesh: number; idx: number }[] = [];
  group = new THREE.Group();
  constructor(trees: Float32Array) {
    const geos = treeGeometries();
    const mat = swayMaterial();
    const counts = [0, 0, 0];
    const n = trees.length / 5;
    for (let i = 0; i < n; i++) counts[trees[i * 5 + 4]]++;
    this.meshes = geos.map((g, t) => {
      const m = new THREE.InstancedMesh(g, mat, Math.max(1, counts[t]));
      m.castShadow = true;
      m.receiveShadow = true;
      m.count = 0;
      return m;
    });
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const tint = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const t = trees[i * 5 + 4];
      const m = this.meshes[t];
      const sc = trees[i * 5 + 3];
      p.set(trees[i * 5], trees[i * 5 + 1] - 0.2, trees[i * 5 + 2]);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i * 2.399) % 6.28);
      s.set(sc, sc * (0.85 + ((i * 7) % 10) / 30), sc);
      mtx.compose(p, q, s);
      m.setMatrixAt(m.count, mtx);
      tint.setHSL(0.15 + (((i * 13) % 17) / 17) * 0.15, 0.35, 0.78 + (((i * 5) % 11) / 11) * 0.2);
      m.setColorAt(m.count, tint);
      this.map.push({ mesh: t, idx: m.count });
      m.count++;
    }
    for (const m of this.meshes) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; this.group.add(m); }
  }
  remove(ids: number[]) {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const touched = new Set<THREE.InstancedMesh>();
    for (const id of ids) {
      const r = this.map[id];
      if (!r) continue;
      const m = this.meshes[r.mesh];
      m.setMatrixAt(r.idx, zero);
      touched.add(m);
    }
    for (const m of touched) m.instanceMatrix.needsUpdate = true;
  }
}
