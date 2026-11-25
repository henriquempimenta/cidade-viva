#!/usr/bin/env node
/**
 * Automated Live Field-Observation Capture for Cidade Viva (CDP over Node 22 native WebSocket).
 *
 * Launches the real 3D simulation in headless Chromium, lets the city warm up,
 * follows citizens (walkers, drivers, bus riders, tourists), bus stops, and buses over time,
 * captures PNG screenshots at multiple timestamps, and writes structured observation telemetry.
 *
 * Usage:
 *   node scripts/capture-field.mjs [--seed 1234] [--terrain vale] [--warmup 40] [--out .review/field]
 */
import { execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import net from 'node:net';

function getGitState() {
  let gitCommit = 'unknown';
  let gitDirty = false;
  let gitWorktreeHash = null;
  try {
    gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const status = execSync('git status --porcelain', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    gitDirty = status.length > 0;
    if (gitDirty) {
      const h = createHash('sha256');
      const diff = execSync('git diff HEAD', { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      h.update(status).update('\0').update(diff);
      const untrackedRaw = execSync('git ls-files -z --others --exclude-standard', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const untracked = untrackedRaw
        ? untrackedRaw.split('\0').filter((f) => f && !f.startsWith('.review/') && !f.startsWith('dist/')).sort()
        : [];
      for (const rel of untracked) {
        h.update('\0U:').update(rel).update('\0');
        try { h.update(readFileSync(resolve(process.cwd(), rel))); } catch { /* ignore unreadable */ }
      }
      gitWorktreeHash = h.digest('hex').slice(0, 12);
    }
  } catch { /* fallback defaults */ }
  return { gitCommit, gitDirty, gitWorktreeHash };
}

const KNOWN_TERRAINS = new Set(['vale', 'serra', 'litoral', 'planicie']);

function parseArgs(argv) {
  const args = {
    seed: '1234',
    terrain: 'vale',
    scenario: '',
    warmup: '40',
    out: '.review/field',
    width: 1440,
    height: 900,
    hour: '14.5', // daylight default; set 'auto' to keep natural clock
  };
  let terrainExplicit = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed' && argv[i + 1]) args.seed = argv[++i];
    else if (a === '--terrain' && argv[i + 1]) { args.terrain = argv[++i]; terrainExplicit = true; }
    else if (a === '--scenario' && argv[i + 1]) args.scenario = argv[++i];
    else if (a === '--warmup' && argv[i + 1]) args.warmup = argv[++i];
    else if (a === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (a === '--hour' && argv[i + 1]) args.hour = argv[++i];
    else if (a === '--width' && argv[i + 1]) args.width = Number(argv[++i]);
    else if (a === '--height' && argv[i + 1]) args.height = Number(argv[++i]);
  }
  if (args.scenario && !terrainExplicit && KNOWN_TERRAINS.has(args.scenario)) {
    args.terrain = args.scenario;
  }
  if (!args.scenario) args.scenario = args.terrain;
  return args;
}

function getFreePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => res(addr.port));
    });
    srv.on('error', rej);
  });
}

