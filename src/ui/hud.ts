import type { App } from '../app';
import { ERAS } from '../shared/constants';
import type { SimEvent, Stats } from '../shared/protocol';
import { Inspector } from './inspector';
import { ParamsPanel } from './paramsPanel';
import { Charts } from './charts';

const fmt = (n: number) => Math.round(n).toLocaleString('pt-BR');

export class Hud {
  root: HTMLElement;
  private top: HTMLElement;
  private cap: HTMLElement;
  private toastEl: HTMLElement;
  private dirhud: HTMLElement;
  private chron: HTMLElement;
  private speedBtns = new Map<number, HTMLElement>();
  private modeBtns = new Map<string, HTMLElement>();
  private autoBtn!: HTMLElement;
  inspector: Inspector;
  params: ParamsPanel;
  charts: Charts;
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private panelBtns = new Map<string, HTMLElement>();

  constructor(private app: App, root: HTMLElement) {
    this.root = root;
    this.top = el('div', 'panel topbar', root);
    this.cap = el('div', 'caption', root);
    this.toastEl = el('div', 'panel toast', root);
    this.dirhud = el('div', 'dirhud', root);
    this.chron = el('div', 'panel chron', root);
    this.chron.innerHTML = '<h4 style="margin:0 0 6px;color:var(--acc);font-size:12px;letter-spacing:1px">CRÔNICA DA CIDADE</h4><div class="list"></div>';
    this.inspector = new Inspector(app, root);
    this.params = new ParamsPanel(app, root);
    this.charts = new Charts(app, root);
    this.buildTop();
    this.buildDock();
  }

  private buildTop() {
    this.top.innerHTML = `<span class="date"></span><span class="clock stat"></span><span class="era"></span>
      <span class="stat">Pop <b class="pop">0</b></span><span class="stat">Caixa <b class="money">0</b></span>
      <span class="stat weather"></span>`;
    const g = el('span', 'group', this.top);
    const speeds: [number, string][] = [[0, '⏸'], [1, '1×'], [10, '10×'], [100, '100×'], [400, '⏩ time-lapse']];
    for (const [s, label] of speeds) {
      const b = btn(label, g, () => { this.app.autoSpeed = false; this.app.setSpeed(s); });
      this.speedBtns.set(s, b);
    }
    this.autoBtn = btn('auto', g, () => { this.app.autoSpeed = !this.app.autoSpeed; this.refreshSpeed(); });
    this.autoBtn.title = 'Velocidade automática: o diretor desacelera em cenas próximas e acelera em planos gerais';
    this.refreshSpeed();
  }

  private buildDock() {
    const dock = el('div', 'panel dock', this.root);
    const modes: [string, string][] = [['auto', '🎬 Auto-diretor'], ['free', '🕹 Livre'], ['cinematic', '🎞 Cinemático']];
    for (const [m, label] of modes) this.modeBtns.set(m, btn(label, dock, () => this.app.setMode(m as 'auto')));
    sep(dock);
    const panels: [string, string, () => void][] = [
      ['params', '⚙ Parâmetros', () => this.params.toggle()],
      ['chron', '📰 Crônica', () => this.chron.classList.toggle('open')],
      ['charts', '📈 Gráficos', () => this.charts.toggle()],
      ['overlay', '🗺 Mapas', () => this.app.overlays.toggleMenu?.()],
      ['metro', '🚇 Linhas', () => this.app.overlays.toggleMetro?.()],
      ['inject', '⚡ Injetar evento', () => this.toggleInject()],
      ['audio', '🔊 Áudio', () => { const on = this.app.audio.toggle?.(); this.panelBtns.get('audio')!.classList.toggle('on', !!on); }],
    ];
    for (const [k, label, fn] of panels) this.panelBtns.set(k, btn(label, dock, fn));
    this.refreshMode();
    this.injectMenu = el('div', 'panel menu', this.root);
    const evs: [string, string][] = [['immigration', '🧳 Onda de imigração'], ['megafactory', '🏭 Mega-fábrica'], ['crisis', '📉 Crise econômica'], ['sports', '🏟 Grande evento esportivo'], ['storm', '⛈ Tempestade'], ['fire', '🔥 Incêndio'], ['epidemic', '🦠 Epidemia leve'], ['festival', '🎉 Festival'], ['blackout', '🔌 Apagão']];
    for (const [k, label] of evs) btn(label, this.injectMenu, () => { this.app.send({ type: 'inject', event: k }); this.toast('Evento injetado: ' + label); this.injectMenu.classList.remove('open'); });
  }
  private injectMenu!: HTMLElement;
  private toggleInject() { this.injectMenu.classList.toggle('open'); }

