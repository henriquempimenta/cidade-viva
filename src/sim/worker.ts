/// <reference lib="webworker" />
import { MOTION_DT } from '../shared/constants';
import type { FromWorker, ToWorker } from '../shared/protocol';
import { World } from './world';
import { SimHost } from './host';
import { WorkerBackend } from './routeKernel';

declare const self: DedicatedWorkerGlobalScope;

let host: SimHost | null = null;
let pool: WorkerBackend | null = null;

/** routing thread pool shared by successive worlds (one per spare core, up to 4) */
function routePool(): WorkerBackend | null {
  if (pool) return pool;
  try {
    if (typeof Worker === 'undefined') return null;
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
    const ws: Worker[] = [];
    for (let i = 0; i < n; i++) ws.push(new Worker(new URL('./routeWorker.ts', import.meta.url), { type: 'module' }));
    pool = new WorkerBackend(ws);
  } catch { pool = null; }
  return pool;
}

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  if (m.type === 'init') {
    host?.stop();
    const world = new World(m.params);
    const warm = (m as { warmup?: number }).warmup ?? 0;
    for (let d = 0; d < warm; d++) for (let k = 0; k < 4800; k++) world.step(MOTION_DT);
    // warm-up ran inline; from here on routing refreshes go to the thread pool
    const backend = routePool();
    if (backend) world.roads.backend = backend;
    host = new SimHost(world, post);
    post({ type: 'init', world: world.initMessage() }, []);
    host.start();
    return;
  }
  host?.handle(m);
};

export { MOTION_DT };
