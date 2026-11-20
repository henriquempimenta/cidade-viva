import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createAssetMaterial, createGlowMaterial, type AssetBuildResult, type AssetDetail } from '../render/meshKit';
import { getFamily, WORKBENCH_FAMILIES } from './registry';
import type { WorkbenchFamily, WorkbenchVariant } from './types';

type TimeOfDay = 'day' | 'dawn' | 'night';
type CaptureMode = 'interactive' | 'sheet' | 'lineup' | 'closeup-grid';

interface WorkbenchWindow extends Window {
  __WORKBENCH_META__?: Record<string, unknown>;
  __WORKBENCH_READY__?: boolean;
}

const params = new URLSearchParams(window.location.search);
const mode = (params.get('mode') as CaptureMode) || 'interactive';
const familyParam = params.get('family');
const variantParam = params.get('variant');
const timeParam = (params.get('time') as TimeOfDay) || 'day';
const pageParam = Math.max(0, Number(params.get('page') || 0));
const detailParam = (params.get('detail') as AssetDetail) || 'high';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const uiEl = document.getElementById('ui') as HTMLDivElement;
const metricsEl = document.getElementById('metrics') as HTMLDivElement;
const overlayEl = document.getElementById('overlay') as HTMLDivElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const bodyMat = createAssetMaterial();
const glowMat = createGlowMaterial();

interface StudioRig {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  ground: THREE.Mesh;
  grid: THREE.GridHelper;
  content: THREE.Group;
  setTime: (tod: TimeOfDay) => void;
}

function createStudio(): StudioRig {
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 160;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  const fill = new THREE.DirectionalLight(0x9fc2ff, 0.55);
  fill.position.set(-18, 12, -20);
  scene.add(fill);

  const hemi = new THREE.HemisphereLight(0xd8eaff, 0x5c584e, 0.95);
  scene.add(hemi);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 300).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x3b4048, roughness: 0.92, metalness: 0.02 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(100, 50, 0x768599, 0x515b69);
  grid.position.y = 0.004;
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.32;
  scene.add(grid);

  const content = new THREE.Group();
  scene.add(content);

  const setTime = (tod: TimeOfDay) => {
    const gmat = ground.material as THREE.MeshStandardMaterial;
    if (tod === 'night') {
      scene.background = new THREE.Color(0x111a2e);
      sun.color.setHex(0x9ab8f2);
      sun.intensity = 1.05;
      sun.position.set(14, 24, 18);
      fill.color.setHex(0xffe1b0); // warm streetlamp bounce
      fill.intensity = 0.45;
      hemi.color.setHex(0x3a5280);
      hemi.groundColor.setHex(0x1b202b);
      hemi.intensity = 0.68;
      gmat.color.setHex(0x28303d);
      glowMat.color.setScalar(2.6);
      glowMat.visible = true;
    } else if (tod === 'dawn') {
      scene.background = new THREE.Color(0xa6b9cf);
      sun.color.setHex(0xffc98b);
      sun.intensity = 2.45;
      sun.position.set(28, 12, 20);
      fill.color.setHex(0x8bb0e8);
      fill.intensity = 0.55;
      hemi.color.setHex(0xf2d1b3);
      hemi.groundColor.setHex(0x524c46);
      hemi.intensity = 0.90;
      gmat.color.setHex(0x464a52);
      glowMat.color.setScalar(1.4);
      glowMat.visible = true;
    } else {
      scene.background = new THREE.Color(0xc8daec);
      sun.color.setHex(0xfffaf0);
      sun.intensity = 2.55;
      sun.position.set(22, 32, 18);
      fill.color.setHex(0xb4d2ff);
      fill.intensity = 0.60;
      hemi.color.setHex(0xdceeff);
      hemi.groundColor.setHex(0x5e5b52);
      hemi.intensity = 0.98;
      gmat.color.setHex(0x4a5059);
      glowMat.color.setScalar(0.75);
      glowMat.visible = true;
    }
  };
  setTime('day');
  return { scene, sun, fill, hemi, ground, grid, content, setTime };
}

