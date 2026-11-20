/// <reference lib="webworker" />
import { runTreeJob, type RouteGraph } from './routeKernel';

declare const self: DedicatedWorkerGlobalScope;

/** Routing thread: builds shortest-path trees for a batch of destinations. */
self.onmessage = (ev: MessageEvent<{ id: number; graph: RouteGraph; dests: number[] }>) => {
  try {
    const nexts = runTreeJob(ev.data);
    self.postMessage({ id: ev.data.id, nexts }, nexts.map((n) => n.buffer));
  } catch (err) {
    self.postMessage({ id: ev.data.id, error: String(err) });
  }
};