async function waitForUrl(url, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 1;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`Eval error: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
    }
    return r.result?.value;
  }
  async screenshot(outPath) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(outPath, Buffer.from(data, 'base64'));
  }
  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(process.cwd(), args.out);
  mkdirSync(outDir, { recursive: true });
  const profileDir = `/tmp/cv-field-${process.pid}`;
  const vitePort = await getFreePort();
  const cdpPort = await getFreePort();

  const vite = spawn(
    process.execPath,
    [resolve('node_modules/vite/bin/vite.js'), '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const chromeBin = process.env.CHROME_BIN || '/usr/bin/chromium';
  let chrome = null;
  let cdp = null;

  try {
    await waitForUrl(`http://127.0.0.1:${vitePort}/index.html`);

    chrome = spawn(chromeBin, [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${cdpPort}`,
      `--window-size=${args.width},${args.height}`,
      'about:blank',
    ], {
      env: { ...process.env, TMPDIR: '/tmp' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const listResp = await waitForUrl(`http://127.0.0.1:${cdpPort}/json/list`, 15000);
    const targets = await listResp.json();
    const pageTarget = targets.find((t) => t.type === 'page') || targets[0];
    if (!pageTarget?.webSocketDebuggerUrl) throw new Error('No Chromium page target found');

    cdp = new CDP(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: args.width,
      height: args.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const url = `http://127.0.0.1:${vitePort}/index.html?seed=${encodeURIComponent(args.seed)}&terrain=${encodeURIComponent(args.terrain)}&warmup=${encodeURIComponent(args.warmup)}`;
    await cdp.send('Page.navigate', { url });

    // Wait for simulation init + first populated snapshot (scale timeout with warmup days)
    const initTimeoutMs = Math.max(60000, Number(args.warmup || 0) * 3500 + 40000);
    const readyInfo = await cdp.eval(`(async () => {
      const t0 = performance.now();
      while (performance.now() - t0 < ${initTimeoutMs}) {
        const a = window.app;
        if (a && a.started && a.curSnap && a.stats && a.buildings.all().length > 20) {
          return {
            pop: a.stats.pop,
            day: a.stats.day,
            year: a.stats.year,
            buildings: a.buildings.all().length,
            edges: a.roads.edges.size,
            lines: a.overlays.lines.size,
          };
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('Simulation did not initialize in time');
    })()`);

    console.log('City ready:', readyInfo);

    // Stabilize lighting for clear visual inspection (unless --hour auto)
    if (args.hour !== 'auto') {
      await cdp.eval(`(() => { window.app.fixedHour = ${Number(args.hour)}; window.app.setSpeed(10); })()`);
    } else {
      await cdp.eval(`(() => { window.app.setSpeed(10); })()`);
    }

    // Wait a moment so agents populate streets & transit lines
    await sleep(3200);

    const { gitCommit, gitDirty, gitWorktreeHash } = getGitState();
    const report = {
      gitCommit,
      gitDirty,
      gitWorktreeHash,
      scenario: args.scenario,
      capturedAt: new Date().toISOString(),
      params: { seed: args.seed, terrain: args.terrain, scenario: args.scenario, warmup: args.warmup, hour: args.hour },
      readyInfo,
      shots: [],
      observations: {},
    };

    // Helper: position overhead angled camera at (x, z) with terrain-occlusion avoidance
    const lookAtPoint = async (x, z, dist = 48, height = 38, targetY = null) => {
      await cdp.eval(`(async () => {
        const a = window.app;
        a.enterFree(false);
        const ty = ${targetY === null ? 'null' : Number(targetY)} ?? Math.max(0.5, a.terrain.heightAt(${x}, ${z}) + 1);
        // Sample 8 azimuths to choose a sightline that never clips into a hillside/riverbank
        const candidates = [
          [0.72, 0.68], [-0.72, 0.68], [0.72, -0.68], [-0.72, -0.68],
          [1.0, 0.0], [-1.0, 0.0], [0.0, 1.0], [0.0, -1.0],
        ];
        let best = candidates[0], bestClear = -Infinity;
        for (const [ux, uz] of candidates) {
          const cx = ${x} + ux * ${dist};
          const cz = ${z} + uz * ${dist};
          const mx = (${x} + cx) * 0.5;
          const mz = (${z} + cz) * 0.5;
          const camH = ty + ${height};
          const midLineH = ty + ${height} * 0.5;
          const clear = Math.min(camH - a.terrain.heightAt(cx, cz), midLineH - a.terrain.heightAt(mx, mz));
          if (clear > bestClear) { bestClear = clear; best = [ux, uz]; }
        }
        const cx = ${x} + best[0] * ${dist};
        const cz = ${z} + best[1] * ${dist};
        const cy = Math.max(ty + ${height}, a.terrain.heightAt(cx, cz) + 14);
        a.controls.target.set(${x}, ty, ${z});
        a.rig.camera.position.set(cx, cy, cz);
        a.controls.update();
        a.send({ type: 'camera', x: ${x}, z: ${z}, h: cy - ty });
        for (let k = 0; k < 5; k++) await new Promise((r) => requestAnimationFrame(r));
      })()`);
    };

    const waitFrames = async (n = 4) => {
      await cdp.eval(`(async () => { for (let k = 0; k < ${n}; k++) await new Promise((r) => requestAnimationFrame(r)); })()`);
    };

    const freezeSim = async () => {
      await cdp.eval(`(async () => {
        window.app.setSpeed(0);
        await new Promise((r) => setTimeout(r, 120));
        for (let k = 0; k < 3; k++) await new Promise((r) => requestAnimationFrame(r));
      })()`);
    };

    const resumeSim = async (speed) => {
      await cdp.eval(`(() => { window.app.setSpeed(${speed}); })()`);
    };

    const snap = async (filename, meta) => {
      const full = resolve(outDir, filename);
      await cdp.screenshot(full);
      report.shots.push({ file: full, ...meta });
      console.log(`  shot -> ${filename} [${meta.kind} cam=${meta.cameraMode} state=${meta.state} inconclusive=${meta.inconclusive}]`);
    };

    const snapFrozen = async (filename, prevSpeed, buildMeta) => {
      await freezeSim();
      try {
        const meta = typeof buildMeta === 'function' ? await buildMeta() : buildMeta;
        await waitFrames(2);
        await snap(filename, meta);
        return meta;
      } finally {
        await resumeSim(prevSpeed);
      }
    };

    // --- 1. Survey current transit lines & agent counts ---
    const initialSurvey = await cdp.eval(`(() => {
      const a = window.app;
      const lines = [...a.overlays.lines.values()].map((l) => ({
        id: l.id, name: l.name, kind: l.kind, color: l.color,
        stopCount: l.stops.length / 2,
        stops: Array.from({ length: l.stops.length / 2 }, (_, k) => ({ x: l.stops[k * 2], z: l.stops[k * 2 + 1] })),
      }));
      const s = a.curSnap;
      let buses = 0, cars = 0, peds = 0;
      for (let i = 0; i < s.veh.length / 9; i++) {
        const t = s.veh[i * 9 + 4];
        if (!t) continue;
        if (t === 4 || t === 5 || t === 12) buses++;
        else if (s.veh[i * 9 + 8] >= 0) cars++;
      }
      for (let i = 0; i < s.ped.length / 7; i++) if (s.ped[i * 7 + 4] >= 0) peds++;
      return { lines, buses, cars, totalPeds: peds };
    })()`);
    report.observations.survey = {
      lines: initialSurvey.lines.length,
      buses: initialSurvey.buses,
      cars: initialSurvey.cars,
      totalPeds: initialSurvey.totalPeds,
    };

    // --- 2. Capture Bus Stop close-ups (distinct stops, avoiding duplicate shot on 2-stop lines) ---
    const busLines = initialSurvey.lines.filter((l) => (l.kind === 'bus' || l.kind === 'brt') && l.stops.length > 0);
    if (busLines.length > 0) {
      await cdp.eval(`(() => { window.app.setSpeed(1); })()`);
      // Gather up to 2 distinct bus stops (prefer distinct indices on line 0, or across lines)
      const pickedStops = [];
      for (const line of busLines) {
        for (let k = 0; k < line.stops.length && pickedStops.length < 2; k++) {
          const st = line.stops[k];
          if (pickedStops.some((p) => Math.hypot(p.x - st.x, p.z - st.z) < 20)) continue;
          pickedStops.push({ line: line.name, stopIndex: k, x: st.x, z: st.z });
        }
        if (pickedStops.length >= 2) break;
      }
      for (let sIdx = 0; sIdx < pickedStops.length; sIdx++) {
        const st = pickedStops[sIdx];
        await lookAtPoint(st.x, st.z, 34, 30);
        await sleep(600);
        await snapFrozen(`01-bus-stop-${sIdx + 1}-t0.png`, 1, async () => {
          const time = await cdp.eval(`window.app.timeLabel()`);
          return {
            kind: 'bus-stop', state: 'observing', mode: 'bus-stop', gen: -1,
            cameraMode: 'free', insideBuilding: false, inconclusive: false,
            line: st.line, stopIndex: st.stopIndex, x: st.x, z: st.z, t: 0, time,
          };
        });
        await sleep(2000);
        await snapFrozen(`01-bus-stop-${sIdx + 1}-t1.png`, 1, async () => {
          const time = await cdp.eval(`window.app.timeLabel()`);
          return {
            kind: 'bus-stop', state: 'observing', mode: 'bus-stop', gen: -1,
            cameraMode: 'free', insideBuilding: false, inconclusive: false,
            line: st.line, stopIndex: st.stopIndex, x: st.x, z: st.z, t: 2, time,
          };
        });
      }
    }

    // --- 3. Follow a Bus picked LIVE at capture time, keeping follow camera active ---
    const liveBus = await cdp.eval(`(() => {
      const a = window.app, s = a.curSnap;
      const list = [];
      for (let i = 0; i < s.veh.length / 9; i++) {
        const o = i * 9, t = s.veh[o + 4];
        if (t === 4 || t === 5 || t === 12) list.push({ slot: i, gen: s.veh[o + 5], type: t, x: s.veh[o], z: s.veh[o + 2], line: s.veh[o + 7] });
      }
      return list[0] ?? null;
    })()`);
    if (liveBus) {
      await cdp.eval(`(() => {
        const a = window.app;
        a.setSpeed(10);
        a.followEntity({ kind: 'vehicle', id: ${liveBus.slot}, gen: ${liveBus.gen} });
      })()`);
      for (let step = 0; step < 3; step++) {
        await sleep(1600);
        await snapFrozen(`02-bus-follow-t${step}.png`, 10, async () => {
          const obs = await cdp.eval(`(() => {
            const a = window.app, s = a.curSnap;
            const o = ${liveBus.slot} * 9;
            const curType = o < s.veh.length ? s.veh[o + 4] : 0;
            const curGen = o < s.veh.length ? s.veh[o + 5] : -1;
            const same = curType > 0 && curGen === ${liveBus.gen};
            const p = same ? a.agents.vehiclePos(${liveBus.slot}, ${liveBus.gen}) : null;
            return { same, curGen, cameraMode: a.mode, time: a.timeLabel(), pose: p ? { x: p.p.x, z: p.p.z, h: p.h } : null };
          })()`);
          return {
            kind: 'bus-follow', state: obs.pose ? 'active' : 'lost', mode: 'bus', gen: obs.curGen,
            cameraMode: obs.cameraMode, insideBuilding: false, inconclusive: !obs.pose || !obs.same,
            bus: liveBus, step, pose: obs.pose, time: obs.time,
          };
        });
      }
    }

    // --- 4. Follow Citizens picked LIVE at the exact moment of each sequence, keeping follow camera active ---
    const desiredRoles = ['waiting-ped', 'walking-ped', 'driver-1', 'driver-2'];
    const usedCitizens = new Set();
    const citizenLogs = [];
    for (let idx = 0; idx < desiredRoles.length; idx++) {
      const role = desiredRoles[idx];
      const exclude = [...usedCitizens];
      // Pick live candidate RIGHT NOW and verify state + not inside a building in the same turn
      const picked = await cdp.eval(`(async () => {
        const a = window.app, s = a.curSnap;
        const used = new Set(${JSON.stringify(exclude)});
        const cands = [];
        if (${JSON.stringify(role)} === 'waiting-ped' || ${JSON.stringify(role)} === 'walking-ped') {
          const wantWait = ${JSON.stringify(role)} === 'waiting-ped';
          for (let i = 0; i < s.ped.length / 7; i++) {
            const o = i * 7, gen = s.ped[o + 4], flags = s.ped[o + 5], cid = s.ped[o + 6];
            if (gen < 0 || cid < 0 || used.has(cid)) continue;
            const isWait = (flags & 128) !== 0;
            if (isWait === wantWait) cands.push({ cid, gen, slot: i });
          }
        } else {
          for (let i = 0; i < s.veh.length / 9; i++) {
            const o = i * 9, t = s.veh[o + 4], gen = s.veh[o + 5], cid = s.veh[o + 8];
            if (!t || cid < 0 || used.has(cid)) continue;
            cands.push({ cid, gen, slot: i });
          }
        }
        for (const c of cands.slice(0, 12)) {
          const d = await a.inspect('citizen', c.cid);
          if (!d || d.insideBuilding >= 0) continue;
          return { id: c.cid, gen: c.gen, state: d.state, mode: d.mode };
        }
        return cands[0] ? { id: cands[0].cid, gen: cands[0].gen, state: 'unknown', mode: 'unknown' } : null;
      })()`);
      if (!picked) continue;
      usedCitizens.add(picked.id);

      const trace = [];
      await cdp.eval(`(async () => {
        const a = window.app;
        a.setSpeed(10);
        await a.hud.inspector.showCitizen(${picked.id});
        a.followEntity({ kind: 'citizen', id: ${picked.id} });
      })()`);

      for (let step = 0; step < 3; step++) {
        await sleep(1400);
        await snapFrozen(`03-citizen-${idx + 1}-${role}-t${step}.png`, 10, async () => {
          const obs = await cdp.eval(`(async () => {
            const a = window.app;
            await a.hud.inspector.showCitizen(${picked.id});
            const d = await a.inspect('citizen', ${picked.id});
            const p = a.agents.citizenPos(${picked.id});
            const insideBuilding = Boolean((d && d.insideBuilding >= 0) || p?.inside);
            const s = a.curSnap;
            let liveGen = ${picked.gen};
            for (let i = 0; i < s.ped.length / 7; i++) if (s.ped[i * 7 + 4] >= 0 && s.ped[i * 7 + 6] === ${picked.id}) { liveGen = s.ped[i * 7 + 4]; break; }
            for (let i = 0; i < s.veh.length / 9; i++) if (s.veh[i * 9 + 4] && s.veh[i * 9 + 8] === ${picked.id}) { liveGen = s.veh[i * 9 + 5]; break; }
            return {
              info: d ? { name: d.name, tourist: d.tourist, home: d.home, job: d.job, state: d.state, mode: d.mode, speedKmh: d.speedKmh, money: d.money, insideBuilding: d.insideBuilding } : null,
              pos: p ? { x: p.p.x, z: p.p.z, inside: p.inside } : null,
              cameraMode: a.mode,
              gen: liveGen,
              insideBuilding,
              inconclusive: !d || !p || insideBuilding,
              time: a.timeLabel(),
            };
          })()`);
          trace.push(obs);
          return {
            kind: 'citizen-follow',
            role,
            citizenId: picked.id,
            step,
            state: obs.info?.state ?? 'lost',
            mode: obs.info?.mode ?? 'unknown',
            gen: obs.gen,
            cameraMode: obs.cameraMode,
            insideBuilding: obs.insideBuilding,
            inconclusive: obs.inconclusive,
            info: obs.info,
            pos: obs.pos,
            time: obs.time,
          };
        });
      }
      citizenLogs.push({ role, id: picked.id, trace });
    }
    report.observations.citizenLogs = citizenLogs;

    // --- 5. Dense central junction overhead view picked by highest active traffic volume ---
    const centerPos = await cdp.eval(`(() => {
      const a = window.app, s = a.curSnap;
      a.hud.inspector.close();
      const cc = a.cityCenter;
      const vehPts = [];
      for (let i = 0; i < s.veh.length / 9; i++) {
        const o = i * 9;
        if (s.veh[o + 4]) vehPts.push([s.veh[o], s.veh[o + 2]]);
      }
      let best = null, bestScore = -1;
      for (const n of a.roads.nodes.values()) {
        if ((n.deg ?? 0) < 3) continue;
        let nearVeh = 0;
        for (const [vx, vz] of vehPts) {
          if (Math.hypot(vx - n.x, vz - n.z) < 80) nearVeh++;
        }
        const distCenter = Math.hypot(n.x - cc.x, n.z - cc.z);
        const score = nearVeh * 10 + (n.control === 2 || n.control === 4 ? 12 : 0) + (n.deg >= 4 ? 6 : 0) - distCenter * 0.015;
        if (score > bestScore) { bestScore = score; best = { x: n.x, z: n.z, deg: n.deg, control: n.control, nearVeh }; }
      }
      return best ?? { x: cc.x, z: cc.z, deg: 0, control: 0, nearVeh: 0 };
    })()`);
    await cdp.eval(`(() => { window.app.setSpeed(1); })()`);
    await lookAtPoint(centerPos.x, centerPos.z, 55, 58);
    await sleep(900);
    await snapFrozen('04-central-junction-t0.png', 1, async () => {
      const time = await cdp.eval(`window.app.timeLabel()`);
      return {
        kind: 'central-junction', state: 'observing', mode: 'junction', gen: -1,
        cameraMode: 'free', insideBuilding: false, inconclusive: centerPos.nearVeh === 0,
        center: centerPos, t: 0, time,
      };
    });
    await sleep(2200);
    await snapFrozen('04-central-junction-t1.png', 1, async () => {
      const time = await cdp.eval(`window.app.timeLabel()`);
      return {
        kind: 'central-junction', state: 'observing', mode: 'junction', gen: -1,
        cameraMode: 'free', insideBuilding: false, inconclusive: centerPos.nearVeh === 0,
        center: centerPos, t: 2.2, time,
      };
    });

    // --- 6. Bridge walkway check (if city has a bridge over water) ---
    const bridgePos = await cdp.eval(`(() => {
      const a = window.app, s = a.curSnap;
      const pedPts = [];
      for (let i = 0; i < s.ped.length / 7; i++) {
        const o = i * 7;
        if (s.ped[o + 4] >= 0) pedPts.push([s.ped[o], s.ped[o + 2]]);
      }
      let best = null, bestScore = -1;
      for (const e of a.roads.edges.values()) {
        if (!e.bridge || e.elevated || e.deck !== undefined || !e.pts || e.pts.length < 6) continue;
        const mi = Math.floor(e.pts.length / 6) * 3;
        const x = e.pts[mi], y = e.pts[mi + 1], z = e.pts[mi + 2];
        let nearPed = 0;
        for (const [px, pz] of pedPts) if (Math.hypot(px - x, pz - z) < 55) nearPed++;
        const score = nearPed * 20 + (e.len ?? 0) * 0.05;
        if (score > bestScore) { bestScore = score; best = { id: e.id, x, y, z, nearPed }; }
      }
      return best;
    })()`);
    if (bridgePos) {
      await lookAtPoint(bridgePos.x, bridgePos.z, 36, 26, bridgePos.y + 0.8);
      await sleep(500);
      await snapFrozen('05-bridge-walkway.png', 1, async () => {
        const time = await cdp.eval(`window.app.timeLabel()`);
        return {
          kind: 'bridge-walkway', state: 'observing', mode: 'bridge', gen: -1,
          cameraMode: 'free', insideBuilding: false, inconclusive: false,
          bridge: bridgePos, time,
        };
      });
    }

    // --- 7. Cycle 2: Active road incident (cones, barricade, hazard vehicle, response & tow) ---
    // Prefer a real emergent incident first; wait briefly at elevated speed before optional fallback injection.
    const incidentPick = await cdp.eval(`(async () => {
      const a = window.app;
      let source = 'emergent';
      if (!a.overlays.incidents || a.overlays.incidents.length === 0) {
        a.setSpeed(50);
        const t0 = performance.now();
        while (performance.now() - t0 < 5500) {
          if (a.overlays.incidents && a.overlays.incidents.length > 0) break;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      if (!a.overlays.incidents || a.overlays.incidents.length === 0) {
        source = 'injected';
        a.setSpeed(10);
        a.send({ type: 'inject', event: 'accident' });
        const t1 = performance.now();
        while (performance.now() - t1 < 3500) {
          if (a.overlays.incidents && a.overlays.incidents.length > 0) break;
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      a.setSpeed(1);
      const inc = a.overlays.incidents?.[0] ?? null;
      return inc ? { source, inc } : null;
    })()`);

    if (incidentPick?.inc) {
      const inc = incidentPick.inc;
      await cdp.eval(`(() => { window.app.hud.inspector.close(); })()`);
      await lookAtPoint(inc.x, inc.z, 30, 22, inc.y + 0.8);
      await sleep(500);
      await snapFrozen('06-road-incident-t0.png', 8, async () => {
        const obs = await cdp.eval(`(async () => {
          const a = window.app;
          const live = a.overlays.incidents.find((x) => x.id === ${inc.id}) ?? a.overlays.incidents[0] ?? null;
          const edgeInfo = await a.inspect('edge', ${inc.edge});
          return { live, edgeIncidents: edgeInfo?.incidents ?? [], time: a.timeLabel() };
        })()`);
        return {
          kind: 'road-incident', source: incidentPick.source,
          state: obs.live?.stage ?? 'cleared', mode: 'incident', gen: -1,
          cameraMode: 'free', insideBuilding: false, inconclusive: !obs.live,
          incident: obs.live ?? inc, edgeIncidents: obs.edgeIncidents, t: 0, time: obs.time,
        };
      });
      // Advance sim moderately while incident remains active so responders visibly approach without clearing early
      await cdp.eval(`(async () => {
        const a = window.app;
        const t0 = performance.now();
        while (performance.now() - t0 < 2400) {
          const live = a.overlays.incidents.find((x) => x.id === ${inc.id});
          if (!live || live.stage === 'clearing') break;
          await new Promise((r) => setTimeout(r, 150));
        }
      })()`);
      await snapFrozen('06-road-incident-t1.png', 1, async () => {
        const obs = await cdp.eval(`(async () => {
          const a = window.app;
          const live = a.overlays.incidents.find((x) => x.id === ${inc.id}) ?? a.overlays.incidents[0] ?? null;
          const edgeId = live?.edge ?? ${inc.edge};
          await a.hud.inspector.showEdge(edgeId);
          // Clear OD arcs so the 3D scene stays clean around the incident cones/barricades
          a.overlays.clearOD?.();
          const edgeInfo = await a.inspect('edge', edgeId);
          return { live, edgeIncidents: edgeInfo?.incidents ?? [], time: a.timeLabel() };
        })()`);
        return {
          kind: 'road-incident', source: incidentPick.source,
          state: obs.live?.stage ?? 'cleared', mode: 'incident', gen: -1,
          cameraMode: 'free', insideBuilding: false, inconclusive: !obs.live,
          incident: obs.live ?? inc, edgeIncidents: obs.edgeIncidents, t: 2.4, time: obs.time,
        };
      });
    }

    // --- 8. Cycle 2: Emergency responder or Tow truck in transit / on scene ---
    const responderPick = await cdp.eval(`(async () => {
      const a = window.app;
      const findBest = () => {
        const s = a.curSnap;
        if (!s) return null;
        const cands = [];
        for (let i = 0; i < s.veh.length / 9; i++) {
          const o = i * 9, t = s.veh[o + 4], gen = s.veh[o + 5], flags = s.veh[o + 6];
          if (!t) continue;
          // Prioritize Tow (16), Ambulance (9), Fire (11), Police (10) with siren or hazard
          if (t === 16 || t === 9 || t === 11 || t === 10) {
            const pri = (t === 16 ? 40 : 0) + ((flags & 1) ? 30 : 0) + ((flags & 32) ? 20 : 0) + (t === 9 || t === 11 ? 15 : 5);
            cands.push({ slot: i, gen, type: t, flags, pri });
          }
        }
        cands.sort((x, y) => y.pri - x.pri);
        return cands[0] ?? null;
      };
      let best = findBest();
      if (!best) {
        a.send({ type: 'inject', event: 'breakdown' });
        a.setSpeed(5);
        const t0 = performance.now();
        while (performance.now() - t0 < 3000) {
          best = findBest();
          if (best) break;
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      return best;
    })()`);

    if (responderPick) {
      await cdp.eval(`(async () => {
        const a = window.app;
        a.setSpeed(1);
        await a.hud.inspector.showVehicle(${responderPick.slot});
        a.followEntity({ kind: 'vehicle', id: ${responderPick.slot}, gen: ${responderPick.gen} });
      })()`);
      await sleep(1400);
      await snapFrozen('07-emergency-response.png', 1, async () => {
        const obs = await cdp.eval(`(async () => {
          const a = window.app;
          await a.hud.inspector.showVehicle(${responderPick.slot});
          const vInfo = await a.inspect('vehicle', ${responderPick.slot});
          const p = a.agents.vehiclePos(${responderPick.slot}, ${responderPick.gen});
          return {
            info: vInfo,
            pose: p ? { x: p.p.x, z: p.p.z, h: p.h } : null,
            cameraMode: a.mode,
            time: a.timeLabel(),
          };
        })()`);
        return {
          kind: 'emergency-response',
          state: obs.info?.mission ?? 'lost',
          mode: obs.info?.typeName ?? 'emergency',
          gen: responderPick.gen,
          cameraMode: obs.cameraMode,
          insideBuilding: false,
          inconclusive: !obs.pose || !obs.info,
          vehicle: obs.info,
          pose: obs.pose,
          time: obs.time,
        };
      });
    }

    // --- 9. Infrastructure close-ups: 08-sloped-junction, 09-rail-crossing-bridge, 10-hillside-buildings ---
    await cdp.eval(`(() => { window.app.hud.inspector.close(); window.app.setSpeed(1); })()`);

    // 08: Sloped or acute urban junction (close-up showing junction seam, sidewalks, zebra & stop-line)
    const slopedJunction = await cdp.eval(`(() => {
      const a = window.app, s = a.curSnap;
      const vehPts = [];
      for (let i = 0; i < s.veh.length / 9; i++) {
        const o = i * 9;
        if (s.veh[o + 4]) vehPts.push([s.veh[o], s.veh[o + 2]]);
      }
      let best = null, bestScore = -1;
      for (const n of a.roads.nodes.values()) {
        const inc = a.roads.edgesAt(n.id);
        if (inc.length < 3) continue;
        if (!inc.some((e) => e.cls >= 1 && e.cls <= 3 && !e.bridge && !e.elevated)) continue;
        const gC = a.terrain.meshY(n.x, n.z);
        const slope = Math.hypot(
          (a.terrain.meshY(n.x + 12, n.z) - a.terrain.meshY(n.x - 12, n.z)) / 24,
          (a.terrain.meshY(n.x, n.z + 12) - a.terrain.meshY(n.x, n.z - 12)) / 24,
        );
        // Minimum angle between adjacent arms
        const angs = inc.map((e) => {
          const o = a.roads.nodes.get(e.a === n.id ? e.b : e.a);
          return o ? Math.atan2(o.z - n.z, o.x - n.x) : 0;
        }).sort((x, y) => x - y);
        let minAng = Math.PI;
        for (let i = 0; i < angs.length; i++) {
          const d = (angs[(i + 1) % angs.length] - angs[i] + Math.PI * 2) % (Math.PI * 2);
          if (d < minAng) minAng = d;
        }
        let nearVeh = 0;
        for (const [vx, vz] of vehPts) if (Math.hypot(vx - n.x, vz - n.z) < 50) nearVeh++;
        const acuteBonus = minAng < 1.25 ? (1.25 - minAng) * 35 : 0;
        const sigBonus = n.control === 2 || n.control === 4 ? 14 : 0;
        const score = slope * 180 + acuteBonus + sigBonus + Math.min(nearVeh, 8) * 3;
        if (score > bestScore) {
          bestScore = score;
          best = { id: n.id, x: n.x, y: gC, z: n.z, deg: inc.length, control: n.control, slope, minAngDeg: minAng * 180 / Math.PI, nearVeh };
        }
      }
      return best;
    })()`);
    if (slopedJunction) {
      await lookAtPoint(slopedJunction.x, slopedJunction.z, 34, 24, slopedJunction.y + 0.8);
      await sleep(700);
      await snapFrozen('08-sloped-junction.png', 1, async () => {
        const time = await cdp.eval(`window.app.timeLabel()`);
        return {
          kind: 'sloped-junction', state: 'observing', mode: 'infrastructure', gen: -1,
          cameraMode: 'free', insideBuilding: false, inconclusive: false,
          junction: slopedJunction, time,
        };
      });
    }

    // 09: Railway level crossing, bridge or hillside embankment close-up
    const railTarget = await cdp.eval(`(() => {
      const a = window.app;
      // Priority 1: level crossing (gates, deck, signals, tracks)
      const level = (a.rail.crossings || []).filter((c) => !c.separated || c.under);
      if (level.length) {
        const c = level[0];
        return { kind: c.under ? 'underpass' : 'crossing', x: c.x, y: Math.max(c.y, a.terrain.meshY(c.x, c.z)), z: c.z };
      }
      // Priority 2: rail bridge over river / valley (piers, closed deck, abutments)
      for (const e of a.rail.edges.values()) {
        if (!e.bridge || !e.pts || e.pts.length < 6) continue;
        const mi = Math.floor(e.pts.length / 6) * 3;
        return { kind: 'rail-bridge', x: e.pts[mi], y: e.pts[mi + 1], z: e.pts[mi + 2] };
      }
      // Priority 3: steepest hillside rail stretch near city
      let best = null, bestScore = -Infinity;
      const cc = a.cityCenter;
      for (const e of a.rail.edges.values()) {
        if (!e.pts || e.pts.length < 6) continue;
        for (let i = 0; i < e.pts.length; i += 3) {
          const x = e.pts[i], y = e.pts[i + 1], z = e.pts[i + 2];
          const slope = Math.hypot(
            (a.terrain.meshY(x + 10, z) - a.terrain.meshY(x - 10, z)) / 20,
            (a.terrain.meshY(x, z + 10) - a.terrain.meshY(x, z - 10)) / 20,
          );
          const dist = Math.hypot(x - cc.x, z - cc.z);
          const score = slope * 200 - dist * 0.04;
          if (score > bestScore) { bestScore = score; best = { kind: 'rail-slope', x, y, z, slope }; }
        }
      }
      return best;
    })()`);
    if (railTarget) {
      await lookAtPoint(railTarget.x, railTarget.z, 38, 22, railTarget.y + 0.8);
      await sleep(500);
      await snapFrozen('09-rail-crossing-bridge.png', 1, async () => {
        const time = await cdp.eval(`window.app.timeLabel()`);
        return {
          kind: 'rail-crossing-bridge', state: 'observing', mode: 'infrastructure', gen: -1,
          cameraMode: 'free', insideBuilding: false, inconclusive: false,
          rail: railTarget, time,
        };
      });
    }

    // 09b: Dedicated railway underpass (c.under) close-up when present
    const underpassTarget = await cdp.eval(`(() => {
      const a = window.app;
      const u = (a.rail.crossings || []).find((c) => c.under);
      if (!u) return null;
      return { kind: 'underpass', x: u.x, y: Math.max(u.y, a.terrain.meshY(u.x, u.z)), z: u.z, angle: u.angle, hw: u.hw, walk: !!u.walk };
    })()`);
    if (underpassTarget) {
      await lookAtPoint(underpassTarget.x, underpassTarget.z, 42, 20, underpassTarget.y - 1.2);
      await sleep(500);
      await snapFrozen('09b-rail-underpass.png', 1, async () => {
        const time = await cdp.eval(`window.app.timeLabel()`);
        return {
          kind: 'rail-underpass', state: 'observing', mode: 'infrastructure', gen: -1,
          cameraMode: 'free', insideBuilding: false, inconclusive: false,
          rail: underpassTarget, time,
        };
      });
    }

    // 10: Steepest hillside buildings + terraced streets (plinths, terraforming, retaining skirts)
    const hillCluster = await cdp.eval(`(() => {
      const a = window.app;
      const blds = a.buildings.all().filter((b) => b.state === 'done');
      let best = null, bestScore = -1;
      for (const b of blds) {
        const slope = Math.hypot(
          (a.terrain.meshY(b.x + 14, b.z) - a.terrain.meshY(b.x - 14, b.z)) / 28,
          (a.terrain.meshY(b.x, b.z + 14) - a.terrain.meshY(b.x, b.z - 14)) / 28,
        );
        let neighbors = 0;
        for (const o of blds) if (o.id !== b.id && Math.hypot(o.x - b.x, o.z - b.z) < 60) neighbors++;
        const score = slope * 260 + Math.min(neighbors, 6) * 4;
        if (score > bestScore) { bestScore = score; best = { id: b.id, kind: b.kind, x: b.x, y: b.y, z: b.z, slope, neighbors }; }
      }
      return best;
    })()`);
    if (hillCluster) {
      await lookAtPoint(hillCluster.x, hillCluster.z, 44, 24, hillCluster.y + 2);
      await sleep(500);
      await snapFrozen('10-hillside-buildings.png', 1, async () => {
        const time = await cdp.eval(`window.app.timeLabel()`);
        return {
          kind: 'hillside-buildings', state: 'observing', mode: 'infrastructure', gen: -1,
          cameraMode: 'free', insideBuilding: false, inconclusive: false,
          cluster: hillCluster, time,
        };
      });
    }

    report.capturedAt = new Date().toISOString();
    const json = JSON.stringify(report, null, 2);
    writeFileSync(resolve(outDir, 'field-report.json'), json);
    writeFileSync(resolve(outDir, 'summary.json'), json);
    console.log(`Captured ${report.shots.length} field screenshots + telemetry to ${outDir}`);
  } finally {
    cdp?.close();
    chrome?.kill('SIGTERM');
    vite.kill('SIGTERM');
    await sleep(300);
    try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
