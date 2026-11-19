import type { App } from '../app';
import { PRESETS, RESTART_KEYS, type SimParams } from '../shared/params';
import { btn, el } from './hud';

type Def = { key: keyof SimParams; label: string; min?: number; max?: number; step?: number; options?: [string, string][]; group: string; hint?: string };

const DEFS: Def[] = [
  { group: 'Mundo', key: 'seed', label: 'Seed', min: 1, max: 99999, step: 1 },
  { group: 'Mundo', key: 'terrain', label: 'Terreno', options: [['vale', 'Vale de rio'], ['litoral', 'Litoral'], ['serra', 'Serra'], ['planicie', 'Planície']] },
  { group: 'Mundo', key: 'mapSize', label: 'Tamanho do mapa', options: [['1800', 'Pequeno (1,8 km)'], ['2400', 'Médio (2,4 km)'], ['3200', 'Grande (3,2 km)']] },
  { group: 'Mundo', key: 'raininess', label: 'Chuva', min: 0, max: 1, step: 0.05 },
  { group: 'Demografia', key: 'immigration', label: 'Imigração', min: 0, max: 2.5, step: 0.05 },
  { group: 'Demografia', key: 'natality', label: 'Natalidade', min: 0, max: 2.5, step: 0.05 },
  { group: 'Demografia', key: 'lifeExpectancy', label: 'Expectativa de vida', min: 50, max: 95, step: 1 },
  { group: 'Demografia', key: 'inequality', label: 'Desigualdade', min: 0, max: 1, step: 0.05 },
  { group: 'Economia', key: 'taxRate', label: 'Impostos', min: 0, max: 0.3, step: 0.01 },
  { group: 'Economia', key: 'vocation', label: 'Vocação', options: [['industria', 'Indústria'], ['servicos', 'Serviços'], ['turismo', 'Turismo'], ['agricultura', 'Agricultura']] },
  { group: 'Economia', key: 'energyCost', label: 'Custo da energia', min: 0.5, max: 2, step: 0.05 },
  { group: 'Planejamento', key: 'budgetMult', label: 'Orçamento da prefeitura', min: 0.3, max: 2.5, step: 0.05 },
  { group: 'Planejamento', key: 'transitPriority', label: 'Carro ↔ transporte público', min: 0, max: 1, step: 0.05 },
  { group: 'Planejamento', key: 'maxDensity', label: 'Densidade máxima', min: 1, max: 5, step: 1 },
  { group: 'Planejamento', key: 'pollutionTolerance', label: 'Tolerância à poluição', min: 0, max: 1, step: 0.05 },
  { group: 'Planejamento', key: 'envPreservation', label: 'Preservação ambiental', min: 0, max: 1, step: 0.05 },
  { group: 'Planejamento', key: 'gridGrowth', label: 'Orgânico ↔ grade', min: 0, max: 1, step: 0.05 },
  { group: 'Sociedade', key: 'baseCrime', label: 'Criminalidade base', min: 0, max: 2, step: 0.05 },
  { group: 'Sociedade', key: 'policeEfficiency', label: 'Eficiência policial', min: 0, max: 2, step: 0.05 },
  { group: 'Sociedade', key: 'initialEducation', label: 'Educação inicial', min: 0, max: 1, step: 0.05 },
  { group: 'Sociedade', key: 'corruption', label: 'Propensão à corrupção', min: 0, max: 1, step: 0.05 },
  { group: 'Sociedade', key: 'transparency', label: 'Transparência e imprensa', min: 0, max: 1, step: 0.05 },
  { group: 'Eventos', key: 'disasterFreq', label: 'Frequência de desastres', min: 0, max: 3, step: 0.1 },
  { group: 'Eventos', key: 'festivalFreq', label: 'Frequência de festivais', min: 0, max: 3, step: 0.1 },
];

export class ParamsPanel {
  private panel: HTMLElement;
  private pendingRestart: Partial<SimParams> = {};

  constructor(private app: App, container: HTMLElement) {
    this.panel = el('div', '', container);
    this.build();
  }

