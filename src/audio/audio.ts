import type * as THREE from 'three';
import type { SimEvent } from '../shared/protocol';

export class AudioEngine {
  onEvent(_e: SimEvent) {}
  toggle(): boolean { return false; }
  update(_p: THREE.Vector3, _app: unknown) {}
}
