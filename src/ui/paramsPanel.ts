import type { App } from '../app';
import { PRESETS, RESTART_KEYS, type SimParams } from '../shared/params';
import type { Stats } from '../shared/protocol';
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
  { group: 'Eventos', key: 'disasterFreq', label: 'Frequência de desastres', min: 0, max: 3, step: 0.1 },
  { group: 'Eventos', key: 'festivalFreq', label: 'Frequência de festivais', min: 0, max: 3, step: 0.1 },
];

export class ParamsPanel {
  private panel: HTMLElement;
  private pendingRestart: Partial<SimParams> = {};
  private demand!: HTMLElement;

  constructor(private app: App, root: HTMLElement) {
    this.panel = el('div', 'panel leftbar', root);
    this.build();
  }
  toggle() { this.panel.classList.toggle('open'); }

  private build() {
    const p = this.app.params;
    const P = this.panel;
    P.innerHTML = '<h3 style="margin:0 0 4px">Parâmetros</h3><div style="color:var(--mut)">Mudanças valem ao vivo. Itens do "Mundo" (seed, terreno, tamanho) reiniciam a cidade.</div>';
    const pr = el('div', '', P);
    pr.innerHTML = '<h4>Presets</h4>';
    for (const name of Object.keys(PRESETS)) btn(name, pr, () => this.applyPreset(name)).style.margin = '2px';
    let group = '';
    for (const d of DEFS) {
      if (d.group !== group) { group = d.group; el('h4', '', P).textContent = group; }
      const w = el('div', 'param', P);
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
    const restart = btn('↻ Reiniciar com o novo mundo', P, () => this.app.restart({ ...this.app.params, ...this.pendingRestart }));
    restart.style.marginTop = '8px';
    restart.className = 'btn restart';
    restart.style.display = 'none';
    el('h4', '', P).textContent = 'Visual';
    const vis = el('div', '', P);
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
    el('h4', '', P).textContent = 'Demanda (RCI)';
    this.demand = el('div', '', P);
  }

  private set(key: keyof SimParams, v: number | string) {
    if (RESTART_KEYS.includes(key)) {
      (this.pendingRestart as Record<string, unknown>)[key] = v;
      (this.panel.querySelector('.restart') as HTMLElement).style.display = 'block';
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
    this.panel.classList.add('open');
    this.app.hud.toast(`Preset aplicado: ${name}`);
  }

  onStats(s: Stats) {
    if (!this.demand) return;
    const bar = (l: string, v: number, c: string) => `<div class="term"><span>${l}</span><div class="tb"><i style="${v >= 0 ? `left:50%;width:${Math.min(50, v * 1.5)}%` : `left:${50 - Math.min(50, -v * 1.5)}%;width:${Math.min(50, -v * 1.5)}%`};background:${c}"></i></div><span class="v">${v.toFixed(0)}</span></div>`;
    this.demand.innerHTML = bar('Residencial', s.demand.res, '#5fd38a') + bar('Comercial', s.demand.com, '#54a0ff') + bar('Industrial', s.demand.ind, '#f2b705') + bar('Escritórios', s.demand.off, '#c56cf0');
  }
}
const fmtV = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2));
