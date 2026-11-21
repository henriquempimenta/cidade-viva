import { DAYS_PER_YEAR, HOUR_SECONDS } from '../shared/constants';
import { KINDS } from '../shared/catalog';
import type { Building } from './buildings';
import type { World } from './world';

/** Scheduled and random events: festivals, New Year, games, floods, epidemics, heritage listing, injected events. */
export class Happenings {
  floodLevel = 0;
  private sentFlood = 0;
  floods = 0;
  dikes: number[][] = [];
  dikesDirty = false;
  private heavyRainHours = 0;
  private lastYear = 1;

  constructor(private w: World) {}

  hourly() {
    const w = this.w, p = w.params;
    // heavy rain -> floods in low areas near the river
    if (w.weather.rain > 0.75) this.heavyRainHours++; else this.heavyRainHours = Math.max(0, this.heavyRainHours - 1);
    const target = this.heavyRainHours > 3 && p.disasterFreq > 0 ? Math.min(3.2, 1.2 + this.heavyRainHours * 0.18 * p.disasterFreq) : 0;
    const protectedCity = this.dikes.length > 0;
    const prev = this.floodLevel;
    this.floodLevel += (target - this.floodLevel) * 0.4;
    if (this.floodLevel > 1.6 && prev <= 1.6) this.flood(protectedCity);
    // New Year's Eve
    const hour = w.hour;
    if (w.year !== this.lastYear) {
      this.lastYear = w.year;
      const plaza = this.bestPlaza();
      w.events.emit('fireworks', plaza?.x ?? w.center.x, plaza?.z ?? w.center.z, 1, `Réveillon: fogos de artifício saúdam o Ano ${w.year}`, { headline: `Cidade celebra a chegada do Ano ${w.year} com fogos`, visual: 1 });
    }
    // festival day (annual, frequency adjustable)
    if (w.festivalDays > 0 && hour > 19 && hour < 20) {
      const plaza = this.bestPlaza();
      w.events.emit('fireworks', plaza?.x ?? w.center.x, plaza?.z ?? w.center.z, 0.8, 'Show de fogos encerra a noite do festival', { visual: 1 });
    }
    // stadium games: traffic peaks toward the stadium
    if (w.gameDay === w.day && hour > 15 && hour < 16) {
      const st = w.buildings.list.find((b) => b.kind === 'stadium' && b.state === 'done');
      if (st) w.events.emit('stadium_game', st.x, st.z, 0.85, `Dia de jogo: torcedores lotam o ${st.name}`, { headline: w.rng.chance(0.3) ? `Clássico no ${st.name} leva multidão e engarrafa avenidas` : undefined, ref: st.id, visual: 0.9 });
    }
  }

  daily() {
    const w = this.w, p = w.params;
    const doy = w.day % DAYS_PER_YEAR;
    if (w.festivalDays > 0) w.festivalDays--;
    if (doy === 4 && p.festivalFreq > 0 || w.rng.chance(0.03 * p.festivalFreq)) this.festival();
    const st = w.buildings.list.find((b) => b.kind === 'stadium' && b.state === 'done');
    if (st && w.day % 4 === 0) w.gameDay = w.day + 1;
    if (w.epidemic > 0) { w.epidemic--; if (!w.epidemic) w.events.emit('epidemic', w.center.x, w.center.z, 0.3, 'Surto controlado: casos voltam ao normal'); }
    else {
      const density = w.population / 3000;
      const sanitation = w.utils.sewage.cap >= w.utils.sewage.prod ? 0.5 : 1.5;
      if (w.rng.chance(0.012 * p.disasterFreq * (0.5 + density) * sanitation)) this.epidemic();
    }
    // heritage listing of the old center when it has tourist value
    if (w.era >= 2 && w.day % 3 === 0) {
      const old = w.buildings.list.filter((b) => !b.heritage && b.state === 'done' && b.era === 0 && b.builtDay < 8 && !b.def.public && Math.hypot(b.x - w.center.x, b.z - w.center.z) < 400);
      if (old.length > 8 && !w.buildings.list.some((b) => b.heritage)) {
        for (const b of old) { b.heritage = true; w.buildings.dirty.add(b.id); }
        const d = w.districts[0];
        w.events.emit('landmark', d.x, d.z, 0.9, `Centro histórico é tombado: ${old.length} edificações protegidas`, { headline: `Centro Velho é tombado como patrimônio histórico`, visual: 0.9 });
      }
    }
  }

