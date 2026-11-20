import { RoadClass } from '../shared/constants';
import { angDiff, DECK_CLEAR, projSeg, segInt, type REdge, type RNode } from './roads';
import type { World } from './world';

/** ramp length of an urban viaduct / tunnel (≈6% average grade for 7.5 m) */
export const DECK_RAMP = 125;

type P2 = { x: number; z: number };
export interface BypassPlan {
  /** where the structure leaves and rejoins the street: an existing node, or a point to split an edge at */
  ends: [End, End];
  /** obstacle(s) passed: for the chronicle */
  over: string;
  len: number;
  /** intermediate joints (positions of the street nodes passed over) */
  joints: P2[];
  passed: number[];
  /** street nodes along the corridor between the two ends, in order (to find the street under the structure) */
  seq: number[];
  /** the street is a wide avenue all along: room for a central trench with surface lanes on both sides */
  wide: boolean;
  cls: RoadClass;
  lanes: number;
  name: string;
  /** mean land value / residential density along the corridor (NIMBY against an elevated deck) */
  value: number;
}
type End = { node: number } | { x: number; z: number };
type Side = { pts: P2[]; end: End; through: number[]; edges: REdge[] };

/**
 * Grade-separated structures as an emergent property of the network.
 *
 * Nothing here is drawn on a whim: a structure is a real edge of the road graph that leaves the street
 * before an obstacle (a junction that stays jammed, the gates of a level crossing) and rejoins it after.
 * Routing decides by itself whether it is worth taking — through traffic does, turning traffic stays below.
 * Rich or dense corridors refuse an elevated deck (shade, noise, falling land values — the "Minhocão"
 * effect also emerges, via the fields) and get a tunnel if the treasury can pay for it.
 * Hills that force long detours between two neighbourhoods get a bored tunnel.
 */
export class Structures {
  /** nodes already passed over/under by a structure (no second one on top) */
  flown = new Set<number>();
  /** structures under construction and the street segments they will replace */
  private swaps: { deck: number[]; pairs: [number, number][]; passed: number[]; name: string; kind: 'fly' | 'tunnel'; over: string; wait?: number }[] = [];
  /** why the last plan failed (shown in the junction decision) */
  why = '';
  private lastHill = -10;
  constructor(private w: World) {}

  // ------------------------------------------------------------------ planning a bypass
  /**
   * Walk from `start` along `edge` and its smooth continuation until `need` metres are covered (or until
   * `need` returns more, so one structure can span several jammed junctions in a row).
   * Returns the polyline and the end (existing node or split point).
   */
  private walk(start: number, edge: REdge, need: (acc: number, node: RNode) => number, px?: number, pz?: number): { pts: P2[]; end: End; through: number[]; edges: REdge[] } | null {
    const R = this.w.roads;
    let cur = start, e = edge, acc = 0;
    const pts: P2[] = [];
    const through: number[] = [];
    const edges: REdge[] = [];
    let fx = px ?? R.nodes[start].x, fz = pz ?? R.nodes[start].z;
    let goal = need(0, R.nodes[start]);
    for (let k = 0; k < 14; k++) {
      if (!e.alive || e.progress < 1 || e.bridge || e.deck !== undefined || e.upgrading) return null;
      const other = e.a === cur ? e.b : e.a;
      const on = R.nodes[other];
      const segLen = Math.hypot(on.x - fx, on.z - fz);
      edges.push(e);
      if (acc + segLen >= goal) {
        const rem = goal - acc;
        if (segLen - rem < 22) { pts.push({ x: on.x, z: on.z }); return { pts, end: { node: other }, through, edges }; }
        const x = fx + (on.x - fx) * (rem / segLen), z = fz + (on.z - fz) * (rem / segLen);
        pts.push({ x, z });
        return { pts, end: { x, z }, through, edges };
      }
      acc += segLen; pts.push({ x: on.x, z: on.z }); through.push(other);
      goal = Math.max(goal, need(acc, on));
      // continue on the smoothest continuation (curved highways are fine, sharp turns are not)
      const dirA = Math.atan2(on.z - fz, on.x - fx);
      let next: REdge | null = null, bd = 0.45;
      for (const id of on.edges) {
        if (id === e.id) continue;
        const q = R.edges[id];
        if (!q.alive || q.deck !== undefined) continue;
        const d = angDiff(R.angleOf(q, other), dirA);
        if (d < bd) { bd = d; next = q; }
      }
      if (!next) return null;
      fx = on.x; fz = on.z; cur = other; e = next;
    }
    return null;
  }

