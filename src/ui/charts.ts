import type { Stats } from '../shared/protocol';

const fmt = (n: number) => Math.round(n).toLocaleString('pt-BR');
const money = (n: number) => (n < 0 ? '−' : '') + '$ ' + fmt(Math.abs(n));
const pct = (x: number) => `${(x * 100).toFixed(1).replace('.', ',')}%`;

interface Series { key: string; label: string; get: (s: Stats) => number; fmt?: (v: number) => string; color: string }
const SERIES: Series[] = [
  { key: 'pop', label: 'População', get: (s) => s.population, color: '#38815f' },
  { key: 'gdp', label: 'PIB por dia', get: (s) => s.gdp, fmt: money, color: '#3d7fb0' },
  { key: 'money', label: 'Caixa da prefeitura', get: (s) => s.money, fmt: money, color: '#7a5fb0' },
  { key: 'happy', label: 'Felicidade', get: (s) => s.happiness, fmt: pct, color: '#c08a2b' },
  { key: 'unemp', label: 'Desemprego', get: (s) => s.unemployed / Math.max(1, s.employed + s.unemployed), fmt: pct, color: '#b8573f' },
  { key: 'emis', label: 'Emissões', get: (s) => s.emissions, color: '#6b7a73' },
  { key: 'crime', label: 'Criminalidade', get: (s) => s.crime * 100, fmt: (v) => v.toFixed(1).replace('.', ','), color: '#a3473a' },
  { key: 'tour', label: 'Turistas', get: (s) => s.tourists, color: '#2a8a9a' },
  { key: 'moving', label: 'Em deslocamento agora', get: (s) => s.vehicles + s.peds + s.virtualTrips, color: '#3e6f8f' },
];

/** Live chart card (SVG area chart with a metric selector), ~8 samples per game day. */
export class Charts {
  private data: Stats[] = [];
  private lastKey = -1;
  private sel: HTMLSelectElement;
  private line: SVGPathElement; private area: SVGPathElement; private dot: SVGCircleElement;
  private value: HTMLElement; private start: HTMLElement; private stop0: SVGStopElement; private stop1: SVGStopElement;

  constructor(card: HTMLElement) {
    card.innerHTML = `<div class="card-title"><strong>Evolução</strong><select aria-label="Métrica">${SERIES.map((s) => `<option value="${s.key}">${s.label}</option>`).join('')}</select></div>
      <div class="chart-value">—</div>
      <div class="chart"><svg viewBox="0 0 260 76" preserveAspectRatio="none" role="img" aria-label="Série temporal"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-opacity=".42"/><stop offset="100%" stop-opacity=".03"/></linearGradient></defs>
      <path class="graph-grid" d="M1 15H259 M1 39H259 M1 63H259"/><path class="area" fill="url(#chart-fill)"/><path class="line" fill="none" stroke-width="2" vector-effect="non-scaling-stroke"/><circle r="3.2"/></svg></div>
      <div class="chart-labels"><span class="start">INÍCIO</span><span>AGORA</span></div>`;
    this.sel = card.querySelector('select')!;
    this.sel.onchange = () => this.draw();
    this.line = card.querySelector('.line')!; this.area = card.querySelector('.area')!; this.dot = card.querySelector('circle')!;
    this.value = card.querySelector('.chart-value')!; this.start = card.querySelector('.start')!;
    const stops = card.querySelectorAll('stop');
    this.stop0 = stops[0] as SVGStopElement; this.stop1 = stops[1] as SVGStopElement;
  }

  push(s: Stats) {
    const key = Math.floor((s.day + s.hour / 24) * 8);
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.data.push(s);
      if (this.data.length > 1500) this.data.splice(0, this.data.length - 1500);
    } else this.data[this.data.length - 1] = s;
    this.draw();
  }

  private draw() {
    const ser = SERIES.find((x) => x.key === this.sel.value) ?? SERIES[0];
    // keep at most ~260 points (downsample older history)
    const src = this.data;
    const step = Math.max(1, Math.ceil(src.length / 260));
    const vals: number[] = [];
    for (let i = 0; i < src.length; i += step) vals.push(ser.get(src[i]));
    if (src.length) vals[vals.length - 1] = ser.get(src[src.length - 1]);
    if (!vals.length) return;
    const last = vals[vals.length - 1];
    this.value.textContent = ser.fmt ? ser.fmt(last) : fmt(last);
    this.value.style.color = ser.color;
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.15, Math.abs(hi) * 0.02, 1e-6);
    lo -= pad; hi += pad;
    const pts = (vals.length === 1 ? [vals[0], vals[0]] : vals).map((v, i, a) => [2 + (i / (a.length - 1)) * 253, 70 - ((v - lo) / (hi - lo)) * 62]);
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    this.line.setAttribute('d', d);
    this.line.setAttribute('stroke', ser.color);
    this.area.setAttribute('d', d + ' L255 76 L2 76Z');
    this.stop0.setAttribute('stop-color', ser.color); this.stop1.setAttribute('stop-color', ser.color);
    this.dot.setAttribute('cx', '255'); this.dot.setAttribute('cy', String(pts[pts.length - 1][1]));
    this.dot.setAttribute('fill', ser.color);
    const first = src[0];
    this.start.textContent = first ? `ANO ${first.year} · DIA ${first.day % 12 + 1}` : 'INÍCIO';
  }
}
