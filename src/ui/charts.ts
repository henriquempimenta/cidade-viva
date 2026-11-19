import type { App } from '../app';
import type { Stats } from '../shared/protocol';
import { el } from './hud';

interface Series { label: string; get: (s: Stats) => number; color: string; fmt?: (v: number) => string }

export class Charts {
  private panel: HTMLElement;
  private series: Series[] = [
    { label: 'População', get: (s) => s.population, color: '#5fd38a' },
    { label: 'PIB / dia', get: (s) => s.gdp, color: '#54a0ff' },
    { label: 'Desemprego %', get: (s) => (s.unemployed / Math.max(1, s.employed + s.unemployed)) * 100, color: '#ff6b6b', fmt: (v) => v.toFixed(1) + '%' },
    { label: 'Felicidade', get: (s) => s.happiness * 100, color: '#feca57', fmt: (v) => v.toFixed(0) + '%' },
    { label: 'Caixa da prefeitura', get: (s) => s.money, color: '#c56cf0' },
    { label: 'Emissões', get: (s) => s.emissions, color: '#a4b0be' },
    { label: 'Criminalidade', get: (s) => s.crime * 100, color: '#ff9f43', fmt: (v) => v.toFixed(1) },
    { label: 'Turistas', get: (s) => s.tourists, color: '#48dbfb' },
    { label: 'Veículos ativos', get: (s) => s.vehicles + s.virtualTrips, color: '#dfe4ea' },
  ];
  private canvases: HTMLCanvasElement[] = [];
  private vals: HTMLElement[] = [];
  private data: Stats[] = [];
  private lastDay = -1;

  constructor(private app: App, root: HTMLElement) {
    this.panel = el('div', 'panel charts', root);
    for (const s of this.series) {
      const c = el('div', 'c', this.panel);
      c.innerHTML = `<div style="display:flex;justify-content:space-between"><span>${s.label}</span><b style="color:${s.color}"></b></div>`;
      this.vals.push(c.querySelector('b') as HTMLElement);
      const cv = el('canvas', '', c) as HTMLCanvasElement;
      cv.width = 360; cv.height = 120;
      this.canvases.push(cv);
    }
    void this.app;
  }
  toggle() { this.panel.classList.toggle('open'); this.draw(); }

  push(s: Stats) {
    // sample about 8 points per game day
    const key = Math.floor((s.day + s.hour / 24) * 8);
    if (key === this.lastDay) return;
    this.lastDay = key;
    this.data.push(s);
    if (this.data.length > 1200) this.data.splice(0, this.data.length - 1200);
    if (this.panel.classList.contains('open')) this.draw();
  }

  private draw() {
    this.series.forEach((ser, i) => {
      const cv = this.canvases[i];
      const ctx = cv.getContext('2d')!;
      ctx.clearRect(0, 0, cv.width, cv.height);
      const vals = this.data.map(ser.get);
      if (vals.length < 2) return;
      let mn = Math.min(...vals), mx = Math.max(...vals);
      if (mx - mn < 1e-6) { mx += 1; mn -= 1; }
      ctx.strokeStyle = 'rgba(255,255,255,.08)';
      ctx.beginPath(); ctx.moveTo(0, cv.height - 1); ctx.lineTo(cv.width, cv.height - 1); ctx.stroke();
      ctx.strokeStyle = ser.color; ctx.lineWidth = 3;
      ctx.beginPath();
      vals.forEach((v, k) => {
        const x = (k / (vals.length - 1)) * cv.width, y = cv.height - 6 - ((v - mn) / (mx - mn)) * (cv.height - 12);
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      const last = vals[vals.length - 1];
      this.vals[i].textContent = ser.fmt ? ser.fmt(last) : Math.round(last).toLocaleString('pt-BR');
    });
  }
}
