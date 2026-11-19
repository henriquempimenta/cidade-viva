import * as THREE from 'three';
import type { App } from '../app';
import type { TransitLineView } from '../shared/protocol';
import { FIELD_LABELS, type FieldName } from '../shared/catalog';
import { U } from './uniforms';
import { el } from '../ui/hud';

const GROUPS: [string, string[]][] = [
  ['Redes e fluxos', ['lines', 'od', 'cargo', 'congestion', 'accessibility', 'transit']],
  ['Ambiente', ['landValue', 'airPollution', 'waterPollution', 'soilPollution', 'noise', 'beauty', 'tourism']],
  ['Serviços e qualidade de vida', ['crime', 'corruption', 'happiness', 'cov_health', 'cov_education', 'cov_police', 'cov_fire', 'cov_parks', 'power', 'waterSupply', 'garbage']],
  ['Densidade', ['resDensity', 'jobDensity']],
];
const MENU: [string, string][] = [
  ['corruption', 'Corrupção local'], ['power', 'Rede de energia (falta)'], ['waterSupply', 'Abastecimento de água'], ['garbage', 'Lixo acumulado'],
  ['landValue', 'Valor do solo'], ['airPollution', 'Poluição do ar'], ['waterPollution', 'Poluição da água'], ['soilPollution', 'Poluição do solo'],
  ['noise', 'Ruído'], ['crime', 'Criminalidade'], ['congestion', 'Congestionamento'], ['accessibility', 'Acessibilidade'], ['beauty', 'Beleza / paisagem'],
  ['cov_health', 'Cobertura de saúde'], ['cov_education', 'Cobertura de educação'], ['cov_police', 'Cobertura policial'], ['cov_fire', 'Cobertura de bombeiros'],
  ['cov_parks', 'Parques'], ['happiness', 'Felicidade'], ['tourism', 'Atratividade turística'], ['transit', 'Acesso a transporte'],
  ['resDensity', 'Densidade residencial'], ['jobDensity', 'Densidade de empregos'],
  ['lines', 'Rede de transporte'], ['cargo', 'Fluxos de carga'], ['od', 'Fluxos origem–destino'],
];

/** Heatmaps, transit lines, OD arcs and the schematic metro map. */
export class Overlays {
  group = new THREE.Group();
  private tex: THREE.DataTexture;
  private G: number;
  private current: string | null = null;
  private menu: HTMLElement;
  private legend: HTMLElement;
  private metro: HTMLElement;
  private metroCanvas: HTMLCanvasElement;
  lines = new Map<number, TransitLineView>();
  private lineGroup = new THREE.Group();
  private stopGroup = new THREE.Group();
  private arcGroup = new THREE.Group();
  private odGroup = new THREE.Group();
  private shelterGeo = new THREE.BoxGeometry(3, 2.6, 1.4);
  private shelterMat = new THREE.MeshStandardMaterial({ color: 0x4a6a8a, transparent: true, opacity: 0.85 });

  constructor(private app: App) {
    this.G = app.init.fieldRes;
    this.tex = new THREE.DataTexture(new Uint8Array(this.G * this.G * 4), this.G, this.G, THREE.RGBAFormat);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    U.uOverlay.value = this.tex;
    this.group.add(this.lineGroup, this.stopGroup, this.arcGroup, this.odGroup);
    this.lineGroup.visible = false;
    const root = app.uiRoot;
    this.menu = document.createElement('div');
    this.menu.className = 'pop-menu';
    const label = (k: string) => MENU.find((m) => m[0] === k)?.[1] ?? k;
    const item = (parent: HTMLElement, k: string | null, text: string) => {
      const b = el('button', '', parent);
      b.innerHTML = `<i></i>${text}`;
      b.dataset.layer = k ?? '';
      b.setAttribute('aria-pressed', String(k === null));
      b.onclick = () => this.select(k);
    };
    el('strong', '', this.menu).textContent = 'Camadas do mapa';
    const g0 = el('div', 'layer-group', this.menu);
    item(g0, null, 'Vista natural');
    for (const [title, keys] of GROUPS) {
      const g = el('div', 'layer-group', this.menu);
      el('small', '', g).textContent = title;
      for (const k of keys) item(g, k, label(k));
    }
    document.addEventListener('click', (e) => { if (!(e.target as Element).closest('.scene-tools')) this.menu.classList.remove('open'); });
    this.legend = el('div', 'overlay-key glass', root);
    this.metro = el('div', 'metro', root);
    this.metro.innerHTML = '<div style="display:flex;justify-content:space-between"><b>Mapa esquemático da rede de transporte</b><span class="x">✕ fechar</span></div>';
    this.metroCanvas = el('canvas', '', this.metro) as HTMLCanvasElement;
    this.metro.querySelector('.x')!.addEventListener('click', () => this.metro.classList.remove('open'));
  }

