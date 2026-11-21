import * as THREE from 'three';
import type { App } from '../app';
import { el } from './hud';
import { icon } from './icons';

interface Term { key: string; label: string; value: number }
interface BuildingInfo {
  id: number; name: string; label: string; cat: string; level: number; wealth: number; floors: number; state: string; progress: number;
  decay: number; squatted: boolean; stalled: boolean; stalledUntil: number; abandonedYears: number; corruption: number;
  district: string; builtDay: number; abandoned: boolean; households: number; hhCap: number; workers: number; jobs: number; students: number;
  profit: number; powered: boolean; watered: boolean; heritage: boolean; garbage: number; visitors: number; x: number; z: number; y: number; height: number;
  fields: Record<string, number>;
  decision: null | { actor: string; motive: string; day: number; sampled: number; total: number; terms: Term[]; alternatives: { x: number; z: number; total: number; terms: Term[]; district: string }[] };
  occupants: null | { id: number; name: string; role: string }[];
}
interface CitizenInfo {
  id: number; name: string; age: number; sex: string; traits: string[]; edu: string; job: string; home: string; income: number; money: number;
  needs: Record<string, number>; state: string; activity: string; agenda: { h: string; act: string; done: boolean }[]; bio: { year: number; text: string }[];
  family: string[]; mode: string; speedKmh?: number | null; happiness: number; tourist: boolean; insideBuilding: number;
  car?: null | { wearPct: number; km: number; ageDays: number; vintage: boolean; status: string };
}
interface VehicleInfo {
  slot: number; type: number; typeName: string; speed: number; limit: number; cap: number | null;
  edge: string; edgeId: number; kind: number; id: number; aux: number;
  siren: boolean; hazard: boolean; incidentId: number; mission: string;
}
interface EdgeInfo {
  id: number; name: string; cls: string; lanes: number; oneway: number; len: number; volume: number[]; capacity: number; vc: number; history: number[];
  congestedDays: number; busLane: boolean; upgrading: boolean; od: [string, number][]; pairs: { ox: number; oz: number; dx: number; dz: number }[];
  limit?: number;
  noise: null | { light: number; moto: number; heavy: number; power: number; index: number; speed: number; samples: number };
  mid: { x: number; y: number; z: number; hx: number; hz: number };
  gate: null | { wait: number; hot: number; separated: boolean };
  upgrade: null | { day: number; chosen: string; options: { label: string; benefit: number; cost: number; ratio: number; feasible: boolean; note: string }[] };
  incidents?: { id: number; kind: string; label: string; stage: string; fullClosure: boolean; units: string[] }[];
}

const WEALTH = ['popular', 'médio', 'alto'];
const NEED_LABEL: Record<string, string> = { hunger: 'Fome', sleep: 'Sono', hygiene: 'Higiene', social: 'Convívio', fun: 'Diversão', health: 'Saúde', safety: 'Segurança', money: 'Dinheiro' };

export class Inspector {
  private panel: HTMLElement;
  private markers = new THREE.Group();
  private kind: 'building' | 'citizen' | 'edge' | 'vehicle' | null = null;
  private id = -1;
  private lastRefresh = 0;
  private downAt = { x: 0, y: 0, t: 0 };