/** Place one or more instances of a built asset using the exact InstancedMesh + aTint path used in-game. */
function makeAssetInstances(
  built: AssetBuildResult,
  placements: { x: number; y: number; z: number; yaw?: number; color: number }[],
  showGlow: boolean,
): THREE.Group {
  const grp = new THREE.Group();
  const n = placements.length;
  const im = new THREE.InstancedMesh(built.body, bodyMat, n);
  im.castShadow = true;
  im.receiveShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const pl = placements[i];
    q.setFromAxisAngle(up, pl.yaw ?? 0);
    m.compose(p.set(pl.x, pl.y, pl.z), q, s);
    im.setMatrixAt(i, m);
    im.setColorAt(i, col.setHex(pl.color));
  }
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  grp.add(im);

  if (built.glow && showGlow) {
    const gm = new THREE.InstancedMesh(built.glow, glowMat, n);
    for (let i = 0; i < n; i++) {
      const pl = placements[i];
      q.setFromAxisAngle(up, pl.yaw ?? 0);
      m.compose(p.set(pl.x, pl.y, pl.z), q, s);
      gm.setMatrixAt(i, m);
    }
    gm.instanceMatrix.needsUpdate = true;
    grp.add(gm);
  }
  return grp;
}

function clearGroup(g: THREE.Group) {
  while (g.children.length > 0) {
    const ch = g.children[0];
    g.remove(ch);
  }
}

function addLabel(x: number, y: number, text: string) {
  const el = document.createElement('div');
  el.className = 'sheet-cell-label';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.textContent = text;
  overlayEl.appendChild(el);
}

function addBanner(left: string, right: string) {
  const el = document.createElement('div');
  el.className = 'sheet-banner';
  const l = document.createElement('span'); l.textContent = left;
  const r = document.createElement('span'); r.textContent = right;
  el.append(l, r);
  overlayEl.appendChild(el);
}

function frameDistance(size: [number, number, number], fovDeg: number, aspect: number, fill = 0.62): number {
  const radius = Math.max(0.8, Math.hypot(size[0], size[1], size[2]) * 0.5);
  const vFov = THREE.MathUtils.degToRad(fovDeg);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const minFov = Math.min(vFov, hFov);
  return (radius / Math.sin(minFov / 2)) / fill * 0.65;
}

