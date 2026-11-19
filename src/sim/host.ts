import { MOTION_DT } from '../shared/constants';
import type { FromWorker, Snapshot, ToWorker } from '../shared/protocol';
import type { World } from './world';
import { buildStats, inspect, makeSnapshot, applyParams, injectEvent, fieldPayload } from './hostApi';

/** Fixed-tick simulation loop decoupled from rendering. Posts snapshots for interpolation. */
export class SimHost {
  speed = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = 0;
  private debt = 0;
  private lastSnap = 0;
  private lastDiff = 0;
  private lastStats = 0;
  private lastField = 0;
  private overlay: string | null = null;
  private simAccum = 0;
  private realAccum = 0;
  speedActual = 0;
  stalls = 0;
  camera = { x: 0, z: 0, h: 300 };

  constructor(public world: World, private post: (m: FromWorker, t?: Transferable[]) => void) {}

  start() {
    this.last = performance.now();
    const tick = () => {
      this.frame();
      this.timer = setTimeout(tick, 4);
    };
    tick();
  }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  private frame() {
    const now = performance.now();
    const realDt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    this.debt += realDt * this.speed;
    const maxDebt = Math.max(1, this.speed * 0.5);
    if (this.debt > maxDebt) this.debt = maxDebt; // CPU-limited: run slower instead of spiralling
    const t0 = performance.now();
    let simulated = 0;
    while (this.debt >= MOTION_DT && performance.now() - t0 < 12) {
      // routing threads still working on the batch due next step: wait for them (keeps determinism)
      if (!this.world.roads.routingReady()) { this.stalls++; break; }
      this.world.step(MOTION_DT);
      this.debt -= MOTION_DT;
      simulated += MOTION_DT;
    }
    this.simAccum += simulated;
    this.realAccum += realDt;
    if (this.realAccum > 1) { this.speedActual = this.simAccum / this.realAccum; this.simAccum = 0; this.realAccum = 0; }

    if (now - this.lastSnap > 45) {
      this.lastSnap = now;
      const s: Snapshot = makeSnapshot(this.world, this.camera);
      this.post(s, [s.veh.buffer, s.ped.buffer, s.train.buffer, s.signals.buffer, s.crossings.buffer]);
    }
    if (now - this.lastDiff > 120) {
      this.lastDiff = now;
      const d = this.world.collectDiff();
      if (now - this.lastStats > 500) { this.lastStats = now; d.stats = buildStats(this.world, this.speedActual); d.stats.threads = 1 + this.world.roads.backend.threads; d.stats.stalls = this.stalls; }
      if (now - this.lastField > 1500) {
        this.lastField = now;
        const fp = fieldPayload(this.world, this.overlay);
        Object.assign(d, fp);
      }
      this.post(d);
    }
  }

  handle(m: ToWorker) {
    switch (m.type) {
      case 'speed': this.speed = m.speed; this.debt = 0; break;
      case 'params': applyParams(this.world, m.params); break;
      case 'inject': injectEvent(this.world, m.event); break;
      case 'overlay': this.overlay = m.field; this.lastField = 0; break;
      case 'camera': this.camera = { x: m.x, z: m.z, h: m.h }; this.world.cam = this.camera; break;
      case 'inspect': this.post({ type: 'inspect', reqId: m.reqId, data: inspect(this.world, m.kind, m.id) }); break;
      case 'follow': this.world.citizens.followed = m.citizen; break;
    }
  }
}
