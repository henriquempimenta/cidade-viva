import * as THREE from 'three';
import type { App } from '../app';
import type { PowerLineView, SimEvent } from '../shared/protocol';
import { U } from './uniforms';

/** Power lines, rain, fireworks, flood water, dikes, garbage bags. */
export class Effects {
  group = new THREE.Group();
  private towers: THREE.InstancedMesh;
  private lines = new Map<number, PowerLineView>();
  private cableMesh: THREE.LineSegments | null = null;
  private rain: THREE.LineSegments;
  private rainPos: Float32Array;
  private flood: THREE.Mesh;
  private floodLevel = 0;
  private floodTarget = 0;
  private dikeMesh: THREE.Mesh | null = null;
  private bags: THREE.InstancedMesh;
  private fireworks: { t: number; x: number; z: number; n: number }[] = [];
  private lastBags = 0;

  constructor(private app: App) {
    const tg = new THREE.Group();
    void tg;
    const tower = new THREE.BufferGeometry();
    const parts: THREE.BufferGeometry[] = [
      new THREE.CylinderGeometry(0.3, 1.6, 22, 4).translate(0, 11, 0),
      new THREE.BoxGeometry(10, 0.4, 0.4).translate(0, 19, 0),
      new THREE.BoxGeometry(7, 0.4, 0.4).translate(0, 15.5, 0),
    ];
    const pos: number[] = [], nor: number[] = [];
    for (const p0 of parts) { const p = p0.toNonIndexed(); pos.push(...(p.attributes.position.array as Float32Array)); nor.push(...(p.attributes.normal.array as Float32Array)); }
    tower.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    tower.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    this.towers = new THREE.InstancedMesh(tower, new THREE.MeshStandardMaterial({ color: 0x8a9096, metalness: 0.5, roughness: 0.5 }), 1500);
    this.towers.count = 0;
    this.towers.castShadow = true;
    this.group.add(this.towers);
    // rain streaks around the camera
    const N = 5000;
    this.rainPos = new Float32Array(N * 6);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xaab8c8, transparent: true, opacity: 0.35 }));
    this.rain.frustumCulled = false;
    this.group.add(this.rain);
    for (let i = 0; i < N; i++) this.resetDrop(i, new THREE.Vector3(), true);
    // flood: a translucent sheet clipped to floodable land via height texture
    const size = app.init.size;
    const fg = new THREE.PlaneGeometry(size, size, 1, 1).rotateX(-Math.PI / 2).translate(size / 2, 0, size / 2);
    this.flood = new THREE.Mesh(fg, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uHeight: U.uHeight, uMapSize: U.uMapSize, uLevel: { value: 0 }, uTime: U.uTime },
      vertexShader: 'varying vec3 vW; uniform float uLevel; void main(){ vec4 w = modelMatrix*vec4(position,1.0); w.y = uLevel; vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }',
      fragmentShader: `uniform sampler2D uHeight; uniform float uMapSize; uniform float uLevel; uniform float uTime; varying vec3 vW;
        void main(){ float h = texture2D(uHeight, vW.xz/uMapSize).r; if (h > uLevel || h < 0.3) discard;
          float d = uLevel - h; float n = sin(vW.x*0.3+uTime)*sin(vW.z*0.27-uTime*1.3);
          gl_FragColor = vec4(mix(vec3(0.45,0.38,0.25), vec3(0.35,0.42,0.38), smoothstep(0.0,1.5,d)) + n*0.03, 0.75); }`,
    }));
    this.flood.visible = false;
    this.flood.renderOrder = 3;
    this.group.add(this.flood);
    this.bags = new THREE.InstancedMesh(new THREE.SphereGeometry(0.45, 6, 4), new THREE.MeshStandardMaterial({ color: 0x262a2e, roughness: 0.4 }), 4000);
    this.bags.count = 0;
    this.group.add(this.bags);
  }

  private resetDrop(i: number, c: THREE.Vector3, any: boolean) {
    const x = c.x + (Math.random() - 0.5) * 300, z = c.z + (Math.random() - 0.5) * 300;
    const y = (any ? Math.random() : 1) * 160 + c.y - 60;
    const o = i * 6;
    this.rainPos[o] = x; this.rainPos[o + 1] = y; this.rainPos[o + 2] = z;
    this.rainPos[o + 3] = x + 0.3; this.rainPos[o + 4] = y - 2.2; this.rainPos[o + 5] = z;
  }

  upsertPowerLine(p: PowerLineView) {
    this.lines.set(p.id, p);
    this.rebuildLines();
  }

  private rebuildLines() {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const seg: number[] = [];
    let n = 0;
    for (const l of this.lines.values()) {
      const pts = l.pts;
      const cnt = pts.length / 3;
      const shown = Math.max(1, Math.floor(cnt * l.progress));
      for (let i = 0; i < shown && n < 1500; i++) {
        const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
        const nx = pts[Math.min(cnt - 1, i + 1) * 3] - pts[Math.max(0, i - 1) * 3], nz = pts[Math.min(cnt - 1, i + 1) * 3 + 2] - pts[Math.max(0, i - 1) * 3 + 2];
        q.setFromAxisAngle(up, -Math.atan2(nz, nx) + Math.PI / 2);
        m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1));
        this.towers.setMatrixAt(n++, m);
        if (i > 0 && i < shown) {
          // sagging cables between towers (catenary approximation), 3 conductors
          const px = pts[(i - 1) * 3], py = pts[(i - 1) * 3 + 1], pz = pts[(i - 1) * 3 + 2];
          const dx = x - px, dz = z - pz, l2 = Math.hypot(dx, dz) || 1;
          const ox = -dz / l2, oz = dx / l2;
          for (const off of [-4.5, 0, 4.5]) {
            const hy = off === 0 ? 15.5 : 19;
            for (let k = 0; k < 8; k++) {
              const t0 = k / 8, t1 = (k + 1) / 8;
              const sag = (t: number) => -Math.sin(Math.PI * t) * 3;
              seg.push(px + dx * t0 + ox * off, py + (y - py) * t0 + hy + sag(t0), pz + dz * t0 + oz * off,
                px + dx * t1 + ox * off, py + (y - py) * t1 + hy + sag(t1), pz + dz * t1 + oz * off);
            }
          }
        }
      }
    }
    this.towers.count = n;
    this.towers.instanceMatrix.needsUpdate = true;
    if (this.cableMesh) { this.group.remove(this.cableMesh); this.cableMesh.geometry.dispose(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    this.cableMesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x30343a }));
    this.group.add(this.cableMesh);
  }

  setFlood(level: number) { this.floodTarget = level; }
  setDikes(d: number[][]) {
    if (this.dikeMesh) this.group.remove(this.dikeMesh);
    const geos = d.map(([x, z, a, len]) => {
      const y = Math.max(0, this.app.terrain.heightAt(x, z));
      return new THREE.BoxGeometry(len, 3.4, 4).rotateY(-a).translate(x, y + 1, z);
    });
    if (!geos.length) return;
    const pos: number[] = [], nor: number[] = [];
    for (const g0 of geos) { const g = g0.toNonIndexed(); pos.push(...(g.attributes.position.array as Float32Array)); nor.push(...(g.attributes.normal.array as Float32Array)); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    this.dikeMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x8a8476, roughness: 1 }));
    this.dikeMesh.castShadow = true;
    this.group.add(this.dikeMesh);
  }

  onEvent(e: SimEvent) {
    if (e.type === 'fireworks' || e.type === 'festival') this.fireworks.push({ t: 0, x: e.x, z: e.z, n: e.type === 'fireworks' ? 60 : 18 });
  }

  update(dt: number, _simDt: number) {
    const app = this.app;
    const cam = app.rig.camera.position;
    // rain / snow
    const rain = U.uRain.value, snow = U.uSnow.value;
    this.rain.visible = rain > 0.08 || snow > 0.1;
    if (this.rain.visible) {
      const N = this.rainPos.length / 6;
      const active = Math.floor(N * Math.min(1, Math.max(rain, snow)));
      const fall = (snow > 0.3 ? 6 : 55) * dt;
      for (let i = 0; i < N; i++) {
        const o = i * 6;
        if (i >= active) { this.rainPos[o + 1] = -9999; this.rainPos[o + 4] = -9999; continue; }
        this.rainPos[o + 1] -= fall; this.rainPos[o + 4] -= fall;
        if (snow > 0.3) { this.rainPos[o] += Math.sin(U.uTime.value + i) * 0.05; this.rainPos[o + 4] = this.rainPos[o + 1] - 0.3; }
        if (this.rainPos[o + 1] < cam.y - 80 || Math.abs(this.rainPos[o] - cam.x) > 160 || Math.abs(this.rainPos[o + 2] - cam.z) > 160) this.resetDrop(i, cam, false);
      }
      (this.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.rain.material as THREE.LineBasicMaterial).color.setHex(snow > 0.3 ? 0xffffff : 0xaab8c8);
      (this.rain.material as THREE.LineBasicMaterial).opacity = snow > 0.3 ? 0.8 : 0.35;
    }
    // flood
    this.floodLevel += (this.floodTarget - this.floodLevel) * Math.min(1, dt * 0.3);
    this.flood.visible = this.floodLevel > 0.15;
    (this.flood.material as THREE.ShaderMaterial).uniforms.uLevel.value = this.floodLevel + 0.3;
    // fireworks
    for (const f of this.fireworks) {
      f.t += dt;
      if (Math.random() < dt * 4 && f.n > 0) {
        f.n--;
        const x = f.x + (Math.random() - 0.5) * 200, z = f.z + (Math.random() - 0.5) * 200, y = 110 + Math.random() * 80;
        const c = new THREE.Color().setHSL(Math.random(), 1, 0.6);
        for (let k = 0; k < 70; k++) {
          const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), s = 18 + Math.random() * 8;
          app.glow.emit(x, y, z, Math.sin(ph) * Math.cos(th) * s, Math.cos(ph) * s, Math.sin(ph) * Math.sin(th) * s, 1.8 + Math.random(), 3.5, c.r * 2, c.g * 2, c.b * 2, 1, -1);
        }
      }
    }
    this.fireworks = this.fireworks.filter((f) => f.n > 0 || f.t < 4);
    // garbage bags on sidewalks
    const now = performance.now();
    if (now - this.lastBags > 2000) {
      this.lastBags = now;
      const m = new THREE.Matrix4();
      let n = 0;
      for (const b of app.buildings.all()) {
        if (b.garbage < 1.5 || b.state !== 'done') continue;
        const k = Math.min(8, Math.floor((b.garbage - 1) * 3));
        const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
        for (let i = 0; i < k && n < 4000; i++) {
          const u = (i - k / 2) * 0.9, v = -b.d / 2 - 1.2;
          const x = b.x + ca * u - sa * v, z = b.z + sa * u + ca * v;
          m.makeTranslation(x, Math.max(0, app.terrain.heightAt(x, z)) + 0.35, z);
          this.bags.setMatrixAt(n++, m);
        }
      }
      this.bags.count = n;
      this.bags.instanceMatrix.needsUpdate = true;
    }
  }
}
