/** Binary min-heap of (key, value) with numeric priority. */
export class MinHeap {
  private k: number[] = [];
  private p: number[] = [];
  get size() { return this.k.length; }
  clear() { this.k.length = 0; this.p.length = 0; }
  push(key: number, pri: number) {
    const k = this.k, p = this.p;
    let i = k.length;
    k.push(key); p.push(pri);
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (p[par] <= pri) break;
      k[i] = k[par]; p[i] = p[par];
      i = par;
    }
    k[i] = key; p[i] = pri;
  }
  peekPri() { return this.p[0]; }
  pop(): number {
    const k = this.k, p = this.p;
    const top = k[0];
    const lk = k.pop()!, lp = p.pop()!;
    const n = k.length;
    if (n > 0) {
      let i = 0;
      while (true) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && p[c + 1] < p[c]) c++;
        if (p[c] >= lp) break;
        k[i] = k[c]; p[i] = p[c];
        i = c;
      }
      k[i] = lk; p[i] = lp;
    }
    return top;
  }
}
