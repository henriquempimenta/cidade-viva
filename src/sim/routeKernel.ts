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
  /** results, or null when the job failed (the caller recomputes inline: same kernel, same answer) */
  take(ticket: number): Int32Array[] | null;
  readonly threads: number;
}

export class InlineBackend implements RouteBackend {
  readonly threads = 0;
  private seq = 0;
  private done = new Map<number, Int32Array[]>();
  submit(graph: RouteGraph, dests: number[]) { const id = ++this.seq; this.done.set(id, runTreeJob({ graph, dests })); return id; }
  ready() { return true; }
  take(ticket: number) { const r = this.done.get(ticket) ?? null; this.done.delete(ticket); return r; }
}

interface PendingPart {
  left: number;
  out: Int32Array[][];
  expected: Map<number, number>;
  slotOf: Map<number, number>;
  nodeCount: number;
}

/** Pool of routing workers; a job is split across all healthy workers and reassembled in order. */
export class WorkerBackend implements RouteBackend {
  private seq = 0;
  private parts = new Map<number, PendingPart>();
  private done = new Map<number, Int32Array[]>();
  private failed = new Set<number>();
  private healthy: boolean[];
  private consecutiveErrors: number[];
  private static readonly MAX_CONSECUTIVE_ERRORS = 3;
  /** jobs that failed on a worker (error, bad message, crashed thread) */
  failures = 0;
  constructor(private workers: Worker[]) {
    this.healthy = workers.map(() => true);
    this.consecutiveErrors = workers.map(() => 0);
    workers.forEach((w, wi) => {
      w.onmessage = (ev: MessageEvent<{ id: number; nexts?: Int32Array[]; error?: string }>) => {
        const data = ev.data;
        if (!data || typeof data.id !== 'number') return;
        const p = this.parts.get(data.id);
        if (!p) return;
        const expectedLen = p.expected.get(wi);
        const slot = p.slotOf.get(wi);
        if (expectedLen === undefined || slot === undefined) return;
        const invalid = !!data.error
          || !Array.isArray(data.nexts)
          || data.nexts.length !== expectedLen
          || data.nexts.some((a) => !(a instanceof Int32Array) || a.length !== p.nodeCount);
        if (invalid) {
          this.consecutiveErrors[wi]++;
          if (this.consecutiveErrors[wi] >= WorkerBackend.MAX_CONSECUTIVE_ERRORS) this.healthy[wi] = false;
          this.fail(data.id);
          return;
        }
        this.consecutiveErrors[wi] = 0;
        p.expected.delete(wi);
        p.out[slot] = data.nexts!;
        if (--p.left === 0) { this.parts.delete(data.id); this.done.set(data.id, p.out.flat()); }
      };
      // a thread that dies is retired and takes its share of every open job with it: fail them all, the sim recomputes inline
      const dead = () => {
        this.healthy[wi] = false;
        for (const [id, p] of [...this.parts.entries()]) {
          if (p.expected.has(wi)) this.fail(id);
        }
      };
      w.onerror = dead;
      w.onmessageerror = dead;
    });
  }
  private fail(id: number) { this.parts.delete(id); this.failed.add(id); this.failures++; }
  get threads() {
    let n = 0;
    for (let i = 0; i < this.healthy.length; i++) if (this.healthy[i]) n++;
    return n;
  }
  submit(graph: RouteGraph, dests: number[]) {
    const id = ++this.seq;
    if (!dests.length) { this.done.set(id, []); return id; }
    const active: number[] = [];
    for (let i = 0; i < this.workers.length; i++) if (this.healthy[i]) active.push(i);
    if (!active.length) { this.failed.add(id); this.failures++; return id; }
    const W = Math.min(active.length, dests.length);
    const per = Math.ceil(dests.length / W);
    const nodeCount = graph.off.length - 1;
    const p: PendingPart = { left: 0, out: [], expected: new Map(), slotOf: new Map(), nodeCount };
    const dispatches: { wi: number; slot: number; chunk: number[] }[] = [];
    for (let k = 0; k < W; k++) {
      const chunk = dests.slice(k * per, (k + 1) * per);
      if (!chunk.length) continue;
      const wi = active[k];
      const slot = dispatches.length;
      p.expected.set(wi, chunk.length);
      p.slotOf.set(wi, slot);
      dispatches.push({ wi, slot, chunk });
    }
    p.left = dispatches.length;
    p.out = new Array<Int32Array[]>(dispatches.length);
    this.parts.set(id, p);
    for (const d of dispatches) {
      try {
        // graph arrays are copied per worker (structured clone); they are small (~100 KB)
        this.workers[d.wi].postMessage({ id, graph, dests: d.chunk });
      } catch {
        this.healthy[d.wi] = false;
        this.fail(id);
        break;
      }
    }
    return id;
  }
  ready(ticket: number) { return this.done.has(ticket) || this.failed.has(ticket); }
  take(ticket: number) {
    if (this.failed.delete(ticket)) return null;
    const r = this.done.get(ticket) ?? null; this.done.delete(ticket); return r;
  }
}