  private build() {
    const p = this.app.params;
    const P = this.panel;
    P.innerHTML = '<div class="section-heading"><h2>Parâmetros</h2></div><p class="hint">Mudanças valem ao vivo e a cidade reage nas próximas horas de jogo. Itens do “Mundo” (seed, terreno, tamanho) geram uma nova cidade.</p>';
    el('h4', '', P).textContent = 'Predefinições';
    const pr = el('div', 'presets', P);
    for (const name of Object.keys(PRESETS)) btn(name, pr, () => this.applyPreset(name));
    let group = '';
    let box: HTMLElement = P;
    for (const d of DEFS) {
      if (d.group !== group) {
        group = d.group;
        box = el('details', 'settings', P);
        if (group === 'Mundo' || group === 'Planejamento') box.setAttribute('open', '');
        el('summary', '', box).textContent = group;
      }
      const w = el('div', 'param', box);
      const lab = el('label', '', w);
      const val = String(p[d.key]);
      if (d.options) {
        lab.innerHTML = `<span>${d.label}</span>`;
        const s = el('select', '', w) as HTMLSelectElement;
        for (const [k, l] of d.options) { const o = document.createElement('option'); o.value = k; o.textContent = l; if (k === val) o.selected = true; s.appendChild(o); }
        s.onchange = () => this.set(d.key, d.key === 'mapSize' ? Number(s.value) : s.value);
      } else {
        lab.innerHTML = `<span>${d.label}</span><b>${fmtV(p[d.key] as number)}</b>`;
        const r = el('input', '', w) as HTMLInputElement;
        r.type = 'range'; r.min = String(d.min); r.max = String(d.max); r.step = String(d.step); r.value = val;
        r.oninput = () => { (lab.querySelector('b') as HTMLElement).textContent = fmtV(Number(r.value)); };
        r.onchange = () => this.set(d.key, Number(r.value));
      }
    }
    const restart = btn('↻ Gerar novo mundo', P, () => this.app.restart({ ...this.app.params, ...this.pendingRestart }));
    restart.style.marginTop = '10px';
    restart.className = 'button primary restart';
    restart.style.display = 'none';
    const visBox = el('details', 'settings', P);
    visBox.setAttribute('open', '');
    el('summary', '', visBox).textContent = 'Visual';
    const vis = el('div', '', visBox);
    const tilt = el('div', 'param', vis);
    tilt.innerHTML = '<label><span>Tilt-shift (diorama)</span></label>';
    const tr = el('input', '', tilt) as HTMLInputElement;
    tr.type = 'range'; tr.min = '0'; tr.max = '1'; tr.step = '0.05'; tr.value = String(this.app.tiltShift);
    tr.oninput = () => { this.app.tiltShift = Number(tr.value); };
    const hr = el('div', 'param', vis);
    hr.innerHTML = '<label><span>Hora</span><b>ciclo</b></label>';
    const hs = el('input', '', hr) as HTMLInputElement;
    hs.type = 'range'; hs.min = '-1'; hs.max = '24'; hs.step = '0.5'; hs.value = '-1';
    hs.oninput = () => { const v = Number(hs.value); this.app.fixedHour = v < 0 ? null : v; (hr.querySelector('b') as HTMLElement).textContent = v < 0 ? 'ciclo' : `${v}h fixa`; };
    const q = el('div', 'param', vis);
    q.innerHTML = '<label><span>Qualidade gráfica</span></label>';
    const qs = el('select', '', q) as HTMLSelectElement;
    for (const k of ['baixa', 'média', 'alta']) { const o = document.createElement('option'); o.value = k; o.textContent = k; if (k === this.app.rig.quality) o.selected = true; qs.appendChild(o); }
    qs.onchange = () => this.app.rig.setQuality(qs.value as 'baixa');
  }

  private set(key: keyof SimParams, v: number | string) {
    if (RESTART_KEYS.includes(key)) {
      (this.pendingRestart as Record<string, unknown>)[key] = v;
      (this.panel.querySelector('.restart') as HTMLElement).style.display = 'flex';
      return;
    }
    (this.app.params as unknown as Record<string, unknown>)[key] = v;
    this.app.send({ type: 'params', params: { [key]: v } as Partial<SimParams> });
    this.app.hud.toast(`Parâmetro "${DEFS.find((d) => d.key === key)?.label}" alterado — observe a reação da cidade`);
  }

  private applyPreset(name: string) {
    const pr = PRESETS[name];
    const live: Partial<SimParams> = {};
    let restart = false;
    for (const [k, v] of Object.entries(pr)) {
      if (RESTART_KEYS.includes(k as keyof SimParams) && (this.app.params as unknown as Record<string, unknown>)[k] !== v) restart = true;
      (live as Record<string, unknown>)[k] = v;
    }
    if (restart) { this.app.restart({ ...this.app.params, ...live }); return; }
    Object.assign(this.app.params, live);
    this.app.send({ type: 'params', params: live });
    this.build();
    this.app.hud.toast(`Preset aplicado: ${name}`);
  }

}
const fmtV = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2));