/** Render a standardized 2x3 multi-angle & multi-situation contact sheet for one variant. */
function renderHeroSheet(studio: StudioRig, family: WorkbenchFamily, variant: WorkbenchVariant) {
  uiEl.style.display = 'none';
  metricsEl.style.display = 'none';
  overlayEl.innerHTML = '';

  const built = variant.build(detailParam);
  const { size, triangles, glowTriangles, minY } = built.meta;
  const targetY = Math.max(0.45, size[1] * 0.45);
  const W = window.innerWidth, H = window.innerHeight;
  const bannerH = 34;
  const gridH = H - bannerH;
  const cols = 3, rows = 2;
  const cw = Math.floor(W / cols), ch = Math.floor(gridH / rows);
  const aspect = cw / ch;

  addBanner(
    `${family.title} — ${variant.label} [${variant.id}]`,
    `tris: ${triangles} (glow: ${glowTriangles}) | L×H×W: ${size[0]}×${size[1]}×${size[2]}m | minY: ${minY}m`,
  );

  // Dividers
  const dh = document.createElement('div');
  dh.className = 'sheet-divider-h';
  dh.style.top = `${bannerH + ch}px`;
  overlayEl.appendChild(dh);
  for (let c = 1; c < cols; c++) {
    const dv = document.createElement('div');
    dv.className = 'sheet-divider-v';
    dv.style.left = `${c * cw}px`;
    overlayEl.appendChild(dv);
  }

  renderer.setScissorTest(true);
  const cam = new THREE.PerspectiveCamera(36, aspect, 0.1, 500);
  const baseDist = frameDistance(size, 36, aspect, 0.68);

  const cells: {
    col: number; row: number; label: string; tod: TimeOfDay;
    setup: () => void;
    camPos: [number, number, number]; lookAt: [number, number, number]; fov?: number;
  }[] = [
    {
      col: 0, row: 0, label: '1. Close-Up 3/4 Frente (Dia)', tod: 'day',
      setup: () => studio.content.add(makeAssetInstances(built, [{ x: 0, y: 0, z: 0, color: variant.defaultColor }], true)),
      camPos: [baseDist * 0.82, targetY + baseDist * 0.36, baseDist * 0.62],
      lookAt: [0, targetY, 0],
    },
    {
      col: 1, row: 0, label: '2. Close-Up 3/4 Traseira (Dia)', tod: 'day',
      setup: () => studio.content.add(makeAssetInstances(built, [{ x: 0, y: 0, z: 0, color: variant.defaultColor }], true)),
      camPos: [-baseDist * 0.84, targetY + baseDist * 0.38, -baseDist * 0.60],
      lookAt: [0, targetY, 0],
    },
    {
      col: 2, row: 0, label: '3. Perfil Lateral (Escala & Solo Y=0)', tod: 'day',
      setup: () => studio.content.add(makeAssetInstances(built, [{ x: 0, y: 0, z: 0, color: variant.defaultColor }], true)),
      camPos: [0, targetY + 0.15, baseDist * 1.48],
      lookAt: [0, targetY, 0],
      fov: 24,
    },
    {
      col: 0, row: 1, label: '4. Close-Up 3/4 Frente (Noite + Emissivos)', tod: 'night',
      setup: () => studio.content.add(makeAssetInstances(built, [{ x: 0, y: 0, z: 0, color: variant.defaultColor }], true)),
      camPos: [baseDist * 0.84, targetY + baseDist * 0.34, baseDist * 0.62],
      lookAt: [0, targetY, 0],
    },
    {
      col: 1, row: 1, label: '5. Distância de Cidade (~35m, 34°)', tod: 'day',
      setup: () => {
        const sp = Math.max(size[2] * 2.2, 3.6);
        const sw = variant.swatches;
        studio.content.add(makeAssetInstances(built, [
          { x: 0, y: 0, z: 0, color: variant.defaultColor },
          { x: size[0] * 1.4, y: 0, z: -sp, color: sw[1 % sw.length] },
          { x: -size[0] * 1.3, y: 0, z: sp, color: sw[2 % sw.length] },
        ], true));
      },
      camPos: [26, 22, 24],
      lookAt: [0, targetY, 0],
      fov: 40,
    },
    {
      col: 2, row: 1, label: '6. Variação de Cores (aTint × 4)', tod: 'dawn',
      setup: () => {
        const sw = variant.swatches;
        const gap = Math.max(size[2] + 1.1, 2.8);
        const pls = sw.slice(0, 4).map((color, idx) => ({
          x: (idx - 1.5) * 0.7,
          y: 0,
          z: (idx - 1.5) * gap,
          color,
        }));
        studio.content.add(makeAssetInstances(built, pls, true));
      },
      camPos: [baseDist * 1.45, targetY + baseDist * 0.78, baseDist * 1.35],
      lookAt: [0, targetY, 0],
    },
  ];

  for (const cell of cells) {
    clearGroup(studio.content);
    studio.setTime(cell.tod);
    cell.setup();
    cam.fov = cell.fov ?? 36;
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
    cam.position.set(...cell.camPos);
    cam.lookAt(...cell.lookAt);

    const vx = cell.col * cw;
    // WebGL viewport Y=0 is at bottom
    const vy = (rows - 1 - cell.row) * ch;
    renderer.setViewport(vx, vy, cw, ch);
    renderer.setScissor(vx, vy, cw, ch);
    renderer.render(studio.scene, cam);

    addLabel(vx + 10, bannerH + cell.row * ch + 10, cell.label);
  }
  renderer.setScissorTest(false);

  const win = window as WorkbenchWindow;
  win.__WORKBENCH_META__ = { mode: 'sheet', family: family.id, meta: built.meta };
  win.__WORKBENCH_READY__ = true;
}

