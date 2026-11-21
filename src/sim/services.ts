import { HOUR_SECONDS, VEH_FLAG_SIREN, VType } from '../shared/constants';
import { clamp } from '../shared/rng';
import type { Building } from './buildings';
import type { World } from './world';
import { carPlan, carPlanEdges } from './trips';
import { P_CONSTRUCTION, P_FUNERAL, P_GARBAGE, P_MOVING, P_PATROL, P_SERVICE } from './traffic';

interface Incident { id: number; type: 'crime' | 'fire' | 'medical'; b: number; t: number; responded: boolean }

/** Public safety & health: emergent crime, fires, medical emergencies and the vehicles that respond. */
export class Services {
  incidents = new Map<number, Incident>();
  private nextId = 1;
  crimesToday = 0;
  crimeHistory: number[] = [];
  patrolTarget = 0;
  patrols = 0;
  firesToday = 0;
  avgCrime = 0;
  /** emergency/collection responses that failed to reach the target due to gridlock */
  delayedResponses = 0;
  private lastDelayNotice = -1e9;

  constructor(private w: World) {}

  private stations(kind: (b: Building) => boolean): Building[] {
    return this.w.buildings.list.filter((b) => b.state === 'done' && !b.abandoned && kind(b));
  }
  private nearest(list: Building[], x: number, z: number): Building | null {
    let best: Building | null = null, bd = Infinity;
    for (const b of list) { const d = Math.hypot(b.x - x, b.z - z); if (d < bd) { bd = d; best = b; } }
    return best;
  }

  /** crime emerges from unemployment, inequality, darkness, abandonment — and is suppressed by police coverage */
  computeCrime() {
    const w = this.w, F = w.fields, G = F.G, C = w.citizens;
    const unemp = new Float32Array(G * G), adults = new Float32Array(G * G), poor = new Float32Array(G * G), rich = new Float32Array(G * G);
    for (const h of C.households.values()) {
      const b = w.buildings.byId.get(h.home);
      if (!b) continue;
      const k = F.idx(b.x, b.z);
      for (const m of h.members) if (C.age[m] >= 16 && C.age[m] < 65) { adults[k]++; if (C.job[m] < 0 && !C.studying[m]) unemp[k]++; }
      if (h.wealth === 0) poor[k] += h.members.length; else if (h.wealth === 2) rich[k] += h.members.length;
    }
    const ub = new Float32Array(G * G), ab = new Float32Array(G * G), pb = new Float32Array(G * G), rb = new Float32Array(G * G), abandoned = new Float32Array(G * G), ab2 = new Float32Array(G * G);
    F.blur(unemp, ub, 3); F.blur(adults, ab, 3); F.blur(poor, pb, 4); F.blur(rich, rb, 4);
    for (const b of w.buildings.list) if (b.abandoned) abandoned[F.idx(b.x, b.z)] += 1;
    F.blur(abandoned, ab2, 3);
    const p = w.params;
    let sum = 0, n = 0;
    for (let k = 0; k < G * G; k++) {
      const people = F.f.resDensity[k] + F.f.jobDensity[k] * 0.4 + F.f.footfall[k] * 0.3;
      if (people < 0.05) { F.f.crime[k] *= 0.9; continue; }
      const ur = ab[k] > 0.01 ? ub[k] / ab[k] : 0;
      const ineq = pb[k] > 0 && rb[k] > 0 ? Math.min(1, Math.sqrt(pb[k] * rb[k]) / (pb[k] + rb[k] + 0.01) * 2) : 0;
      const dark = F.f.power[k] < 0.5 ? 1 : 0;
      const target = p.baseCrime * (0.08 + ur * 1.6 + ineq * 0.35 * (0.5 + p.inequality) + ab2[k] * 2.5 + dark * 0.3 + (pb[k] > rb[k] * 3 ? 0.1 : 0) + Math.min(0.3, people / 40))
        * (1 - Math.min(0.88, F.f.cov_police[k] * p.policeEfficiency * 0.75 * (1 - (w.integrity?.policeLeak(k) ?? 0)))) * (w.economy.crisis > 0 ? 1.4 : 1);
      F.f.crime[k] += (clamp(target, 0, 1.5) - F.f.crime[k]) * 0.3;
      sum += F.f.crime[k] * people; n += people;
    }
    this.avgCrime = n ? sum / n : 0;
  }