  private pos(e: End): P2 { return 'node' in e ? this.w.roads.nodes[e.node] : e; }

  private corridorValue(pts: P2[]): number {
    const F = this.w.fields;
    let v = 0;
    for (const p of pts) v += F.sample('landValue', p.x, p.z) * 0.6 + Math.min(1, F.sample('resDensity', p.x, p.z)) * 0.6;
    return v / Math.max(1, pts.length);
  }

  /** extend the structure over further jammed junctions met within reach */
  private jamNeed(base: number) {
    return (acc: number, n: RNode) => {
      if (acc === 0) return base;
      const jammed = n.edges.length >= 3 && n.delay > 18 && !n.deck;
      return jammed && acc < 520 ? acc + base : 0;
    };
  }

  /** bypass of a junction along the axis e1–n–e2 */
  planJunction(n: RNode, e1: REdge, e2: REdge): BypassPlan | null {
    if (this.flown.has(n.id)) { this.why = 'já há estrutura aqui'; return null; }
    const base = DECK_RAMP + n.radius + 14;
    // try to span the neighbouring jammed junctions too; fall back to this junction alone
    const s1 = this.walk(n.id, e1, this.jamNeed(base)) ?? this.walk(n.id, e1, () => base);
    const s2 = this.walk(n.id, e2, this.jamNeed(base)) ?? this.walk(n.id, e2, () => base);
    if (!s1 || !s2) { this.why = 'sem trecho contínuo para as rampas'; return null; }
    const extra = s1.through.length + s2.through.length;
    const over = extra ? `${extra + 1} cruzamentos da ${e1.name}` : `o cruzamento da ${e1.name} com ${this.crossName(n, e1, e2)}`;
    return this.finish(s1, s2, [n.id], { x: n.x, z: n.z }, over, Math.max(e1.cls, e2.cls), Math.min(e1.lanes, e2.lanes), e1.name);
  }

  /** bypass of a level crossing on edge e at parameter t (from e.a) */
  planOverRail(e: REdge, t: number): BypassPlan | null {
    const R = this.w.roads;
    const a = R.nodes[e.a], b = R.nodes[e.b];
    const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    const need = () => DECK_RAMP + 18;
    const s1 = this.walk(e.b, e, need, x, z), s2 = this.walk(e.a, e, need, x, z);
    if (!s1 || !s2) return null;
    return this.finish(s1, s2, [], { x, z }, 'a ferrovia', e.cls, e.lanes, e.name);
  }

  private crossName(n: RNode, e1: REdge, e2: REdge) {
    const R = this.w.roads;
    const o = n.edges.map((id) => R.edges[id]).find((q) => q.id !== e1.id && q.id !== e2.id && q.name !== e1.name);
    return o?.name ?? 'a transversal';
  }

  private finish(s1: Side, s2: Side, passed: number[], mid: P2, over: string, cls: RoadClass, lanes: number, street: string): BypassPlan | null {
    // path from end 1 through the obstacle to end 2
    const path: P2[] = [...s1.pts].reverse();
    path.push(mid, ...s2.pts);
    let len = 0;
    for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    if (len < DECK_RAMP * 2 + 10 || len > 1600) { this.why = `extensão inviável (${Math.round(len)} m)`; return null; }
    const all = [...passed, ...s1.through, ...s2.through];
    for (const nid of all) if (this.flown.has(nid)) { this.why = 'encontraria outra estrutura'; return null; }
    const R = this.w.roads;
    // must not hit another structure, nor a track that is already raised there
    for (let i = 1; i < path.length; i++) {
      const A = path[i - 1], B = path[i];
      for (const q of R.edgesNear((A.x + B.x) / 2, (A.z + B.z) / 2, Math.hypot(B.x - A.x, B.z - A.z) / 2 + 10)) {
        if (q.deck === undefined || !q.alive) continue;
        const qa = R.nodes[q.a], qb = R.nodes[q.b];
        if (segInt(A.x, A.z, B.x, B.z, qa.x, qa.z, qb.x, qb.z)) { this.why = 'cruzaria outra estrutura'; return null; }
      }
      for (const l of this.w.rail2?.lines ?? []) for (let k = 0; k < l.x.length - 1; k++) {
        const h = segInt(A.x, A.z, B.x, B.z, l.x[k], l.z[k], l.x[k + 1], l.z[k + 1]);
        if (h && (l.elevated || l.y[k] - Math.max(0, this.w.terrain.heightAt(h.x, h.z)) > 1.5)) { this.why = 'ferrovia elevada no caminho'; return null; }
      }
    }
    // every street node passed (and the obstacle itself) becomes a joint of the structure, at the same place
    const seq = [...s1.through].reverse().concat(passed, s2.through);
    const wide = [...s1.edges, ...s2.edges].every((q) => q.cls >= RoadClass.Avenue && q.lanes >= 2 && !q.oneway);
    return { ends: [s1.end, s2.end], joints: path.slice(1, -1), seq, wide, over, len, cls: Math.max(cls, RoadClass.Collector), lanes: Math.max(1, Math.min(3, lanes)), name: street.replace(/^(Rua|Avenida|Alameda|Travessa|Estrada|Rodovia) /, ''), value: this.corridorValue(path), passed: all };
  }

