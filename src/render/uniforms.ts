import * as THREE from 'three';

/** Uniforms shared by every procedural shader (time of day, weather, blackouts...). */
export const U = {
  uTime: { value: 0 },
  uNight: { value: 0 }, // 0 day .. 1 full night
  uLitRes: { value: 0 },
  uLitOff: { value: 0 },
  uLitBoost: { value: 0 },
  uWind: { value: 0.6 },
  uRain: { value: 0 },
  uSnow: { value: 0 },
  uMapSize: { value: 2400 },
  uOutage: { value: null as THREE.Texture | null },
  uOverlay: { value: null as THREE.Texture | null },
  uOverlayOn: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0.3, 1, 0.2).normalize() },
  uSkyColor: { value: new THREE.Color(0x9ec9ff) },
  uSunColor: { value: new THREE.Color(0xffffff) },
  uWaterPol: { value: null as THREE.Texture | null },
  uHeight: { value: null as THREE.Texture | null },
  uFlood: { value: 0 },
};

export function makeOutageTexture(G: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(G * G * 4), G, G, THREE.RGBAFormat);
  t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}