  refreshSpeed() {
    for (const [s, b] of this.speedBtns) b.classList.toggle('on', s === this.app.speed && !this.app.autoSpeed);
    this.autoBtn.classList.toggle('on', this.app.autoSpeed);
  }
  refreshMode() {
    for (const [m, b] of this.modeBtns) b.classList.toggle('on', m === this.app.mode);
  }

  updateStats(s: Stats) {
    const q = (c: string) => this.top.querySelector('.' + c) as HTMLElement;
    q('date').textContent = `Ano ${s.year} · ${['Primavera', 'Verão', 'Outono', 'Inverno'][s.season]}`;
    q('era').textContent = ERAS[s.era];
    q('pop').textContent = fmt(s.population);
    q('money').textContent = (s.money < 0 ? '−' : '') + '$' + fmt(Math.abs(s.money));
    q('weather').textContent = `${s.weather} · ${s.temperature.toFixed(0)}°C`;
    this.charts.push(s);
    this.params.onStats(s);
  }

  frame(_dt: number) {
    (this.top.querySelector('.clock') as HTMLElement).textContent = this.app.timeLabel();
    const s = this.app.stats;
    this.dirhud.textContent = this.app.mode === 'auto' || this.app.mode === 'cinematic'
      ? `diretor: ${this.app.director.status()}${s ? ` · ${s.speedActual.toFixed(0)}× real · ${s.vehicles} veículos · ${s.peds} pedestres` : ''}`
      : this.app.mode === 'free' ? 'câmera livre — o diretor retoma após alguns segundos sem interação' : 'seguindo entidade';
    this.inspector.frame();
  }

  caption(text: string) {
    const [lead, ...rest] = text.split(' — ');
    this.cap.innerHTML = `<span class="lead">${lead}</span>${rest.join(' — ')}`;
    this.cap.classList.add('show');
    if (this.capTimer) clearTimeout(this.capTimer);
    this.capTimer = setTimeout(() => this.cap.classList.remove('show'), 6500);
  }

  toast(text: string) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    setTimeout(() => this.toastEl.classList.remove('show'), 4000);
  }

  addChronicle(ev: SimEvent) {
    const list = this.chron.querySelector('.list')!;
    const d = document.createElement('div');
    d.className = 'item';
    const year = Math.floor(ev.day / 12) + 1;
    d.innerHTML = `<div class="d">Ano ${year} · dia ${ev.day % 12 + 1}</div><div class="h">${ev.headline}</div>`;
    d.style.cursor = 'pointer';
    d.onclick = () => { this.app.enterFree(); this.app.controls.target.set(ev.x, 0, ev.z); this.app.rig.camera.position.set(ev.x + 120, 140, ev.z + 120); };
    list.prepend(d);
    while (list.children.length > 200) list.lastChild?.remove();
  }
}

export function el(tag: string, cls: string, parent: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}
export function btn(label: string, parent: HTMLElement, fn: () => void): HTMLElement {
  const b = el('button', 'btn', parent);
  b.textContent = label;
  b.onclick = fn;
  return b;
}
function sep(p: HTMLElement) { const s = el('span', '', p); s.style.width = '6px'; }