  mountMenu(parent: HTMLElement) { parent.appendChild(this.menu); }
  toggleMenu() { this.menu.classList.toggle('open'); }
  toggleMetro(force?: boolean) { this.metro.classList.toggle('open', force); this.drawMetro(); }
  private legendFor(k: string | null) {
    const L = this.legend;
    L.classList.toggle('open', !!k);
    if (!k) return;
    const name = MENU.find((m) => m[0] === k)?.[1] ?? FIELD_LABELS[k as FieldName] ?? k;
    if (k === 'lines') {
      const rows = [...this.lines.values()].map((l) => `<div class="row"><b style="background:${l.color}"></b>${l.name}</div>`).join('');
      L.innerHTML = `<strong>${name}</strong>${rows || '<div class="note">Aguardando as primeiras linhas</div>'}`;
    } else if (k === 'od' || k === 'cargo') {
      L.innerHTML = `<strong>${name}</strong><div class="note">${k === 'od' ? 'Arcos ligam bairros de origem e destino das viagens medidas; espessura = volume.' : 'Entregas de carga entre produtores, indústrias e comércio.'}</div>`;
    } else {
      const inv = k.startsWith('cov_') || ['happiness', 'accessibility', 'transit', 'beauty', 'tourism', 'landValue', 'waterSupply'].includes(k);
      L.innerHTML = `<strong>${name}</strong><div class="ramp"></div><div class="scale"><span>${inv ? 'pouco' : 'baixo'}</span><span>${inv ? 'muito' : 'alto'}</span></div>`;
    }
  }

