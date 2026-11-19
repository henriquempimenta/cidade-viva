import * as THREE from 'three';
import { U } from './uniforms';

export function makeWater(size: number, sea: number): THREE.Mesh {
  const ext = 6000;
  const geo = new THREE.PlaneGeometry(size + ext * 2, size + ext * 2, 1, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(size / 2, sea, size / 2);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: U.uTime, uSunDir: U.uSunDir, uSkyColor: U.uSkyColor, uSunColor: U.uSunColor, uHeight: U.uHeight,
      uMapSize: U.uMapSize, uNight: U.uNight, uRain: U.uRain, uWaterPol: U.uWaterPol, uFlood: U.uFlood,
    }]),
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      varying vec3 vW;
      void main(){
        vec4 wp = modelMatrix * vec4(position,1.0);
        vW = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <fog_pars_fragment>
      uniform float uTime; uniform vec3 uSunDir; uniform vec3 uSkyColor; uniform vec3 uSunColor;
      uniform sampler2D uHeight; uniform sampler2D uWaterPol; uniform float uMapSize; uniform float uNight; uniform float uRain;
      varying vec3 vW;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
      void main(){
        vec2 uv = vW.xz / uMapSize;
        float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
        float h = inside > 0.5 ? texture2D(uHeight, uv).r : -12.0;
        float depth = clamp(-h, 0.0, 14.0);
        if (inside > 0.5 && h > 0.6) discard;
        vec2 p = vW.xz * 0.06;
        float t = uTime * 0.6;
        float n1 = noise(p + vec2(t * 0.4, t * 0.25));
        float n2 = noise(p * 2.3 - vec2(t * 0.3, -t * 0.5));
        float n3 = noise(p * 6.0 + vec2(t, t * 0.7));
        vec3 nrm = normalize(vec3((n1 - 0.5) * 0.5 + (n2 - 0.5) * 0.3 + (n3 - 0.5) * 0.15 * (1.0 + uRain * 2.0), 1.0, (n2 - 0.5) * 0.5 + (n3 - n1) * 0.2));
        vec3 V = normalize(cameraPosition - vW);
        float fres = pow(1.0 - max(dot(nrm, V), 0.0), 3.0);
        vec3 shallow = vec3(0.22, 0.62, 0.62), deep = vec3(0.04, 0.2, 0.33);
        vec3 base = mix(shallow, deep, smoothstep(0.0, 9.0, depth));
        float pol = inside > 0.5 ? texture2D(uWaterPol, uv).r : 0.0;
        base = mix(base, vec3(0.32, 0.33, 0.18), clamp(pol * 0.6, 0.0, 0.75));
        vec3 sky = mix(uSkyColor, vec3(0.02, 0.03, 0.08), uNight * 0.7);
        vec3 col = mix(base * (0.35 + 0.65 * (1.0 - uNight * 0.85)), sky, fres * 0.75);
        vec3 R = reflect(-V, nrm);
        float spec = pow(max(dot(R, normalize(uSunDir)), 0.0), 180.0) * (1.0 - uNight);
        col += uSunColor * spec * 2.5;
        float foam = smoothstep(1.2, 0.0, depth) * (0.5 + 0.5 * sin(uTime * 1.5 + n1 * 6.0 + vW.x * 0.05)) * inside;
        col = mix(col, vec3(0.92) * (1.0 - uNight * 0.8), foam * 0.55 * (1.0 - uNight * 0.6));
        float alpha = mix(0.55, 0.93, smoothstep(0.0, 3.0, depth));
        gl_FragColor = vec4(col, alpha);
        #include <fog_fragment>
      }`,
  });
  // UniformsUtils.merge clones values: re-link the shared uniforms so they stay live
  Object.assign(mat.uniforms, { uTime: U.uTime, uSunDir: U.uSunDir, uSkyColor: U.uSkyColor, uSunColor: U.uSunColor, uHeight: U.uHeight, uMapSize: U.uMapSize, uNight: U.uNight, uRain: U.uRain, uWaterPol: U.uWaterPol, uFlood: U.uFlood });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 2;
  m.name = 'water';
  return m;
}