  /**
   * Cost per metre, calibrated against the rest of the city: adding a surface lane costs ~4.5/m and an
   * ordinary bridge ~20–25/m. A viaduct is roughly two bridges per metre (~10× a surface lane), a
   * cut-and-cover tunnel three times a viaduct, a bored tunnel through rock more still — which is why
   * cities build them rarely, only where congestion or geography leave no cheaper way out.
   */
  static PER_M = { fly: 45, tunnel: 130, bore: 160 };
  cost(p: BypassPlan, kind: 'fly' | 'tunnel') { return Math.round(p.len * Structures.PER_M[kind] * (p.lanes >= 2 ? 1.4 : 1)); }
  /** daily upkeep factor relative to a street of the same length (inspections, lighting, ventilation, pumps) */
  static UPKEEP = { fly: 6, tunnel: 15 };
  /** what the neighbourhood will accept: high land value or dense housing refuses a deck; a central trench
   */
  prefers(p: BypassPlan): 'fly' | 'tunnel' {
    const w = this.w;
    const rich = p.value > 0.62;
    const affordable = w.era >= 2 && w.budget.money > this.cost(p, 'tunnel') * 1.4;
    return rich && affordable ? 'tunnel' : 'fly';
  }
  /** one big structure at a time: they take a long time and tie up the city's engineering */
  busy(): boolean { return this.w.roads.edges.some((e) => e.alive && e.deck !== undefined && e.progress < 1); }