  select(k: string | null) {
    this.current = k;
    this.menu.classList.remove('open');
    const field = k && !['lines', 'cargo', 'od'].includes(k) ? k : null;
    this.app.send({ type: 'overlay', field: k && ['cargo', 'od'].includes(k) ? k : field });
    U.uOverlayOn.value = field ? 1 : 0;
    this.lineGroup.visible = k === 'lines' || k === 'od' || k === 'cargo' ? k === 'lines' : false;
    this.odGroup.visible = k === 'od' || k === 'cargo';
    if (k !== 'od' && k !== 'cargo') this.odGroup.clear();
    this.legendFor(k);
    this.menu.querySelectorAll<HTMLElement>('[data-layer]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.layer || null) === k)));
    if (k) this.app.hud.toast(`Mapa: ${MENU.find((m) => m[0] === k)?.[1]}`);
  }

  setField(name: string, data: Float32Array, max: number) {
    if (name !== this.current) return;
    const d = this.tex.image.data as Uint8Array;
    const scale = name === 'congestion' ? 1.2 : name.startsWith('cov_') || name === 'happiness' ? 1.1 : Math.max(0.05, max);
    for (let i = 0; i < data.length; i++) {
      const v = Math.min(1, Math.max(0, data[i] / scale));
      d[i * 4] = v * 255;
      d[i * 4 + 3] = (v > 0.02 || name.startsWith('cov_') ? 1 : 0.15) * 255;
    }
    this.tex.needsUpdate = true;
  }

  setFlows(arr: number[] | undefined, cargo: boolean) {
    if (!arr) return;
    this.odGroup.clear();
    const max = Math.max(1, ...arr.filter((_, i) => i % 5 === 4));
    for (let i = 0; i < arr.length; i += 5) {
      const [x1, z1, x2, z2, wgt] = arr.slice(i, i + 5);
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(x1, 20, z1), new THREE.Vector3((x1 + x2) / 2, 60 + Math.hypot(x2 - x1, z2 - z1) * 0.25, (z1 + z2) / 2), new THREE.Vector3(x2, 20, z2));
      const g = new THREE.BufferGeometry().setFromPoints(curve.getPoints(24));
      const c = cargo ? new THREE.Color(wgt > 1 ? 0xff9f43 : 0xfeca57) : new THREE.Color().setHSL(0.55 - 0.55 * (wgt / max), 1, 0.55);
      this.odGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: cargo ? 0.35 : 0.3 + 0.7 * (wgt / max) })));
    }
  }

  showOD(pairs: { ox: number; oz: number; dx: number; dz: number }[]) {
    this.arcGroup.clear();
    for (const p of pairs) {
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(p.ox, 15, p.oz), new THREE.Vector3((p.ox + p.dx) / 2, 80, (p.oz + p.dz) / 2), new THREE.Vector3(p.dx, 15, p.dz));
      this.arcGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(20)), new THREE.LineBasicMaterial({ color: 0x6aa8ff, transparent: true, opacity: 0.6 })));
    }
  }
  clearOD() { this.arcGroup.clear(); }

  upsertLine(l: TransitLineView) {
    this.lines.set(l.id, l);
    this.app.agents.lineColors.set(l.id, new THREE.Color(l.color));
    this.rebuildLines();
  }
  removeLine(id: number) { this.lines.delete(id); this.rebuildLines(); }

  private rebuildLines() {
    this.lineGroup.clear();
    this.stopGroup.clear();
    for (const l of this.lines.values()) {
      if (l.pts.length >= 6) {
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < l.pts.length; i += 3) pts.push(new THREE.Vector3(l.pts[i], l.pts[i + 1] + 6, l.pts[i + 2]));
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        this.lineGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: l.color, linewidth: 3 })));
      }
      for (let i = 0; i < l.stops.length; i += 2) {
        const x = l.stops[i], z = l.stops[i + 1];
        const y = Math.max(0, this.app.terrain.heightAt(x, z));
        if (l.kind === 'bus' || l.kind === 'brt') {
          // bus shelter on the sidewalk + colored sign
          const sh = new THREE.Mesh(this.shelterGeo, this.shelterMat);
          sh.position.set(x + 7, y + 1.3, z + 7);
          const sign = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.15, 10).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: l.color }));
          sign.position.set(x + 8.8, y + 2.9, z + 7);
          this.stopGroup.add(sh, sign);
        }
        const mk = new THREE.Mesh(new THREE.SphereGeometry(3, 8, 6), new THREE.MeshBasicMaterial({ color: l.color }));
        mk.position.set(x, y + 12, z);
        this.lineGroup.add(mk);
      }
    }
    if (this.metro.classList.contains('open')) this.drawMetro();
  }

  /** schematic "metro map": octilinear segments between stops */
  drawMetro() {
    const c = this.metroCanvas;
    const W = c.clientWidth || 800, H = c.clientHeight || 500;
    c.width = W * 2; c.height = H * 2;
    const ctx = c.getContext('2d')!;
    ctx.scale(2, 2);
    ctx.fillStyle = '#f7f5ef';
    ctx.fillRect(0, 0, W, H);
    const all: number[] = [];
    for (const l of this.lines.values()) all.push(...l.stops);
    if (!all.length) { ctx.fillStyle = '#555'; ctx.font = '14px sans-serif'; ctx.fillText('Ainda não há linhas de transporte público.', 20, 30); return; }
    let mnx = Infinity, mnz = Infinity, mxx = -Infinity, mxz = -Infinity;
    for (let i = 0; i < all.length; i += 2) { mnx = Math.min(mnx, all[i]); mxx = Math.max(mxx, all[i]); mnz = Math.min(mnz, all[i + 1]); mxz = Math.max(mxz, all[i + 1]); }
    const sc = Math.min((W - 80) / Math.max(1, mxx - mnx), (H - 80) / Math.max(1, mxz - mnz));
    const grid = 18;
    const P = (x: number, z: number): [number, number] => [Math.round((40 + (x - mnx) * sc) / grid) * grid, Math.round((40 + (z - mnz) * sc) / grid) * grid];
    let li = 0;
    for (const l of this.lines.values()) {
      ctx.strokeStyle = l.color;
      ctx.lineWidth = l.kind === 'metro' ? 9 : l.kind === 'rail' ? 7 : l.kind === 'brt' ? 6 : 4;
      if (l.kind === 'rail') ctx.setLineDash([14, 6]); else ctx.setLineDash([]);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const off = (li % 3 - 1) * 4;
      for (let i = 0; i < l.stops.length; i += 2) {
        const [x, y] = P(l.stops[i], l.stops[i + 1]);
        if (i === 0) ctx.moveTo(x + off, y + off);
        else {
          const [px, py] = P(l.stops[i - 2], l.stops[i - 1]);
          const dx = x - px, dy = y - py;
          const d = Math.min(Math.abs(dx), Math.abs(dy));
          ctx.lineTo(px + Math.sign(dx) * d + off, py + Math.sign(dy) * d + off); // 45° segment, then straight
          ctx.lineTo(x + off, y + off);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
      for (let i = 0; i < l.stops.length; i += 2) {
        const [x, y] = P(l.stops[i], l.stops[i + 1]);
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#222'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x + off, y + off, l.kind === 'bus' ? 4 : 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      ctx.fillStyle = l.color;
      ctx.font = 'bold 12px sans-serif';
      const [lx, ly] = P(l.stops[0], l.stops[1]);
      ctx.fillText(l.name.split(' · ')[0], lx + 8, ly - 8);
      li++;
    }
    // legend
    ctx.font = '12px sans-serif';
    let y = H - 14 - this.lines.size * 16;
    for (const l of this.lines.values()) {
      ctx.fillStyle = l.color; ctx.fillRect(W - 300, y - 9, 22, 8);
      ctx.fillStyle = '#222'; ctx.fillText(`${l.name} · ${l.riders} passageiros/dia · ${l.vehicles} veíc.`, W - 272, y);
      y += 16;
    }
  }

  update(_dt: number) {}
}
