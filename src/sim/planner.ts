import { KINDS } from '../shared/catalog';
import { ERAS, RoadClass } from '../shared/constants';
import type { Building, Candidate, Decision } from './buildings';
import { evaluate, profileFor, sampleSites, topAlternatives, TERM_LABELS } from './siting';
import type { World } from './world';
import { angDiff } from './roads';

/**
 * Private market: developers build where the utility function is highest,
 * and redevelop when the land becomes worth more than what stands on it.
 */
export class Market {
  constructor(private w: World) {}

  /** choose and start a zoned building. Returns the building or null. */
  develop(kind: string, wealth: number, motive: string, opts: { level?: number; near?: { x: number; z: number; r: number }; samples?: number } = {}): Building | null {
    const w = this.w;
    const def = KINDS[kind];
    const rng = w.rng;
    const level = opts.level ?? 1;
    let bw = rng.range(def.w[0], def.w[1]), bd = rng.range(def.d[0], def.d[1]);
    if (kind === 'res' && level >= 3) { bw = Math.max(bw, 20); bd = Math.max(bd, 20); }
    if (kind === 'res' && wealth === 2 && level <= 2) { bw *= 1.25; bd *= 1.2; }
    const informal = kind === 'informal';
    const cands = sampleSites(w.siteCtx(), bw, bd, opts.samples ?? 40, {
      offRoad: def.offRoad || informal, informal,
      nearX: opts.near?.x, nearZ: opts.near?.z, nearR: opts.near?.r,
    });
    if (!cands.length) { w.siteScarcity += 1; return null; }
    const prof = profileFor(kind, wealth, w.params);
    for (const c of cands) evaluate(w.siteCtx(), c, kind, prof, bw, bd);
    cands.sort((a, b) => b.total - a.total);
    const chosen = cands[0];
    if (cands.length < 6) w.siteScarcity += 0.5;
    const decision: Decision = {
      actor: informal ? 'Autoconstrução' : 'Mercado', kind, day: w.day, motive, chosen: { ...chosen, terms: { ...chosen.terms } },
      alternatives: topAlternatives(cands, chosen, 5), sampled: cands.length,
    };
    if (chosen.edge < 0 && !informal) {
      // needs an access road
      if (!w.buildAccessRoad(chosen, bw, bd)) return null;
    }
    const b = w.buildings.create(kind, chosen, { level, wealth, era: w.era, day: w.day, w: bw, d: bd, maxDensity: w.params.maxDensity, decision });
    w.onBuildingStarted(b);
    return b;
  }

