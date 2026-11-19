import * as THREE from 'three';
import type { App } from '../app';
import type { PowerLineView, SimEvent } from '../shared/protocol';

export class Effects {
  group = new THREE.Group();
  constructor(private app: App) {}
  upsertPowerLine(_p: PowerLineView) {}
  setFlood(_l: number) {}
  setDikes(_d: number[][]) {}
  onEvent(_e: SimEvent) {}
  update(_dt: number, _simDt: number) { void this.app; }
}