  // ------------------------------------------------------------------ building
  build(p: BypassPlan, kind: 'fly' | 'tunnel', motive: string): REdge | null {
    const w = this.w, R = w.roads;
    // validate both endpoints before mutating the graph with any edge split
    const canResolve = (e: End): boolean => {
      if ('node' in e) return !!R.nodes[e.node]?.alive;
      return !!R.nearestEdgePoint(e.x, e.z, 2);
    };
    if (!canResolve(p.ends[0]) || !canResolve(p.ends[1])) return null;
    if ('node' in p.ends[0] && 'node' in p.ends[1] && p.ends[0].node === p.ends[1].node) return null;
    const p0 = this.pos(p.ends[0]), p1 = this.pos(p.ends[1]);
    if (Math.hypot(p1.x - p0.x, p1.z - p0.z) < 20) return null;
    const node = (e: End): number => {
      if ('node' in e) return e.node;
      const pe = R.nearestEdgePoint(e.x, e.z, 2);
      if (!pe) return -1;
      return R.splitEdge(pe.edge.id, pe.t).id;
    };
    const a = node(p.ends[0]);
    const b = node(p.ends[1]);
    if (a < 0 || b < 0 || a === b) return null;
    let name = kind === 'fly' ? `Elevado ${p.name}` : `Túnel ${p.name}`;
    if (R.edges.some((q) => q.alive && q.name === name)) name += ` (${w.districtName((R.nodes[a].x + R.nodes[b].x) / 2, (R.nodes[a].z + R.nodes[b].z) / 2)})`;
    // one piece per stretch between joints; joints are deck nodes (not connected to the streets below)
    const ids = [a];
    for (const j of p.joints) { const n = R.addNode(j.x, j.z); n.deck = true; ids.push(n.id); }
    ids.push(b);
    let tot = 0;
    const seg: number[] = [];
    for (let i = 1; i < ids.length; i++) { const A = R.nodes[ids[i - 1]], B = R.nodes[ids[i]]; seg.push(Math.hypot(B.x - A.x, B.z - A.z)); tot += seg[i - 1]; }
    // joints carry the deck height (vehicles crossing a joint use the node height)
    let s0 = 0;
    for (let i = 1; i < ids.length - 1; i++) {
      s0 += seg[i - 1];
      const n = R.nodes[ids[i]];
      const f0 = Math.min(1, Math.min(s0, tot - s0) / DECK_RAMP), f = f0 * f0 * (3 - 2 * f0);
      const ground = Math.max(w.terrain.heightAt(n.x, n.z), 0.3) + 0.12;
      n.y = kind === 'fly' ? ground + 0.06 + DECK_CLEAR * f : ground - 8 * f;
    }
    let first: REdge | null = null;
    const pieces: number[] = [];
    s0 = 0;
    for (let i = 1; i < ids.length; i++) {
      const e = R.addEdge(ids[i - 1], ids[i], p.cls, { progress: 0, elevated: kind === 'fly', tunnel: kind === 'tunnel', deck: DECK_RAMP, deckS0: s0, deckTot: tot, lanes: p.lanes, name, day: w.day });
      s0 += seg[i - 1];
      first ??= e;
      pieces.push(e.id);
      w.onRoadStarted(e, motive);
    }
    for (const nid of p.passed) this.flown.add(nid);
    // the street between the ramps stays open during the works (locked: nothing attaches to it);
    // when the structure opens, that street segment is removed: the road itself now runs over/under
    const street = [a, ...p.seq, b];
    const pairs: [number, number][] = [];
    for (let i = 1; i < street.length; i++) {
      const q = R.edgeBetween(street[i - 1], street[i]);
      if (q && q.deck === undefined) { q.locked = true; pairs.push([street[i - 1], street[i]]); }
    }
    this.swaps.push({ deck: pieces, pairs, passed: p.passed.slice(), name, kind, over: p.over });
    const A = R.nodes[a], B = R.nodes[b];
    w.events.emit('road_upgrade', (A.x + B.x) / 2, (A.z + B.z) / 2, 0.85,
      kind === 'fly' ? `Começa o ${name} sobre ${p.over} (${Math.round(tot)} m) — ${motive}` : `Começa o ${name} sob ${p.over}: a vizinhança recusou um elevado — ${motive}`,
      { entity: { kind: 'edge', id: first!.id }, ref: first!.id, visual: 0.95, headline: kind === 'fly' ? `${name} vai passar por cima de ${p.over}` : `Moradores barram elevado; ${p.over} ganhará um túnel` });
    return first;
  }

  /** hourly: a finished structure takes over — the old street segment between its ramps disappears */
  hourly() {
    const w = this.w, R = w.roads;
    this.swaps = this.swaps.filter((sw) => {
      if (sw.deck.some((id) => R.edges[id].progress < 1)) return true;
      if (sw.deck.some((id) => !R.edges[id].alive)) { for (const [x, y] of sw.pairs) { const q = R.edgeBetween(x, y); if (q) q.locked = false; } return false; }
      // the swap waits (up to half a day) for the street to empty, so nobody vanishes with the asphalt
      const T = w.traffic;
      const ids = new Set(sw.pairs.map(([x, y]) => R.edgeBetween(x, y)?.id ?? -1));
      sw.wait = (sw.wait ?? 0) + 1;
      if (sw.wait < 12) { for (let i = 0; i < T.max; i++) if (T.active[i] && ids.has(T.edge[i])) return true; }
      for (const [x, y] of sw.pairs) { const q = R.edgeBetween(x, y); if (q) R.removeEdge(q.id); }
      for (const nid of sw.passed) {
        const n = R.nodes[nid];
        // the cross street now passes under (or over) without meeting the road: no junction, no signal
        n.control = 0; n.phases = []; n.interchange = false;
        if (!n.edges.length) n.alive = false;
        R.updateNodeGeom(n);
      }
      R.topoVer++; // signal lists and routing refresh
      w.replanAfterTopology();
      const e = R.edges[sw.deck[0]], A = R.nodes[e.a];
      w.events.emit('road_upgrade', A.x, A.z, 0.7, sw.kind === 'fly' ? `${sw.name} entra em operação: o trecho no chão foi desativado e a via agora passa por cima de ${sw.over}` : `${sw.name} entra em operação: a via agora passa por baixo de ${sw.over}`, { entity: { kind: 'edge', id: e.id }, ref: e.id, visual: 0.6 });
      return false;
    });
  }

