import { HOUR_SECONDS, PED_FLAG_WAITING, RoadClass, VEH_FLAG_BRAKE, VEH_FLAG_HAZARD, VEH_FLAG_SIREN, VType } from '../shared/constants';
import { edgeHalfWidth } from '../shared/roadGeom';
import type { RoadIncidentKind, RoadIncidentStage, RoadIncidentView } from '../shared/protocol';
import type { Building } from './buildings';
import { Act, ST_CAR, ST_IN, ST_VIRTUAL, ST_WALK } from './citizens';
import type { REdge } from './roads';
import { P_BUS, P_CITIZEN, P_INCIDENT, type RoadBlockage } from './traffic';
import { carPlan, carPlanEdges, type CarPlan } from './trips';
import type { World } from './world';

export const INC_ROLE_POLICE = 0;
export const INC_ROLE_AMBULANCE = 1;
export const INC_ROLE_FIRE = 2;
export const INC_ROLE_TOW = 3;
export const INC_ROLE_EVAC_HOSPITAL = 4;
export const INC_ROLE_RETURN_BASE = 5;

export interface InvolvedVehicle {
  slot: number;
  gen: number;
  type: VType;
  citizenId: number;
  hhId: number;
  busLineId: number;
  severeDamage: boolean;
}

export interface UnitDispatch {
  slot: number;
  gen: number;
  stationId: number;
  arrived: boolean;
  required: boolean;
  transporting?: boolean;
}

export interface RoadIncident {
  id: number;
  kind: RoadIncidentKind;
  edge: number;
  dir: number;
  lane: number;
  s: number;
  x: number;
  y: number;
  z: number;
  angle: number;
  fullClosure: boolean;
  stage: RoadIncidentStage;
  vehicles: number[];
  involved: InvolvedVehicle[];
  injuredCitizen: number;
  injuredGen: number;
  injuredWasPed: boolean;
  hospitalId: number;
  units: {
    police: UnitDispatch;
    ambulance: UnitDispatch;
    fire: UnitDispatch;
    tow: UnitDispatch;
  };
  createdAt: number;
  clearStartAt: number;
  clearDuration: number;
  timeoutAt: number;
  edgeName: string;
  districtName: string;
}

const KIND_LABEL: Record<RoadIncidentKind, string> = {
  breakdown: 'Pane mecânica',
  minor_crash: 'Colisão leve',
  major_crash: 'Acidente grave',
  ped_crash: 'Atropelamento',
};

const STAGE_LABEL: Record<RoadIncidentStage, string> = {
  active: 'aguardando atendimento',
  responding: 'equipes a caminho / no local',
  clearing: 'remoção e liberação da via',
};

interface PendingEvac {
  citizenId: number;
  citizenGen: number;
  hospitalId: number;
  incidentId: number;
  vehGen: number;
  retries: number;
  deadline: number;
  lastX: number;
  lastZ: number;
}

/**
 * Emergent road safety, traffic incidents, temporary lane/road closures,
 * coordinated emergency & tow-truck response, and fail-safe clearance.
 */
export class RoadIncidents {
  active = new Map<number, RoadIncident>();
  /** ambulances currently transporting an injured citizen to a hospital, keyed by vehicle slot */
  private evacs = new Map<number, PendingEvac>();
  /** citizen IDs currently under active ambulance evacuation (blocks virtual arrival into hospital) */
  private evacCitizens = new Set<number>();
  private nextId = 1;
  private checkAccum = 0;
  private lastCreatedAt = -1e9;
  dirty = true;

  // Diagnostic counters
  totalCrashes = 0;
  minorCrashes = 0;
  majorCrashes = 0;
  pedCrashes = 0;
  breakdowns = 0;
  emergencyDispatches = 0;
  ambulanceEvacuations = 0;
  towRemovals = 0;
  incidentsResolved = 0;
  failSafeResolutions = 0;

  constructor(private w: World) {}

  /** Returns true while citizen `cid` is actively being evacuated by an ambulance (prevents virtual hospital arrival). */
  isCitizenEvacuating(cid: number): boolean {
    return this.evacCitizens.has(cid);
  }

  /** Live world pose of the ambulance currently evacuating `cid`, or null if not being evacuated. */
  evacPose(cid: number): { x: number; y: number; z: number; h: number } | null {
    if (!this.evacCitizens.has(cid)) return null;
    const w = this.w, T = w.traffic, C = w.citizens;
    if (cid < 0 || !C.alive[cid]) return null;
    for (const [slot, ev] of this.evacs) {
      if (ev.citizenId !== cid || ev.citizenGen !== C.gen[cid]) continue;
      if (T.active[slot] === 1 && (ev.vehGen < 0 || T.gen[slot] === ev.vehGen)) {
        const curE = w.roads.edges[T.edge[slot]];
        if (curE?.alive) {
          T.computePose(slot);
          if (Number.isFinite(T.x[slot]) && Number.isFinite(T.z[slot])) {
            ev.lastX = T.x[slot];
            ev.lastZ = T.z[slot];
            return { x: T.x[slot], y: T.y[slot], z: T.z[slot], h: T.h[slot] };
          }
        }
      }
      const y = Math.max(0.2, w.terrain.heightAt(ev.lastX, ev.lastZ)) + 0.5;
      return { x: ev.lastX, y, z: ev.lastZ, h: 0 };
    }
    return null;
  }

  private registerEvac(slot: number, ev: PendingEvac) {
    this.evacs.set(slot, ev);
    this.evacCitizens.add(ev.citizenId);
  }

  private removeEvac(slot: number): PendingEvac | undefined {
    const ev = this.evacs.get(slot);
    if (!ev) return undefined;
    this.evacs.delete(slot);
    this.evacCitizens.delete(ev.citizenId);
    return ev;
  }

  step(dt: number) {
    // 1. Update active incidents (clearing progress & fail-safe timeouts)
    for (const inc of [...this.active.values()]) {
      this.stepIncident(inc);
    }
    // 2. Monitor active ambulance evacuations (lost vehicle / removed road / deadline timeout)
    this.stepEvacs();
    // 3. Emergent incident checks every 10 sim seconds
    this.checkAccum += dt;
    if (this.checkAccum < 10) return;
    this.checkAccum = 0;
    this.maybeGenerateEmergent();
  }

  private stepEvacs() {
    if (!this.evacs.size) return;
    const w = this.w, T = w.traffic, C = w.citizens;
    for (const [slot, ev] of [...this.evacs.entries()]) {
      const aliveSameVeh = T.active[slot] === 1
        && (ev.vehGen < 0 || T.gen[slot] === ev.vehGen)
        && T.pKind[slot] === P_INCIDENT
        && T.pAux[slot] === INC_ROLE_EVAC_HOSPITAL;
      if (ev.citizenId < 0 || !C.alive[ev.citizenId] || C.gen[ev.citizenId] !== ev.citizenGen) {
        this.removeEvac(slot);
        // Never leave an orphan ambulance driving with a removed/deceased patient
        if (aliveSameVeh) T.despawn(slot);
        continue;
      }
      if (!aliveSameVeh) {
        this.removeEvac(slot);
        this.handleEvacInterrupted(ev, ev.lastX, ev.lastZ, -1);
        continue;
      }
      const curE = w.roads.edges[T.edge[slot]];
      if (curE?.alive) {
        T.computePose(slot);
        if (Number.isFinite(T.x[slot]) && Number.isFinite(T.z[slot])) {
          ev.lastX = T.x[slot];
          ev.lastZ = T.z[slot];
        }
      }
      if (w.t >= ev.deadline) {
        this.removeEvac(slot);
        T.despawn(slot);
        this.completeFieldStabilization(ev.citizenId, ev.citizenGen, ev.lastX, ev.lastZ, 'evac_timeout');
      }
    }
  }

  private maxConcurrent(): number {
    return Math.min(4, 1 + this.w.era);
  }