  private bestPlaza(): Building | null {
    const ps = this.w.buildings.list.filter((b) => (b.kind === 'plaza' || b.kind === 'park') && b.state === 'done');
    let best: Building | null = null, bd = Infinity;
    for (const b of ps) { const d = Math.hypot(b.x - this.w.center.x, b.z - this.w.center.z); if (d < bd) { bd = d; best = b; } }
    return best;
  }

  festival() {
    const w = this.w;
    w.festivalDays = 2;
    const plaza = this.bestPlaza();
    const names = ['Festival de Inverno', 'Festa Junina', 'Festival do Rio', 'Carnaval', 'Festa da Colheita', 'Festival de Música'];
    const name = names[w.year % names.length];
    w.events.emit('festival', plaza?.x ?? w.center.x, plaza?.z ?? w.center.z, 0.9, `${name} reúne moradores e visitantes${plaza ? ' na ' + plaza.name : ''}`, { headline: `${name} movimenta a cidade`, ref: plaza?.id, visual: 1 });
    // crowd: many citizens head to the festival
    if (plaza) {
      const C = w.citizens;
      let n = 0;
      for (let i = 0; i < C.max && n < 300; i += 7) {
        if (!C.alive[i] || C.state[i] !== 0 || C.age[i] < 8) continue;
        const here = w.buildings.byId.get(C.loc[i]);
        if (!here || here.id === plaza.id) continue;
        C.startTrip(i, here, plaza, 7 /* Park */, HOUR_SECONDS * 3);
        n++;
      }
    }
  }

  epidemic() {
    const w = this.w;
    w.epidemic = 3;
    w.events.emit('epidemic', w.center.x, w.center.z, 0.7, 'Surto de gripe: postos de saúde lotados', { headline: 'Surto de gripe lota postos de saúde', visual: 0.4 });
  }

  private flood(protectedCity: boolean) {
    const w = this.w;
    this.floods++;
    const F = w.fields, T = w.terrain;
    let hit = 0;
    let fx = w.center.x, fz = w.center.z;
    for (const b of w.buildings.list) {
      if (!T.isFlood(b.x, b.z) || b.state !== 'done') continue;
      if (protectedCity && Math.hypot(b.x - w.center.x, b.z - w.center.z) < w.cityRadius + 300) continue;
      hit++; fx = b.x; fz = b.z;
      for (const hid of b.households) { const h = w.citizens.households.get(hid); if (h) { h.money -= 300; h.unhappyDays++; } }
    }
    w.floodVictims += hit;
    void F;
    if (hit) w.events.emit('flood', fx, fz, 1, `Enchente atinge ${hit} imóveis em áreas baixas`, { headline: `Chuva forte provoca enchente em ${w.districtName(fx, fz)}: ${hit} imóveis atingidos`, visual: 1 });
    else if (protectedCity) w.events.emit('flood', fx, fz, 0.6, 'Rio sobe, mas os diques protegem a cidade', { headline: 'Diques seguram a cheia do rio' });
  }

