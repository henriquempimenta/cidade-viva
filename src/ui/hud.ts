import type { App } from '../app';
import { ERAS, SEASONS } from '../shared/constants';
import type { HallReport, SimEvent, Stats } from '../shared/protocol';
import { Inspector } from './inspector';
import { ParamsPanel } from './paramsPanel';
import { Charts } from './charts';
import { icon } from './icons';

const fmt = (n: number) => Math.round(n).toLocaleString('pt-BR');
const money = (n: number) => (n < 0 ? '−' : '') + '$ ' + fmt(Math.abs(n));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const TERRAIN: Record<string, string> = { vale: 'Vale de rio', litoral: 'Litoral', serra: 'Serra', planicie: 'Planície' };
const CITY_NAMES = ['Rio Claro', 'Águas Belas', 'Serra Azul', 'Campo Verde', 'Pedra Branca', 'Vale Sereno', 'Ribeirão das Garças', 'Bom Retiro', 'Alto Belo', 'Porto Manso', 'Santa Aurora', 'Três Barras'];
export const cityName = (seed: number, era: number) => { const n = CITY_NAMES[Math.abs(seed) % CITY_NAMES.length]; return era === 0 ? `Vila de ${n}` : n; };

/** chronicle categories (type of news) */
export type NewsKind = 'politics' | 'building' | 'road' | 'transit' | 'era' | 'weather' | 'service' | 'safety' | 'economy' | 'festival';
export const NEWS_LABEL: Record<NewsKind, string> = { politics: 'Política e integridade', building: 'Construção e imóveis', road: 'Malha viária', transit: 'Transporte', era: 'Marco urbano', weather: 'Clima e desastres', service: 'Serviços', safety: 'Segurança', economy: 'Economia', festival: 'Eventos' };
const NEWS_ICON: Record<NewsKind, string> = { politics: 'brief', building: 'crane', road: 'bridge', transit: 'bus', era: 'flag', weather: 'cloud', service: 'park', safety: 'shield', economy: 'coins', festival: 'spark' };
export function newsKind(t: string): NewsKind {
  if (/investigation|election|mayor|works_|expropriation|corrupt/.test(t)) return 'politics';
  if (/collapse|occupation|abandoned/.test(t)) return 'building';
  if (/era|district|landmark|heritage|gentrification|reconversion/.test(t)) return 'era';
  if (/road|bridge|viaduct|interchange|upgrade|crossing/.test(t)) return 'road';
  if (/line|bus|rail|train|station|metro|brt|freight/.test(t)) return 'transit';
  if (/flood|storm|rain|snow|blackout|dike|weather|epidemic|outbreak/.test(t)) return 'weather';
  if (/crime|police|chase|fire|accident|prison/.test(t)) return 'safety';
  if (/loan|bank|crisis|factory|economy|tax|tourist|hotel|overtourism|immigration/.test(t)) return 'economy';
  if (/festival|firework|stadium|wedding|funeral|birth/.test(t)) return 'festival';
  if (/power|water|sewage|garbage|school|clinic|hospital|city_hall|park|service/.test(t)) return 'service';
  return 'building';
}
const storyKey = (e: SimEvent) => e.entity ? `${e.entity.kind}:${e.entity.id}` : e.ref !== undefined ? `ref:${e.ref}` : null;

type Tab = 'overview' | 'chronicle' | 'cityhall' | 'inspector' | 'params';
type Metric = { label: string; get: (s: Stats) => number; fmt?: (v: number) => string };
const METRICS: Record<string, Metric> = {
  population: { label: 'População', get: (s) => s.population },
  gdp: { label: 'PIB por dia', get: (s) => s.gdp, fmt: money },
  money: { label: 'Caixa da prefeitura', get: (s) => s.money, fmt: money },
  happiness: { label: 'Felicidade', get: (s) => s.happiness, fmt: pct },
  unemployment: { label: 'Desemprego', get: (s) => s.unemployed / Math.max(1, s.employed + s.unemployed), fmt: pct },
  emissions: { label: 'Emissões', get: (s) => s.emissions },
  crime: { label: 'Criminalidade', get: (s) => s.crime * 100, fmt: (v) => v.toFixed(1) },
  tourists: { label: 'Turistas', get: (s) => s.tourists },
  traffic: { label: 'Em deslocamento', get: (s) => s.vehicles + s.peds + s.virtualTrips },
};

export class Hud {
  root: HTMLElement;
  inspector: Inspector;
  params: ParamsPanel;
  charts: Charts;
  private cap: HTMLElement;
  private toastEl: HTMLElement;
  private dirhud: HTMLElement;
  private bodies = {} as Record<Tab, HTMLElement>;
  private tab: Tab = 'overview';
  private returnTab: Tab = 'overview';
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private events: SimEvent[] = [];
  private selectedStory: number | null = null;
  private chronKey = '';
  private recentKey = '';
  private hallKey = '';
  private dialog!: HTMLDialogElement;