  constructor(private app: App, container: HTMLElement, private onShow: () => void = () => {}, private onClose: () => void = () => {}) {
    this.panel = el('div', 'insp', container);
    app.rig.scene.add(this.markers);
    const c = app.rig.renderer.domElement;
    c.addEventListener('pointerdown', (e) => { this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    c.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 5 || performance.now() - this.downAt.t > 400) return;
      this.pick(e.clientX, e.clientY);
    });
  }

  close() { if (this.kind === null) return; this.kind = null; this.clearMarkers(); this.app.overlays.clearOD?.(); this.onClose(); }
  private pendingOpen = false;
  private open() { if (this.pendingOpen) { this.pendingOpen = false; this.onShow(); } }
  private head(label: string, title: string, sub: string) {
    return `<div class="inspector-top"><span class="eyeline"><span></span>${label}</span><button class="text-button close">${icon('close', 14)} Fechar</button></div><h2>${title}</h2><p class="sub">${sub}</p>`;
  }

  private pick(x: number, y: number) {
    const ray = new THREE.Raycaster();
    const rc = this.app.rig.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - rc.left) / rc.width) * 2 - 1, -((y - rc.top) / rc.height) * 2 + 1);
    ray.setFromCamera(ndc, this.app.rig.camera);
    // agents first (small targets get a generous pick radius)
    const ag = this.app.agents.pickAgent?.(ray);
    if (ag) {
      if (ag.kind === 'ped' && ag.citizen >= 0) { this.showCitizen(ag.citizen); this.app.followEntity({ kind: 'citizen', id: ag.citizen }); return; }
      if (ag.kind === 'vehicle' && ag.citizen >= 0) { this.showCitizen(ag.citizen); this.app.followEntity({ kind: 'citizen', id: ag.citizen }); return; }
      if (ag.kind === 'vehicle') { this.showVehicle(ag.slot); this.app.followEntity({ kind: 'vehicle', id: ag.slot, gen: ag.gen }); return; }
    }
    const objs: THREE.Object3D[] = [...this.app.buildings.pickables()];
    if (this.app.roads.mainMesh) objs.push(this.app.roads.mainMesh);
    const hits = ray.intersectObjects(objs, true);
    for (const h of hits) {
      const bid = this.app.buildings.pick(h);
      if (bid !== null) { this.showBuilding(bid); return; }
      const eid = this.app.roads.pickEdge(h);
      if (eid !== null) { this.showEdge(eid); return; }
    }
  }

  async showBuilding(id: number) {
    this.kind = 'building'; this.id = id; this.pendingOpen = true;
    await this.refreshBuilding(true);
  }
  private async refreshBuilding(drawMarkers: boolean) {
    const id = this.id;
    const d = await this.app.inspect<BuildingInfo>('building', id);
    if (!d || this.kind !== 'building' || this.id !== id) return;
    this.open();
    const occ = d.cat === 'res' || d.cat === 'informal' ? `${d.households}/${d.hhCap} famílias` : d.jobs ? `${d.workers}/${d.jobs} empregos` : '';
    let html = this.head('Por que aqui?', d.name, `${d.label}${d.cat === 'res' ? ` · nível ${d.level} · padrão ${WEALTH[d.wealth]}` : ''} · ${d.district}`) + `
      ${d.decision ? `<div class="score-card"><span>Utilidade do lote escolhido</span><strong>${d.decision.total.toFixed(2)}</strong></div>` : ''}
      <div class="kv">
        <span>Situação</span><span>${d.abandoned ? `abandonado há ${d.abandonedYears < 1 ? 'menos de 1 ano' : `${Math.round(d.abandonedYears)} ano(s)`}` : d.squatted ? 'ocupação' : d.stalled ? 'obra parada' : d.state === 'done' ? 'em operação' : `em obra (${Math.round(d.progress * 100)}%)`}</span>
        ${d.decay > 0.01 ? `<span>Deterioração</span><span>${Math.round(d.decay * 100)}%${d.decay > 0.75 ? ' · risco de desabamento' : ''}</span>` : ''}
        ${d.corruption > 0.05 ? `<span>Corrupção local</span><span>${Math.round(d.corruption * 100)}%</span>` : ''}
        <span>Andares</span><span>${d.floors}</span>
        ${occ ? `<span>Ocupação</span><span>${occ}</span>` : ''}
        ${d.students ? `<span>Alunos</span><span>${d.students}</span>` : ''}
        ${d.visitors ? `<span>Visitantes/dia</span><span>${d.visitors}</span>` : ''}
        <span>Energia / água</span><span>${d.powered ? '✔' : '✖'} / ${d.watered ? '✔' : '✖'}</span>
        ${d.heritage ? '<span>Patrimônio</span><span>🏛 tombado</span>' : ''}
        <span>Valor do solo</span><span>${d.fields.landValue.toFixed(2)}</span>
        <span>Poluição do ar</span><span>${d.fields.air.toFixed(2)}</span>
        <span>Ruído / crime</span><span>${d.fields.noise.toFixed(2)} / ${d.fields.crime.toFixed(2)}</span>
      </div>`;
    if (d.decision) {
      const dec = d.decision;
      html += `<h4>Decomposição da decisão</h4><div class="hint" style="margin-bottom:6px">${dec.actor} · dia ${dec.day + 1} · ${dec.motive}<br>${dec.sampled} lotes avaliados por <i>utilidade = Σ(peso × campo) − custos − rejeição</i></div>`;
      html += termsHtml(dec.terms, dec.total);
      if (dec.alternatives.length) {
        html += `<h4>Alternativas que perderam</h4>`;
        dec.alternatives.forEach((a, i) => {
          const diff = dec.total - a.total;
          const worst = [...a.terms].sort((p, q) => p.value - q.value)[0];
          const chosenTerm = dec.terms.find((t) => t.key === worst?.key);
          html += `<div class="alt"><b style="color:${altColor(i)}">●</b> Alternativa ${i + 1} · ${a.district} · utilidade ${a.total.toFixed(2)} (−${diff.toFixed(2)})<br>
            ${worst ? `pesou contra: <b>${worst.label}</b> ${worst.value.toFixed(2)}${chosenTerm ? ` (aqui: ${chosenTerm.value.toFixed(2)})` : ''}` : ''}</div>`;
        });
      }
      if (drawMarkers) this.drawMarkers(d);
    } else if (drawMarkers) this.clearMarkers();
    if (d.occupants?.length) {
      html += `<h4>Quem está aqui</h4><p class="hint">Clique numa pessoa para segui-la.</p>` + d.occupants.slice(0, 14).map((o) => `<div class="tag" data-cid="${o.id}" style="cursor:pointer">${o.name} · ${o.role}</div>`).join('');
    }
    this.panel.innerHTML = html;
    this.panel.querySelector('.close')!.addEventListener('click', () => this.close());
    this.panel.querySelectorAll('[data-cid]').forEach((n) => n.addEventListener('click', () => { const cid = Number((n as HTMLElement).dataset.cid); this.showCitizen(cid); this.app.followEntity({ kind: 'citizen', id: cid }); }));
  }

  private drawMarkers(d: BuildingInfo) {
    this.clearMarkers();
    const mk = (x: number, z: number, col: number, h: number) => {
      const y = this.app.terrain.heightAt(x, z);
      const g = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, h, 6).translate(0, h / 2, 0), new THREE.MeshBasicMaterial({ color: col }));
      g.position.set(x, y, z);
      const s = new THREE.Mesh(new THREE.SphereGeometry(3.5, 10, 8), new THREE.MeshBasicMaterial({ color: col }));
      s.position.set(x, y + h, z);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(d.x, d.y + d.height + 6, d.z), new THREE.Vector3(x, y + h, z)]), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.6 }));
      this.markers.add(g, s, line);
    };
    const y = d.y + d.height + 6;
    const star = new THREE.Mesh(new THREE.OctahedronGeometry(5), new THREE.MeshBasicMaterial({ color: 0x5fd38a }));
    star.position.set(d.x, y, d.z);
    this.markers.add(star);
    d.decision?.alternatives.forEach((a, i) => mk(a.x, a.z, altColorHex(i), 30));
  }
  private clearMarkers() { this.markers.clear(); }

  async showCitizen(id: number) {
    this.kind = 'citizen'; this.id = id; this.pendingOpen = true;
    this.clearMarkers();
    await this.refreshCitizen();
  }
  private async refreshCitizen() {
    const id = this.id;
    const d = await this.app.inspect<CitizenInfo>('citizen', id);
    if (!d || this.kind !== 'citizen' || this.id !== id) return;
    this.open();
    let html = this.head(d.tourist ? 'Visitante · observação individual' : 'Observação individual', `${d.tourist ? '🧳 ' : ''}${d.name}`, `${d.age} anos · ${d.sex} · ${d.edu}`) + `
      <div style="margin:2px 0 4px">${d.traits.map((t) => `<span class="tag">${t}</span>`).join('')}</div>
      <div class="state-pill">${d.state}</div>
      <div class="kv">${d.tourist ? `<span>Hotel</span><span>${d.home}</span><span>Situação</span><span>${d.job}</span>` : `<span>Casa</span><span>${d.home}</span><span>Trabalho/escola</span><span>${d.job}</span>`}
      <span>Renda/dia</span><span>$${d.income.toFixed(0)}</span><span>Economias</span><span>$${d.money.toFixed(0)}</span><span>Transporte</span><span>${d.mode}</span>${d.speedKmh != null ? `<span>Velocidade atual</span><span>${d.speedKmh.toFixed(0)} km/h</span>` : ''}<span>Felicidade</span><span>${Math.round(d.happiness * 100)}%</span></div>`;
    if (d.car) {
      html += `<h4>Veículo da família</h4><div class="kv"><span>Situação</span><span>${d.car.status}</span><span>Desgaste</span><span>${d.car.wearPct}%${d.car.vintage ? ' · clássico' : ''}</span><span>Quilometragem</span><span>${d.car.km} km (${d.car.ageDays} d)</span></div>`;
    }
    html += `<h4>Necessidades</h4>`;
    for (const [k, v] of Object.entries(d.needs)) html += `<div class="term"><span>${NEED_LABEL[k] ?? k}</span><div class="tb"><i style="left:0;width:${Math.round(v * 100)}%;background:${v > 0.6 ? 'var(--good)' : v > 0.3 ? 'var(--warn)' : 'var(--bad)'}"></i></div><span class="v">${Math.round(v * 100)}</span></div>`;
    if (d.agenda.length) html += `<h4>Agenda de hoje</h4>` + d.agenda.map((a) => `<div class="alt" style="${a.done ? 'color:#93a598;text-decoration:line-through' : ''}">${a.h} · ${a.act}</div>`).join('');
    if (d.family.length) html += `<h4>Família</h4>` + d.family.map((f) => `<span class="tag">${f}</span>`).join('');
    html += `<h4>Biografia</h4>` + d.bio.map((b) => `<div class="bio"><b>Ano ${b.year}</b> · ${b.text}</div>`).join('');
    this.panel.innerHTML = html;
    this.panel.querySelector('.close')!.addEventListener('click', () => { this.close(); this.app.setMode('auto'); });
  }

  async showEdge(id: number) {
    this.kind = 'edge'; this.id = id; this.pendingOpen = true;
    this.clearMarkers();
    await this.refreshEdge(true);
  }
  private async refreshEdge(drawOD: boolean) {
    const id = this.id;
    const d = await this.app.inspect<EdgeInfo>('edge', id);
    if (!d || this.kind !== 'edge' || this.id !== id) return;
    this.open();
    let html = this.head('Por que congestionado?', d.name, `${d.cls} · ${d.lanes} faixa(s)/sentido${d.oneway ? ' · mão única' : ''}${d.busLane ? ' · faixa de ônibus' : ''}${d.upgrading ? ' · 🚧 em obras' : ''}`) + `
      <div class="score-card"><span>Volume / capacidade</span><strong style="color:${d.vc > 0.85 ? 'var(--bad)' : 'inherit'}">${Math.round(d.vc * 100)}%</strong></div>
      <div class="kv"><span>Comprimento</span><span>${d.len.toFixed(0)} m</span><span>Volume (veíc./h)</span><span>${d.volume.map((v) => v.toFixed(0)).join(' / ')}</span>
      <span>Capacidade</span><span>${d.capacity.toFixed(0)}</span><span>Volume/capacidade</span><span style="color:${d.vc > 0.85 ? 'var(--bad)' : 'inherit'}">${d.vc.toFixed(2)}</span>
      <span>Dias congestionado</span><span>${d.congestedDays}</span><span>Picos (7 dias)</span><span>${d.history.map((h) => h.toFixed(2)).join(' ')}</span></div>`;
    if (d.incidents?.length) {
      html += `<h4>Ocorrência viária ativa</h4>`;
      for (const inc of d.incidents) {
        html += `<div class="alt">🚨 <b>${inc.label}</b> · ${inc.fullClosure ? 'via interditada' : 'faixa bloqueada'}<br>${inc.stage}${inc.units.length ? `<br>Equipes: ${inc.units.join(' · ')}` : ''}</div>`;
      }
    }
    if (d.gate) {
      const g = d.gate;
      html += g.separated ? `<div class="alt">🚆 Cruza a ferrovia em desnível: sem cancelas.</div>`
        : `<h4>Passagem de nível</h4><div class="alt">🚧 As cancelas retiveram ~${Math.round(g.wait / 60)} min de veículos parados ontem${g.hot ? `; ${g.hot} dia(s) seguidos saturada` : ''}.${g.hot >= 3 ? ' A prefeitura já considera um viaduto ferroviário.' : ''}</div>`;
    }
    html += `<h4>Por que congestionado? (origem → destino)</h4>`;
    if (!d.od.length) html += '<div style="color:var(--mut)">Sem viagens registradas ainda.</div>';
    const max = Math.max(1, ...d.od.map((o) => o[1]));
    for (const [k, n] of d.od) html += `<div class="term"><span style="font-size:11px">${k}</span><div class="tb"><i style="left:0;width:${(n / max) * 100}%;background:#6aa8ff"></i></div><span class="v">${n}</span></div>`;
    if (d.noise && d.noise.power > 0.02) {
      const n = d.noise;
      html += `<h4>Ruído do tráfego</h4><div class="score-card"><span>Índice simulado da via</span><strong>${Math.round(n.index * 100)}<small style="font-size:12px"> / 100</small></strong></div>`;
      for (const [l, v] of [['Veículos leves', n.light], ['Motos', n.moto], ['Ônibus e caminhões', n.heavy]] as [string, number][]) {
        const f = v / n.power;
        html += `<div class="term"><span>${l}</span><div class="tb"><i style="left:0;width:${f * 100}%;background:#7c9db8"></i></div><span class="v">${Math.round(f * 100)}%</span></div>`;
      }
      html += `<div class="kv"><span>Velocidade média observada</span><span>${(n.speed * 3.6).toFixed(0)} km/h</span></div>`;
      if (d.limit) html += `<div class="kv"><span>Limite sinalizado</span><span>${Math.round(d.limit * 3.6)} km/h${d.upgrading ? ' (obra)' : ''}</span></div>`;
      html += `<button class="button listen">${icon('speaker', 15)} Ouvir este trecho</button>`;
    } else html += `<h4>Ruído do tráfego</h4><p class="empty">Sem amostras de ruído veicular na última hora.</p>`;
    if (d.upgrade) {
      html += `<h4>Decisão de upgrade (dia ${d.upgrade.day + 1})</h4><div>Escolhida: <b>${d.upgrade.chosen}</b></div>`;
      for (const o of d.upgrade.options) html += `<div class="alt">${o.feasible ? '' : '🚫 '}${o.label}: benefício ${o.benefit.toFixed(0)} veíc·min/dia, custo $${o.cost.toFixed(0)}, razão ${o.ratio.toFixed(2)}${o.note ? ` — ${o.note}` : ''}</div>`;
    }
    this.panel.innerHTML = html;
    this.panel.querySelector('.close')!.addEventListener('click', () => this.close());
    this.panel.querySelector('.listen')?.addEventListener('click', () => this.app.listenAt(d.mid));
    if (drawOD) this.app.overlays.showOD?.(d.pairs);
  }

  async showVehicle(slot: number) {
    this.kind = 'vehicle'; this.id = slot; this.pendingOpen = true;
    this.clearMarkers();
    await this.refreshVehicle();
  }
  private async refreshVehicle() {
    const slot = this.id;
    const d = await this.app.inspect<VehicleInfo>('vehicle', slot);
    if (!d || this.kind !== 'vehicle' || this.id !== slot) return;
    this.open();
    const badges: string[] = [];
    if (d.siren) badges.push('🚨 Sirene ligada');
    if (d.hazard) badges.push('⚠️ Alerta/Giroflex');
    const html = this.head('Veículo em operação', d.typeName, `${d.edge}${badges.length ? ' · ' + badges.join(' · ') : ''}`) + `
      <div class="state-pill">${d.mission}</div>
      <div class="kv">
        <span>Velocidade</span><span>${Math.round(d.speed * 3.6)} km/h</span>
        <span>Limite da via</span><span>${Math.round(d.limit * 3.6)} km/h</span>
        ${d.incidentId >= 0 ? `<span>Ocorrência</span><span>#${d.incidentId}</span>` : ''}
      </div>`;
    this.panel.innerHTML = html;
    this.panel.querySelector('.close')!.addEventListener('click', () => { this.close(); this.app.setMode('auto'); });
  }

  frame() {
    const now = performance.now();
    if (this.kind === 'citizen' && now - this.lastRefresh > 1000) { this.lastRefresh = now; this.refreshCitizen(); }
    else if (this.kind === 'vehicle' && now - this.lastRefresh > 1000) { this.lastRefresh = now; this.refreshVehicle(); }
    else if (this.kind === 'edge' && now - this.lastRefresh > 2000) { this.lastRefresh = now; this.refreshEdge(false); }
    else if (this.kind === 'building' && now - this.lastRefresh > 2000) { this.lastRefresh = now; this.refreshBuilding(false); }
    for (const m of this.markers.children) if ((m as THREE.Mesh).geometry?.type === 'OctahedronGeometry') m.rotation.y += 0.03;
  }
}

function termsHtml(terms: Term[], total: number): string {
  const max = Math.max(0.01, ...terms.map((t) => Math.abs(t.value)));
  let h = '';
  for (const t of terms) {
    const w = (Math.abs(t.value) / max) * 50;
    const pos = t.value >= 0;
    h += `<div class="term"><span>${t.label}</span><div class="tb"><i style="${pos ? `left:50%;width:${w}%;background:var(--good)` : `left:${50 - w}%;width:${w}%;background:var(--bad)`}"></i></div><span class="v">${t.value >= 0 ? '+' : ''}${t.value.toFixed(2)}</span></div>`;
  }
  h += `<div class="term" style="font-weight:700"><span>Utilidade total</span><span></span><span class="v">${total.toFixed(2)}</span></div>`;
  return h;
}
const ALT = ['#ff9f43', '#54a0ff', '#c56cf0', '#ff6b6b', '#48dbfb', '#feca57', '#a4b0be'];
function altColor(i: number) { return ALT[i % ALT.length]; }
function altColorHex(i: number) { return parseInt(ALT[i % ALT.length].slice(1), 16); }