  /** Redevelopment: demolish & rebuild denser when land value justifies it. */
  redevelop(samples: number) {
    const w = this.w;
    const list = w.buildings.list;
    if (!list.length) return;
    for (let i = 0; i < samples; i++) {
      const b = list[Math.floor(w.rng.next() * list.length)];
      if (b.state !== 'done' || b.heritage || b.def.public) continue;
      if (b.kind !== 'res' && b.kind !== 'com' && b.kind !== 'off' && b.kind !== 'informal' && !(b.def.cat === 'ind' && b.abandoned)) continue;
      const lv = w.fields.avg('landValue', b.x, b.z, 40);
      const acc = w.fields.sample('accessibility', b.x, b.z);
      const tr = w.fields.sample('transit', b.x, b.z);
      const potential = lv * 2.2 + acc * 1.6 + tr * 1.4 + w.era * 0.5; // proxy of what a developer could sell
      const maxL = Math.min(w.params.maxDensity, [2, 3, 4, 5][w.era]);
      let target = Math.min(maxL, Math.max(1, Math.floor(potential)));
      if (b.w * b.d < 380) target = Math.min(target, 3);
      if (b.w * b.d < 260) target = Math.min(target, 2);
      const age = w.day - b.builtDay;
      if (age < 4 && !b.abandoned) continue;
      const demandOk = b.kind === 'res' ? w.demand.res > -5 : b.kind === 'com' ? w.demand.com > -3 : w.demand.off > -3;
      // gentrification: low-income housing on valuable land is bought out
      const gentrify = b.kind === 'res' && b.wealth === 0 && lv > 0.75 && w.rng.chance(0.4);
      const informalUpgrade = b.kind === 'informal' && lv > 0.45;
      if (b.abandoned && b.def.cat === 'ind') {
        // brownfield reconversion: lofts if valuable, otherwise left for the city hall (park)
        if (lv > 0.35 && w.fields.sample('soilPollution', b.x, b.z) < 0.8) {
          this.rebuild(b, 'res', 2, 1, 'Reconversão de área industrial abandonada em lofts', 1);
          w.events.emit('reconversion', b.x, b.z, 0.7, `Galpão abandonado vira lofts`, { headline: `Antiga ${b.def.label.toLowerCase()} vira condomínio de lofts`, ref: b.id });
        }
        continue;
      }
      if ((target > b.level && demandOk && w.rng.chance(0.5)) || gentrify || informalUpgrade) {
        const newKind = informalUpgrade ? 'res' : b.kind;
        const newWealth = gentrify ? (lv > 1.0 ? 2 : 1) : informalUpgrade ? 0 : b.wealth;
        const newLevel = informalUpgrade ? 1 : Math.max(b.level + (gentrify ? 0 : 1), 1);
        if (gentrify) {
          w.events.emit('gentrification', b.x, b.z, 0.6, `Gentrificação: moradias populares dão lugar a padrão ${newWealth === 2 ? 'alto' : 'médio'}`, { headline: w.rng.chance(0.3) ? `Aluguel dispara e antigos moradores deixam ${w.districtName(b.x, b.z)}` : undefined, ref: b.id });
        }
        this.rebuild(b, newKind, newLevel, newWealth, gentrify ? 'Gentrificação: valor do solo subiu' : informalUpgrade ? 'Urbanização de moradia informal' : `Valor do solo justifica nível ${newLevel}`);
        return; // one at a time
      }
    }
  }

  rebuild(b: Building, kind: string, level: number, wealth: number, motive: string, variant = 0) {
    const w = this.w;
    const lv = w.fields.avg('landValue', b.x, b.z, 40);
    const cand: Candidate = { x: b.x, z: b.z, angle: b.angle, edge: b.edge, t: b.edgeT, side: b.side, access: b.access, offDist: 0, total: 0, terms: {} };
    evaluate(w.siteCtx(), cand, kind, profileFor(kind, wealth, w.params), b.w, b.d);
    const decision: Decision = {
      actor: 'Mercado', kind, day: w.day, motive: motive + ` (valor do solo ${lv.toFixed(2)})`, chosen: cand, alternatives: [], sampled: 1,
    };
    b.pendingRebuild = { kind, level, wealth, floors: 0, decision, variant };
    w.evict(b);
    w.buildings.demolish(b);
    w.events.emit('demolition', b.x, b.z, 0.5 + 0.1 * b.level, `Demolição para dar lugar a um prédio maior`, { ref: b.id, visual: 0.8 });
  }
}

/** Road growth: frontier expansion, organic (follows terrain) or planned (grid). */
export class RoadGrowth {
  gridAngle = 0;
  constructor(private w: World) {}

