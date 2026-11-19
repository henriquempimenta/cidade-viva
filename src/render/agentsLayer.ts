import * as THREE from 'three';
import type { App } from '../app';

/** Vehicles, pedestrians and trains (stage 2+). */
export class AgentsLayer {
  group = new THREE.Group();
  constructor(private app: App) {}
  update(_dt: number, _alpha: number) {}
  vehiclePos(_slot: number, _gen: number): { p: THREE.Vector3; h: number } | null { return null; }
  pedPos(_slot: number, _gen: number): { p: THREE.Vector3; h: number } | null { return null; }
  trainPos(_i: number): { p: THREE.Vector3; h: number } | null { return null; }
  pickAgent(_r: THREE.Raycaster): { kind: 'ped' | 'vehicle'; slot: number; gen: number; citizen: number } | null { return null; }
  citizenPos(_id: number): { p: THREE.Vector3; h: number; inside: boolean } | null { void this.app; return null; }
}