  /** city hall project after recurring floods: dikes or relocation, by cost-benefit */
  projects(): unknown[] {
    const w = this.w;
    if (w.floodVictims < 8 || this.dikes.length) return [];
    const T = w.terrain;
    const victims = w.buildings.list.filter((b) => T.isFlood(b.x, b.z) && b.state === 'done' && !b.def.public);
    const relocationCost = victims.length * 160;
    const segs: number[][] = [];
    for (let i = 0; i < T.river.length - 1; i += 2) {
      const p = T.river[i], q = T.river[Math.min(T.river.length - 1, i + 2)];
      if (Math.hypot(p.x - w.center.x, p.z - w.center.z) > w.cityRadius + 250) continue;
      const ang = Math.atan2(q.z - p.z, q.x - p.x);
      for (const side of [1, -1]) {
        const off = T.riverWidth / 2 + 14;
        const x = (p.x + q.x) / 2 - Math.sin(ang) * off * side, z = (p.z + q.z) / 2 + Math.cos(ang) * off * side;
        if (T.isFlood(x, z) || T.heightAt(x, z) < 2.5 && T.heightAt(x, z) > 0) segs.push([x, z, ang, Math.hypot(q.x - p.x, q.z - p.z) + 2]);
      }
    }
    const dikeCost = segs.length * 45;
    const benefit = victims.length * 2 + w.floodVictims;
    const out: unknown[] = [];
    if (segs.length) out.push({ kind: 'dike', label: 'Diques no rio', motive: `${w.floodVictims} imóveis atingidos por enchentes; dique de ${segs.length * 12} m (relocação custaria $${relocationCost})`, benefit, cost: dikeCost, critical: dikeCost < relocationCost, run: () => { this.dikes = segs; this.dikesDirty = true; for (const s of segs) T.raiseRect(s[0], s[1], 8, 3); w.floodVictims = 0; w.events.emit('city_hall', segs[0][0], segs[0][1], 0.8, 'Diques são erguidos ao longo do rio', { headline: 'Prefeitura ergue diques contra enchentes (mais barato que relocar moradores)', visual: 0.8 }); return true; } });
    if (victims.length) out.push({ kind: 'relocate', label: 'Relocação de moradores', motive: `${victims.length} imóveis em área alagável`, benefit: benefit * 0.9, cost: relocationCost, run: () => { for (const b of victims.slice(0, 40)) { w.evict(b); w.buildings.demolish(b); } w.floodVictims = 0; w.events.emit('city_hall', victims[0].x, victims[0].z, 0.7, 'Moradores de área alagável são realocados', { headline: 'Famílias de áreas alagáveis são realocadas' }); return true; } });
    return out;
  }

  inject(ev: string) {
    const w = this.w;
    switch (ev) {
      case 'roadgrant':
        w.structures.grant();
        break;
      case 'immigration':
        w.economy.boomQueue += 250 + w.population * 0.1;
        w.events.emit('immigration', w.center.x, w.center.z, 1, 'Onda de imigração: centenas de famílias a caminho', { headline: 'Onda de imigração: famílias chegam em massa pela rodovia', visual: 0.8 });
        break;
      case 'megafactory': {
        const b = w.market.develop(w.era >= 1 ? 'steelMill' : 'factory', 1, 'Evento: chegada de uma grande indústria', { samples: 80 });
        if (b) { b.name = 'Mega-fábrica ' + b.name.split(' ').pop(); b.jobCap = b.jobCap.map((j) => j * 3) as [number, number, number, number]; w.events.emit('megafactory', b.x, b.z, 1, `Chega a ${b.name}: ${b.jobCap.reduce((a, c) => a + c, 0)} vagas`, { headline: `${b.name} anuncia instalação e promete milhares de empregos`, entity: { kind: 'building', id: b.id }, ref: b.id, visual: 0.9 }); }
        break;
      }
      case 'crisis':
        w.economy.crisis = 6;
        w.events.emit('crisis', w.center.x, w.center.z, 1, 'Crise econômica: vendas e exportações despencam', { headline: 'Crise econômica atinge a cidade: indústrias cortam turnos', visual: 0.5 });
        break;
      case 'sports': {
        const st = w.buildings.list.find((b) => b.kind === 'stadium');
        if (st) { w.gameDay = w.day; w.events.emit('stadium_game', st.x, st.z, 1, 'Grande final no estádio!', { headline: 'Grande final esportiva para a cidade', visual: 1 }); }
        else this.festival();
        break;
      }
      case 'storm':
        w.weather.storm = HOUR_SECONDS * 8;
        w.events.emit('storm', w.center.x, w.center.z, 1, 'Tempestade se aproxima: ventos fortes e chuva intensa', { headline: 'Tempestade castiga a cidade', visual: 1 });
        break;
      case 'fire': {
        const list = w.buildings.list.filter((b) => b.state === 'done' && !b.def.public);
        const b = list[Math.floor(w.rng.next() * list.length)];
        if (b) w.services.ignite(b);
        break;
      }
      case 'epidemic': this.epidemic(); break;
      case 'festival': this.festival(); break;
      case 'blackout': w.utils.forcedBlackout = 6; break;
      case 'accident': w.incidents?.injectIncident('major_crash'); break;
      case 'breakdown': w.incidents?.injectIncident('breakdown'); break;
    }
  }

  static KINDS = KINDS;
}