/** Render a full-family lineup on a shared asphalt strip (scale coherence & identity check). */
function renderLineup(studio: StudioRig, family: WorkbenchFamily, variants: WorkbenchVariant[], tod: TimeOfDay) {
  uiEl.style.display = 'none';
  metricsEl.style.display = 'none';
  overlayEl.innerHTML = '';

  const W = window.innerWidth, H = window.innerHeight;
  const bannerH = 34;
  const builtList = variants.map((v) => ({ v, built: v.build(detailParam) }));

  // Lay out in 2 neat rows along Z if > 7 variants, else 1 row
  const perRow = builtList.length > 7 ? Math.ceil(builtList.length / 2) : builtList.length;
  const rowDepth = Math.max(...builtList.map((b) => b.built.meta.size[0])) + 3.2;

  clearGroup(studio.content);
  studio.setTime(tod);

  let minZ = Infinity, maxZ = -Infinity, maxH = 2;
  const rowOffsets = new Array<number>(Math.ceil(builtList.length / perRow)).fill(0);
  const placements: { built: AssetBuildResult; v: WorkbenchVariant; x: number; z: number }[] = [];

  for (let i = 0; i < builtList.length; i++) {
    const r = Math.floor(i / perRow);
    const { v, built } = builtList[i];
    const w = Math.max(built.meta.size[2], 1.6);
    const z = rowOffsets[r] + w * 0.5;
    rowOffsets[r] += w + 1.5;
    const x = (r - (rowOffsets.length - 1) * 0.5) * -rowDepth;
    placements.push({ built, v, x, z });
    maxH = Math.max(maxH, built.meta.size[1]);
  }
  // Center each row along Z
  for (const p of placements) {
    const r = Math.floor(placements.indexOf(p) / perRow);
    p.z -= rowOffsets[r] * 0.5;
    minZ = Math.min(minZ, p.z - p.built.meta.size[2] * 0.5);
    maxZ = Math.max(maxZ, p.z + p.built.meta.size[2] * 0.5);
    studio.content.add(makeAssetInstances(p.built, [{ x: p.x, y: 0, z: p.z, color: p.v.defaultColor }], true));
  }

  const spanZ = Math.max(8, maxZ - minZ + 3);
  const spanX = Math.max(6, rowOffsets.length * rowDepth);
  const cam = new THREE.PerspectiveCamera(34, W / (H - bannerH), 0.2, 600);
  const dist = Math.max(spanZ * 0.92, spanX * 1.15);
  cam.position.set(dist * 0.85, maxH * 1.6 + dist * 0.36, dist * 0.62);
  cam.lookAt(0, maxH * 0.32, 0);

  renderer.setViewport(0, 0, W, H - bannerH);
  renderer.render(studio.scene, cam);

  const totalTris = builtList.reduce((acc, b) => acc + b.built.meta.triangles, 0);
  const maxTris = Math.max(...builtList.map((b) => b.built.meta.triangles));
  addBanner(
    `${family.title} — Alinhamento Completo (${variants.length} variantes, ${tod.toUpperCase()})`,
    `max tris: ${maxTris} (orçamento: ${family.triangleBudget}) | soma: ${totalTris}`,
  );
  addLabel(12, bannerH + 10, `Escala relativa 1:1 | Grade = 1 m | Frente = +X`);

  const win = window as WorkbenchWindow;
  win.__WORKBENCH_META__ = {
    mode: 'lineup',
    family: family.id,
    time: tod,
    variants: builtList.map((b) => b.built.meta),
  };
  win.__WORKBENCH_READY__ = true;
}

/** Render a 3x2 grid of close-up 3/4 shots covering up to 6 variants per page. */
function renderCloseupGrid(studio: StudioRig, family: WorkbenchFamily, variants: WorkbenchVariant[], page: number, tod: TimeOfDay) {
  uiEl.style.display = 'none';
  metricsEl.style.display = 'none';
  overlayEl.innerHTML = '';

  const slice = variants.slice(page * 6, page * 6 + 6);
  const W = window.innerWidth, H = window.innerHeight;
  const bannerH = 34;
  const gridH = H - bannerH;
  const cols = 3, rows = 2;
  const cw = Math.floor(W / cols), ch = Math.floor(gridH / rows);
  const aspect = cw / ch;

  addBanner(
    `${family.title} — Close-Up Grid (pág. ${page + 1}/${Math.max(1, Math.ceil(variants.length / 6))}, ${tod.toUpperCase()})`,
    `orçamento alvo: ≤ ${family.triangleBudget} tris/variante`,
  );
  const dh = document.createElement('div');
  dh.className = 'sheet-divider-h';
  dh.style.top = `${bannerH + ch}px`;
  overlayEl.appendChild(dh);
  for (let c = 1; c < cols; c++) {
    const dv = document.createElement('div');
    dv.className = 'sheet-divider-v';
    dv.style.left = `${c * cw}px`;
    overlayEl.appendChild(dv);
  }

  renderer.setScissorTest(true);
  const cam = new THREE.PerspectiveCamera(36, aspect, 0.1, 400);
  const metas = [];
  for (let idx = 0; idx < slice.length; idx++) {
    const v = slice[idx];
    const built = v.build(detailParam);
    metas.push(built.meta);
    const col = idx % cols, row = Math.floor(idx / cols);
    clearGroup(studio.content);
    studio.setTime(tod);
    studio.content.add(makeAssetInstances(built, [{ x: 0, y: 0, z: 0, color: v.defaultColor }], true));
    const d = frameDistance(built.meta.size, 36, aspect, 0.72);
    const ty = Math.max(0.45, built.meta.size[1] * 0.45);
    cam.position.set(d * 0.82, ty + d * 0.36, d * 0.62);
    cam.lookAt(0, ty, 0);
    const vx = col * cw, vy = (rows - 1 - row) * ch;
    renderer.setViewport(vx, vy, cw, ch);
    renderer.setScissor(vx, vy, cw, ch);
    renderer.render(studio.scene, cam);
    addLabel(vx + 10, bannerH + row * ch + 10, `${v.label} — ${built.meta.triangles} tris (${built.meta.size[0]}×${built.meta.size[1]}×${built.meta.size[2]}m)`);
  }
  renderer.setScissorTest(false);

  const win = window as WorkbenchWindow;
  win.__WORKBENCH_META__ = { mode: 'closeup-grid', family: family.id, page, variants: metas };
  win.__WORKBENCH_READY__ = true;
}