  hourly() {
    const w = this.w, F = w.fields, r = w.rng;
    if (w.hourIdx % 3 === 0) this.computeCrime();
    // --- crime incidents ---
    const res = w.buildings.list.filter((b) => b.state === 'done' && (b.def.cat === 'res' || b.def.cat === 'com' || b.def.cat === 'informal'));
    for (let k = 0; k < Math.min(30, res.length); k++) {
      const b = res[Math.floor(r.next() * res.length)];
      const c = F.sample('crime', b.x, b.z);
      if (r.next() < c * 0.06 * (w.dayFrac > 0.8 || w.dayFrac < 0.2 ? 1.8 : 1)) this.crime(b);
    }
    // --- medical emergencies ---
    const C = w.citizens;
    for (let k = 0; k < 20; k++) {
      const i = Math.floor(r.next() * C.max);
      if (!C.alive[i] || C.health[i] > 0.35 || !r.chance(0.3)) continue;
      const h = C.households.get(C.hh[i]);
      const home = h ? w.buildings.byId.get(h.home) : undefined;
      if (home) this.emergency('medical', home, `Ambulância socorre ${C.name(i)} em ${w.districtName(home.x, home.z)}`, i);
    }
    // --- fires ---
    const freq = w.params.disasterFreq;
    for (const b of w.buildings.list) {
      if (b.state !== 'done' || b.fire > 0) continue;
      const age = (w.day - b.builtDay) / 30;
      const risk = 0.00003 * freq * (1 + age) * (b.def.cat === 'ind' ? 3 : 1) * (b.abandoned ? 2.5 : b.squatted ? 2 : 1) * (1 + b.decay) * (1 - F.sample('cov_fire', b.x, b.z) * 0.6) * (b.def.public ? 0.3 : 1);
      if (r.next() < risk) this.ignite(b);
    }
    for (const b of w.buildings.list) {
      if (b.fire <= 0) continue;
      b.fire = Math.min(4, b.fire + 0.25);
      w.buildings.dirty.add(b.id);
      if (b.fire >= 3.5) {
        b.fire = 0;
        w.events.emit('fire', b.x, b.z, 0.9, `${b.name} é destruído pelo fogo`, { headline: `Incêndio destrói ${b.name}${F.sample('cov_fire', b.x, b.z) < 0.3 ? '; bairro não tinha cobertura de bombeiros' : ''}`, ref: b.id });
        w.evict(b);
        w.buildings.demolish(b);
      }
    }
    // --- patrols: keep a fleet roaming proportional to stations and crime ---
    const stations = this.stations((b) => b.kind === 'police');
    this.patrolTarget = Math.round(stations.length * (2 + this.avgCrime * 6));
    if (this.patrols < this.patrolTarget && stations.length && w.traffic.capacityLeft > 200) {
      const st = stations[Math.floor(r.next() * stations.length)];
      if (this.patrol(st, -1)) this.patrols++;
    }
  }

  daily() {
    this.crimeHistory.push(this.crimesToday);
    if (this.crimeHistory.length > 30) this.crimeHistory.shift();
    this.crimesToday = 0;
    this.firesToday = 0;
  }

  crimeTrend(): number {
    const h = this.crimeHistory;
    if (h.length < 4) return 0;
    const recent = (h[h.length - 1] + h[h.length - 2]) / 2, older = (h[h.length - 3] + h[h.length - 4]) / 2;
    return recent - older;
  }

