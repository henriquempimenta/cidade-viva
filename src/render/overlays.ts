import * as THREE from 'three';
import type { App } from '../app';
import { LANE_WIDTH } from '../shared/constants';
import type { RoadIncidentView, TransitLineView } from '../shared/protocol';
import { FIELD_LABELS, type FieldName } from '../shared/catalog';
import { edgePtsCum, sampleEdgePts } from '../shared/roadGeom';
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
  incidents: RoadIncidentView[] = [];
  private lineGroup = new THREE.Group();
  private stopGroup = new THREE.Group();
  private incidentGroup = new THREE.Group();
  private arcGroup = new THREE.Group();
  private odGroup = new THREE.Group();
  private shelterRoofGeo = new THREE.BoxGeometry(3.2, 0.14, 1.15);
  private shelterBackGeo = new THREE.BoxGeometry(3.0, 2.15, 0.08);
  private shelterSideGeo = new THREE.BoxGeometry(0.08, 2.15, 0.95);
  private shelterBenchGeo = new THREE.BoxGeometry(2.1, 0.42, 0.36);
  private shelterPostGeo = new THREE.CylinderGeometry(0.055, 0.055, 2.5, 6);
  private shelterPoleGeo = new THREE.CylinderGeometry(0.06, 0.06, 2.85, 6);
  private shelterSignGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.12, 12).rotateX(Math.PI / 2);
  private shelterPlinthGeo = new THREE.BoxGeometry(3.5, 1, 1.35).translate(0, -0.5, 0);
  private shelterFrameMat = new THREE.MeshStandardMaterial({ color: 0x3b4856, roughness: 0.55, metalness: 0.35 });
  private shelterGlassMat = new THREE.MeshStandardMaterial({ color: 0x8fb8d8, transparent: true, opacity: 0.45, roughness: 0.25 });
  private shelterBenchMat = new THREE.MeshStandardMaterial({ color: 0x7a5c3c, roughness: 0.85 });
  private shelterPlinthMat = new THREE.MeshStandardMaterial({ color: 0xaba69c, roughness: 0.92 });
  // Road incident 3D signage (cones, striped barricades, pulsing warning beacon & halo)
  private coneBaseGeo = new THREE.BoxGeometry(0.46, 0.06, 0.46);
  private coneBodyGeo = new THREE.ConeGeometry(0.19, 0.78, 8);
  private coneBandGeo = new THREE.CylinderGeometry(0.105, 0.145, 0.17, 8);
  private barLegGeo = new THREE.BoxGeometry(0.12, 1.05, 0.12);
  private barBoardGeo = new THREE.BoxGeometry(0.10, 0.38, 2.5);
  private barStripeGeo = new THREE.BoxGeometry(0.12, 0.36, 0.32);
  private barLampGeo = new THREE.CylinderGeometry(0.11, 0.13, 0.18, 8);
  private incidentGeos: THREE.BufferGeometry[] = [];
  private coneBaseMat = new THREE.MeshStandardMaterial({ color: 0x1e2228, roughness: 0.9 });
  private coneOrangeMat = new THREE.MeshStandardMaterial({ color: 0xff5a12, roughness: 0.45 });
  private coneWhiteMat = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.35 });
  private barRedMat = new THREE.MeshStandardMaterial({ color: 0xd92622, roughness: 0.4 });
  private barFrameMat = new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.6, metalness: 0.35 });
  private incAmberMat = new THREE.MeshBasicMaterial({ color: 0xffaa1a, toneMapped: false });
  private incCrashMat = new THREE.MeshBasicMaterial({ color: 0xff2a1e, toneMapped: false });
  private incHaloAmberMat = new THREE.MeshBasicMaterial({ color: 0xffa61a, transparent: true, opacity: 0.36, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  private incHaloCrashMat = new THREE.MeshBasicMaterial({ color: 0xff2e22, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  private pulseT = 0;

  constructor(private app: App) {
    this.G = app.init.fieldRes;
    this.tex = new THREE.DataTexture(new Uint8Array(this.G * this.G * 4), this.G, this.G, THREE.RGBAFormat);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    U.uOverlay.value = this.tex;
    this.group.add(this.lineGroup, this.stopGroup, this.incidentGroup, this.arcGroup, this.odGroup);
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
    const col = new THREE.Color(l.color);
    this.app.agents.lineColors.set(l.id, col);
    if (l.kind === 'metro') this.app.agents.metroLineColor = col;
    this.rebuildLines();
  }
  removeLine(id: number) { this.lines.delete(id); this.rebuildLines(); }

  /** Resync bus shelters and road-incident signage onto updated terraformed terrain mesh heights. */
  refreshGround() {
    if (this.lines.size) this.rebuildLines();
    if (this.incidents.length) this.setIncidents(this.incidents);
  }

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
        const stopIdx = i / 2;
        const x = l.stops[i], z = l.stops[i + 1];
        const y = Math.max(0, this.app.terrain.meshY(x, z));
        if (l.kind === 'bus' || l.kind === 'brt') {
          // bus shelter aligned on the back of the sidewalk, facing the carriageway (-Z local)
          const poseIdx = stopIdx * 3;
          const sx = l.stopPoses && poseIdx + 2 < l.stopPoses.length ? l.stopPoses[poseIdx] : x;
          const sz = l.stopPoses && poseIdx + 2 < l.stopPoses.length ? l.stopPoses[poseIdx + 1] : z;
          const angle = l.stopPoses && poseIdx + 2 < l.stopPoses.length ? l.stopPoses[poseIdx + 2] : 0;
          const ca = Math.cos(angle), sa = Math.sin(angle);
          let maxG = this.app.terrain.meshY(sx, sz);
          let minG = maxG;
          for (const [lx, lz] of [[-1.6, -0.6], [1.6, -0.6], [-1.6, 0.6], [1.6, 0.6], [0, -1.8]]) {
            const gh = this.app.terrain.meshY(sx + lx * ca - lz * sa, sz + lx * sa + lz * ca);
            if (gh > maxG) maxG = gh;
            if (gh < minG) minG = gh;
          }
          // Seat cleanly atop the lifted sidewalk surface (never buried in grass, plinth seals downhill slope)
          const sy = Math.max(0.25, maxG + 0.26);
          const shelter = new THREE.Group();
          shelter.position.set(sx, sy, sz);
          shelter.rotation.y = -angle;
          const plinthH = Math.max(0.35, sy - minG + 0.35);
          const plinth = new THREE.Mesh(this.shelterPlinthGeo, this.shelterPlinthMat);
          plinth.scale.set(1, plinthH, 1);
          plinth.position.set(0, 0.02, 0.06);
          // open-front canopy shelter: local +X along road travel dir, local -Z facing road, local +Z back wall
          const roof = new THREE.Mesh(this.shelterRoofGeo, this.shelterFrameMat);
          roof.position.set(0, 2.45, 0);
          const back = new THREE.Mesh(this.shelterBackGeo, this.shelterGlassMat);
          back.position.set(0, 1.22, 0.46);
          const sideL = new THREE.Mesh(this.shelterSideGeo, this.shelterGlassMat);
          sideL.position.set(-1.5, 1.22, 0.02);
          const bench = new THREE.Mesh(this.shelterBenchGeo, this.shelterBenchMat);
          bench.position.set(-0.2, 0.25, 0.22);
          const p1 = new THREE.Mesh(this.shelterPostGeo, this.shelterFrameMat);
          p1.position.set(-1.5, 1.25, 0.46);
          const p2 = new THREE.Mesh(this.shelterPostGeo, this.shelterFrameMat);
          p2.position.set(1.5, 1.25, 0.46);
          const pole = new THREE.Mesh(this.shelterPoleGeo, this.shelterFrameMat);
          pole.position.set(1.85, 1.42, -0.32);
          const sign = new THREE.Mesh(this.shelterSignGeo, new THREE.MeshBasicMaterial({ color: l.color }));
          sign.position.set(1.85, 2.75, -0.32);
          shelter.add(plinth, roof, back, sideL, bench, p1, p2, pole, sign);
          this.stopGroup.add(shelter);
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

  setIncidents(list: RoadIncidentView[]) {
    this.incidents = list;
    this.incidentGroup.clear();
    for (const geo of this.incidentGeos) geo.dispose();
    this.incidentGeos.length = 0;

    for (const inc of list) {
      const g = new THREE.Group();
      const cosA = Math.cos(inc.angle);
      const sinA = Math.sin(inc.angle);
      const edgeView = this.app.roads.edges.get(inc.edge);
      const pts = edgeView?.pts && edgeView.pts.length >= 6 ? edgeView.pts : null;
      const cum = pts ? edgePtsCum(pts) : undefined;

      // Exact road + terrain surface height at any local (lx, lz) in the incident's travel frame:
      // local +X = forward (cosA, sinA), local +Z = right / higher lane index (-sinA, cosA)
      const surfaceY = (lx: number, lz: number): number => {
        const wx = inc.x + cosA * lx - sinA * lz;
        const wz = inc.z + sinA * lx + cosA * lz;
        const roadY = pts ? sampleEdgePts(pts, inc.s + lx, inc.dir, cum)[1] : inc.y;
        const terrY = this.app.terrain.meshY(wx, wz);
        return Math.max(roadY + 0.08, terrY + 0.16);
      };

      const baseY = surfaceY(0, 0);
      g.position.set(inc.x, baseY, inc.z);
      g.rotation.y = -inc.angle;

      const addCone = (lx: number, lz: number) => {
        const ly = surfaceY(lx, lz) - baseY;
        const base = new THREE.Mesh(this.coneBaseGeo, this.coneBaseMat);
        base.position.set(lx, ly + 0.03, lz);
        const body = new THREE.Mesh(this.coneBodyGeo, this.coneOrangeMat);
        body.position.set(lx, ly + 0.42, lz);
        body.castShadow = true;
        const band = new THREE.Mesh(this.coneBandGeo, this.coneWhiteMat);
        band.position.set(lx, ly + 0.45, lz);
        g.add(base, body, band);
      };

      const addBarricade = (lx: number, lz: number, crash: boolean) => {
        const ly = Math.max(surfaceY(lx, lz - 1.05), surfaceY(lx, lz), surfaceY(lx, lz + 1.05)) - baseY;
        const leg1 = new THREE.Mesh(this.barLegGeo, this.barFrameMat);
        leg1.position.set(lx, ly + 0.52, lz - 1.05);
        const leg2 = new THREE.Mesh(this.barLegGeo, this.barFrameMat);
        leg2.position.set(lx, ly + 0.52, lz + 1.05);
        const board = new THREE.Mesh(this.barBoardGeo, this.coneWhiteMat);
        board.position.set(lx, ly + 0.86, lz);
        board.castShadow = true;
        g.add(leg1, leg2, board);
        const stripeMat = crash ? this.barRedMat : this.coneOrangeMat;
        for (const sz of [-0.92, -0.32, 0.28, 0.88]) {
          const st = new THREE.Mesh(this.barStripeGeo, stripeMat);
          st.position.set(lx, ly + 0.86, lz + sz);
          g.add(st);
        }
        const lamp = new THREE.Mesh(this.barLampGeo, crash ? this.incCrashMat : this.incAmberMat);
        lamp.position.set(lx, ly + 1.14, lz);
        g.add(lamp);
      };

      const isCrash = inc.kind !== 'breakdown';
      const lanes = Math.max(1, inc.lanes);
      const incLane = Math.max(0, Math.min(lanes - 1, inc.lane));
      // Breakdowns pull slightly to the right (+0.65 m); offset signage back to true lane center
      const lat0 = inc.kind === 'breakdown' ? 0.65 : 0;
      const laneCenterZ = (l: number) => (l - incLane) * LANE_WIDTH - lat0;

      // Striped barricades upstream of the disabled/crashed vehicle(s) covering every closed lane in THIS direction
      // Set back to -8.8 m so even long 10-12 m buses/trucks have clear visual margin behind the rear bumper
      const barricadeX = -8.8;
      if (inc.fullClosure) {
        for (let l = 0; l < lanes; l++) {
          addBarricade(barricadeX, laneCenterZ(l), isCrash);
        }
      } else {
        addBarricade(barricadeX, laneCenterZ(incLane), isCrash);
      }

      // Perimeter traffic cones tapering upstream and flanking strictly within the closed lane(s) (never in oncoming traffic or on sidewalks)
      const zMin = (inc.fullClosure ? laneCenterZ(0) : laneCenterZ(incLane)) - 1.25;
      const zMax = (inc.fullClosure ? laneCenterZ(lanes - 1) : laneCenterZ(incLane)) + 1.25;
      const coneCoords: [number, number][] = [
        [-12.6, zMin], [-12.6, zMax],
        [-10.4, zMin], [-10.4, zMax],
        [-5.0, zMin], [-5.0, zMax],
        [5.6, zMin], [5.6, zMax],
      ];
      if (inc.fullClosure && lanes >= 2) {
        for (let l = 0; l < lanes - 1; l++) {
          const zMid = (laneCenterZ(l) + laneCenterZ(l + 1)) * 0.5;
          coneCoords.push([-11.6, zMid], [-5.0, zMid], [5.6, zMid]);
        }
      }
      for (const [cx, cz] of coneCoords) addCone(cx, cz);

      // Slope-conforming pulsing warning halo (kept compact so it never spills onto sidewalks or clips below slopes)
      const segs = 28;
      const innerR = inc.kind === 'major_crash' ? 2.25 : 2.0;
      const outerR = inc.kind === 'major_crash' ? 2.78 : 2.5;
      const pos = new Float32Array((segs + 1) * 2 * 3);
      const idx: number[] = [];
      for (let k = 0; k <= segs; k++) {
        const a = (k / segs) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const ix = ca * innerR, iz = sa * innerR;
        const ox = ca * outerR, oz = sa * outerR;
        const iy = surfaceY(ix, iz) - baseY + 0.14;
        const oy = surfaceY(ox, oz) - baseY + 0.14;
        const v0 = k * 2;
        pos[v0 * 3] = ix; pos[v0 * 3 + 1] = iy; pos[v0 * 3 + 2] = iz;
        pos[(v0 + 1) * 3] = ox; pos[(v0 + 1) * 3 + 1] = oy; pos[(v0 + 1) * 3 + 2] = oz;
        if (k < segs) {
          idx.push(v0, v0 + 1, v0 + 2, v0 + 1, v0 + 3, v0 + 2);
        }
      }
      const haloGeo = new THREE.BufferGeometry();
      haloGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      haloGeo.setIndex(idx);
      haloGeo.computeVertexNormals();
      this.incidentGeos.push(haloGeo);
      const halo = new THREE.Mesh(haloGeo, isCrash ? this.incHaloCrashMat : this.incHaloAmberMat);
      g.add(halo);

      this.incidentGroup.add(g);
    }
  }

  update(dt: number) {
    if (!this.incidents.length) return;
    this.pulseT += dt;
    const amb = 0.5 + 0.5 * Math.sin(this.pulseT * 8.5);
    const red = 0.5 + 0.5 * Math.sin(this.pulseT * 12.5);
    this.incAmberMat.color.setRGB(1.2 + amb * 1.8, 0.55 + amb * 1.0, 0.05);
    this.incCrashMat.color.setRGB(0.6 + red * 2.4, 0.08 + (1 - red) * 0.25, 0.08 + (1 - red) * 2.2);
    this.incHaloAmberMat.opacity = 0.18 + amb * 0.30;
    this.incHaloCrashMat.opacity = 0.20 + red * 0.34;
  }
}
