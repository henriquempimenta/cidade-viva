import type { SimEvent } from '../shared/protocol';

/** Every system publishes what it does here; the camera director and the chronicle subscribe. */
export class EventBus {
  private nextId = 1;
  pending: SimEvent[] = [];
  chronicle: SimEvent[] = [];
  counts = new Map<string, number>();
  /** optional tap (tests, tools) */
  onEmit: ((e: SimEvent) => void) | null = null;
  constructor(private clock: () => { t: number; day: number }) {}

  emit(type: string, x: number, z: number, mag: number, text: string, extra: Partial<SimEvent> = {}): SimEvent {
    const c = this.clock();
    const ev: SimEvent = { id: this.nextId++, type, t: c.t, day: c.day, x, z, mag, text, ...extra };
    this.pending.push(ev);
    this.onEmit?.(ev);
    this.counts.set(type, (this.counts.get(type) ?? 0) + 1);
    if (ev.headline) {
      this.chronicle.push(ev);
      if (this.chronicle.length > 400) this.chronicle.shift();
    }
    if (this.pending.length > 300) this.pending.splice(0, this.pending.length - 300);
    return ev;
  }

  drain(): SimEvent[] {
    const p = this.pending;
    this.pending = [];
    return p;
  }
}