  crime(b: Building) {
    const w = this.w;
    this.crimesToday++;
    const types = ['Assalto', 'Furto de veículo', 'Arrombamento', 'Roubo a comércio', 'Vandalismo'];
    const t = types[Math.floor(w.rng.next() * types.length)];
    const ok = this.emergency('crime', b, `${t} em ${w.districtName(b.x, b.z)}`);
    if (!ok) w.events.emit('crime', b.x, b.z, 0.35, `${t} em ${w.districtName(b.x, b.z)} — sem viatura disponível`, { ref: b.id });
    // occasional chase: suspect flees, police follows the same route
    if (ok && w.rng.chance(0.25) && w.traffic.capacityLeft > 100) {
      const far = w.buildings.list[Math.floor(w.rng.next() * w.buildings.list.length)];
      const plan = far ? carPlan(w.roads, b, far) : null;
      if (plan && plan.path.length > 4) {
        const thief = w.traffic.spawn(VType.Car, plan.path, plan.startS, plan.destS, { kind: P_SERVICE, id: -2, aux: -1 }, b.id, far.id);
        if (thief >= 0) {
          w.traffic.v0f[thief] = 1.5;
          const cop = w.traffic.spawn(VType.Police, plan.path, Math.max(0, plan.startS - 25), plan.destS, { kind: P_SERVICE, id: -2, aux: -1 }, b.id, far.id, VEH_FLAG_SIREN);
          if (cop >= 0) w.events.emit('police_chase', b.x, b.z, 0.8, `Perseguição policial em ${w.districtName(b.x, b.z)}`, { entity: { kind: 'vehicle', id: cop, gen: w.traffic.gen[cop] }, visual: 1 });
        }
      }
    }
  }

  ignite(b: Building) {
    const w = this.w;
    b.fire = 1;
    this.firesToday++;
    w.buildings.dirty.add(b.id);
    this.emergency('fire', b, `Incêndio em ${b.name} (${w.districtName(b.x, b.z)})`);
  }

  /** dispatch the nearest station's vehicle with sirens */
  emergency(type: 'crime' | 'fire' | 'medical', b: Building, text: string, citizen = -1): boolean {
    const w = this.w;
    const st = this.nearest(this.stations((s) => type === 'crime' ? s.kind === 'police' : type === 'fire' ? s.kind === 'fire' : s.kind === 'hospital' || s.kind === 'clinic'), b.x, b.z);
    const inc: Incident = { id: this.nextId++, type, b: b.id, t: w.t, responded: false };
    this.incidents.set(inc.id, inc);
    if (!st) {
      if (type === 'fire') w.events.emit('fire', b.x, b.z, 0.8, text + ' — sem bombeiros na cidade', { ref: b.id, visual: 1 });
      return false;
    }
    const plan = carPlan(w.roads, st, b);
    if (!plan || w.traffic.capacityLeft < 10) return false;
    const vt = type === 'crime' ? VType.Police : type === 'fire' ? VType.Fire : VType.Ambulance;
    const slot = w.traffic.spawn(vt, plan.path, plan.startS, plan.destS, { kind: P_SERVICE, id: inc.id, aux: st.id }, st.id, b.id, VEH_FLAG_SIREN);
    if (slot >= 0) {
      const ev = type === 'fire' ? 'fire' : type === 'crime' ? 'crime' : 'emergency';
      w.events.emit(ev, b.x, b.z, type === 'fire' ? 0.85 : type === 'medical' ? 0.55 : 0.4, text, { entity: { kind: 'vehicle', id: slot, gen: w.traffic.gen[slot] }, ref: b.id, visual: type === 'fire' ? 1 : 0.8 });
      void citizen;
    }
    return slot >= 0;
  }

  patrol(st: Building, slotPrev: number): boolean {
    const w = this.w;
    const nodes = w.roads.nodesNear(st.x, st.z, 900).filter((n) => n.edges.some((id) => w.roads.edges[id].progress >= 1));
    if (!nodes.length) return false;
    const n = nodes[Math.floor(w.rng.next() * nodes.length)];
    const e = w.roads.edges[n.edges[0]];
    const a = w.roads.edges[st.edge] ?? null;
    if (!a || !e.alive || e.progress < 1) return false;
    const plan = carPlanEdges(w.roads, a, st.edgeT, e, 0.5, st.x, st.z, n.x, n.z);
    if (!plan) return false;
    const slot = w.traffic.spawn(VType.Police, plan.path, plan.startS, plan.destS, { kind: P_PATROL, id: st.id, aux: 0 }, -1, -1);
    void slotPrev;
    return slot >= 0;
  }

