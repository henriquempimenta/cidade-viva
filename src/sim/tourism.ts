import { HOUR_SECONDS, VType } from '../shared/constants';
import { clamp } from '../shared/rng';
import type { Building } from './buildings';
import { Act } from './citizens';
import { carPlan, carPlanFromNode } from './trips';
import { P_TOURBUS } from './traffic';
import type { World } from './world';

interface Stay { hh: number; until: number; visited: Set<number> }

/** Tourism emerges once the city's attractiveness crosses a threshold. */
export class Tourism {
  attractiveness = 0;
  threshold = 0.42;
  started = false;
  pressure = 0; // tourists / residents
  stays = new Map<number, Stay>();
  count = 0;
  spendToday = 0;
  taxToday = 0;
  hotelDemand = 0;
  private lastTourBus = 0;

  constructor(private w: World) {}

  daily() {
    const w = this.w, F = w.fields;
    // attractiveness: landscape, heritage, culture, parks, landmarks — minus crime and dirt
    const vals: number[] = [];
    for (let k = 0; k < F.G * F.G; k++) if (F.f.resDensity[k] + F.f.jobDensity[k] > 0.2 || F.f.tourism[k] > 0.3) vals.push(F.f.tourism[k]);
    vals.sort((a, b) => b - a);
    const top = vals.slice(0, Math.max(5, Math.floor(vals.length * 0.15)));
    const avgTop = top.length ? top.reduce((a, b) => a + b, 0) / top.length : 0;
    const landmarks = w.buildings.list.filter((b) => b.state === 'done' && (b.def.cat === 'landmark' || b.kind === 'museum' || b.kind === 'stadium' || b.kind === 'theater')).length;
    const heritage = w.buildings.list.filter((b) => b.heritage).length;
    const safety = 1 - clamp(w.services.avgCrime * 2, 0, 0.8);
    const clean = 1 - clamp(F.f.garbage.reduce((a, b) => a + b, 0) / 400, 0, 0.6);
    const water = w.terrain.type === 'litoral' ? 0.15 * (1 - clamp(Math.max(...F.riverPol) * 0.3, 0, 1)) : 0;
    const voc = w.params.vocation === 'turismo' ? 1.25 : 1;
    this.attractiveness = clamp((avgTop * 0.45 + landmarks * 0.05 + heritage * 0.015 + water + (w.festivalDays > 0 ? 0.1 : 0)) * safety * clean * voc, 0, 2);
    if (!this.started && this.attractiveness > this.threshold) {
      this.started = true;
      w.events.emit('tourists', w.center.x, w.center.z, 1, `A cidade entra no mapa do turismo (atratividade ${this.attractiveness.toFixed(2)} > ${this.threshold})`, { headline: 'Chegam os primeiros turistas: cidade entra no roteiro regional', visual: 0.9 });
    }
    // overtourism: shops near hotspots turn into tourist shops
    let rooms = 0;
    for (const b of w.buildings.list) if ((b.kind === 'hotel' || b.kind === 'hostel') && b.state === 'done') rooms += b.hhCap;
    this.pressure = this.count / Math.max(200, w.population);
    if (this.pressure > 0.08) {
      for (const b of w.buildings.list) {
        if (b.kind !== 'com' || b.state !== 'done' || b.level > 2) continue;
        if (F.sample('tourism', b.x, b.z) > 0.7 && w.rng.chance(0.06 * this.pressure * 10)) {
          w.market.rebuild(b, 'souvenir', 1, 1, 'Excesso de turismo: comércio local vira loja para turistas');
          w.events.emit('overtourism', b.x, b.z, 0.5, `Comércio tradicional dá lugar a loja de souvenirs em ${w.districtName(b.x, b.z)}`, { headline: w.rng.chance(0.4) ? `Turismo em excesso: moradores reclamam de aluguéis e lojas de souvenir em ${w.districtName(b.x, b.z)}` : undefined });
          break;
        }
      }
    }
    // arrivals
    if (!this.started) { this.hotelDemand = 0; return; }
    const airport = w.buildings.list.some((b) => b.kind === 'airport' && b.state === 'done') ? 1.6 : 1;
    const arrivals = Math.round((this.attractiveness - this.threshold * 0.8) * 120 * voc * airport * (w.economy.crisis > 0 ? 0.5 : 1));
    this.hotelDemand = Math.max(0, arrivals * 2.5 - rooms);
    let placed = 0;
    for (let k = 0; k < arrivals / 2; k++) {
      const hotels = w.buildings.list.filter((b) => (b.kind === 'hotel' || b.kind === 'hostel') && b.state === 'done' && b.households.length < b.hhCap);
      if (!hotels.length) break;
      const hotel = hotels[Math.floor(w.rng.next() * hotels.length)];
      if (this.arrive(hotel)) placed++;
    }
    this.taxToday = this.spendToday * 0.06;
    this.spendToday = 0;
    void placed;
  }