  constructor(private app: App, root: HTMLElement) {
    this.root = root;
    this.buildHeader();
    this.cap = el('div', 'caption glass', root);
    this.cap.innerHTML = `<span class="caption-icon">${icon('article', 18)}</span><div><small></small><strong></strong></div>`;
    this.toastEl = el('div', 'toast glass', root);
    this.dirhud = el('div', 'dirhud', root);
    this.buildSceneTools();
    this.buildViewerBar();
    this.buildPanel();
    this.buildFooter();
    this.inspector = new Inspector(app, this.bodies.inspector, () => this.show('inspector'), () => this.show(this.returnTab === 'inspector' ? 'overview' : this.returnTab));
    this.params = new ParamsPanel(app, this.bodies.params);
    this.charts = new Charts(this.bodies.overview.querySelector('.chart-card') as HTMLElement);
    this.show('overview');
    this.refreshSpeed();
    this.refreshMode();
  }

  // ---------------- layout ----------------
  private buildHeader() {
    const h = document.getElementById('site-header')!;
    const p = this.app.params;
    h.innerHTML = `<div class="brand"><span class="brand-mark">${icon('logo', 22)}</span><span>Cidade<span class="brand-accent"> Viva</span></span></div>
      <div class="header-divider"></div><span class="header-context">Observatório urbano · uma cidade procedural que cresce sozinha</span>
      <div class="header-actions">
        <span class="seed" title="Mundo gerado">${icon('pin', 15)}<span>${TERRAIN[p.terrain] ?? p.terrain}</span><i></i><span class="mono">Seed ${p.seed}</span></span>
        <span class="status" id="status"><i></i><span>Em simulação</span></span>
        <button class="button" id="btn-params" aria-expanded="false">${icon('sliders', 17)}<span>Parâmetros</span></button>
      </div>`;
    h.querySelector('#btn-params')!.addEventListener('click', () => this.show(this.tab === 'params' ? this.returnTab : 'params'));
  }

  private buildSceneTools() {
    const r = this.root;
    const loc = el('div', 'scene-location glass', r);
    loc.innerHTML = `<div class="live"><b></b><span class="feed">AO VIVO</span></div><strong class="city">—</strong><span class="scene-date">—</span>`;
    const tools = el('div', 'scene-tools', r);
    const ib = (name: string, label: string, fn: () => void) => { const b = el('button', 'icon-button', tools); b.innerHTML = icon(name); b.title = label; b.setAttribute('aria-label', label); b.onclick = fn; return b; };
    const audio = ib('speaker', 'Ativar áudio ambiente', () => { const on = this.app.audio.toggle?.(); audio.classList.toggle('active', !!on); audio.title = on ? 'Silenciar áudio' : 'Ativar áudio ambiente'; });
    ib('layers', 'Camadas do mapa', () => this.app.overlays.toggleMenu());
    ib('map', 'Mapa esquemático das linhas', () => this.app.overlays.toggleMetro());
    ib('fullscreen', 'Tela cheia', async () => {
      const v = document.getElementById('viewer')!;
      try { if (document.fullscreenElement) await document.exitFullscreen(); else await v.requestFullscreen(); } catch { document.body.classList.toggle('expanded'); }
    });
    this.app.overlays.mountMenu(tools);
    const zoom = el('div', 'zoom-tools', r);
    const zb = (name: string, label: string, fn: () => void) => { const b = el('button', 'icon-button', zoom); b.innerHTML = icon(name); b.title = label; b.setAttribute('aria-label', label); b.onclick = fn; };
    zb('plus', 'Aproximar', () => this.app.zoom(0.8));
    zb('minus', 'Afastar', () => this.app.zoom(1.25));
    zb('compass', 'Voltar ao auto-diretor', () => { this.inspector.close(); this.app.setMode('auto'); });
  }