  /** a service vehicle arrived */
  arrived(slot: number) {
    const w = this.w, T = w.traffic;
    const kind = T.pKind[slot];
    if (kind === P_PATROL) {
      const st = w.buildings.byId.get(T.pId[slot]);
      this.patrols--;
      if (st && this.patrols < this.patrolTarget && this.patrol(st, slot)) this.patrols++;
      return;
    }
    if (kind === P_SERVICE) {
      const inc = this.incidents.get(T.pId[slot]);
      if (inc) {
        this.incidents.delete(inc.id);
        const b = w.buildings.byId.get(inc.b);
        if (b && inc.type === 'fire' && b.fire > 0) {
          b.fire = 0;
          w.buildings.dirty.add(b.id);
          w.events.emit('fire_out', b.x, b.z, 0.3, `Bombeiros controlam o incêndio em ${b.name}`, { ref: b.id });
        }
        // return to base without sirens
        const st = w.buildings.byId.get(T.pAux[slot]);
        if (b && st && T.capacityLeft > 100) {
          const plan = carPlan(w.roads, b, st);
          if (plan) w.traffic.spawn(T.type[slot], plan.path, plan.startS, plan.destS, { kind: P_SERVICE, id: -1, aux: -1 }, b.id, st.id);
        }
      }
      return;
    }
    if (kind === P_GARBAGE) {
      const b = w.buildings.byId.get(T.pId[slot]);
      w.utils.onGarbageArrived(T.pId[slot]);
      if (!b) return;
      // truck actually reached the block: collect from the target and immediate neighbours up to its load
      let cap = T.pAux[slot] > 0 ? T.pAux[slot] / 10 : 4;
      let collected = 0;
      const collect = (t: Building) => {
        if (cap <= 0 || t.garbage <= 0) return;
        const take = Math.min(t.garbage, cap);
        t.garbage -= take;
        cap -= take;
        collected += take;
        w.buildings.dirty.add(t.id);
      };
      collect(b);
      if (cap > 0.1) {
        for (const n of w.buildings.list) {
          if (cap <= 0) break;
          if (n.id === b.id || n.state !== 'done' || n.garbage <= 0.1) continue;
          if (Math.hypot(n.x - b.x, n.z - b.z) <= 110) collect(n);
        }
      }
      if (collected > 0) w.utils.garbage.stock += collected;
      return;
    }
    void P_CONSTRUCTION; void P_FUNERAL; void P_MOVING;
  }

  /** a service vehicle gave up in gridlock: never count the service as delivered */
  stuck(slot: number) {
    const w = this.w, T = w.traffic;
    const kind = T.pKind[slot];
    if (kind === P_PATROL) {
      this.patrols = Math.max(0, this.patrols - 1);
      const st = w.buildings.byId.get(T.pId[slot]);
      if (st && this.patrols < this.patrolTarget && this.patrol(st, slot)) this.patrols++;
      return;
    }
    if (kind === P_SERVICE) {
      const inc = this.incidents.get(T.pId[slot]);
      if (!inc) return;
      this.incidents.delete(inc.id);
      this.delayedResponses++;
      const b = w.buildings.byId.get(inc.b);
      if (b && inc.type === 'fire' && b.fire > 0) {
        if (w.t - this.lastDelayNotice > HOUR_SECONDS * 2) {
          this.lastDelayNotice = w.t;
          w.events.emit('fire', b.x, b.z, 0.7, `Congestionamento impede chegada dos bombeiros em ${b.name}`, { ref: b.id });
        }
      }
      return;
    }
    if (kind === P_GARBAGE) {
      this.delayedResponses++;
      w.utils.onGarbageStuck(T.origin[slot], T.pId[slot]);
      return;
    }
  }

  static HOUR = HOUR_SECONDS;
}