  grow(attempts: number, urgency: number): number {
    const w = this.w, R = w.roads, rng = w.rng;
    let built = 0;
    const center = w.center;
    const radius = w.cityRadius;
    const nodes = R.nodes.filter((n) => n.alive && n.edges.length > 0 && n.edges.length < 4 && n.edges.some((id) => R.edges[id].progress >= 1));
    if (!nodes.length) return 0;
    const planned = rng.next() < w.params.gridGrowth * (w.era >= 1 ? 1 : 0.5);
    for (let a = 0; a < attempts * 6 && built < attempts; a++) {
      const n = rng.weighted(nodes, (q) => {
        const d = Math.hypot(q.x - center.x, q.z - center.z);
        const deg = q.edges.length;
        const onlyHighway = q.edges.every((id) => R.edges[id].cls === RoadClass.Highway);
        const lv = w.fields.sample('landValue', q.x, q.z);
        const acc = w.fields.sample('accessibility', q.x, q.z);
        return (deg === 1 ? 3 : deg === 2 ? 1.2 : 0.4) * Math.exp(-d / (radius + 150)) * (0.4 + lv + acc) * (onlyHighway ? 0.5 : 1);
      });
      if (!n) break;
      const deg = n.edges.length;
      const e0 = R.edges[n.edges[Math.floor(rng.next() * deg)]];
      const base = R.angleOf(e0, n.id) + Math.PI; // continuing straight away from that edge
      let ang: number;
      if (deg === 1) ang = base + (planned ? 0 : rng.range(-0.45, 0.45));
      else ang = base + (rng.chance(0.5) ? 1 : -1) * Math.PI / 2 + (planned ? 0 : rng.range(-0.25, 0.25));
      if (planned) ang = this.gridAngle + Math.round((ang - this.gridAngle) / (Math.PI / 2)) * (Math.PI / 2);
      else {
        // organic: choose among nearby angles the one that follows the contour (least grade)
        let best = ang, bestG = Infinity;
        for (const da of [0, -0.3, 0.3, -0.6, 0.6]) {
          const aa = ang + da;
          const g = Math.abs(w.terrain.heightAt(n.x + Math.cos(aa) * 60, n.z + Math.sin(aa) * 60) - w.terrain.heightAt(n.x, n.z)) + Math.abs(da) * 2 + rng.next() * 1.5;
          if (g < bestG) { bestG = g; best = aa; }
        }
        ang = best;
      }
      const len = planned ? rng.range(92, 112) : rng.range(55, 95);
      const cls = w.era === 0 ? RoadClass.Dirt : RoadClass.Local;
      const plan = R.planSegment(n.id, n.x + Math.cos(ang) * len, n.z + Math.sin(ang) * len, cls, {});
      if (!plan.ok) continue;
      const e = R.applyPlan(plan, { progress: 0, day: w.day });
      w.onRoadStarted(e, urgency > 1 ? 'Falta de lotes: expansão viária' : 'Expansão da malha');
      built++;
    }
    return built;
  }

  /** close loops at dead ends so the network doesn't become a tree of culs-de-sac */
  closeLoops(attempts: number) {
    const w = this.w, R = w.roads;
    const dead = R.nodes.filter((n) => n.alive && n.edges.length === 1 && R.edges[n.edges[0]].progress >= 1);
    for (let i = 0; i < attempts && dead.length; i++) {
      const n = dead[Math.floor(w.rng.next() * dead.length)];
      const own = R.edges[n.edges[0]];
      const outAng = R.angleOf(own, n.id) + Math.PI;
      const targets = R.nodesNear(n.x, n.z, 150).filter((q) => q.id !== n.id && q.edges.length < 4 && !R.edgeBetween(n.id, q.id) && q.id !== (own.a === n.id ? own.b : own.a));
      targets.sort((a, b) => Math.hypot(a.x - n.x, a.z - n.z) - Math.hypot(b.x - n.x, b.z - n.z));
      for (const q of targets.slice(0, 4)) {
        const ang = Math.atan2(q.z - n.z, q.x - n.x);
        if (angDiff(ang, outAng) > 1.2) continue;
        const plan = R.planSegment(n.id, q.x, q.z, own.cls === RoadClass.Highway ? RoadClass.Local : own.cls);
        if (plan.ok) { const e = R.applyPlan(plan, { progress: 0, day: w.day }); w.onRoadStarted(e, 'Ligação de rua sem saída'); break; }
      }
    }
  }
}

export function decisionText(d: Decision): string[] {
  const out: string[] = [];
  out.push(`${d.actor} · ${KINDS[d.kind]?.label ?? d.kind} · dia ${d.day}`);
  out.push(d.motive);
  const terms = Object.entries(d.chosen.terms).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  for (const [k, v] of terms.slice(0, 6)) out.push(`${v >= 0 ? '+' : '−'} ${TERM_LABELS[k] ?? k}: ${Math.abs(v).toFixed(2)}`);
  return out;
}

export const ERA_LABEL = ERAS;