  private modeMenu!: HTMLElement;
  private modeLabel!: HTMLElement;
  private speedBtns = new Map<number, HTMLElement>();
  private autoBtn!: HTMLElement;
  private playBtn!: HTMLElement;
  private clockEl!: HTMLElement;
  private weatherEl!: HTMLElement;
  private realEl!: HTMLElement;
  private buildViewerBar() {
    const bar = document.getElementById('viewer-bar')!;
    bar.innerHTML = `<div class="camera-control"><button class="camera-button" aria-expanded="false">${icon('camera', 17)}<span class="mode-label">Auto-diretor</span>${icon('chevron', 13)}</button>
        <div class="pop-menu"></div></div>
      <div class="transport"><button class="play-button" title="Pausar (espaço)">${icon('pause', 18)}</button><div class="speed-group" aria-label="Velocidade"></div><span class="real-speed"></span></div>
      <div class="sim-clock"><span class="wx">${icon('sun', 17)}</span><time>—</time><small class="wtext"></small></div>`;
    const cb = bar.querySelector('.camera-button') as HTMLElement;
    this.modeMenu = bar.querySelector('.camera-control .pop-menu') as HTMLElement;
    this.modeLabel = bar.querySelector('.mode-label') as HTMLElement;
    cb.onclick = () => { this.modeMenu.classList.toggle('open'); cb.setAttribute('aria-expanded', String(this.modeMenu.classList.contains('open'))); };
    const modes: [string, string, string][] = [['auto', 'camera', 'Auto-diretor'], ['free', 'compass', 'Câmera livre'], ['cinematic', 'film', 'Cinemático'], ['follow', 'locate', 'Seguir um cidadão']];
    for (const [m, ic, label] of modes) {
      const b = el('button', '', this.modeMenu);
      b.innerHTML = `${icon(ic, 15)} ${label}`;
      b.dataset.mode = m;
      b.onclick = () => {
        this.modeMenu.classList.remove('open');
        if (m === 'follow') this.app.followSomeone(); else this.app.setMode(m as 'auto');
      };
    }
    this.playBtn = bar.querySelector('.play-button') as HTMLElement;
    this.playBtn.onclick = () => this.togglePause();
    const g = bar.querySelector('.speed-group') as HTMLElement;
    const speeds: [number, string, string][] = [[1, '1×', 'Tempo real dos agentes'], [10, '10×', ''], [100, '100×', ''], [400, '', 'Time-lapse (400×)']];
    for (const [s, label, title] of speeds) {
      const b = el('button', '', g);
      if (label) b.textContent = label; else b.innerHTML = icon('trend', 14);
      if (title) b.title = title;
      b.onclick = () => { this.app.autoSpeed = false; this.app.setSpeed(s); };
      this.speedBtns.set(s, b);
    }
    this.autoBtn = el('button', '', g);
    this.autoBtn.textContent = 'Auto';
    this.autoBtn.title = 'Velocidade automática: o diretor desacelera em cenas próximas e acelera nos planos gerais';
    this.autoBtn.onclick = () => { this.app.autoSpeed = !this.app.autoSpeed; if (this.app.speed === 0) this.app.setSpeed(10); this.refreshSpeed(); };
    this.clockEl = bar.querySelector('time') as HTMLElement;
    this.weatherEl = bar.querySelector('.wtext') as HTMLElement;
    this.realEl = bar.querySelector('.real-speed') as HTMLElement;
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !(e.target as Element).closest('input,select,textarea,button,dialog')) { e.preventDefault(); this.togglePause(); }
    });
    document.addEventListener('click', (e) => { if (!(e.target as Element).closest('.camera-control')) this.modeMenu.classList.remove('open'); });
  }
  private lastSpeed = 10;
  private togglePause() {
    if (this.app.speed === 0) this.app.setSpeed(this.lastSpeed || 10);
    else { this.lastSpeed = this.app.speed; this.app.autoSpeed = false; this.app.setSpeed(0); }
  }

  private buildPanel() {
    const P = document.getElementById('panel')!;
    const tabs = el('div', 'tabs', P);
    tabs.setAttribute('role', 'tablist');
    const tdefs: [Tab, string, string][] = [['overview', 'chart', 'Visão geral'], ['chronicle', 'article', 'Crônica'], ['cityhall', 'brief', 'Prefeitura']];
    for (const [k, ic, label] of tdefs) {
      const b = el('button', '', tabs);
      b.setAttribute('role', 'tab'); b.dataset.tab = k;
      b.innerHTML = `${icon(ic, 15)} ${label}`;
      b.onclick = () => this.show(k);
    }
    for (const k of ['overview', 'chronicle', 'cityhall', 'inspector', 'params'] as Tab[]) {
      const b = el('div', 'panel-body', P);
      b.dataset.body = k;
      this.bodies[k] = b;
    }
    this.bodies.overview.innerHTML = `
      <div class="section-heading"><h2>Panorama</h2><span class="era-chip"><i></i><span class="era">Vila</span></span></div>
      <div class="stats">
        ${[['people', 'pop', 'Habitantes'], ['brief', 'jobs', 'Empregos'], ['coins', 'money', 'Caixa'], ['crane', 'works', 'Em obras']].map(([g, id, t]) => `<div class="stat"><span class="stat-icon">${icon(g, 16)}</span><div><strong data-s="${id}">—</strong><small>${t}</small></div></div>`).join('')}
      </div>
      <div class="card chart-card"></div>
      <div class="section-heading" style="margin-top:14px;margin-bottom:2px"><h2 style="font-size:13.5px">Atividade recente</h2><button class="text-button" data-goto="chronicle">Ver tudo ${icon('arrow', 12)}</button></div>
      <div class="event-list recent"></div>
      <div class="card soft"><strong>Demanda (residencial · comercial · indústria · escritórios)</strong><div class="rci"></div></div>
      <div class="card soft"><strong>Mercado imobiliário</strong><div class="dl market"></div></div>
      <div class="card soft"><strong>Serviços essenciais</strong><div class="services"></div></div>
      <div class="card soft"><strong>Como a cidade se move</strong><div class="dl modal"></div></div>`;
    this.bodies.overview.querySelector('[data-goto]')!.addEventListener('click', () => this.show('chronicle'));
    this.bodies.chronicle.innerHTML = `<div class="section-heading"><h2>Crônica da Cidade</h2></div>
      <div class="chronicle-filter"><label>Tipo de notícia</label><select><option value="all">Todas</option>${Object.entries(NEWS_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
      <div class="related" hidden></div><div class="event-list chron"></div>`;
    (this.bodies.chronicle.querySelector('select') as HTMLSelectElement).onchange = () => this.drawChronicle(true);
    this.bodies.cityhall.innerHTML = `<div class="section-heading"><h2>Orçamento municipal</h2><span class="era-chip"><i></i><span class="hall-day">—</span></span></div>
      <div class="dl hall-budget"></div>
      <h3>Integridade pública</h3><div class="hall-int"></div>
      <h3>Redes e serviços</h3><div class="hall-net"></div>
      <h3>Obras municipais em andamento</h3><div class="hall-works"></div>
      <h3>Transporte público</h3><div class="hall-lines"></div>
      <h3>Último ciclo de planejamento</h3><div class="hall-cycle"></div>
      <h3>Lançamentos recentes</h3><div class="dl hall-ledger"></div>`;
    for (const k of ['overview', 'chronicle', 'cityhall'] as Tab[]) this.bodies[k].addEventListener('click', (e) => this.onPanelClick(e));
  }

  private buildFooter() {
    const f = document.getElementById('page-footer')!;
    f.innerHTML = `<div><span class="footer-dot"></span><span class="fstate">Simulação em andamento</span></div>
      <span>Arraste para orbitar <b>·</b> role para aproximar <b>·</b> clique num prédio, rua ou pessoa para inspecionar <b>·</b> espaço pausa</span>
      <button class="text-button" id="btn-inject">${icon('spark', 14)} Injetar evento</button>`;
    this.dialog = document.createElement('dialog');
    const evs: [string, string, string][] = [['immigration', 'people', 'Onda de imigração'], ['megafactory', 'crane', 'Mega-fábrica'], ['crisis', 'chart', 'Crise econômica'], ['sports', 'flag', 'Grande evento esportivo'], ['storm', 'cloud', 'Tempestade'], ['fire', 'fire', 'Incêndio'], ['epidemic', 'heart', 'Epidemia leve'], ['festival', 'spark', 'Festival'], ['blackout', 'bolt', 'Apagão']];
    this.dialog.innerHTML = `<div class="dialog-top"><div><h2>Injetar evento</h2><p>Observe como a cidade reage a uma mudança repentina.</p></div><button class="icon-button" aria-label="Fechar">${icon('close')}</button></div>
      <div class="inject-grid">${evs.map(([k, ic, l]) => `<button class="button" data-ev="${k}">${icon(ic, 18)}${l}</button>`).join('')}</div>`;
    document.body.appendChild(this.dialog);
    this.dialog.querySelector('.dialog-top button')!.addEventListener('click', () => this.dialog.close());
    this.dialog.querySelectorAll('[data-ev]').forEach((b) => b.addEventListener('click', () => {
      const k = (b as HTMLElement).dataset.ev!;
      this.app.send({ type: 'inject', event: k });
      this.toast('Evento injetado: ' + (b as HTMLElement).textContent);
      this.dialog.close();
      this.show('chronicle');
    }));
    f.querySelector('#btn-inject')!.addEventListener('click', () => this.dialog.showModal());
  }

  show(t: Tab) {
    if (t !== 'inspector' && t !== 'params') this.returnTab = t;
    else if (this.tab !== 'inspector' && this.tab !== 'params') this.returnTab = this.tab;
    this.tab = t;
    for (const [k, b] of Object.entries(this.bodies)) b.hidden = k !== t;
    document.querySelectorAll<HTMLElement>('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    document.getElementById('btn-params')?.setAttribute('aria-expanded', String(t === 'params'));
    if (t === 'chronicle') this.drawChronicle(true);
    if (t === 'cityhall') { this.hallKey = ''; if (this.app.stats?.hall) this.drawHall(this.app.stats); }
  }

  private onPanelClick(e: Event) {
    const t = (e.target as Element).closest<HTMLElement>('[data-event],[data-building],[data-layer],[data-line]');
    if (!t) return;
    if (t.dataset.event) {
      const ev = this.events.find((x) => x.id === Number(t.dataset.event));
      if (!ev) return;
      this.selectedStory = ev.id;
      this.app.showEvent(ev);
      if (this.tab === 'chronicle') this.drawChronicle(true);
    } else if (t.dataset.building) {
      this.inspector.showBuilding(Number(t.dataset.building));
      this.app.lookAtBuilding(Number(t.dataset.building));
    } else if (t.dataset.layer) {
      this.app.overlays.select(t.dataset.layer);
    } else if (t.dataset.line) {
      this.app.overlays.select('lines');
      this.app.overlays.toggleMetro(true);
    }
  }

  // ---------------- state refresh ----------------
  refreshSpeed() {
    const sp = this.app.speed;
    for (const [s, b] of this.speedBtns) b.setAttribute('aria-pressed', String(s === sp && !this.app.autoSpeed));
    this.autoBtn.setAttribute('aria-pressed', String(this.app.autoSpeed));
    this.playBtn.innerHTML = icon(sp === 0 ? 'play' : 'pause', 18);
    this.playBtn.title = sp === 0 ? 'Retomar (espaço)' : 'Pausar (espaço)';
    const st = document.getElementById('status');
    if (st) { st.classList.toggle('paused', sp === 0); st.querySelector('span')!.textContent = sp === 0 ? 'Em pausa' : 'Em simulação'; }
    const fs = document.querySelector('.fstate');
    if (fs) fs.textContent = sp === 0 ? 'Simulação em pausa' : this.app.autoSpeed ? `Velocidade automática · ${sp}×` : 'Simulação em andamento';
  }
  refreshMode() {
    const L: Record<string, string> = { auto: 'Auto-diretor', free: 'Câmera livre', cinematic: 'Cinemático', follow: 'Seguindo' };
    this.modeLabel.textContent = L[this.app.mode] ?? this.app.mode;
    this.modeMenu.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === this.app.mode)));
    const feed = this.root.querySelector('.feed');
    if (feed) feed.textContent = this.app.mode === 'auto' || this.app.mode === 'cinematic' ? 'AO VIVO · DIRETOR' : this.app.mode === 'follow' ? 'AO VIVO · SEGUINDO' : 'AO VIVO · CÂMERA LIVRE';
  }

  updateStats(s: Stats) {
    const q = (sel: string) => this.root.querySelector(sel) as HTMLElement | null;
    const city = q('.city'); if (city) city.textContent = cityName(this.app.params.seed, s.era);
    const date = q('.scene-date'); if (date) date.textContent = `Ano ${s.year} · ${SEASONS[s.season]} · ${ERAS[s.era]}`;
    const ov = this.bodies.overview;
    const set = (k: string, v: string) => { const n = ov.querySelector(`[data-s="${k}"]`); if (n) n.textContent = v; };
    set('pop', fmt(s.population)); set('jobs', fmt(s.jobs)); set('money', money(s.money)); set('works', fmt(s.underConstruction));
    (ov.querySelector('.era') as HTMLElement).textContent = ERAS[s.era];
    const wx: Record<string, string> = { chuva: 'cloud', tempestade: 'cloud', neve: 'cloud', neblina: 'cloud' };
    const night = this.app.dayFrac < 0.25 || this.app.dayFrac > 0.78;
    const glyph = s.rain > 0.3 || s.snow > 0.3 ? 'cloud' : night ? 'moon' : wx[s.weather] ?? 'sun';
    const w = this.root.ownerDocument.querySelector('.sim-clock .wx') as HTMLElement;
    if (w && w.dataset.icon !== glyph) { w.dataset.icon = glyph; w.innerHTML = icon(glyph, 17); }
    this.weatherEl.textContent = `${s.weather} · ${s.temperature.toFixed(0)}°C`;
    this.realEl.textContent = this.app.speed ? `${s.speedActual.toFixed(0)}× real` : '';
    this.realEl.title = `Simulação em ${s.threads ?? 1} thread(s): 1 principal + ${(s.threads ?? 1) - 1} de rotas. Quando a CPU não acompanha, a velocidade real fica abaixo da pedida.`;
    this.charts.push(s);
    this.drawOverview(s);
    if (this.tab === 'cityhall') this.drawHall(s);
  }

  private drawOverview(s: Stats) {
    const ov = this.bodies.overview;
    const d = s.demand;
    const row = (l: string, v: number, c: string) => {
      const w = Math.min(50, Math.abs(v) * 1.2);
      return `<div class="rci-row"><span>${l}</span><div class="rci-bar"><i style="${v >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`};background:${c}"></i></div><b>${v > 0 ? '+' : ''}${v.toFixed(0)}</b></div>`;
    };
    (ov.querySelector('.rci') as HTMLElement).innerHTML = row('Residencial', d.res, '#5aa874') + row('Comercial', d.com, '#5b8fc7') + row('Indústria', d.ind, '#d0a14a') + row('Escritórios', d.off, '#9a7cc4');
    const m = s.hall?.market;
    if (m) (ov.querySelector('.market') as HTMLElement).innerHTML = [
      ['Famílias sem moradia', fmt(m.homeless)], ['Imigrantes aguardando vaga', fmt(m.pending)], ['Moradias vagas', fmt(m.vacant)],
      ['Imóveis abandonados', fmt(m.abandoned)], ['Em demolição', fmt(m.demolishing)], ['Aluguel médio por dia', money(m.rent)],
    ].map(([a, b]) => `<div><span>${a}</span><strong>${b}</strong></div>`).join('');
    const nets = s.hall?.networks ?? [];
    (ov.querySelector('.services') as HTMLElement).innerHTML = nets.slice(0, 4).map((n) => {
      const r = n.demand > 0 ? Math.min(1, n.served / n.demand) : 1;
      return `<button class="meter-row" data-layer="${n.key === 'power' ? 'power' : n.key === 'water' ? 'waterSupply' : n.key === 'garbage' ? 'garbage' : 'waterPollution'}"><span>${n.label}</span><div class="meter ${r < 0.7 ? 'bad' : r < 0.95 ? 'warn' : ''}"><i style="width:${r * 100}%"></i></div><strong>${n.demand > 0 ? pct(r) : '—'}</strong></button>`;
    }).join('');
    const md = s.modal;
    (ov.querySelector('.modal') as HTMLElement).innerHTML = [
      ['A pé', md.walk], ['Bicicleta', md.bike], ['Carro', md.car], ['Ônibus', md.bus], ['Trem e metrô', md.rail],
    ].map(([a, b]) => `<div><span>${a}</span><strong>${pct(b as number)}</strong></div>`).join('') +
      `<div><span>Agora nas ruas</span><strong>${fmt(s.vehicles)} veículos · ${fmt(s.peds)} pedestres</strong></div>`;
  }

  private drawHall(s: Stats) {
    const H: HallReport | undefined = s.hall;
    if (!H) return;
    const key = JSON.stringify([s.day, s.hour, Math.round(s.money), H.integrity && Math.round(H.integrity.index * 100), H.works.map((w) => [w.id, Math.round(w.progress * 50)]), H.lines.map((l) => [l.riders, l.waiting, l.fleet]), H.ledger.length && H.ledger[0]]);
    if (key === this.hallKey) return;
    this.hallKey = key;
    const b = this.bodies.cityhall;
    (b.querySelector('.hall-day') as HTMLElement).textContent = `Dia ${s.day + 1}`;
    const B = H.breakdown;
    (b.querySelector('.hall-budget') as HTMLElement).innerHTML = [
      ['Saldo em caixa', money(s.money), s.money >= 0], ['Dívida em aberto', money(s.debt), s.debt <= 0],
      ['Impostos por dia', money(B.taxes), true], ['Tarifas (água, luz, lixo)', money(B.tariffs), true], ['Repasses estaduais', money(B.transfers), true],
      ...(B.tourism > 0 ? [['Taxa de turismo', money(B.tourism), true]] : []),
      ['Manutenção de equipamentos', money(-B.upkeep), false], ['Conservação de vias', money(-B.roads), false], ['Folha e custeio', money(-B.staff), false],
      ...(B.transit > 0 ? [['Subsídio ao transporte', money(-B.transit), false]] : []), ...(B.interest > 0 ? [['Juros', money(-B.interest), false]] : []),
    ].map(([a, v, good]) => `<div><span>${a}</span><strong class="${good ? 'positive' : 'negative'}">${v}</strong></div>`).join('');
    const I = H.integrity;
    if (I) {
      const lvl = (v: number) => (v < 0.2 ? 'baixa' : v < 0.4 ? 'moderada' : v < 0.6 ? 'alta' : 'sistêmica');
      (b.querySelector('.hall-int') as HTMLElement).innerHTML = `
        <button class="meter-row" data-layer="corruption" title="Ver no mapa"><span><strong>Corrupção</strong><small>${lvl(I.index)} · ${I.investigations} operação(ões) de investigação</small></span><div class="meter ${I.index > 0.5 ? 'bad' : I.index > 0.25 ? 'warn' : ''}"><i style="width:${I.index * 100}%"></i></div><strong>${pct(I.index)}</strong></button>
        <div class="meter-row"><span><strong>Confiança social</strong><small>afeta felicidade e investimento</small></span><div class="meter ${I.trust < 0.4 ? 'bad' : I.trust < 0.6 ? 'warn' : ''}"><i style="width:${I.trust * 100}%"></i></div><strong>${pct(I.trust)}</strong></div>
        <div class="dl">
          <div><span>${I.mayorTitle === 'prefeita' ? 'Prefeita' : 'Prefeito'}</span><strong>${esc(I.mayor)} · desde o ano ${I.since}</strong></div>
          <div><span>Próximas eleições</span><strong>ano ${I.nextElection}</strong></div>
          <div><span>Desvios estimados (total · este ano)</span><strong class="negative">${money(I.diverted)} · ${money(I.divertedYear)}</strong></div>
          <div><span>Obras paradas</span><strong>${I.stalled}</strong></div>
          <div><span>Imóveis abandonados</span><strong>${I.derelict}${I.derelict ? ` · em média há ${I.avgAbandonYears.toFixed(1).replace('.', ',')} anos` : ''}</strong></div>
          <div><span>Ocupações · desabamentos</span><strong>${I.squatted} · ${I.collapses}</strong></div>
        </div>`;
    }
    const LAYER: Record<string, string> = { power: 'power', water: 'waterSupply', sewage: 'waterPollution', garbage: 'garbage', health: 'cov_health', education: 'cov_education', police: 'cov_police', fire: 'cov_fire' };
    (b.querySelector('.hall-net') as HTMLElement).innerHTML = H.networks.map((n) => {
      const r = n.demand > 0 ? Math.min(1, n.served / n.demand) : 1;
      const unit = ['power', 'water', 'sewage', 'garbage'].includes(n.key) ? `${fmt(n.served)} de ${fmt(n.demand)} atendidos` : `${pct(r)} dos moradores no raio de atendimento`;
      return `<button class="meter-row" data-layer="${LAYER[n.key]}" title="Ver no mapa"><span><strong>${n.label}</strong><small>${unit}${n.pending ? ` · ${n.pending} em obra` : ''}</small></span><div class="meter ${r < 0.7 ? 'bad' : r < 0.95 ? 'warn' : ''}"><i style="width:${r * 100}%"></i></div><strong>${n.demand > 0 ? pct(r) : '—'}</strong></button>`;
    }).join('');
    (b.querySelector('.hall-works') as HTMLElement).innerHTML = H.works.length ? H.works.map((w) => `<button class="work" ${w.road ? '' : `data-building="${w.id}"`}><strong>${esc(w.name)}</strong><small>${money(w.cost)} · ${Math.round(w.progress * 100)}% concluído${w.motive ? ' · ' + esc(w.motive) : ''}</small><div class="meter"><i style="width:${w.progress * 100}%"></i></div></button>`).join('') : '<p class="empty">Nenhuma obra municipal em andamento.</p>';
    const KIND: Record<string, string> = { bus: 'Ônibus', brt: 'BRT', rail: 'Trem de passageiros', freight: 'Trem de carga', metro: 'Metrô' };
    (b.querySelector('.hall-lines') as HTMLElement).innerHTML = H.lines.length ? H.lines.map((l) => `<button class="work line-row" style="--line-color:${l.color}" data-line="${l.id}"><strong>${esc(l.name)}</strong><small>${KIND[l.kind] ?? l.kind} · ${l.fleet} na frota · ${l.stops} paradas</small><small>${fmt(l.riders)} passageiros ontem${l.waiting ? ` · ${l.waiting} aguardando agora` : ''}</small></button>`).join('') : '<p class="empty">Aguardando demanda medida para implantar as primeiras linhas.</p>';
    const c = H.lastCycle;
    (b.querySelector('.hall-cycle') as HTMLElement).innerHTML = c ? `<p class="hint">Dia ${c.day + 1}: a prefeitura listou necessidades, gerou projetos e escolheu por custo-benefício.</p>
      ${c.chosen.length ? `<h4>Aprovados</h4>${c.chosen.map((x) => `<div class="alt">✓ ${esc(x)}</div>`).join('')}` : '<p class="empty">Nenhum projeto aprovado.</p>'}
      ${c.rejected.length ? `<h4>Adiados</h4>${c.rejected.map((x) => `<div class="alt">· ${esc(x)}</div>`).join('')}` : ''}` : '<p class="empty">O primeiro ciclo de planejamento ainda não ocorreu.</p>';
    (b.querySelector('.hall-ledger') as HTMLElement).innerHTML = H.ledger.map((l) => `<div><span>Dia ${l.day + 1} · ${esc(l.text)}</span><strong class="${l.value >= 0 ? 'positive' : 'negative'}">${l.value >= 0 ? '+' : ''}${money(l.value)}</strong></div>`).join('') || '<p class="empty">Sem lançamentos ainda.</p>';
  }

  private eventHtml(e: SimEvent, details: boolean) {
    const k = newsKind(e.type);
    const year = Math.floor(e.day / 12) + 1;
    return `<button class="event${e.id === this.selectedStory ? ' selected' : ''}" data-event="${e.id}">
      <span class="event-icon ${k}">${icon(NEWS_ICON[k], 15)}</span>
      <span class="event-copy"><strong class="${details && e.headline ? 'headline' : ''}">${esc(details && e.headline ? e.headline : e.text)}</strong><small>${NEWS_LABEL[k]} <b>·</b> Ano ${year} <b>·</b> dia ${e.day % 12 + 1}</small>${details && e.headline && e.headline !== e.text ? `<span class="event-detail">${esc(e.text)}</span>` : ''}</span>
      <span class="event-open">${icon('locate', 12)}</span></button>`;
  }

  private drawChronicle(force = false) {
    if (this.tab !== 'chronicle' && !force) return;
    const b = this.bodies.chronicle;
    const kind = (b.querySelector('select') as HTMLSelectElement).value;
    const all = this.events.filter((e) => e.headline);
    const vis = all.filter((e) => kind === 'all' || newsKind(e.type) === kind).slice(-80).reverse();
    const story = this.events.find((e) => e.id === this.selectedStory);
    const sk = story ? storyKey(story) : null;
    const related = sk ? this.events.filter((e) => e.id !== story!.id && storyKey(e) === sk).slice(-5).reverse() : [];
    const key = JSON.stringify([kind, vis.length && vis[0].id, vis.length, this.selectedStory, related.map((e) => e.id)]);
    if (key === this.chronKey && !force) return;
    this.chronKey = key;
    const rel = b.querySelector('.related') as HTMLElement;
    rel.hidden = !related.length;
    rel.innerHTML = related.length ? `<h3>Do mesmo assunto</h3>${related.map((e) => this.eventHtml(e, false)).join('')}` : '';
    (b.querySelector('.chron') as HTMLElement).innerHTML = vis.length ? vis.map((e) => this.eventHtml(e, true)).join('') : '<p class="empty">Nenhuma notícia desta categoria ainda.</p>';
  }

  frame(_dt: number) {
    this.clockEl.textContent = this.app.timeLabel();
    const s = this.app.stats;
    this.dirhud.textContent = this.app.mode === 'auto' || this.app.mode === 'cinematic'
      ? `plano: ${this.app.director.status()}${s ? ` · ${fmt(s.vehicles)} veículos · ${fmt(s.peds)} pedestres` : ''}`
      : this.app.mode === 'free' ? 'câmera livre — o diretor retoma após alguns segundos sem interação' : 'seguindo — clique em Voltar ao auto-diretor para sair';
    this.inspector.frame();
  }

  caption(text: string) {
    const [lead, ...rest] = text.split(' — ');
    (this.cap.querySelector('small') as HTMLElement).textContent = rest.length ? lead : (this.app.dateLabel() || 'Cidade Viva');
    (this.cap.querySelector('strong') as HTMLElement).textContent = rest.length ? rest.join(' — ') : lead;
    this.cap.classList.add('show');
    if (this.capTimer) clearTimeout(this.capTimer);
    this.capTimer = setTimeout(() => this.cap.classList.remove('show'), 7000);
  }

  toast(text: string) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 4000);
  }

  /** every event goes here (stories use non-headline events as related context) */
  addEvent(ev: SimEvent) {
    this.events.push(ev);
    if (this.events.length > 1500) this.events.splice(0, this.events.length - 1500);
    if (!ev.headline && (ev.mag < 0.6 || ev.type === 'train')) return;
    const recent = this.events.filter((e) => e.headline || (e.mag >= 0.6 && e.type !== 'train')).slice(-4).reverse();
    const key = recent.map((e) => e.id).join(',');
    if (key !== this.recentKey) {
      this.recentKey = key;
      (this.bodies.overview.querySelector('.recent') as HTMLElement).innerHTML = recent.map((e) => this.eventHtml(e, false)).join('');
    }
    this.drawChronicle();
  }
  addChronicle(ev: SimEvent) { this.addEvent(ev); }
}

export function el(tag: string, cls: string, parent: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}
export function btn(label: string, parent: HTMLElement, fn: () => void): HTMLElement {
  const b = el('button', 'button', parent);
  b.textContent = label;
  b.onclick = fn;
  return b;
}
