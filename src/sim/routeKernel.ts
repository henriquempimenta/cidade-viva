import { MinHeap } from './heap';

/**
 * Compact, transferable road graph for shortest-path trees (CSR, reverse adjacency).
 * For node u, entries off[u]..off[u+1] list the directed edges that ENTER u:
 * nbr = the node they come from, de = directed edge id (edge*2+dir), cost = seconds.
 * Pure data: the same arrays are used on the sim thread and on routing workers.
 */
export interface RouteGraph { N: number; off: Int32Array; nbr: Int32Array; de: Int32Array; cost: Float32Array; ver: number; t: number }

/** reverse Dijkstra towards `dest`: next[u] = directed edge to take from u (or -1) */
export function dijkstraTree(g: RouteGraph, dest: number, next: Int32Array, dist: Float64Array, heap: MinHeap) {
  const N = g.N, off = g.off, nbr = g.nbr, de = g.de, cost = g.cost;
  dist.fill(Infinity, 0, N); next.fill(-1, 0, N);
  dist[dest] = 0;
  heap.clear();
  heap.push(dest, 0);
  while (heap.size) {
    const pri = heap.peekPri();
    const u = heap.pop();
    if (pri > dist[u]) continue;
    for (let k = off[u], e = off[u + 1]; k < e; k++) {
      const w = nbr[k];
      const c = pri + cost[k];
      if (c < dist[w]) { dist[w] = c; next[w] = de[k]; heap.push(w, c); }
    }
  }
}

export interface TreeJob { id: number; graph: RouteGraph; dests: number[] }
export interface TreeResult { id: number; dests: number[]; nexts: Int32Array[] }

export function runTreeJob(job: { graph: RouteGraph; dests: number[] }): Int32Array[] {
  const g = job.graph;
  const dist = new Float64Array(g.N), heap = new MinHeap();
  return job.dests.map((d) => { const n = new Int32Array(g.N); dijkstraTree(g, d, n, dist, heap); return n; });
}

/**
 * Where trees are computed. The simulation always installs results at a fixed future
 * step, so whether a backend runs inline or on N worker threads the city is identical.
 */
export interface RouteBackend {
  submit(graph: RouteGraph, dests: number[]): number;
  ready(ticket: number): boolean;
  take(ticket: number): Int32Array[];
  readonly threads: number;
}

export class InlineBackend implements RouteBackend {
  readonly threads = 0;
  private seq = 0;
  private done = new Map<number, Int32Array[]>();
  submit(graph: RouteGraph, dests: number[]) { const id = ++this.seq; this.done.set(id, runTreeJob({ graph, dests })); return id; }
  ready() { return true; }
  take(ticket: number) { const r = this.done.get(ticket)!; this.done.delete(ticket); return r; }
}

/** Pool of routing workers; a job is split across all of them and reassembled in order. */
export class WorkerBackend implements RouteBackend {
  private seq = 0;
  private parts = new Map<number, { left: number; out: Int32Array[][] }>();
  private done = new Map<number, Int32Array[]>();
  constructor(private workers: Worker[]) {
    workers.forEach((w, wi) => {
      w.onmessage = (ev: MessageEvent<{ id: number; nexts: Int32Array[] }>) => {
        const p = this.parts.get(ev.data.id);
        if (!p) return;
        p.out[wi] = ev.data.nexts;
        if (--p.left === 0) { this.parts.delete(ev.data.id); this.done.set(ev.data.id, p.out.flat()); }
      };
    });
  }
  get threads() { return this.workers.length; }
  submit(graph: RouteGraph, dests: number[]) {
    const id = ++this.seq;
    const W = Math.min(this.workers.length, dests.length);
    const per = Math.ceil(dests.length / W);
    const p = { left: W, out: new Array<Int32Array[]>(W) };
    this.parts.set(id, p);
    for (let k = 0; k < W; k++) {
      const chunk = dests.slice(k * per, (k + 1) * per);
      // graph arrays are copied per worker (structured clone); they are small (~100 KB)
      this.workers[k].postMessage({ id, graph, dests: chunk });
    }
    return id;
  }
  ready(ticket: number) { return this.done.has(ticket); }
  take(ticket: number) { const r = this.done.get(ticket)!; this.done.delete(ticket); return r; }
}