  /**
   * Injected event: a state/federal grant pays for one structure at the city's worst bottleneck (that is how
   * most of them get built in real life). The city still chooses where and which kind; it just doesn't pay.
   */
  grant() {
    const w = this.w, R = w.roads;
    if (this.busy()) { w.events.emit('road_upgrade', w.center.x, w.center.z, 0.4, 'Verba federal adiada: já há uma grande obra viária em andamento', {}); return; }
    const up = w.upgrades as unknown as { axis(n: RNode): [REdge, REdge] | null };
    const nodes = R.nodes.filter((n) => n.alive && !n.deck && n.edges.length >= 3 && !this.flown.has(n.id)).sort((a, b) => b.delay - a.delay);
    for (const n of nodes.slice(0, 30)) {
      const axis = up.axis(n);
      const plan = axis && this.planJunction(n, axis[0], axis[1]);
      if (!plan) continue;
      const kind = plan.value > 0.62 && w.era >= 2 ? 'tunnel' : 'fly';
      const cost = this.cost(plan, kind);
      const e = this.build(plan, kind, `verba federal de $${cost.toLocaleString('pt-BR')} para o pior gargalo (espera de ${n.delay.toFixed(0)} s)`);
      if (e) { w.events.emit('road_upgrade', n.x, n.z, 1, `Governo federal libera $${cost.toLocaleString('pt-BR')} para obra viária na cidade`, { headline: 'Verba federal vai financiar grande obra viária', visual: 0.6 }); return; }
    }
    w.events.emit('road_upgrade', w.center.x, w.center.z, 0.4, 'Verba federal devolvida: não há eixo largo e contínuo onde caiba um elevado ou túnel', {});
  }