  private arrive(hotel: Building): boolean {
    const w = this.w, C = w.citizens;
    const size = w.rng.int(1, 3);
    if (C.max - C.count < 100) return false;
    const h = C.newHousehold(hotel.id, 2, true);
    h.car = w.rng.chance(0.3);
    h.money = 3000;
    for (let k = 0; k < size; k++) {
      const i = C.add({ age: w.rng.range(18, 70), edu: 2, hh: h.id, tourist: true });
      if (i < 0) break;
      h.members.push(i);
      C.loc[i] = -1;
      C.addBio(i, `Turista hospedado(a) no ${hotel.name}`);
      C.tripDest[i] = hotel.id; C.tripAct[i] = Act.Hotel; C.tripDur[i] = HOUR_SECONDS * 2; C.act[i] = Act.Hotel;
    }
    this.stays.set(h.id, { hh: h.id, until: w.day + w.rng.int(2, 4), visited: new Set() });
    this.count += h.members.length;
    // arrival: by tour bus / car from the highway, or by train at the station
    const station = w.buildings.list.find((b) => b.kind === 'railStation' && b.state === 'done');
    const entry = w.entryNode();
    const plan = station && w.rng.chance(0.4) ? carPlan(w.roads, station, hotel) : entry >= 0 ? carPlanFromNode(w.roads, entry, hotel) : null;
    if (plan && w.traffic.capacityLeft > 80 && w.t - this.lastTourBus > 60) {
      const slot = w.traffic.spawn(h.car ? VType.Car : VType.TourBus, plan.path, plan.startS, plan.destS, { kind: P_TOURBUS, id: -1, aux: 0 }, -1, hotel.id);
      this.lastTourBus = w.t;
      if (slot >= 0 && w.rng.chance(0.2)) w.events.emit('tourists', hotel.x, hotel.z, 0.5, `Turistas chegam ao ${hotel.name}`, { entity: { kind: 'vehicle', id: slot, gen: w.traffic.gen[slot] } });
    }
    for (const m of h.members) C.virtualArrive(m, (plan?.time ?? 200) + 30);
    return true;
  }

  /** a tourist's itinerary: sights, food, souvenirs, beach; nights at the hotel */
  decideTourist(i: number, here: Building, hour: number) {
    const w = this.w, C = w.citizens;
    const h = C.households.get(C.hh[i]);
    const stay = h ? this.stays.get(h.id) : undefined;
    const hotel = h ? w.buildings.byId.get(h.home) : undefined;
    if (!h || !stay || !hotel) { C.remove(i); return; }
    if (w.day >= stay.until && hour > 8) { this.leave(h.id); return; }
    const r = w.rng;
    if (hour >= 22 || hour < 7.5) { C.perform(i, Act.Sleep, here, hotel, h, hour); return; }
    if ((hour > 12 && hour < 14) || (hour > 19 && hour < 21)) {
      const eat = w.places.pick('eat', here.x, here.z, () => r.next());
      if (eat) { this.spend(eat, 45); C.startTrip(i, here, eat, Act.Eat, HOUR_SECONDS * 1.2); return; }
    }
    if (w.beachOk() && w.season === 1 && r.chance(0.3)) {
      const b = w.beachPlace(here);
      if (b) { C.startTrip(i, here, b, Act.Beach, HOUR_SECONDS * 2.5); return; }
    }
    const sights = (w.places.lists.get('tourism') ?? []).filter((b) => !stay.visited.has(b.id));
    if (sights.length) {
      let best = sights[0], bs = -Infinity;
      for (const b of sights.slice(0, 40)) { const s = b.def.tourism * 3 + (b.heritage ? 1 : 0) - Math.hypot(b.x - here.x, b.z - here.z) / 800 + r.next(); if (s > bs) { bs = s; best = b; } }
      stay.visited.add(best.id);
      this.spend(best, 30);
      C.startTrip(i, here, best, Act.Sightsee, HOUR_SECONDS * r.range(1, 2));
      if (r.chance(0.04)) w.events.emit('tourists', best.x, best.z, 0.4, `Turistas fotografam ${best.name}`, { entity: { kind: 'citizen', id: i } });
      return;
    }
    const shop = w.places.pick('shop', here.x, here.z, () => r.next());
    if (shop) { this.spend(shop, 35); C.startTrip(i, here, shop, Act.Shop, HOUR_SECONDS); return; }
    C.perform(i, Act.Home, here, hotel, h, hour);
  }

  private spend(b: Building, amount: number) {
    b.revenue += amount * this.w.economy.priceIndex;
    b.customers++;
    this.spendToday += amount;
  }

  private leave(hid: number) {
    const w = this.w, C = w.citizens;
    const h = C.households.get(hid);
    this.stays.delete(hid);
    if (!h) return;
    this.count -= h.members.length;
    for (const m of [...h.members]) C.remove(m);
    if (C.households.has(hid)) C.removeHousehold(h);
  }
}