  private maybeGenerateEmergent() {
    const w = this.w, T = w.traffic, r = w.rng;
    const freq = w.params.incidentFreq ?? 1;
    if (freq <= 0) return;
    if (w.day < 1 || T.count < 12) return;
    if (this.active.size >= this.maxConcurrent()) return;
    if (w.t - this.lastCreatedAt < 180) return;

    const rain = w.weather.rain;
    const fog = w.weather.fog;
    const weatherRisk = 1 + rain * 2.4 + fog * 1.4;
    const trafficScale = Math.max(0.35, Math.min(1.8, T.count / 150));

    // 1. Mechanical breakdowns (driven by real carWear / bus fleetWear)
    if (r.next() < 0.0085 * trafficScale * freq) {
      const cand = this.pickBreakdownCandidate();
      if (cand >= 0 && this.triggerBreakdown(cand)) return;
    }

    // 2. Rare car-pedestrian crash (higher in rain/fog near crosswalks/traffic)
    if (w.peds.count >= 12 && r.next() < 0.0028 * weatherRisk * Math.min(1.5, trafficScale) * freq) {
      const pair = this.pickPedCrashPair();
      if (pair && this.triggerPedCrash(pair.vehSlot, pair.pedSlot)) return;
    }

    // 3. Car-car collision under real risk conditions (weather, speed, braking, volume)
    if (r.next() < 0.0050 * weatherRisk * trafficScale * freq) {
      const cand = this.pickCrashCandidate();
      if (cand >= 0) {
        const major = r.next() < (0.24 + rain * 0.14 + (T.v[cand] > 11 ? 0.15 : 0));
        this.triggerCrash(cand, major ? 'major_crash' : 'minor_crash');
      }
    }
  }

  private isEdgeEligible(e: REdge | undefined, dir: number, s: number): boolean {
    if (!e || !e.alive || e.progress < 1) return false;
    if (e.bridge || e.tunnel || e.elevated || e.deck !== undefined) return false;
    if (e.len < 42) return false;
    if (this.w.traffic.closedCrossings.has(e.id)) return false;
    // Never stack two incidents on the same road edge
    for (const inc of this.active.values()) if (inc.edge === e.id) return false;
    const ss = this.w.traffic.sStart(e, dir);
    const se = this.w.traffic.sEnd(e, dir);
    return s > ss + 14 && s < se - 14;
  }

  /** Urban crosswalk-aware edge eligibility for pedestrian conflicts (allows approaching within ~5 m of ends while staying outside junction boxes). */
  private isPedCrashEdgeEligible(e: REdge | undefined, dir: number, s: number): boolean {
    if (!e || !e.alive || e.progress < 1) return false;
    if (e.cls === RoadClass.Highway) return false;
    if (e.bridge || e.tunnel || e.elevated || e.deck !== undefined) return false;
    if (e.len < 24) return false;
    if (this.w.traffic.closedCrossings.has(e.id)) return false;
    for (const inc of this.active.values()) if (inc.edge === e.id) return false;
    const ss = this.w.traffic.sStart(e, dir);
    const se = this.w.traffic.sEnd(e, dir);
    return s > ss + 4.5 && s < se - 4.5;
  }

  private isCivilianVehicle(slot: number): boolean {
    const T = this.w.traffic;
    if (!T.active[slot] || T.incidentId[slot] >= 0 || T.jnode[slot] >= 0 || T.dwell[slot] > 0) return false;
    const ty = T.type[slot];
    if (ty === VType.Police || ty === VType.Ambulance || ty === VType.Fire || ty === VType.Tow || ty === VType.Hearse) return false;
    if (T.pKind[slot] === P_INCIDENT) return false;
    return true;
  }

