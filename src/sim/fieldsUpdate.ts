import { RoadClass } from '../shared/constants';
import { clamp } from '../shared/rng';
import type { World } from './world';

let scratch: Record<string, Float32Array> = {};
function buf(name: string, n: number) {
  let b = scratch[name];
  if (!b || b.length !== n) scratch[name] = b = new Float32Array(n);
  else b.fill(0);
  return b;
}

/** Recompute all heatmaps from the current state of the city. Called once per game hour. */
export function updateFields(w: World) {
  const F = w.fields;
  const G = F.G, N = G * G;
  const f = F.f;
  const airSrc = buf('air', N), noiseSrc = buf('noise', N), roadProx = buf('road', N), hw = buf('hw', N), rail = buf('rail', N);
  const res = buf('res', N), jobs = buf('jobs', N), beautyDyn = buf('beauty', N), tour = buf('tour', N), foot = buf('foot', N);
  const riverIn = new Float32Array(F.riverPol.length);
  const cov: Record<string, Float32Array> = {
    health: buf('ch', N), education: buf('ce', N), police: buf('cp', N), fire: buf('cf', N), parks: buf('cpk', N), culture: buf('cc', N),
  };
  const transit = buf('tr', N);
  const abandon = buf('ab', N);
  const wealthAcc = buf('wa', N), wealthCnt = buf('wc', N);

  // --- roads ---
  for (const e of w.roads.edges) {
    if (!e.alive || e.progress < 1) continue;
    const vol = e.volume[0] + e.volume[1];
    const n = Math.max(1, Math.round(e.len / 15));
    const p = e.pts;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const k = Math.min(p.length / 3 - 1, Math.round(t * (p.length / 3 - 1)));
      const x = p[k * 3], z = p[k * 3 + 2];
      const kk = F.idx(x, z);
      roadProx[kk] = Math.max(roadProx[kk], e.cls === RoadClass.Highway ? 0.5 : 0.6 + e.cls * 0.1);
      noiseSrc[kk] += (0.04 + vol * 0.004) * (1 + e.cls * 0.4);
      airSrc[kk] += vol * 0.0006 * (1 - w.params.transitPriority * 0.3);
      foot[kk] += vol * 0.02 * (e.cls >= RoadClass.Collector ? 1.5 : 1) + (e.cls >= RoadClass.Avenue ? 0.4 : 0);
    }
  }
  const cong = f.congestion;
  cong.fill(0);
  for (const e of w.roads.edges) {
    if (!e.alive || e.progress < 1) continue;
    const vc = Math.max(e.volume[0], e.volume[1]) / w.roads.capacity(e);
    for (let i = 0; i < e.pts.length; i += 6) { const k = F.idx(e.pts[i], e.pts[i + 2]); cong[k] = Math.max(cong[k], vc); }
  }
  for (const n of w.roads.nodes) {
    if (!n.alive) continue;
    if (n.edges.some((id) => w.roads.edges[id].cls === RoadClass.Highway && w.roads.edges[id].progress >= 1)) F.splat(hw, n.x, n.z, 1, 25);
  }
  // --- rail ---
  if (w.rail) w.rail.splatAccess(F, rail, transit);
  if (w.transit) w.transit.splatCoverage(F, transit);

  // --- buildings ---
  const toler = w.params.pollutionTolerance;
  for (const b of w.buildings.list) {
    if (b.state !== 'done') { if (b.state === 'structure' || b.state === 'foundation') noiseSrc[F.idx(b.x, b.z)] += 0.5; continue; }
    const def = b.def;
    const k = F.idx(b.x, b.z);
    const hh = b.households.length;
    res[k] += hh;
    const jc = b.workers.length || (b.jobCap[0] + b.jobCap[1] + b.jobCap[2] + b.jobCap[3]) * 0.5;
    jobs[k] += jc;
    if (def.cat === 'res' || def.cat === 'informal') { wealthAcc[k] += b.wealth * Math.max(1, hh); wealthCnt[k] += Math.max(1, hh); }
    if (b.abandoned) { abandon[k] += 1; continue; }
    const active = def.public || b.workers.length > 0 || def.cat === 'res';
    const act = active ? 1 : 0.3;
    if (def.air) airSrc[k] += def.air * act * (b.kind === 'thermalPlant' ? 1.2 : 1) * (1 - 0.25 * (1 - toler));
    if (def.noise) F.splat(noiseSrc, b.x, b.z, def.noise * act, 60);
    if (def.soil) f.soilPollution[k] = Math.min(4, f.soilPollution[k] + def.soil * 0.004 * act);
    if (def.waterPol && F.riverCell[k] >= 0) riverIn[F.riverCell[k]] += def.waterPol * 0.02 * act;
    if (def.beauty) F.splat(beautyDyn, b.x, b.z, def.beauty, def.cat === 'park' ? 220 : 150);
    if (def.undesir > 0.6) F.splat(beautyDyn, b.x, b.z, -def.undesir * 0.6, 220);
    if (def.tourism) F.splat(tour, b.x, b.z, def.tourism * (b.heritage ? 1.4 : 1), 450);
    if (b.heritage) F.splat(tour, b.x, b.z, 0.25, 200);
    if (def.service) {
      const r = def.service.radius;
      const util = b.def.public ? Math.min(1.4, def.service.capacity / Math.max(50, (b.visitors + 1) * 6)) : 1;
      splatCoverage(F, cov[def.service.type], b.x, b.z, r, clamp(util, 0.4, 1.2));
    }
    if (b.kind === 'com' || b.kind === 'restaurant' || b.kind === 'mall') foot[k] += 0.4;
  }
  // untreated sewage
  if (w.utilities) w.utilities.riverInput(riverIn);

  // --- derived fields ---
  F.blur(res, f.resDensity, 1);
  for (let k = 0; k < N; k++) f.resDensity[k] *= 3;
  F.blur(jobs, f.jobDensity, 1);
  for (let k = 0; k < N; k++) f.jobDensity[k] *= 3;
  const jobAcc = buf('ja', N);
  F.blur(jobs, jobAcc, 16);
  let jm = 0.001;
  for (let k = 0; k < N; k++) jm = Math.max(jm, jobAcc[k]);
  const rp = buf('rp', N);
  F.blur(roadProx, rp, 2);
  const hwb = buf('hwb', N);
  F.blur(hw, hwb, 14);
  let hm = 0.0001;
  for (let k = 0; k < N; k++) hm = Math.max(hm, hwb[k]);
  F.blur(foot, f.footfall, 1);
  const bd = buf('bd', N);
  F.blur(beautyDyn, bd, 2);
  F.blur(noiseSrc, f.noise, 2);
  for (let k = 0; k < N; k++) f.noise[k] = Math.min(2, f.noise[k] * 2.5);
  F.advectAir(airSrc, w.weather.wind * 0.9, 5);
  F.propagateRiver(riverIn);
  for (let k = 0; k < N; k++) f.soilPollution[k] *= 0.9993;
  const rlb = buf('rlb', N);
  F.blur(rail, rlb, 6);
  const tb = buf('tb', N);
  F.blur(transit, tb, 1);
  const tourB = buf('tourB', N);
  F.blur(tour, tourB, 3);
  const wealthB = buf('wb', N), wealthCB = buf('wcb', N);
  F.blur(wealthAcc, wealthB, 3);
  F.blur(wealthCnt, wealthCB, 3);
  const abB = buf('abB', N);
  F.blur(abandon, abB, 3);
  for (const name of Object.keys(cov)) {
    const dst = f[('cov_' + name) as 'cov_health'];
    for (let k = 0; k < N; k++) dst[k] = Math.min(1.2, cov[name][k]);
  }
  const garbage = f.garbage;
  const crime = f.crime;
  for (let k = 0; k < N; k++) {
    const roadP = Math.min(1, rp[k] * 2.2);
    f.accessibility[k] = clamp(roadP * (0.35 + 0.65 * (jobAcc[k] / jm)) + tb[k] * 0.25, 0, 1.3);
    f.highwayAccess[k] = clamp(hwb[k] / hm, 0, 1) * roadP;
    f.railAccess[k] = clamp(rlb[k] * 6, 0, 1.2);
    f.transit[k] = clamp(tb[k], 0, 1.2);
    const air = f.airPollution[k];
    const beauty = F.staticBeauty(k) * (1 - Math.min(0.8, f.waterPollution[k] * 0.4)) + bd[k] * 1.6 - air * 0.3 - garbage[k] * 0.4 - abB[k] * 0.6;
    f.beauty[k] = clamp(beauty, -1, 2);
    const neighWealth = wealthCB[k] > 0.01 ? wealthB[k] / wealthCB[k] : 1;
    const services = (f.cov_health[k] + f.cov_education[k] + f.cov_police[k] + f.cov_fire[k]) / 4;
    const tourismV = clamp(tourB[k] * 1.5 + Math.max(0, f.beauty[k]) * 0.35 + f.cov_culture[k] * 0.2 + f.cov_parks[k] * 0.15 - crime[k] * 0.4 - garbage[k] * 0.5, 0, 2);
    f.tourism[k] = tourismV;
    const target = 0.12
      + 0.42 * f.accessibility[k]
      + 0.55 * f.beauty[k]
      + 0.3 * services
      + 0.22 * f.cov_parks[k]
      + 0.3 * f.transit[k]
      + 0.18 * (neighWealth - 1)
      + 0.15 * tourismV * (w.tourism ? w.tourism.pressure : 0)
      - 0.8 * air
      - 0.35 * f.noise[k]
      - 0.55 * crime[k]
      - 0.35 * f.soilPollution[k]
      - 0.3 * f.waterPollution[k]
      - 0.4 * garbage[k]
      - 0.5 * abB[k];
    const inf = roadP > 0.05 ? 1 : 0.3;
    f.landValue[k] += (clamp(target, 0, 2) * inf - f.landValue[k]) * 0.25;
    f.complaint[k] = f.resDensity[k] * (0.4 + f.landValue[k]) * (0.6 + 0.4 * neighWealth);
  }
}

function splatCoverage(F: World['fields'], arr: Float32Array, x: number, z: number, r: number, strength: number) {
  const G = F.G, c = F.cell;
  const i0 = Math.max(0, Math.floor((x - r) / c)), i1 = Math.min(G - 1, Math.floor((x + r) / c));
  const j0 = Math.max(0, Math.floor((z - r) / c)), j1 = Math.min(G - 1, Math.floor((z + r) / c));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const d = Math.hypot((i + 0.5) * c - x, (j + 0.5) * c - z);
    if (d > r) continue;
    const v = strength * (1 - (d / r) * (d / r) * 0.7);
    arr[j * G + i] = Math.max(arr[j * G + i], 0) + v * 0.75;
  }
}