  // ------------------------------------------------------------------ tunnels through hills
  /**
   * Every few days: look for two neighbourhoods separated by a hill whose streets make a long detour
   * around it. A straight bore is proposed when the detour is long, the hill is real and the treasury allows.
   */
  hillTunnel(): void {
    const w = this.w, R = w.roads;
    if (w.era < 2 || w.day - this.lastHill < 4 || w.budget.money < 40000 || this.busy()) return;
    this.lastHill = w.day;
    const nodes = R.nodes.filter((n) => n.alive && n.edges.some((id) => { const e = R.edges[id]; return e.alive && e.progress >= 1 && e.deck === undefined && e.cls >= RoadClass.Local && e.cls < RoadClass.Highway; }));
    if (nodes.length < 20) return;
    let best: { a: RNode; b: RNode; gain: number; len: number } | null = null;
    for (let k = 0; k < 40; k++) {
      const a = nodes[Math.floor(w.rng.next() * nodes.length)];
      const near = R.nodesNear(a.x, a.z, 650).filter((q) => q.alive && q.edges.length > 0 && q.edges.length < 4);
      if (!near.length) continue;
      const b = near[Math.floor(w.rng.next() * near.length)];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 220 || a.edges.length >= 4 || R.edgeBetween(a.id, b.id)) continue;
      const g = this.boreOk(a, b, len);
      if (!g) continue;
      const route = R.route(a.id, b.id);
      let net = Infinity;
      if (route) { net = 0; for (const de of route) net += R.edges[de >> 1].len; }
      if (net < len * 2.2) continue;
      // people who would use it: housing and jobs at both ends
      const users = w.fields.sum('resDensity', a.x, a.z, 300) + w.fields.sum('resDensity', b.x, b.z, 300) + 0.5 * (w.fields.sum('jobDensity', a.x, a.z, 300) + w.fields.sum('jobDensity', b.x, b.z, 300));
      const gain = (Math.min(net, len * 6) - len) * users;
      if (users > 15 && (!best || gain > best.gain)) best = { a, b, gain, len };
    }
    if (!best) return;
    const cost = Math.round(best.len * Structures.PER_M.bore);
    if (w.budget.money < cost * 1.3) return;
    const name = `Túnel do Morro (${w.districtName((best.a.x + best.b.x) / 2, (best.a.z + best.b.z) / 2)})`;
    const e = R.addEdge(best.a.id, best.b.id, RoadClass.Collector, { progress: 0, tunnel: true, deck: -1, lanes: 1, name, day: w.day });
    w.budget.money -= cost;
    w.clearTreesAlong([{ x: best.a.x, z: best.a.z }, { x: best.b.x, z: best.b.z }], 10);
    w.cityHall.book(name, -cost);
    w.onRoadStarted(e, 'Morro obriga um desvio longo');
    w.events.emit('road_upgrade', (best.a.x + best.b.x) / 2, (best.a.z + best.b.z) / 2, 0.9,
      `${name}: ${Math.round(best.len)} m sob o morro substituem um desvio pelas ruas de contorno`, { entity: { kind: 'edge', id: e.id }, ref: e.id, visual: 1, headline: `Prefeitura vai furar o morro: ${name} encurta o caminho entre os bairros` });
  }

  /** a straight bore from a to b: gentle grade, a real hill in between, open approaches clear of buildings */
  private boreOk(a: RNode, b: RNode, len: number): boolean {
    const w = this.w, T = w.terrain, R = w.roads;
    if (Math.abs(b.y - a.y) / len > 0.07) return false;
    let peak = -Infinity, under = 0;
    const steps = Math.ceil(len / 10);
    for (let i = 1; i < steps; i++) {
      const t = i / steps, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      const h = T.heightAt(x, z), y = a.y + (b.y - a.y) * t;
      if (h < T.seaLevel + 0.5) return false;
      peak = Math.max(peak, h - y);
      if (h - y > 6) under += len / steps;
      else if (h - y < -1.5) return false; // a valley in the middle: not a hill
    }
    if (peak < 14 || under < len * 0.45) return false;
    // open approaches: no streets crossed, no buildings
    for (const q of R.edgesNear((a.x + b.x) / 2, (a.z + b.z) / 2, len / 2 + 20)) {
      if (!q.alive || q.a === a.id || q.b === a.id || q.a === b.id || q.b === b.id) continue;
      const qa = R.nodes[q.a], qb = R.nodes[q.b];
      const h = segInt(a.x, a.z, b.x, b.z, qa.x, qa.z, qb.x, qb.z);
      if (!h) continue;
      const depth = T.heightAt(h.x, h.z) - (a.y + (b.y - a.y) * h.t);
      if (depth < 6 || q.deck !== undefined) return false;
    }
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps, t1 = (i + 1) / steps;
      const x0 = a.x + (b.x - a.x) * t0, z0 = a.z + (b.z - a.z) * t0, x1 = a.x + (b.x - a.x) * t1, z1 = a.z + (b.z - a.z) * t1;
      if (T.heightAt(x0, z0) - (a.y + (b.y - a.y) * t0) > 1) continue;
      if (!w.occ.segFree(x0, z0, x1, z1, 5, 5).ok) return false;
    }
    // the railway: only far below it
    for (const l of w.rail2?.lines ?? []) for (let i = 0; i < l.x.length - 1; i++) {
      const h = segInt(a.x, a.z, b.x, b.z, l.x[i], l.z[i], l.x[i + 1], l.z[i + 1]);
      if (h && l.y[i] - (a.y + (b.y - a.y) * h.t) < 8) return false;
    }
    return R.minAngleAt(a.id, Math.atan2(b.z - a.z, b.x - a.x)) > 0.6 && R.minAngleAt(b.id, Math.atan2(a.z - b.z, a.x - b.x)) > 0.6;
  }

  /** for the land-value field: shade/noise source along elevated decks */
  splatShade(F: World['fields'], shade: Float32Array) {
    const R = this.w.roads;
    for (const e of R.edges) {
      if (!e.alive || e.progress < 1 || !e.elevated || e.deck === undefined) continue;
      for (let i = 0; i < e.pts.length; i += 9) {
        const lift = e.pts[i + 1] - Math.max(0, this.w.terrain.heightAt(e.pts[i], e.pts[i + 2]));
        if (lift > DECK_CLEAR * 0.5) shade[F.idx(e.pts[i], e.pts[i + 2])] += 1;
      }
    }
  }
}
