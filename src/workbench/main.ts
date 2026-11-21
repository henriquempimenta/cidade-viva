import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createAssetMaterial, createGlowMaterial, type AssetBuildResult, type AssetDetail } from '../render/meshKit';
import { attachPedInstanceBuffers, createPedDepthMaterial, createPedMaterial } from '../render/pedMaterial';
import { getFamily, WORKBENCH_FAMILIES } from './registry';
import type { PedShowcaseConfig, WorkbenchFamily, WorkbenchVariant } from './types';

type TimeOfDay = 'day' | 'dawn' | 'night';
type CaptureMode = 'interactive' | 'sheet' | 'lineup' | 'closeup-grid' | 'lod-compare';

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

const wbPedTime = { value: 0 };
const bodyMat = createAssetMaterial();
const pedMat = createPedMaterial({ timeUniform: wbPedTime });
const pedDepthMat = createPedDepthMaterial(wbPedTime);
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

interface Placement {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  color: number;
  anim?: [number, number, number, number];
}

/** Place one or more instances of a built asset using the exact InstancedMesh path used in-game. */
function makeAssetInstances(
  built: AssetBuildResult,
  placements: Placement[],
  showGlow: boolean,
  pedShowcase?: PedShowcaseConfig,
  detail: AssetDetail = detailParam,
): THREE.Group {
  const grp = new THREE.Group();
  const n = placements.length;
  const isPed = Boolean(pedShowcase) && Boolean(built.body.getAttribute('aPedMeta'));
  const mat = isPed ? pedMat : bodyMat;
  const im = new THREE.InstancedMesh(built.body, mat, n);
  im.castShadow = true;
  im.receiveShadow = true;
  if (isPed) im.customDepthMaterial = pedDepthMat;

  const pedBuf = isPed ? attachPedInstanceBuffers(im, n) : null;
  const skinC = new THREE.Color(pedShowcase?.skinColor ?? 0xe2b18f);
  const hairC = new THREE.Color(pedShowcase?.hairColor ?? 0x31231a);
  const botC = new THREE.Color(pedShowcase?.bottomColor ?? 0x2c3d59);
  const defAnim = pedShowcase?.anim ?? [0, 0, 0, 0];

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const pl = placements[i];
    q.setFromAxisAngle(up, pl.yaw ?? 0);
    m.compose(p.set(pl.x, pl.y, pl.z), q, s);
    im.setMatrixAt(i, m);
    im.setColorAt(i, col.setHex(pl.color));
    if (pedBuf) {
      const i3 = i * 3;
      pedBuf.skin[i3] = skinC.r; pedBuf.skin[i3 + 1] = skinC.g; pedBuf.skin[i3 + 2] = skinC.b;
      pedBuf.hair[i3] = hairC.r; pedBuf.hair[i3 + 1] = hairC.g; pedBuf.hair[i3 + 2] = hairC.b;
      pedBuf.bottom[i3] = botC.r; pedBuf.bottom[i3 + 1] = botC.g; pedBuf.bottom[i3 + 2] = botC.b;
      const a = pl.anim ?? defAnim;
      const i4 = i * 4;
      pedBuf.anim[i4] = a[0]; pedBuf.anim[i4 + 1] = a[1]; pedBuf.anim[i4 + 2] = a[2]; pedBuf.anim[i4 + 3] = a[3];
    }
  }
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  pedBuf?.markUpdated();
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

  // Optional companion asset (e.g. bicycle directly under mounted cyclist, synced crank phase)
  if (pedShowcase?.companion) {
    const compBuilt = pedShowcase.companion.build(detail);
    const compPlacements = placements.map((pl) => {
      const baseAnim = pl.anim ?? defAnim;
      return {
        ...pl,
        color: pedShowcase.companion!.color,
        anim: [baseAnim[0], baseAnim[1], 0, 0] as [number, number, number, number],
      };
    });
    grp.add(
      makeAssetInstances(
        compBuilt,
        compPlacements,
        showGlow,
        { skinColor: 0xe2b18f, hairColor: 0x31231a, bottomColor: 0x2c3d59, anim: [defAnim[0], defAnim[1], 0, 0] },
        detail,
      ),
    );
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

function effectiveSize(built: AssetBuildResult, variant: WorkbenchVariant): [number, number, number] {
  const s = built.meta.size;
  if (variant.pedShowcase?.companion) {
    // Cyclist mounted on bike spans ~1.74m along X and ~1.68m along Y
    return [Math.max(s[0], 1.75), Math.max(s[1], 1.68), Math.max(s[2], 0.62)];
  }
  return s;
}

function frameDistance(size: [number, number, number], fovDeg: number, aspect: number, fill = 0.62): number {
  const radius = Math.max(0.65, Math.hypot(size[0], size[1], size[2]) * 0.5);
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
  const { triangles, glowTriangles, minY } = built.meta;
  const size = effectiveSize(built, variant);
  const isSmallAsset = size[0] < 2.2 && size[1] < 2.2;
  const targetY = Math.max(0.38, size[1] * 0.48);
  const W = window.innerWidth, H = window.innerHeight;
  const bannerH = 34;
  const gridH = H - bannerH;
  const cols = 3, rows = 2;
  const cw = Math.floor(W / cols), ch = Math.floor(gridH / rows);
  const aspect = cw / ch;

  addBanner(
    `${family.title} — ${variant.label} [${variant.id}]`,
    `tris: ${triangles} (glow: ${glowTriangles}) | L×H×W: ${built.meta.size[0]}×${built.meta.size[1]}×${built.meta.size[2]}m | minY: ${minY}m`,
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
  const baseDist = frameDistance(size, 36, aspect, isSmallAsset ? 0.56 : 0.68);
  const swatchGap = isSmallAsset ? Math.max(size[2] * 1.9, 1.15) : Math.max(size[2] + 1.1, 2.8);

  const cells: {
    col: number; row: number; label: string; tod: TimeOfDay;
    setup: () => void;
    camPos: [number, number, number]; lookAt: [number, number, number]; fov?: number;
  }[] = [
    {
      col: 0, row: 0, label: '1. Close-Up 3/4 Frente (Dia)', tod: 'day',
      setup: () => studio.content.add(makeAssetInstances(built, [{ x: 0, y: 0, z: 0, color: variant.defaultColor }], true, variant.pedShowcase)),
      camPos: [baseDist * 0.84, targetY + baseDist * 0.28, baseDist * 0.64],
      lookAt: [0, targetY, 0],
    },
    {
      col: 1, row: 0, label: '2. Close-Up 3/4 Traseira (Dia)', tod: 'day',
      setup: () => studio.content.add(makeAssetInstances(built, [{ x: 0, y: 0, z: 0, color: variant.defaultColor }], true, variant.pedShowcase)),
      camPos: [-baseDist * 0.84, targetY + baseDist * 0.30, -baseDist * 0.62],
      lookAt: [0, targetY, 0],
    },
    {
      col: 2, row: 0, label: '3. Perfil Lateral (Escala & Solo Y=0)', tod: 'day',
      setup: () => studio.content.add(makeAssetInstances(built, [{ x: 0, y: 0, z: 0, color: variant.defaultColor }], true, variant.pedShowcase)),
      camPos: [0, targetY + 0.08, baseDist * 1.52],
      lookAt: [0, targetY, 0],
      fov: 24,
    },
    {
      col: 0, row: 1, label: '4. Close-Up 3/4 Frente (Noite + Emissivos)', tod: 'night',
      setup: () => studio.content.add(makeAssetInstances(built, [{ x: 0, y: 0, z: 0, color: variant.defaultColor }], true, variant.pedShowcase)),
      camPos: [baseDist * 0.84, targetY + baseDist * 0.28, baseDist * 0.64],
      lookAt: [0, targetY, 0],
    },
    {
      col: 1, row: 1, label: isSmallAsset ? '5. Distância de Cidade (~24m, 34°)' : '5. Distância de Cidade (~35m, 34°)', tod: 'day',
      setup: () => {
        const sp = isSmallAsset ? Math.max(size[2] * 2.4, 1.8) : Math.max(size[2] * 2.2, 3.6);
        const sw = variant.swatches;
        studio.content.add(makeAssetInstances(built, [
          { x: 0, y: 0, z: 0, color: variant.defaultColor },
          { x: Math.max(size[0] * 1.4, 1.4), y: 0, z: -sp, color: sw[1 % sw.length] },
          { x: -Math.max(size[0] * 1.3, 1.3), y: 0, z: sp, color: sw[2 % sw.length] },
        ], true, variant.pedShowcase));
      },
      camPos: isSmallAsset ? [14, 13, 14] : [26, 22, 24],
      lookAt: [0, targetY, 0],
      fov: 40,
    },
    {
      col: 2, row: 1, label: '6. Variação de Cores (aZone/aTint × 4)', tod: 'dawn',
      setup: () => {
        const sw = variant.swatches;
        const pls = sw.slice(0, 4).map((color, idx) => ({
          x: (idx - 1.5) * (isSmallAsset ? 0.28 : 0.7),
          y: 0,
          z: (idx - 1.5) * swatchGap,
          color,
        }));
        studio.content.add(makeAssetInstances(built, pls, true, variant.pedShowcase));
      },
      camPos: [baseDist * (isSmallAsset ? 1.55 : 1.45), targetY + baseDist * 0.62, baseDist * (isSmallAsset ? 1.40 : 1.35)],
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

  const maxLen = Math.max(...builtList.map((b) => effectiveSize(b.built, b.v)[0]));
  const isCompact = maxLen < 2.5;
  const perRow = builtList.length > 7 ? Math.ceil(builtList.length / 2) : builtList.length;
  const rowDepth = maxLen + (isCompact ? 1.85 : 3.2);

  clearGroup(studio.content);
  studio.setTime(tod);

  let minZ = Infinity, maxZ = -Infinity, maxH = 1.6;
  const rowOffsets = new Array<number>(Math.ceil(builtList.length / perRow)).fill(0);
  const placements: { built: AssetBuildResult; v: WorkbenchVariant; x: number; z: number }[] = [];

  for (let i = 0; i < builtList.length; i++) {
    const r = Math.floor(i / perRow);
    const { v, built } = builtList[i];
    const sz = effectiveSize(built, v);
    const w = Math.max(sz[2], isCompact ? 0.92 : 1.6);
    const z = rowOffsets[r] + w * 0.5;
    rowOffsets[r] += w + (isCompact ? 0.65 : 1.5);
    const x = (r - (rowOffsets.length - 1) * 0.5) * -rowDepth;
    placements.push({ built, v, x, z });
    maxH = Math.max(maxH, sz[1]);
  }
  // Center each row along Z
  for (const p of placements) {
    const r = Math.floor(placements.indexOf(p) / perRow);
    p.z -= rowOffsets[r] * 0.5;
    const sz = effectiveSize(p.built, p.v);
    minZ = Math.min(minZ, p.z - sz[2] * 0.5);
    maxZ = Math.max(maxZ, p.z + sz[2] * 0.5);
    studio.content.add(makeAssetInstances(p.built, [{ x: p.x, y: 0, z: p.z, color: p.v.defaultColor }], true, p.v.pedShowcase));
  }

  const spanZ = Math.max(isCompact ? 5.5 : 8, maxZ - minZ + (isCompact ? 1.8 : 3));
  const spanX = Math.max(isCompact ? 3.5 : 6, rowOffsets.length * rowDepth);
  const cam = new THREE.PerspectiveCamera(34, W / (H - bannerH), 0.2, 600);
  const dist = Math.max(spanZ * (isCompact ? 0.85 : 0.92), spanX * 1.15);
  cam.position.set(dist * 0.85, maxH * 1.25 + dist * 0.30, dist * 0.58);
  cam.lookAt(0, maxH * 0.42, 0);

  renderer.setViewport(0, 0, W, H - bannerH);
  renderer.render(studio.scene, cam);

  const totalTris = builtList.reduce((acc, b) => acc + b.built.meta.triangles, 0);
  const maxTris = Math.max(...builtList.map((b) => b.built.meta.triangles));
  addBanner(
    `${family.title} — Alinhamento Completo (${variants.length} variantes, ${tod.toUpperCase()})`,
    `max tris: ${maxTris} (orçamento: ${family.triangleBudget}) | soma: ${totalTris}`,
  );
  addLabel(12, bannerH + 10, `Escala relativa 1:1 | Grade = 1 m | Frente = +X`);

  // Expose family automation hints in DOM data attributes for capture-workbench.mjs
  if (family.heroVariants?.length) overlayEl.dataset.heroVariants = family.heroVariants.join(',');
  if (family.lodCompareVariants?.length) overlayEl.dataset.lodVariants = family.lodCompareVariants.join(',');

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
    studio.content.add(makeAssetInstances(built, [{ x: 0, y: 0, z: 0, color: v.defaultColor }], true, v.pedShowcase));
    const sz = effectiveSize(built, v);
    const d = frameDistance(sz, 36, aspect, sz[0] < 2.2 ? 0.58 : 0.72);
    const ty = Math.max(0.38, sz[1] * 0.48);
    cam.position.set(d * 0.84, ty + d * 0.28, d * 0.64);
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

/** Render a 3x2 LOD comparison sheet: each cell places high | med | low side-by-side. */
function renderLodCompare(studio: StudioRig, family: WorkbenchFamily, variants: WorkbenchVariant[], tod: TimeOfDay) {
  uiEl.style.display = 'none';
  metricsEl.style.display = 'none';
  overlayEl.innerHTML = '';

  const pickIds = family.lodCompareVariants ?? variants.slice(0, 6).map((v) => v.id);
  const slice = pickIds
    .map((id) => variants.find((v) => v.id === id))
    .filter((v): v is WorkbenchVariant => Boolean(v))
    .slice(0, 6);

  const W = window.innerWidth, H = window.innerHeight;
  const bannerH = 34;
  const gridH = H - bannerH;
  const cols = 3, rows = 2;
  const cw = Math.floor(W / cols), ch = Math.floor(gridH / rows);
  const aspect = cw / ch;

  addBanner(
    `${family.title} — Comparativo de LOD em Tempo Real (HIGH | MED | LOW)`,
    `Distâncias na cidade: HIGH < 42m | MED 42–115m | LOW > 115m`,
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
  const cam = new THREE.PerspectiveCamera(34, aspect, 0.1, 400);
  const lodLevels: AssetDetail[] = ['high', 'med', 'low'];
  const summary = [];

  for (let idx = 0; idx < slice.length; idx++) {
    const v = slice[idx];
    const col = idx % cols, row = Math.floor(idx / cols);
    clearGroup(studio.content);
    studio.setTime(tod);

    const builds = lodLevels.map((d) => ({ d, built: v.build(d) }));
    const refSize = effectiveSize(builds[0].built, v);
    const gap = Math.max(refSize[2] * 1.85, 1.12);

    // Place HIGH (left in +X camera view = +Z), MED (center = 0), LOW (right = -Z) to match HIGH | MED | LOW banner
    builds.forEach((entry, k) => {
      const z = (1 - k) * gap;
      studio.content.add(
        makeAssetInstances(entry.built, [{ x: 0, y: 0, z, color: v.defaultColor }], true, v.pedShowcase, entry.d),
      );
    });

    const spanSize: [number, number, number] = [refSize[0], refSize[1], gap * 2.5 + refSize[2]];
    const dist = frameDistance(spanSize, 34, aspect, 0.72);
    const ty = Math.max(0.38, refSize[1] * 0.48);
    cam.position.set(dist * 0.94, ty + dist * 0.24, dist * 0.32);
    cam.lookAt(0, ty, 0);

    const vx = col * cw, vy = (rows - 1 - row) * ch;
    renderer.setViewport(vx, vy, cw, ch);
    renderer.setScissor(vx, vy, cw, ch);
    renderer.render(studio.scene, cam);

    const [tH, tM, tL] = builds.map((b) => b.built.meta.triangles);
    summary.push({ id: v.id, high: tH, med: tM, low: tL });
    addLabel(vx + 10, bannerH + row * ch + 10, `${v.label} — HIGH: ${tH} | MED: ${tM} | LOW: ${tL} tris`);
  }
  renderer.setScissorTest(false);

  const win = window as WorkbenchWindow;
  win.__WORKBENCH_META__ = { mode: 'lod-compare', family: family.id, lods: summary };
  win.__WORKBENCH_READY__ = true;
}

/** Interactive studio mode for human exploration. */
function runInteractive(studio: StudioRig, initialFamily: WorkbenchFamily) {
  let family = initialFamily;
  let variants = family.variants();
  let curVariant = variants.find((v) => v.id === variantParam) ?? variants[0];
  let curColor = curVariant.defaultColor;
  let curTime: TimeOfDay = timeParam;
  let curDetail: AssetDetail = detailParam;
  let wireframe = false;
  let liveAnim = false;

  const cam = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 600);
  cam.position.set(4.5, 2.4, 4.2);
  const controls = new OrbitControls(cam, canvas);
  controls.enableDamping = true;
  controls.target.set(0, 0.95, 0);

  const rebuild = () => {
    clearGroup(studio.content);
    studio.setTime(curTime);
    bodyMat.wireframe = wireframe;
    pedMat.wireframe = wireframe;
    const built = curVariant.build(curDetail);
    studio.content.add(makeAssetInstances(built, [{ x: 0, y: 0, z: 0, color: curColor }], true, curVariant.pedShowcase, curDetail));
    const m = built.meta;
    metricsEl.textContent = `${m.label} [${curDetail}] | tris: ${m.triangles} (glow: ${m.glowTriangles}) | L×H×W: ${m.size[0]}×${m.size[1]}×${m.size[2]} m | minY: ${m.minY} m`;
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

    for (const d of ['high', 'med', 'low'] as AssetDetail[]) {
      const b = document.createElement('button');
      b.textContent = d.toUpperCase();
      if (d === curDetail) b.classList.add('active');
      b.onclick = () => { curDetail = d; renderUI(); rebuild(); };
      uiEl.appendChild(b);
    }

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

    const animBtn = document.createElement('button');
    animBtn.textContent = liveAnim ? 'Anim: ON' : 'Anim: Pose';
    if (liveAnim) animBtn.classList.add('active');
    animBtn.onclick = () => { liveAnim = !liveAnim; if (!liveAnim) wbPedTime.value = 0; renderUI(); };
    uiEl.appendChild(animBtn);

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

  const clock = new THREE.Clock();
  const tick = () => {
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (liveAnim) wbPedTime.value += dt;
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
} else if (mode === 'lod-compare') {
  renderLodCompare(studio, family, variants, timeParam);
} else {
  runInteractive(studio, family);
}
