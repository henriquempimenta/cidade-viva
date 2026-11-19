import * as THREE from 'three';
import type { App } from '../app';
import type { TransitLineView } from '../shared/protocol';

export class Overlays {
  group = new THREE.Group();
  constructor(private app: App) {}
  upsertLine(_l: TransitLineView) {}
  removeLine(_id: number) {}
  setField(_n: string, _d: Float32Array, _m: number) {}
  toggleMenu() {}
  toggleMetro() {}
  showOD(_p: { ox: number; oz: number; dx: number; dz: number }[]) {}
  clearOD() {}
  update(_dt: number) { void this.app; }
}
