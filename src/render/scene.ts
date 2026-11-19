import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { U } from './uniforms';
import { smoothstep } from '../shared/rng';

const TiltShift = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 0 }, uFocus: { value: 0.55 }, uRes: { value: new THREE.Vector2(1, 1) }, uLetter: { value: 0 }, uVignette: { value: 0.25 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uAmount; uniform float uFocus; uniform vec2 uRes; uniform float uLetter; uniform float uVignette; varying vec2 vUv;
    void main(){
      float d = abs(vUv.y - uFocus);
      float blur = smoothstep(0.12, 0.5, d) * uAmount * 3.0;
      vec4 c = vec4(0.0); float tot = 0.0;
      for (int i = -4; i <= 4; i++) for (int j = -2; j <= 2; j++) {
        vec2 o = vec2(float(j) * 1.5, float(i)) * blur / uRes;
        float w = 1.0 - abs(float(i)) / 5.0;
        c += texture2D(tDiffuse, vUv + o) * w; tot += w;
      }
      c /= tot;
      if (uAmount > 0.0) { c.rgb = mix(c.rgb, (c.rgb - 0.5) * 1.12 + 0.5, uAmount * 0.6); float l = dot(c.rgb, vec3(0.299,0.587,0.114)); c.rgb = mix(vec3(l), c.rgb, 1.0 + uAmount * 0.25); }
      float vig = smoothstep(0.85, 0.2, length(vUv - 0.5)); c.rgb *= mix(1.0, vig, uVignette);
      if (vUv.y < uLetter || vUv.y > 1.0 - uLetter) c.rgb = vec3(0.0);
      gl_FragColor = c;
    }`,
};

export class SceneRig {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  sun: THREE.DirectionalLight;
  moon: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sky: Sky;
  stars: THREE.Points;
  bloom: UnrealBloomPass;
  tilt: ShaderPass;
  gtao: GTAOPass | null = null;
  bokeh: BokehPass;
  quality: 'baixa' | 'média' | 'alta' = 'média';
  night = 0;
  private fogColor = new THREE.Color();
  clouds: THREE.Group;

  constructor(canvas: HTMLCanvasElement, private mapSize: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.localClippingEnabled = true;
    this.camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 1.5, 14000);
    this.scene.fog = new THREE.FogExp2(0xb8cde0, 0.00028);
    U.uMapSize.value = mapSize;

    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    const su = this.sky.material.uniforms;
    su.turbidity.value = 6; su.rayleigh.value = 1.6; su.mieCoefficient.value = 0.005; su.mieDirectionalG.value = 0.8;
    this.scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -420; sc.right = 420; sc.top = 420; sc.bottom = -420; sc.near = 10; sc.far = 3000;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);
    this.moon = new THREE.DirectionalLight(0x8fa8ff, 0.0);
    this.scene.add(this.moon);
    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6a6048, 1.1);
    this.scene.add(this.hemi);

    // stars
    const sp: number[] = [];
    for (let i = 0; i < 1500; i++) {
      const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 0.95);
      sp.push(Math.sin(ph) * Math.cos(th) * 9000, Math.cos(ph) * 9000, Math.sin(ph) * Math.sin(th) * 9000);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    this.scene.add(this.stars);

    // drifting stylized clouds
    this.clouds = new THREE.Group();
    const cm = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.85, flatShading: true });
    for (let i = 0; i < 26; i++) {
      const c = new THREE.Group();
      for (let k = 0; k < 5; k++) {
        const s = new THREE.Mesh(new THREE.IcosahedronGeometry(30 + Math.random() * 30, 0), cm);
        s.position.set(k * 35 - 70 + Math.random() * 20, Math.random() * 15, Math.random() * 30);
        s.scale.y = 0.55;
        c.add(s);
      }
      c.position.set(Math.random() * mapSize * 1.6 - mapSize * 0.3, 380 + Math.random() * 160, Math.random() * mapSize * 1.6 - mapSize * 0.3);
      this.clouds.add(c);
    }
    this.scene.add(this.clouds);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.5, 0.6, 0.82);
    this.composer.addPass(this.bloom);
    this.bokeh = new BokehPass(this.scene, this.camera, { focus: 300, aperture: 0.00012, maxblur: 0.006 });
    this.bokeh.enabled = false;
    this.composer.addPass(this.bokeh);
    this.composer.addPass(new OutputPass());
    this.tilt = new ShaderPass(TiltShift);
    this.composer.addPass(this.tilt);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setQuality(q: 'baixa' | 'média' | 'alta') {
    this.quality = q;
    this.renderer.shadowMap.enabled = q !== 'baixa';
    this.sun.shadow.mapSize.set(q === 'alta' ? 4096 : 2048, q === 'alta' ? 4096 : 2048);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.renderer.setPixelRatio(q === 'baixa' ? 1 : Math.min(window.devicePixelRatio, q === 'alta' ? 2 : 1.5));
    if (q === 'alta' && !this.gtao) {
      this.gtao = new GTAOPass(this.scene, this.camera, window.innerWidth, window.innerHeight);
      this.gtao.blendIntensity = 0.7;
      this.composer.insertPass(this.gtao, 1);
    }
    if (this.gtao) this.gtao.enabled = q === 'alta';
    this.bloom.enabled = q !== 'baixa';
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    (this.tilt.uniforms.uRes.value as THREE.Vector2).set(w, h);
  }

  /** time of day & weather → lights, sky, fog, window lights */
  updateEnvironment(dayFrac: number, rain: number, fog: number, snow: number, target: THREE.Vector3, dt: number) {
    const ang = (dayFrac - 0.25) * Math.PI * 2; // 0 at 6h
    const elev = Math.sin(ang);
    const az = ang * 0.9 + 0.6;
    const sunDir = new THREE.Vector3(Math.cos(az) * Math.cos(Math.asin(elev)), elev, Math.sin(az) * Math.cos(Math.asin(elev))).normalize();
    U.uSunDir.value.copy(sunDir);
    const day = smoothstep(-0.08, 0.18, elev);
    this.night = 1 - day;
    U.uNight.value = this.night;
    const su = this.sky.material.uniforms;
    su.sunPosition.value.copy(sunDir.clone().multiplyScalar(1000));
    su.rayleigh.value = 1.2 + rain * 2.5;
    su.turbidity.value = 5 + rain * 12 + fog * 6;
    const golden = smoothstep(0.35, 0.0, Math.abs(elev)) * day;
    this.sun.color.setRGB(1, 0.92 - golden * 0.35, 0.82 - golden * 0.55);
    this.sun.intensity = 2.8 * day * (1 - rain * 0.65) * (1 - fog * 0.4);
    this.sun.position.copy(target).addScaledVector(sunDir, 1400);
    this.sun.target.position.copy(target);
    this.sun.shadow.camera.updateProjectionMatrix();
    this.moon.intensity = 0.35 * this.night;
    this.moon.position.copy(target).add(new THREE.Vector3(-400, 900, 300));
    this.moon.target = this.sun.target;
    this.hemi.intensity = 0.25 + 0.95 * day - rain * 0.2;
    this.hemi.color.setRGB(0.75 + 0.1 * day, 0.85, 1).multiplyScalar(0.55 + 0.45 * day);
    U.uSunColor.value.copy(this.sun.color);
    const skyCol = new THREE.Color().setHSL(0.58, 0.55 - rain * 0.4, 0.62 * day + 0.06);
    U.uSkyColor.value.copy(skyCol);
    (this.stars.material as THREE.PointsMaterial).opacity = Math.max(0, this.night - rain) * 0.9;
    this.fogColor.setRGB(0.66 * day + 0.03, 0.74 * day + 0.04, 0.85 * day + 0.08).lerp(new THREE.Color(0.55, 0.57, 0.6).multiplyScalar(0.3 + 0.7 * day), rain * 0.6);
    const f = this.scene.fog as THREE.FogExp2;
    f.color.copy(this.fogColor);
    f.density = 0.00018 + rain * 0.0004 + fog * 0.0011 + snow * 0.0003;
    this.renderer.toneMappingExposure = 0.85 + 0.25 * this.night;
    // window lights by hour
    const h = dayFrac * 24;
    const res = h < 5 ? 0.12 : h < 7 ? 0.35 : h < 17 ? 0.06 : h < 19 ? 0.45 : h < 23 ? 0.72 : 0.3;
    const off = h < 7 ? 0.08 : h < 18 ? 0.55 : h < 21 ? 0.35 : 0.12;
    U.uLitRes.value += (res - U.uLitRes.value) * Math.min(1, dt * 0.8);
    U.uLitOff.value += (off - U.uLitOff.value) * Math.min(1, dt * 0.8);
    this.bloom.strength = 0.25 + 0.7 * this.night;
    this.bloom.threshold = 0.85 - 0.25 * this.night;
    // clouds drift with the wind
    const cm = (this.clouds.children[0]?.children[0] as THREE.Mesh)?.material as THREE.MeshStandardMaterial;
    if (cm) { cm.opacity = 0.6 + rain * 0.35; cm.color.setScalar(0.95 - rain * 0.5).multiplyScalar(0.2 + 0.8 * day); }
    for (const c of this.clouds.children) {
      c.position.x += dt * (6 + U.uWind.value * 10);
      if (c.position.x > this.mapSize * 1.4) c.position.x = -this.mapSize * 0.4;
    }
  }

  render() { this.composer.render(); }
}