  private pickBreakdownCandidate(): number {
    const w = this.w, T = w.traffic, C = w.citizens, r = w.rng;
    let best = -1, bestScore = 0;
    const stride = Math.max(1, Math.floor(T.max / 40));
    const offset = r.int(0, stride - 1);
    for (let i = offset; i < T.max; i += stride) {
      if (!this.isCivilianVehicle(i)) continue;
      const e = w.roads.edges[T.edge[i]];
      if (!this.isEdgeEligible(e, T.dir[i], T.s[i])) continue;
      let wear = 0;
      if (T.pKind[i] === P_CITIZEN && T.type[i] === VType.Car) {
        const cid = T.pId[i];
        const h = cid >= 0 && C.alive[cid] ? C.households.get(C.hh[cid]) : null;
        if (h?.car) wear = h.carWear;
      } else if (T.pKind[i] === P_BUS) {
        const line = w.transitSys.lines.find((l) => l.id === T.pId[i]);
        if (line) wear = line.fleetWear ?? 0;
      }
      if (wear < 0.36) continue;
      const excess = wear - 0.32;
      const score = excess * excess * (0.5 + r.next());
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  private pickCrashCandidate(): number {
    const w = this.w, T = w.traffic, R = w.roads, r = w.rng;
    let best = -1, bestScore = 0;
    const stride = Math.max(1, Math.floor(T.max / 48));
    const offset = r.int(0, stride - 1);
    for (let i = offset; i < T.max; i += stride) {
      if (!this.isCivilianVehicle(i) || T.v[i] < 3.5) continue;
      const e = R.edges[T.edge[i]];
      if (!this.isEdgeEligible(e, T.dir[i], T.s[i])) continue;
      const vc = e.volume[T.dir[i]] / Math.max(1, R.capacity(e));
      const braking = (T.flags[i] & VEH_FLAG_BRAKE) !== 0 ? 1.8 : 1.0;
      const speedF = Math.min(2.2, T.v[i] / 7);
      const score = (0.35 + vc) * braking * speedF * (0.6 + r.next() * 0.8);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  pickPedCrashPair(): { vehSlot: number; pedSlot: number } | null {
    const w = this.w, T = w.traffic, P = w.peds, C = w.citizens, r = w.rng;
    const vehCands: number[] = [];
    const vStride = T.count > 120 ? Math.max(1, Math.floor(T.max / 90)) : 1;
    const vOff = vStride > 1 ? r.int(0, vStride - 1) : 0;
    for (let i = vOff; i < T.max; i += vStride) {
      if (!this.isCivilianVehicle(i) || T.v[i] < 2.5) continue;
      const e = w.roads.edges[T.edge[i]];
      if (!this.isPedCrashEdgeEligible(e, T.dir[i], T.s[i])) continue;
      T.computePose(i);
      vehCands.push(i);
    }
    if (!vehCands.length) return null;
    const pStride = P.count > 240 ? Math.max(1, Math.floor(P.max / 220)) : 1;
    const pOff = pStride > 1 ? r.int(0, pStride - 1) : 0;
    for (let p = pOff; p < P.max; p += pStride) {
      if (!P.active[p] || !Number.isFinite(P.arrive[p])) continue;
      const cid = P.citizen[p];
      if (cid < 0 || !C.alive[cid] || C.state[cid] !== ST_WALK || C.slot[cid] !== p) continue;
      P.pose(p);
      const px = P.x[p], py = P.y[p], pz = P.z[p];
      const phx = Math.cos(P.h[p]), phz = Math.sin(P.h[p]);
      const pSpeed = P.speed[p];
      for (const v of vehCands) {
        const dx = px - T.x[v];
        const dz = pz - T.z[v];
        // Cheap horizontal proximity pre-filter
        if (dx * dx + dz * dz > 16 * 16) continue;
        // 1. Strict 3D vertical level match (rejects viaducts/underpasses)
        if (Math.abs(T.y[v] - py) >= 2.0) continue;
        // 2. Real roadway / crossing trajectory conflict in the vehicle's forward frame (strictly rejecting diverging trajectories)
        const fx = Math.cos(T.h[v]), fz = Math.sin(T.h[v]);
        const rx = -fz, rz = fx;
        const along = dx * fx + dz * fz;
        if (along < 0.5) continue; // must be ahead of the vehicle
        const lat = dx * rx + dz * rz;
        const absLat = Math.abs(lat);
        const hl = T.len[v] * 0.5;
        const vt = T.type[v];
        const halfW = vt === VType.Moto
          ? 0.55
          : vt === VType.Bus || vt === VType.Truck || vt === VType.TourBus || vt === VType.SchoolBus
            ? 1.3
            : 0.95;
        const longVel = (phx * fx + phz * fz) * pSpeed;
        const latVel = (phx * rx + phz * rz) * pSpeed;
        const vRel = T.v[v] - longVel;
        if (vRel <= 0.25) continue; // vehicle is not closing on the pedestrian

        const tLongMin = Math.max(0, (along - (hl + 0.35)) / vRel);
        const tLongMax = (along + (hl + 0.35)) / vRel;
        if (tLongMin > 1.5) continue;

        // Case 1: Pedestrian is ALREADY within the vehicle's actual body width AND remains inside at impact time tHit
        const maxDirectLong = Math.min(10.0, Math.max(5.0, hl + T.v[v] * 0.85));
        if (along <= maxDirectLong && absLat <= halfW + 0.25) {
          const tHit = Math.max(0, Math.min(1.5, Math.max(0, along - hl) / Math.max(0.5, vRel)));
          if (Math.abs(lat + latVel * tHit) <= halfW + 0.35) {
            return { vehSlot: v, pedSlot: p };
          }
        }

        // Case 2: Pedestrian is actively moving TOWARD the vehicle's travel lane (never diverging/parallel!)
        // and the lateral lane-crossing time interval overlaps the vehicle's longitudinal arrival interval in [0.05, 1.5] s
        if (lat * latVel < -0.15) {
          const latBand = halfW + 0.35;
          const absLatVel = Math.abs(latVel);
          const tLatMin = Math.max(0, (absLat - latBand) / absLatVel);
          const tLatMax = (absLat + latBand) / absLatVel;
          const tEnter = Math.max(0.05, tLatMin, tLongMin);
          const tExit = Math.min(1.5, tLatMax, tLongMax);
          if (tEnter <= tExit) {
            return { vehSlot: v, pedSlot: p };
          }
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ creation & immobilization

  /** Trigger a mechanical breakdown on an active vehicle slot. */
  triggerBreakdown(slot: number): RoadIncident | null {
    const w = this.w, T = w.traffic;
    if (!T.active[slot] || T.incidentId[slot] >= 0) return null;
    const e = w.roads.edges[T.edge[slot]];
    if (!e || !e.alive) return null;
    const dir = T.dir[slot];
    const lane = T.lane[slot];
    const s = T.s[slot];
    const fullClosure = e.lanes <= 1;

    const inc = this.createBaseIncident('breakdown', e, dir, lane, s, fullClosure);
    const inv = this.immobilizeVehicle(slot, inc, true, false);
    if (!inv) return null;
    inc.vehicles.push(slot);
    inc.involved.push(inv);
    inc.units.tow.required = true;
    inc.clearDuration = 12;
    inc.timeoutAt = w.t + 190;

    this.active.set(inc.id, inc);
    this.syncBlockage(inc);
    this.breakdowns++;
    this.lastCreatedAt = w.t;
    this.dirty = true;

    const vehLabel = inv.busLineId >= 0 ? 'Ônibus' : 'Veículo';
    w.events.emit(
      'breakdown',
      inc.x,
      inc.z,
      0.45,
      `${vehLabel} sofre pane mecânica em ${inc.edgeName} (${inc.districtName}) — guincho acionado`,
      { entity: { kind: 'vehicle', id: slot, gen: inv.gen }, ref: inc.edge, visual: 0.7 },
    );

    this.dispatchUnits(inc);
    return inc;
  }

  /** Trigger a car-car collision ('minor_crash' or 'major_crash') centered on `slot`. */
  triggerCrash(slot: number, kind: 'minor_crash' | 'major_crash' = 'minor_crash'): RoadIncident | null {
    const w = this.w, T = w.traffic;
    if (!T.active[slot] || T.incidentId[slot] >= 0) return null;
    const e = w.roads.edges[T.edge[slot]];
    if (!e || !e.alive) return null;
    const dir = T.dir[slot];
    const lane = T.lane[slot];
    const s = T.s[slot];
    const fullClosure = kind === 'major_crash' || e.lanes <= 1;

    const inc = this.createBaseIncident(kind, e, dir, lane, s, fullClosure);

    // Optionally involve one nearby vehicle in the same lane/direction (strictly keeping existing non-overlapping positions)
    let secondSlot = -1;
    let bestD = 18;
    for (let o = 0; o < T.max; o++) {
      if (o === slot || !this.isCivilianVehicle(o)) continue;
      if (T.edge[o] !== e.id || T.dir[o] !== dir || T.lane[o] !== lane) continue;
      const d = Math.abs(T.s[o] - s);
      if (d < bestD) { bestD = d; secondSlot = o; }
    }

    const wantInjury = kind === 'major_crash' || w.rng.chance(0.4);
    const hasLivingDriver = (sId: number) => {
      if (sId < 0 || !T.active[sId] || T.pKind[sId] !== P_CITIZEN) return false;
      const cid = T.pId[sId];
      return cid >= 0 && w.citizens.alive[cid] === 1 && w.citizens.state[cid] === ST_CAR && w.citizens.slot[cid] === sId;
    };
    const skipWalk1 = wantInjury && hasLivingDriver(slot);
    const skipWalk2 = wantInjury && !skipWalk1 && hasLivingDriver(secondSlot);

    const inv1 = this.immobilizeVehicle(slot, inc, false, kind === 'major_crash', skipWalk1);
    if (!inv1) return null;
    inc.vehicles.push(slot);
    inc.involved.push(inv1);
    if (secondSlot >= 0) {
      const inv2 = this.immobilizeVehicle(secondSlot, inc, false, kind === 'major_crash', skipWalk2);
      if (inv2) {
        inc.vehicles.push(secondSlot);
        inc.involved.push(inv2);
      }
    }

    // Injure a citizen driver in major crashes (or ~40% of minor crashes)
    if (wantInjury) {
      const driverInv = inc.involved.find((v) => v.citizenId >= 0 && w.citizens.alive[v.citizenId]);
      if (driverInv) {
        const cid = driverInv.citizenId;
        // Defensive cleanup: if any walking pedestrian exists for this citizen, despawn it before holding for ambulance
        if (w.citizens.state[cid] === ST_WALK && w.citizens.slot[cid] >= 0) {
          const ps = w.citizens.slot[cid];
          if (w.peds.active[ps] && w.peds.citizen[ps] === cid) w.peds.despawn(ps);
        }
        w.citizens.health[cid] = Math.max(0.15, w.citizens.health[cid] - (kind === 'major_crash' ? 0.38 : 0.24));
        inc.injuredCitizen = cid;
        inc.injuredGen = w.citizens.gen[cid];
        inc.injuredWasPed = false;
        // Hold injured citizen safely in virtual wait until ambulance evacuates them to hospital
        w.citizens.state[cid] = ST_VIRTUAL;
        w.citizens.slot[cid] = -1;
        w.citizens.vFromX[cid] = inc.x;
        w.citizens.vFromZ[cid] = inc.z;
        w.citizens.vStartT[cid] = w.t;
        w.citizens.vEndT[cid] = w.t + 600;
        w.citizens.schedule(cid, w.t + 600);
      }
    }

    inc.units.police.required = true;
    inc.units.tow.required = true;
    inc.units.ambulance.required = inc.injuredCitizen >= 0;
    inc.units.fire.required = kind === 'major_crash';
    inc.clearDuration = kind === 'major_crash' ? 18 : 14;
    inc.timeoutAt = w.t + (kind === 'major_crash' ? 240 : 210);

    this.active.set(inc.id, inc);
    this.syncBlockage(inc);
    this.totalCrashes++;
    if (kind === 'major_crash') this.majorCrashes++; else this.minorCrashes++;
    this.lastCreatedAt = w.t;
    this.dirty = true;

    const headline = kind === 'major_crash'
      ? `Acidente grave interdita ${inc.edgeName} em ${inc.districtName}`
      : undefined;
    w.events.emit(
      'accident',
      inc.x,
      inc.z,
      kind === 'major_crash' ? 0.9 : 0.6,
      `${KIND_LABEL[kind]} em ${inc.edgeName} (${inc.districtName})${inc.fullClosure ? ' — via interditada' : ' — faixa bloqueada'}`,
      { headline, entity: { kind: 'vehicle', id: slot, gen: inv1.gen }, ref: inc.edge, visual: 0.95 },
    );

    this.dispatchUnits(inc);
    return inc;
  }

  /** Trigger a car-pedestrian accident injuring the pedestrian and dispatching Police + Ambulance (+ Tow). */
  triggerPedCrash(vehSlot: number, pedSlot: number): RoadIncident | null {
    const w = this.w, T = w.traffic, P = w.peds, C = w.citizens;
    if (!T.active[vehSlot] || T.incidentId[vehSlot] >= 0) return null;
    if (!P.active[pedSlot]) return null;
    const pedCid = P.citizen[pedSlot];
    if (pedCid < 0 || !C.alive[pedCid] || C.state[pedCid] !== ST_WALK || C.slot[pedCid] !== pedSlot) return null;
    const e = w.roads.edges[T.edge[vehSlot]];
    if (!e || !e.alive) return null;
    T.computePose(vehSlot);
    P.pose(pedSlot);
    if (Math.abs(T.y[vehSlot] - P.y[pedSlot]) >= 2.5) return null;

    const dir = T.dir[vehSlot];
    const lane = T.lane[vehSlot];
    const s = T.s[vehSlot];
    const inc = this.createBaseIncident('ped_crash', e, dir, lane, s, true);
    const inv = this.immobilizeVehicle(vehSlot, inc, false, false);
    if (!inv) return null;
    inc.vehicles.push(vehSlot);
    inc.involved.push(inv);

    // Injure pedestrian and hold them safely at the scene for Ambulance pickup (marked WAITING so animation stops)
    C.health[pedCid] = Math.max(0.15, C.health[pedCid] - 0.36);
    P.hold(pedSlot);
    P.flags[pedSlot] |= PED_FLAG_WAITING;
    inc.injuredCitizen = pedCid;
    inc.injuredGen = C.gen[pedCid];
    inc.injuredWasPed = true;

    inc.units.police.required = true;
    inc.units.ambulance.required = true;
    inc.units.tow.required = true;
    inc.clearDuration = 14;
    inc.timeoutAt = w.t + 220;

    this.active.set(inc.id, inc);
    this.syncBlockage(inc);
    this.totalCrashes++;
    this.pedCrashes++;
    this.lastCreatedAt = w.t;
    this.dirty = true;

    w.events.emit(
      'accident',
      inc.x,
      inc.z,
      0.82,
      `Atropelamento em ${inc.edgeName} (${inc.districtName}): ${C.name(pedCid)} aguarda socorro`,
      { headline: `Atropelamento em ${inc.edgeName} mobiliza polícia e ambulância`, entity: { kind: 'vehicle', id: vehSlot, gen: inv.gen }, ref: inc.edge, visual: 0.9 },
    );

    this.dispatchUnits(inc);
    return inc;
  }

  /** Inject an emergent-style incident on the busiest eligible urban road (for UI/event injection or field capture). */
  injectIncident(kind: RoadIncidentKind = 'major_crash'): RoadIncident | null {
    const w = this.w, T = w.traffic;
    let best = -1, bestScore = -1;
    for (let i = 0; i < T.max; i++) {
      if (!this.isCivilianVehicle(i)) continue;
      const e = w.roads.edges[T.edge[i]];
      if (!this.isEdgeEligible(e, T.dir[i], T.s[i])) continue;
      const dCenter = Math.hypot(w.roads.nodes[e.a].x - w.center.x, w.roads.nodes[e.a].z - w.center.z);
      const score = (e.lanes >= 2 ? 30 : 10) + T.v[i] * 2 - dCenter * 0.02;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) return null;
    if (kind === 'breakdown') return this.triggerBreakdown(best);
    if (kind === 'ped_crash') {
      const pair = this.pickPedCrashPair();
      if (pair) return this.triggerPedCrash(pair.vehSlot, pair.pedSlot);
      return this.triggerCrash(best, 'minor_crash');
    }
    return this.triggerCrash(best, kind);
  }

  private createBaseIncident(kind: RoadIncidentKind, e: REdge, dir: number, lane: number, s: number, fullClosure: boolean): RoadIncident {
    const w = this.w;
    const p = w.traffic.point(e, dir, lane, s, kind === 'breakdown' ? 0.65 : 0);
    const emptyUnit = (): UnitDispatch => ({ slot: -1, gen: -1, stationId: -1, arrived: false, required: false });
    return {
      id: this.nextId++,
      kind,
      edge: e.id,
      dir,
      lane,
      s,
      x: p[0],
      y: p[1],
      z: p[2],
      angle: p[3],
      fullClosure,
      stage: 'active',
      vehicles: [],
      involved: [],
      injuredCitizen: -1,
      injuredGen: -1,
      injuredWasPed: false,
      hospitalId: -1,
      units: { police: emptyUnit(), ambulance: emptyUnit(), fire: emptyUnit(), tow: emptyUnit() },
      createdAt: w.t,
      clearStartAt: -1,
      clearDuration: 14,
      timeoutAt: w.t + 220,
      edgeName: e.name,
      districtName: w.districtName(p[0], p[2]),
    };
  }

  private immobilizeVehicle(slot: number, inc: RoadIncident, isBreakdown: boolean, severeDamage: boolean, skipWalk = false): InvolvedVehicle | null {
    const w = this.w, T = w.traffic, C = w.citizens;
    if (!T.active[slot]) return null;
    T.computePose(slot);
    const vx = T.x[slot], vz = T.z[slot];
    const type = T.type[slot] as VType;
    const gen = T.gen[slot];
    let citizenId = -1;
    let hhId = -1;
    let busLineId = -1;

    if (T.pKind[slot] === P_CITIZEN) {
      const cid = T.pId[slot];
      if (cid >= 0 && C.alive[cid] && C.state[cid] === ST_CAR && C.slot[cid] === slot) {
        citizenId = cid;
        const h = C.households.get(C.hh[cid]);
        if (h && h.car && h.carUser === cid) {
          hhId = h.id;
        }
        // Detach citizen from the disabled car slot; if uninjured they walk or continue virtually.
        // If `skipWalk` is true, triggerCrash immediately holds the injured driver in ST_VIRTUAL for Ambulance pickup.
        C.slot[cid] = -1;
        if (!skipWalk) {
          if (!C.switchToWalk(cid, vx, vz)) {
            C.virtualArrive(cid, Math.max(40, T.remainingTime(slot)), vx, vz);
          }
        }
        // Lock the disabled household car until towed & repaired (never allow instant clone!)
        if (h && hhId >= 0) {
          h.carUser = -1;
          h.carLoc = -1;
          h.carDriver = -1;
          h.carRepairUntil = w.t + HOUR_SECONDS * 24;
        }
      }
    } else if (T.pKind[slot] === P_BUS) {
      busLineId = T.pId[slot];
      w.transitSys.evacuateBus(slot);
    }

    // Immobilize the vehicle physically at the scene with flashing hazard lights
    T.incidentId[slot] = inc.id;
    T.pKind[slot] = P_INCIDENT;
    T.pId[slot] = inc.id;
    T.pAux[slot] = isBreakdown ? 99 : 98;
    T.v[slot] = 0;
    T.stuck[slot] = 0;
    T.legitWait[slot] = 1;
    T.flags[slot] |= VEH_FLAG_HAZARD;
    T.flags[slot] &= ~VEH_FLAG_SIREN;

    return { slot, gen, type, citizenId, hhId, busLineId, severeDamage };
  }

  // ------------------------------------------------------------------ blockage & routing sync

  private syncBlockage(inc: RoadIncident) {
    const T = this.w.traffic, R = this.w.roads;
    const e = R.edges[inc.edge];
    if (!e || !e.alive) return;
    const blk: RoadBlockage = {
      incidentId: inc.id,
      edge: inc.edge,
      dir: inc.dir,
      lane: inc.lane,
      s: inc.s,
      len: inc.kind === 'major_crash' ? 16 : 12,
      fullClosure: inc.fullClosure,
    };
    const addBlk = (de: number, b: RoadBlockage) => {
      let list = T.blockages.get(de);
      if (!list) T.blockages.set(de, (list = []));
      list.push(b);
    };
    const de = inc.edge * 2 + inc.dir;
    addBlk(de, blk);
    R.setIncidentPenalty(de, inc.fullClosure ? 900 : 65);
    // Major crash on a narrow 1-lane-per-direction two-way street blocks both directions
    if (inc.fullClosure && inc.kind === 'major_crash' && !e.oneway && e.lanes <= 1) {
      const oppDe = inc.edge * 2 + (1 - inc.dir);
      addBlk(oppDe, { ...blk, dir: 1 - inc.dir, s: e.len - inc.s });
      R.setIncidentPenalty(oppDe, 900);
    }
  }

  private clearBlockage(inc: RoadIncident) {
    const T = this.w.traffic, R = this.w.roads;
    for (const dir of [0, 1]) {
      const de = inc.edge * 2 + dir;
      const list = T.blockages.get(de);
      if (!list) continue;
      const next = list.filter((b) => b.incidentId !== inc.id);
      if (next.length) T.blockages.set(de, next);
      else T.blockages.delete(de);
      if (!next.length) R.setIncidentPenalty(de, 0);
      else R.setIncidentPenalty(de, next.some((b) => b.fullClosure) ? 900 : 65);
    }
  }

  // ------------------------------------------------------------------ coordinated unit dispatch

  private findStation(kinds: string[], x: number, z: number): Building | null {
    let best: Building | null = null, bd = Infinity;
    for (const b of this.w.buildings.list) {
      if (!b.alive || b.state !== 'done' || b.abandoned) continue;
      if (!kinds.includes(b.kind)) continue;
      const d = Math.hypot(b.x - x, b.z - z);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  private planToIncident(from: Building | null, inc: RoadIncident, role = INC_ROLE_TOW): CarPlan | null {
    const w = this.w, R = w.roads;
    const te = R.edges[inc.edge];
    if (!te || !te.alive || te.progress < 1) return null;
    const incDe = te.id * 2 + inc.dir;
    const incTail = inc.dir === 0 ? te.a : te.b;
    // Stagger responder staging distances realistically: ambulance & tow closest to scene, fire & police securing upstream perimeter
    const roleBack = role === INC_ROLE_AMBULANCE ? 7.5 : role === INC_ROLE_TOW ? 8.5 : role === INC_ROLE_FIRE ? 14.5 : 17.5;
    const targetS = Math.max(w.traffic.sStart(te, inc.dir) + 3, inc.s - roleBack);
    const targetT = inc.dir === 0 ? targetS / Math.max(1, te.len) : 1 - targetS / Math.max(1, te.len);
    const clampedTargetT = Math.max(0.02, Math.min(0.98, targetT));

    // Temporarily lift THIS incident's own routing penalty on (inc.edge, inc.dir) so responders
    // route upstream along the SAME carriageway (critical on divided avenues/highways with central medians).
    const savedPen = R.incidentPenalty.get(incDe) ?? 0;
    const liftPenalty = savedPen > 0;
    if (liftPenalty) {
      R.setIncidentPenalty(incDe, 0);
      R.invalidateTree(incTail);
    }

    const planSameDirFromEdge = (fe: REdge, fromT: number): CarPlan | null => {
      if (fe.id === te.id) {
        const fromS = inc.dir === 0 ? fromT * te.len : (1 - fromT) * te.len;
        if (fromS < targetS - 2) {
          return { path: [incDe], startS: fromS, destS: targetS, time: (targetS - fromS) / R.freeSpeed(te) };
        }
      }
      const tryDirs = fe.oneway ? [0] : [0, 1];
      let best: CarPlan | null = null;
      for (const dirO of tryDirs) {
        const head = dirO === 0 ? fe.b : fe.a;
        const startS = dirO === 0 ? fromT * fe.len : (1 - fromT) * fe.len;
        const mid = R.route(head, incTail, 500, true);
        if (!mid) continue;
        const path = [fe.id * 2 + dirO, ...mid, incDe];
        if (mid.length && (mid[0] >> 1) === fe.id) path.splice(0, 2, mid[0]);
        if (!R.validPath(path)) continue;
        const s0 = (path[0] >> 1) === fe.id ? ((path[0] & 1) === dirO ? startS : fe.len - startS) : 0;
        const time = R.pathTime(path);
        if (!best || time < best.time) {
          best = { path, startS: s0, destS: targetS, time };
        }
      }
      return best;
    };

    try {
      if (from) {
        const fe = R.edges[from.edge];
        if (fe && fe.alive && fe.progress >= 1) {
          const sameDir = planSameDirFromEdge(fe, from.edgeT);
          if (sameDir) return sameDir;
          if (te.cls < RoadClass.Avenue) {
            const plan = carPlanEdges(R, fe, from.edgeT, te, clampedTargetT, from.x, from.z, inc.x, inc.z);
            if (plan) return this.adjustPlanForIncidentDir(plan, te, inc.dir, targetS);
          }
        }
      }
      // Fallback for Era 0 tow service when no depot/station exists yet: dispatch from a nearby road node
      const nodes = R.nodesNear(inc.x, inc.z, 550).filter((n) => n.edges.some((id) => R.edges[id]?.alive && R.edges[id].progress >= 1));
      for (const n of nodes) {
        if (Math.hypot(n.x - inc.x, n.z - inc.z) < 65) continue;
        const fe = n.edges.map((id) => R.edges[id]).find((q) => q.alive && q.progress >= 1 && q.id !== te.id && (!q.oneway || q.a === n.id));
        if (!fe) continue;
        const t0 = fe.a === n.id ? 0.05 : 0.95;
        const sameDir = planSameDirFromEdge(fe, t0);
        if (sameDir) return sameDir;
        if (te.cls < RoadClass.Avenue) {
          const plan = carPlanEdges(R, fe, t0, te, clampedTargetT, n.x, n.z, inc.x, inc.z);
          if (plan) return this.adjustPlanForIncidentDir(plan, te, inc.dir, targetS);
        }
      }
      return null;
    } finally {
      if (liftPenalty) {
        R.setIncidentPenalty(incDe, savedPen);
        R.invalidateTree(incTail);
      }
    }
  }

  private adjustPlanForIncidentDir(plan: CarPlan, te: REdge, dir: number, targetS: number): CarPlan {
    const lastDe = plan.path[plan.path.length - 1];
    if ((lastDe >> 1) === te.id) {
      const lastDir = lastDe & 1;
      const destS = lastDir === dir ? targetS : Math.max(4, te.len - targetS - 6);
      return { ...plan, destS };
    }
    return plan;
  }

  private dispatchUnits(inc: RoadIncident) {
    const w = this.w, T = w.traffic;
    let anyDispatched = false;

    const sendUnit = (
      unit: UnitDispatch,
      vtype: VType,
      role: number,
      stationKinds: string[],
      flags: number,
      allowNodeFallback: boolean,
    ) => {
      if (!unit.required) return;
      const st = this.findStation(stationKinds, inc.x, inc.z);
      if (!st && !allowNodeFallback) {
        // Era 0 or missing service station: cannot block clearance indefinitely
        unit.required = false;
        return;
      }
      const plan = this.planToIncident(st, inc, role);
      if (!plan) {
        unit.required = false;
        return;
      }
      const slot = T.spawn(vtype, plan.path, plan.startS, plan.destS, { kind: P_INCIDENT, id: inc.id, aux: role }, st?.id ?? -1, -1, flags);
      if (slot >= 0) {
        unit.slot = slot;
        unit.gen = T.gen[slot];
        unit.stationId = st?.id ?? -1;
        anyDispatched = true;
        this.emergencyDispatches++;
      } else {
        unit.required = false;
      }
    };

    sendUnit(inc.units.police, VType.Police, INC_ROLE_POLICE, ['police'], VEH_FLAG_SIREN, false);
    if (inc.units.ambulance.required) {
      const hosp = this.findStation(['hospital', 'clinic'], inc.x, inc.z);
      inc.hospitalId = hosp?.id ?? -1;
      sendUnit(inc.units.ambulance, VType.Ambulance, INC_ROLE_AMBULANCE, ['hospital', 'clinic'], VEH_FLAG_SIREN, false);
    }
    sendUnit(inc.units.fire, VType.Fire, INC_ROLE_FIRE, ['fire'], VEH_FLAG_SIREN, false);
    sendUnit(
      inc.units.tow,
      VType.Tow,
      INC_ROLE_TOW,
      ['busDepot', 'warehouse', 'factory', 'police', 'fire', 'cityHall'],
      VEH_FLAG_HAZARD,
      true,
    );

    if (anyDispatched) inc.stage = 'responding';
    else {
      // No unit could be spawned (e.g., tiny disconnected road): start bounded self-clearing countdown
      inc.stage = 'clearing';
      inc.clearStartAt = w.t;
    }
  }

  // ------------------------------------------------------------------ responder callbacks

  unitArrived(slot: number) {
    const w = this.w, T = w.traffic;
    const role = T.pAux[slot];
    const incId = T.pId[slot];

    // 1. Ambulance completed hospital delivery of injured citizen
    if (role === INC_ROLE_EVAC_HOSPITAL) {
      const ev = this.removeEvac(slot);
      if (!ev) return;
      const hosp = ev.hospitalId >= 0 ? w.buildings.byId.get(ev.hospitalId) : undefined;
      if (hosp && hosp.alive && hosp.state === 'done' && !hosp.abandoned) {
        this.completeHospitalTreatment(ev.citizenId, ev.citizenGen, hosp.id);
      } else {
        // Destination hospital was demolished/abandoned/closed mid-transport: re-route to another operational hospital or stabilize in field
        const curE = w.roads.edges[T.edge[slot]];
        if (curE?.alive) T.computePose(slot);
        const ax = curE?.alive && Number.isFinite(T.x[slot]) ? T.x[slot] : ev.lastX;
        const az = curE?.alive && Number.isFinite(T.z[slot]) ? T.z[slot] : ev.lastZ;
        this.handleEvacInterrupted(ev, ax, az, slot);
      }
      return;
    }
    // 2. Unit finished returning to base
    if (role === INC_ROLE_RETURN_BASE) return;

    const inc = this.active.get(incId);
    if (!inc) return;

    const unit = this.unitByRole(inc, role);
    if (!unit) return;
    unit.arrived = true;

    // Ambulance arriving on scene: immediately load injured citizen & rush to hospital with siren!
    if (role === INC_ROLE_AMBULANCE && inc.injuredCitizen >= 0 && !unit.transporting) {
      unit.transporting = true;
      this.evacuateInjuredToHospital(inc, slot, unit.stationId);
      // Let ambulance despawn from scene slot (a fresh hospital-bound siren ambulance was spawned)
      this.checkClearingReady(inc);
      return;
    }

    // Keep Police / Fire / Tow visibly parked on scene ONLY when clear of lane neighbors (zero overlap guarantee!)
    if (T.isClearOfLaneNeighbors(slot, 0.5)) {
      T.incidentId[slot] = inc.id;
      T.v[slot] = 0;
      T.stuck[slot] = 0;
      T.legitWait[slot] = 1;
      if (role === INC_ROLE_TOW) T.flags[slot] |= VEH_FLAG_HAZARD;
    } else {
      unit.slot = -1;
    }

    this.checkClearingReady(inc);
  }

  unitStuck(slot: number) {
    const w = this.w, T = w.traffic;
    const role = T.pAux[slot];
    const incId = T.pId[slot];
    if (role === INC_ROLE_EVAC_HOSPITAL) {
      const ev = this.removeEvac(slot);
      if (!ev) return;
      const curE = w.roads.edges[T.edge[slot]];
      if (curE?.alive) T.computePose(slot);
      const ax = curE?.alive && Number.isFinite(T.x[slot]) ? T.x[slot] : ev.lastX;
      const az = curE?.alive && Number.isFinite(T.z[slot]) ? T.z[slot] : ev.lastZ;
      this.handleEvacInterrupted(ev, ax, az, slot);
      return;
    }
    const inc = this.active.get(incId);
    if (!inc) return;
    const unit = this.unitByRole(inc, role);
    if (unit) {
      unit.slot = -1;
      unit.required = false; // fail-safe: don't stall the scene forever on a gridlocked responder
    }
    this.checkClearingReady(inc);
  }

  /** Re-dispatch an interrupted hospital evacuation (up to 2 retries) or fall back to honest field stabilization. */
  private handleEvacInterrupted(ev: PendingEvac, ax: number, az: number, currentSlot: number) {
    const w = this.w, T = w.traffic, C = w.citizens;
    if (ev.citizenId < 0 || !C.alive[ev.citizenId] || C.gen[ev.citizenId] !== ev.citizenGen) return;

    if (ev.retries < 2) {
      const origHosp = ev.hospitalId >= 0 ? w.buildings.byId.get(ev.hospitalId) : undefined;
      const hosp = origHosp && origHosp.alive && origHosp.state === 'done' && !origHosp.abandoned
        ? origHosp
        : this.findStation(['hospital', 'clinic'], ax, az);
      const he = hosp ? w.roads.edges[hosp.edge] : undefined;
      let respawned = -1;
      if (hosp && he?.alive && he.progress >= 1) {
        if (currentSlot >= 0 && T.active[currentSlot]) {
          const curEdge = w.roads.edges[T.edge[currentSlot]];
          if (curEdge?.alive && curEdge.progress >= 1) {
            const curDir = T.dir[currentSlot];
            const curT = curDir === 0 ? T.s[currentSlot] / Math.max(1, curEdge.len) : 1 - T.s[currentSlot] / Math.max(1, curEdge.len);
            const plan = carPlanEdges(w.roads, curEdge, Math.max(0.05, Math.min(0.95, curT)), he, hosp.edgeT, ax, az, hosp.x, hosp.z);
            if (plan) {
              respawned = T.spawn(VType.Ambulance, plan.path, plan.startS, plan.destS, { kind: P_INCIDENT, id: ev.incidentId, aux: INC_ROLE_EVAC_HOSPITAL }, -1, hosp.id, VEH_FLAG_SIREN);
            }
          }
        }
        if (respawned < 0) {
          const excludeEdge = currentSlot >= 0 ? T.edge[currentSlot] : -1;
          const near = w.roads.nodesNear(ax, az, 160);
          for (const n of near) {
            const altE = n.edges.map((id) => w.roads.edges[id]).find((q) => q?.alive && q.progress >= 1 && q.id !== excludeEdge && (!q.oneway || q.a === n.id));
            if (!altE) continue;
            const t0 = altE.a === n.id ? 0.05 : 0.95;
            const plan = carPlanEdges(w.roads, altE, t0, he, hosp.edgeT, n.x, n.z, hosp.x, hosp.z);
            if (!plan) continue;
            respawned = T.spawn(VType.Ambulance, plan.path, plan.startS, plan.destS, { kind: P_INCIDENT, id: ev.incidentId, aux: INC_ROLE_EVAC_HOSPITAL }, -1, hosp.id, VEH_FLAG_SIREN);
            if (respawned >= 0) break;
          }
        }
        if (respawned >= 0) {
          this.registerEvac(respawned, {
            citizenId: ev.citizenId,
            citizenGen: ev.citizenGen,
            hospitalId: hosp.id,
            incidentId: ev.incidentId,
            vehGen: T.gen[respawned],
            retries: ev.retries + 1,
            deadline: Math.max(ev.deadline, w.t + 300),
            lastX: ax,
            lastZ: az,
          });
          C.state[ev.citizenId] = ST_VIRTUAL;
          C.slot[ev.citizenId] = -1;
          C.tripDest[ev.citizenId] = -1;
          C.vFromX[ev.citizenId] = ax;
          C.vFromZ[ev.citizenId] = az;
          C.vStartT[ev.citizenId] = w.t;
          C.vEndT[ev.citizenId] = w.t + 3600;
          C.schedule(ev.citizenId, w.t + 3600);
          return;
        }
      }
    }
    // Re-dispatch exhausted or impossible: stabilize honestly in the field (NEVER fake hospital treatment!)
    this.completeFieldStabilization(ev.citizenId, ev.citizenGen, ax, az, 'evac_stuck');
  }

  private unitByRole(inc: RoadIncident, role: number): UnitDispatch | null {
    if (role === INC_ROLE_POLICE) return inc.units.police;
    if (role === INC_ROLE_AMBULANCE) return inc.units.ambulance;
    if (role === INC_ROLE_FIRE) return inc.units.fire;
    if (role === INC_ROLE_TOW) return inc.units.tow;
    return null;
  }

  private evacuateInjuredToHospital(inc: RoadIncident, sceneSlot: number, stationId: number) {
    const w = this.w, C = w.citizens, T = w.traffic;
    const cid = inc.injuredCitizen;
    const cgen = inc.injuredGen;
    inc.injuredCitizen = -1;
    if (cid < 0 || !C.alive[cid] || C.gen[cid] !== cgen) return;

    // Remove held pedestrian from road if ped_crash
    if (inc.injuredWasPed) {
      const ps = C.slot[cid];
      if (ps >= 0 && w.peds.active[ps] && w.peds.citizen[ps] === cid) {
        w.peds.despawn(ps);
      }
      C.slot[cid] = -1;
    }

    const candidateHosp = w.buildings.byId.get(inc.hospitalId) ?? w.buildings.byId.get(stationId);
    const hosp = candidateHosp && candidateHosp.alive && candidateHosp.state === 'done' && !candidateHosp.abandoned
      ? candidateHosp
      : this.findStation(['hospital', 'clinic'], inc.x, inc.z);
    if (!hosp) {
      this.completeFieldStabilization(cid, cgen, inc.x, inc.z, 'no_hospital');
      return;
    }

    // Spawn ambulance driving from scene edge to hospital with siren (with nearby-node fallback if scene edge is jammed)
    const se = w.roads.edges[inc.edge];
    const he = w.roads.edges[hosp.edge];
    let spawned = -1;
    if (se?.alive && he?.alive) {
      const startT = inc.dir === 0 ? inc.s / Math.max(1, se.len) : 1 - inc.s / Math.max(1, se.len);
      const plan = carPlanEdges(w.roads, se, Math.max(0.05, Math.min(0.95, startT)), he, hosp.edgeT, inc.x, inc.z, hosp.x, hosp.z);
      if (plan) {
        spawned = T.spawn(VType.Ambulance, plan.path, plan.startS, plan.destS, { kind: P_INCIDENT, id: inc.id, aux: INC_ROLE_EVAC_HOSPITAL }, -1, hosp.id, VEH_FLAG_SIREN);
      }
      if (spawned < 0) {
        const nearNodes = w.roads.nodesNear(inc.x, inc.z, 120);
        for (const n of nearNodes) {
          const altE = n.edges.map((id) => w.roads.edges[id]).find((q) => q?.alive && q.progress >= 1 && q.id !== se.id && (!q.oneway || q.a === n.id));
          if (!altE) continue;
          const t0 = altE.a === n.id ? 0.05 : 0.95;
          const altPlan = carPlanEdges(w.roads, altE, t0, he, hosp.edgeT, n.x, n.z, hosp.x, hosp.z);
          if (!altPlan) continue;
          spawned = T.spawn(VType.Ambulance, altPlan.path, altPlan.startS, altPlan.destS, { kind: P_INCIDENT, id: inc.id, aux: INC_ROLE_EVAC_HOSPITAL }, -1, hosp.id, VEH_FLAG_SIREN);
          if (spawned >= 0) break;
        }
      }
    }
    if (spawned >= 0) {
      this.ambulanceEvacuations++;
      this.registerEvac(spawned, {
        citizenId: cid,
        citizenGen: cgen,
        hospitalId: hosp.id,
        incidentId: inc.id,
        vehGen: T.gen[spawned],
        retries: 0,
        deadline: w.t + 480,
        lastX: inc.x,
        lastZ: inc.z,
      });
      C.state[cid] = ST_VIRTUAL;
      C.slot[cid] = -1;
      C.tripDest[cid] = -1;
      C.vFromX[cid] = inc.x;
      C.vFromZ[cid] = inc.z;
      C.vStartT[cid] = w.t;
      C.vEndT[cid] = w.t + 3600;
      C.schedule(cid, w.t + 3600);
      w.events.emit('emergency', inc.x, inc.z, 0.55, `Ambulância transporta ${C.name(cid)} ao ${hosp.name}`, {
        entity: { kind: 'vehicle', id: spawned, gen: T.gen[spawned] }, ref: hosp.id, visual: 0.8,
      });
    } else {
      this.completeFieldStabilization(cid, cgen, inc.x, inc.z, 'evac_spawn_failed');
    }
    void sceneSlot;
  }

  /** Honest field first-aid fallback when hospital evacuation could not be completed (never teleports to hospital or fakes hospital cure). */
  private completeFieldStabilization(cid: number, cgen: number, x: number, z: number, _reason: string) {
    const w = this.w, C = w.citizens;
    if (cid < 0 || !C.alive[cid] || C.gen[cid] !== cgen) return;
    const ps = C.slot[cid];
    if (ps >= 0 && w.peds.active[ps] && w.peds.citizen[ps] === cid) w.peds.despawn(ps);
    C.slot[cid] = -1;

    // Modest field stabilization only (never jumps straight to 0.75)
    C.health[cid] = Math.min(1, C.health[cid] + 0.10);
    C.addBio(cid, 'Recebeu primeiros socorros no local após acidente de trânsito');

    const h = C.households.get(C.hh[cid]);
    const homeId = h?.home ?? -1;
    const home = homeId >= 0 ? w.buildings.byId.get(homeId) : undefined;
    C.act[cid] = Act.Home;
    C.tripAct[cid] = Act.Home;
    C.tripDest[cid] = home?.id ?? homeId;
    C.tripDur[cid] = HOUR_SECONDS * 1.4;
    if (home && C.switchToWalk(cid, x, z)) {
      return;
    }
    const dist = home ? Math.hypot(home.x - x, home.z - z) : 120;
    C.virtualArrive(cid, Math.max(30, dist / 1.3), x, z);
  }

  private completeHospitalTreatment(cid: number, cgen: number, hospitalId: number) {
    const w = this.w, C = w.citizens;
    if (cid < 0 || !C.alive[cid] || C.gen[cid] !== cgen) return;
    const hosp = hospitalId >= 0 ? w.buildings.byId.get(hospitalId) : undefined;
    if (!hosp || !hosp.alive || hosp.state !== 'done' || hosp.abandoned) {
      this.completeFieldStabilization(cid, cgen, C.vFromX[cid] || w.center.x, C.vFromZ[cid] || w.center.z, 'hospital_unavailable');
      return;
    }

    C.health[cid] = Math.min(1, Math.max(0.75, C.health[cid] + 0.45));
    C.state[cid] = ST_IN;
    C.slot[cid] = -1;
    C.act[cid] = Act.Doctor;
    C.loc[cid] = hosp.id;
    C.addBio(cid, `Atendid${C.sex[cid] ? 'a' : 'o'} no ${hosp.name} após acidente de trânsito`);
    C.schedule(cid, w.t + HOUR_SECONDS * 1.4);
  }

  private checkClearingReady(inc: RoadIncident) {
    if (inc.stage === 'clearing') return;
    const u = inc.units;
    const ready = (!u.police.required || u.police.arrived)
      && (!u.ambulance.required || u.ambulance.arrived)
      && (!u.fire.required || u.fire.arrived)
      && (!u.tow.required || u.tow.arrived);
    if (ready) {
      inc.stage = 'clearing';
      inc.clearStartAt = this.w.t;
      this.dirty = true;
    }
  }

  private stepIncident(inc: RoadIncident) {
    const w = this.w, T = w.traffic;
    const e = w.roads.edges[inc.edge];
    if (!e || !e.alive) {
      this.resolveIncident(inc, true, true);
      return;
    }
    // Detect if any dispatched unit unexpectedly vanished before arriving
    for (const unit of [inc.units.police, inc.units.ambulance, inc.units.fire, inc.units.tow]) {
      if (unit.required && !unit.arrived && unit.slot >= 0) {
        if (!T.active[unit.slot] || T.gen[unit.slot] !== unit.gen) {
          unit.slot = -1;
          unit.required = false;
        }
      }
    }
    this.checkClearingReady(inc);

    if (inc.stage === 'clearing' && inc.clearStartAt >= 0 && w.t >= inc.clearStartAt + inc.clearDuration) {
      this.resolveIncident(inc, false);
      return;
    }
    if (w.t >= inc.timeoutAt) {
      this.resolveIncident(inc, true);
    }
  }

  private resolveIncident(inc: RoadIncident, failSafe: boolean, skipReturnTrips = false) {
    const w = this.w, T = w.traffic, C = w.citizens;
    this.active.delete(inc.id);
    this.clearBlockage(inc);
    this.dirty = true;
    this.incidentsResolved++;
    const anyArrived = inc.units.police.arrived || inc.units.ambulance.arrived || inc.units.fire.arrived || inc.units.tow.arrived;
    if (failSafe || !anyArrived) this.failSafeResolutions++;
    if (inc.units.tow.arrived && !failSafe) this.towRemovals++;

    // 1. Ensure any still-unpicked injured citizen receives honest field stabilization (never fake hospital treatment)
    if (inc.injuredCitizen >= 0) {
      const cid = inc.injuredCitizen;
      if (inc.injuredWasPed && C.alive[cid] && C.gen[cid] === inc.injuredGen) {
        const ps = C.slot[cid];
        if (ps >= 0 && w.peds.active[ps] && w.peds.citizen[ps] === cid) w.peds.despawn(ps);
        C.slot[cid] = -1;
      }
      this.completeFieldStabilization(cid, inc.injuredGen, inc.x, inc.z, failSafe ? 'timeout_failsafe' : 'unresolved_evac');
      inc.injuredCitizen = -1;
    }

    // 2. Despawn immobilized scene vehicles & restore household car / bus fleet state cleanly
    for (const inv of inc.involved) {
      if (T.active[inv.slot] && T.gen[inv.slot] === inv.gen && T.incidentId[inv.slot] === inc.id) {
        T.despawn(inv.slot);
      }
      if (inv.hhId >= 0) {
        const h = C.households.get(inv.hhId);
        if (h && h.car) {
          h.carUser = -1;
          h.carDriver = -1;
          if (inv.severeDamage) {
            // Major crash total loss: replace if savings allow, otherwise household temporarily loses car
            const replaceCost = [420, 680, 1100][h.wealth] * w.economy.priceIndex;
            if (h.money >= replaceCost + 100) {
              h.money -= replaceCost;
              h.carAge = 0;
              h.carKm = 0;
              h.carWear = 0;
              h.carVariant = w.era === 0 ? 0 : 1 + w.rng.int(0, 10);
              h.carLoc = h.home;
              h.carRepairUntil = w.t + HOUR_SECONDS * 6;
              C.carRenewals++;
            } else {
              h.car = false;
              h.carLoc = -1;
              h.carAge = 0;
              h.carKm = 0;
              h.carWear = 0;
              h.carRepairUntil = 0;
              C.carRetirements++;
            }
          } else {
            // Repaired at workshop and returned to home garage after cooldown
            h.carLoc = h.home;
            h.carWear = Math.max(0.12, h.carWear - 0.35);
            h.carRepairUntil = w.t + HOUR_SECONDS * (inc.kind === 'breakdown' ? 8 : 14);
          }
        }
      }
      if (inv.busLineId >= 0) {
        const line = w.transitSys.lines.find((l) => l.id === inv.busLineId);
        if (line) line.fleetWear = Math.max(0.10, (line.fleetWear ?? 0.5) - 0.25);
      }
    }

    // 3. Release parked responder units & spawn return-to-base trips
    const returnTrips: { vtype: VType; stationId: number }[] = [];
    const pairs: [UnitDispatch, VType][] = [
      [inc.units.tow, VType.Tow],
      [inc.units.police, VType.Police],
      [inc.units.fire, VType.Fire],
      [inc.units.ambulance, VType.Ambulance],
    ];
    for (const [u, vtype] of pairs) {
      if (u.slot >= 0 && T.active[u.slot] && T.gen[u.slot] === u.gen && T.incidentId[u.slot] === inc.id) {
        T.despawn(u.slot);
        if (u.stationId >= 0) returnTrips.push({ vtype, stationId: u.stationId });
      }
    }
    const se = w.roads.edges[inc.edge];
    if (!skipReturnTrips && se?.alive && returnTrips.length) {
      const startT = inc.dir === 0 ? inc.s / Math.max(1, se.len) : 1 - inc.s / Math.max(1, se.len);
      for (const rt of returnTrips) {
        const st = w.buildings.byId.get(rt.stationId);
        const de = st ? w.roads.edges[st.edge] : null;
        if (!st || !de?.alive) continue;
        const plan = carPlanEdges(w.roads, se, Math.max(0.05, Math.min(0.95, startT)), de, st.edgeT, inc.x, inc.z, st.x, st.z);
        if (plan) {
          T.spawn(rt.vtype, plan.path, plan.startS, plan.destS, { kind: P_INCIDENT, id: -1, aux: INC_ROLE_RETURN_BASE }, -1, st.id, rt.vtype === VType.Tow ? VEH_FLAG_HAZARD : 0);
        }
      }
    }

    w.events.emit(
      'road_cleared',
      inc.x,
      inc.z,
      0.28,
      `Via liberada em ${inc.edgeName} (${inc.districtName}) após ${KIND_LABEL[inc.kind].toLowerCase()}`,
      { ref: inc.edge, visual: 0.45 },
    );
  }

  /** Keep active incidents & blockages synchronized when a road edge is split into (e1, e2). */
  onEdgeSplit(old: REdge, e1: REdge, e2: REdge, t: number) {
    const cut0 = t * old.len, cut1 = (1 - t) * old.len;
    for (const inc of [...this.active.values()]) {
      if (inc.edge !== old.id) continue;
      this.clearBlockage(inc);
      const cut = inc.dir === 0 ? cut0 : cut1;
      if (inc.s < cut) {
        inc.edge = inc.dir === 0 ? e1.id : e2.id;
      } else {
        inc.edge = inc.dir === 0 ? e2.id : e1.id;
        inc.s = Math.max(4, inc.s - cut);
      }
      const ne = this.w.roads.edges[inc.edge];
      if (!ne?.alive || ne.len < 12) {
        this.resolveIncident(inc, true, true);
        continue;
      }
      inc.s = Math.max(4, Math.min(ne.len - 4, inc.s));
      const p = this.w.traffic.point(ne, inc.dir, inc.lane, inc.s, inc.kind === 'breakdown' ? 0.65 : 0);
      inc.x = p[0]; inc.y = p[1]; inc.z = p[2]; inc.angle = p[3];
      this.syncBlockage(inc);
      this.dirty = true;
    }
  }

  /** Clean up any active incident, blockage, and routing penalty when a road edge is deleted. */
  onEdgeRemoved(eid: number) {
    for (const inc of [...this.active.values()]) {
      if (inc.edge === eid) this.resolveIncident(inc, true, true);
    }
    this.clearEdgeResiduals(eid);
  }

  /** Clean up active incidents on an edge undergoing topology mutation (e.g., one-way pair / lane doubling / reversal). */
  onEdgeTopologyChange(eid: number) {
    for (const inc of [...this.active.values()]) {
      if (inc.edge === eid) this.resolveIncident(inc, true, true);
    }
    this.clearEdgeResiduals(eid);
  }

  private clearEdgeResiduals(eid: number) {
    const T = this.w.traffic, R = this.w.roads;
    for (const dir of [0, 1]) {
      const de = eid * 2 + dir;
      if (T.blockages.has(de)) T.blockages.delete(de);
      if (R.incidentPenalty.has(de)) R.setIncidentPenalty(de, 0);
    }
  }

  // ------------------------------------------------------------------ views & inspector helpers

  views(): RoadIncidentView[] {
    const out: RoadIncidentView[] = [];
    for (const inc of this.active.values()) {
      const e = this.w.roads.edges[inc.edge];
      out.push({
        id: inc.id,
        kind: inc.kind,
        edge: inc.edge,
        dir: inc.dir,
        lane: inc.lane,
        s: inc.s,
        x: inc.x,
        y: inc.y,
        z: inc.z,
        angle: inc.angle,
        fullClosure: inc.fullClosure,
        stage: inc.stage,
        lanes: e?.lanes ?? 1,
        halfWidth: e ? edgeHalfWidth(e) : 4,
      });
    }
    return out;
  }

  onEdge(edgeId: number) {
    const out: { id: number; kind: RoadIncidentKind; label: string; stage: string; fullClosure: boolean; units: string[] }[] = [];
    for (const inc of this.active.values()) {
      if (inc.edge !== edgeId) continue;
      const units: string[] = [];
      if (inc.units.police.slot >= 0 || inc.units.police.arrived) units.push(inc.units.police.arrived ? 'Polícia (no local)' : 'Polícia (a caminho)');
      if (inc.units.ambulance.slot >= 0 || inc.units.ambulance.arrived) units.push(inc.units.ambulance.arrived ? 'Ambulância (atendendo)' : 'Ambulância (a caminho)');
      if (inc.units.fire.slot >= 0 || inc.units.fire.arrived) units.push(inc.units.fire.arrived ? 'Bombeiros (no local)' : 'Bombeiros (a caminho)');
      if (inc.units.tow.slot >= 0 || inc.units.tow.arrived) units.push(inc.units.tow.arrived ? 'Guincho (removendo)' : 'Guincho (a caminho)');
      out.push({
        id: inc.id,
        kind: inc.kind,
        label: KIND_LABEL[inc.kind],
        stage: STAGE_LABEL[inc.stage],
        fullClosure: inc.fullClosure,
        units,
      });
    }
    return out;
  }

  describeVehicle(slot: number): string | null {
    const T = this.w.traffic;
    if (!T.active[slot]) return null;
    if (T.incidentId[slot] >= 0) {
      const inc = this.active.get(T.incidentId[slot]);
      if (inc) {
        if (T.pAux[slot] === 99) return `Veículo em pane mecânica (${STAGE_LABEL[inc.stage]})`;
        if (T.pAux[slot] === 98) return `Veículo envolvido em ${KIND_LABEL[inc.kind].toLowerCase()} (${STAGE_LABEL[inc.stage]})`;
        if (T.type[slot] === VType.Tow) return `Guincho operando remoção em ${inc.edgeName}`;
        if (T.type[slot] === VType.Police) return `Polícia isolando ocorrência em ${inc.edgeName}`;
        if (T.type[slot] === VType.Fire) return `Bombeiros estabilizando acidente em ${inc.edgeName}`;
      }
    }
    if (T.pKind[slot] === P_INCIDENT) {
      const role = T.pAux[slot];
      const inc = this.active.get(T.pId[slot]);
      if (role === INC_ROLE_EVAC_HOSPITAL) return 'Ambulância transportando ferido ao hospital';
      if (role === INC_ROLE_RETURN_BASE) return 'Retornando à base após atendimento';
      if (inc) {
        if (role === INC_ROLE_TOW) return `Guincho a caminho de ${KIND_LABEL[inc.kind].toLowerCase()} em ${inc.edgeName}`;
        if (role === INC_ROLE_POLICE) return `Polícia a caminho de ${KIND_LABEL[inc.kind].toLowerCase()} em ${inc.edgeName}`;
        if (role === INC_ROLE_AMBULANCE) return `Ambulância a caminho de socorro em ${inc.edgeName}`;
        if (role === INC_ROLE_FIRE) return `Bombeiros a caminho de acidente grave em ${inc.edgeName}`;
      }
    }
    return null;
  }

  static readonly carPlan = carPlan;
}