/** Interactive studio mode for human exploration. */
function runInteractive(studio: StudioRig, initialFamily: WorkbenchFamily) {
  let family = initialFamily;
  let variants = family.variants();
  let curVariant = variants.find((v) => v.id === variantParam) ?? variants[0];
  let curColor = curVariant.defaultColor;
  let curTime: TimeOfDay = timeParam;
  let wireframe = false;

  const cam = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 600);
  cam.position.set(8, 4.5, 7);
  const controls = new OrbitControls(cam, canvas);
  controls.enableDamping = true;
  controls.target.set(0, 1, 0);

  const rebuild = () => {
    clearGroup(studio.content);
    studio.setTime(curTime);
    bodyMat.wireframe = wireframe;
    const built = curVariant.build(detailParam);
    studio.content.add(makeAssetInstances(built, [{ x: 0, y: 0, z: 0, color: curColor }], true));
    const m = built.meta;
    metricsEl.textContent = `${m.label} | tris: ${m.triangles} (glow: ${m.glowTriangles}) | L×H×W: ${m.size[0]}×${m.size[1]}×${m.size[2]} m | minY: ${m.minY} m`;
  };

  const renderUI = () => {
    uiEl.innerHTML = '';
    const famSel = document.createElement('select');
    for (const f of WORKBENCH_FAMILIES) {
      const o = document.createElement('option');
      o.value = f.id; o.textContent = f.title; o.selected = f.id === family.id;
      famSel.appendChild(o);
    }
    famSel.onchange = () => {
      family = getFamily(famSel.value);
      variants = family.variants();
      curVariant = variants[0];
      curColor = curVariant.defaultColor;
      renderUI(); rebuild();
    };
    uiEl.appendChild(famSel);

    const varSel = document.createElement('select');
    for (const v of variants) {
      const o = document.createElement('option');
      o.value = v.id; o.textContent = `${v.label} (${v.category})`; o.selected = v.id === curVariant.id;
      varSel.appendChild(o);
    }
    varSel.onchange = () => {
      curVariant = variants.find((v) => v.id === varSel.value) ?? variants[0];
      curColor = curVariant.defaultColor;
      renderUI(); rebuild();
    };
    uiEl.appendChild(varSel);

    for (const sw of curVariant.swatches) {
      const b = document.createElement('button');
      b.style.background = `#${sw.toString(16).padStart(6, '0')}`;
      b.style.width = '22px'; b.style.height = '22px'; b.title = `#${sw.toString(16).padStart(6, '0')}`;
      b.onclick = () => { curColor = sw; rebuild(); };
      uiEl.appendChild(b);
    }

    for (const tod of ['day', 'dawn', 'night'] as TimeOfDay[]) {
      const b = document.createElement('button');
      b.textContent = tod === 'day' ? 'Dia' : tod === 'dawn' ? 'Crepúsculo' : 'Noite';
      if (tod === curTime) b.classList.add('active');
      b.onclick = () => { curTime = tod; renderUI(); rebuild(); };
      uiEl.appendChild(b);
    }

    const wfBtn = document.createElement('button');
    wfBtn.textContent = 'Wireframe';
    if (wireframe) wfBtn.classList.add('active');
    wfBtn.onclick = () => { wireframe = !wireframe; renderUI(); rebuild(); };
    uiEl.appendChild(wfBtn);
  };

  renderUI();
  rebuild();

  window.addEventListener('resize', () => {
    cam.aspect = window.innerWidth / window.innerHeight;
    cam.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  });

  const tick = () => {
    requestAnimationFrame(tick);
    controls.update();
    renderer.render(studio.scene, cam);
  };
  tick();
}

const studio = createStudio();
const family = getFamily(familyParam);
const variants = family.variants();

if (mode === 'sheet') {
  const v = variants.find((x) => x.id === variantParam) ?? variants[0];
  renderHeroSheet(studio, family, v);
} else if (mode === 'lineup') {
  renderLineup(studio, family, variants, timeParam);
} else if (mode === 'closeup-grid') {
  renderCloseupGrid(studio, family, variants, pageParam, timeParam);
} else {
  runInteractive(studio, family);
}
