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
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import net from 'node:net';

function parseArgs(argv) {
  const args = {
    seed: '1234',
    terrain: 'vale',
    warmup: '40',
    out: '.review/field',
    width: 1440,
    height: 900,
    hour: '14.5', // daylight default; set 'auto' to keep natural clock
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed' && argv[i + 1]) args.seed = argv[++i];
    else if (a === '--terrain' && argv[i + 1]) args.terrain = argv[++i];
    else if (a === '--warmup' && argv[i + 1]) args.warmup = argv[++i];
    else if (a === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (a === '--hour' && argv[i + 1]) args.hour = argv[++i];
    else if (a === '--width' && argv[i + 1]) args.width = Number(argv[++i]);
    else if (a === '--height' && argv[i + 1]) args.height = Number(argv[++i]);
  }
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

    // Wait for simulation init + first populated snapshot
    const readyInfo = await cdp.eval(`(async () => {
      const t0 = performance.now();
      while (performance.now() - t0 < 45000) {
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

    const report = {
      params: { seed: args.seed, terrain: args.terrain, warmup: args.warmup, hour: args.hour },
      readyInfo,
      shots: [],
      observations: {},
    };

    // Helper: position overhead angled camera at (x, z) and wait 3 frames so render & culling catch up
    const lookAtPoint = async (x, z, dist = 48, height = 38) => {
      await cdp.eval(`(async () => {
        const a = window.app;
        a.enterFree(false);
        a.controls.target.set(${x}, a.terrain.heightAt(${x}, ${z}) + 1, ${z});
        a.rig.camera.position.set(${x} + ${dist * 0.72}, a.terrain.heightAt(${x}, ${z}) + ${height}, ${z} + ${dist * 0.68});
        a.controls.update();
        a.send({ type: 'camera', x: ${x}, z: ${z}, h: ${height} });
        for (let k = 0; k < 5; k++) await new Promise((r) => requestAnimationFrame(r));
      })()`);
    };

    const snap = async (filename, meta) => {
      const full = resolve(outDir, filename);
      await cdp.screenshot(full);
      report.shots.push({ file: full, ...meta });
      console.log(`  shot -> ${filename}`);
    };

    // --- 1. Sample transit lines, bus stops, and busy intersections ---
    const sceneSurvey = await cdp.eval(`(() => {
      const a = window.app;
      const lines = [...a.overlays.lines.values()].map((l) => ({
        id: l.id, name: l.name, kind: l.kind, color: l.color,
        stopCount: l.stops.length / 2,
        stops: Array.from({ length: l.stops.length / 2 }, (_, k) => ({ x: l.stops[k * 2], z: l.stops[k * 2 + 1] })),
      }));
      // Pick up to 6 active buses, 12 active pedestrians, 8 active drivers
      const snap = a.curSnap;
      const buses = [], cars = [], peds = [];
      for (let i = 0; i < snap.veh.length / 9; i++) {
        const o = i * 9, t = snap.veh[o + 4];
        if (!t) continue;
        if (t === 4 || t === 5 || t === 12) buses.push({ slot: i, gen: snap.veh[o + 5], type: t, x: snap.veh[o], z: snap.veh[o + 2], line: snap.veh[o + 7] });
        else if (snap.veh[o + 8] >= 0) cars.push({ slot: i, gen: snap.veh[o + 5], type: t, x: snap.veh[o], z: snap.veh[o + 2], citizen: snap.veh[o + 8] });
      }
      for (let i = 0; i < snap.ped.length / 7; i++) {
        const o = i * 7;
        if (snap.ped[o + 4] < 0) continue;
        peds.push({ slot: i, gen: snap.ped[o + 4], x: snap.ped[o], z: snap.ped[o + 2], flags: snap.ped[o + 5], citizen: snap.ped[o + 6] });
      }
      return { lines, buses: buses.slice(0, 8), cars: cars.slice(0, 10), peds: peds.slice(0, 20), totalPeds: peds.length, totalVeh: buses.length + cars.length };
    })()`);
    report.observations.survey = {
      lines: sceneSurvey.lines.length,
      buses: sceneSurvey.buses.length,
      cars: sceneSurvey.cars.length,
      totalPeds: sceneSurvey.totalPeds,
    };

    // --- 2. Capture Bus Stop close-ups (2 stops, T=0 and T+2.5s) ---
    const busLines = sceneSurvey.lines.filter((l) => (l.kind === 'bus' || l.kind === 'brt') && l.stops.length > 0);
    if (busLines.length > 0) {
      await cdp.eval(`(() => { window.app.setSpeed(1); })()`);
      for (let sIdx = 0; sIdx < Math.min(2, busLines[0].stops.length); sIdx++) {
        const st = busLines[0].stops[Math.min(sIdx + 1, busLines[0].stops.length - 1)];
        await lookAtPoint(st.x, st.z, 34, 30);
        await sleep(600);
        await snap(`01-bus-stop-${sIdx + 1}-t0.png`, { kind: 'bus-stop', line: busLines[0].name, stopIndex: sIdx + 1, x: st.x, z: st.z, t: 0 });
        await sleep(2000);
        await snap(`01-bus-stop-${sIdx + 1}-t1.png`, { kind: 'bus-stop', line: busLines[0].name, stopIndex: sIdx + 1, x: st.x, z: st.z, t: 2 });
      }
    }

    // --- 3. Follow a Bus over 3 timestamps (approach, stop, departure) ---
    if (sceneSurvey.buses.length > 0) {
      const bus = sceneSurvey.buses[0];
      await cdp.eval(`(async () => {
        const a = window.app;
        a.setSpeed(10);
        a.followEntity({ kind: 'vehicle', id: ${bus.slot}, gen: ${bus.gen} });
      })()`);
      for (let step = 0; step < 3; step++) {
        await sleep(1800);
        const pose = await cdp.eval(`(() => {
          const p = window.app.agents.vehiclePos(${bus.slot}, ${bus.gen});
          return p ? { x: p.p.x, z: p.p.z, h: p.h } : null;
        })()`);
        if (pose) await lookAtPoint(pose.x, pose.z, 36, 32);
        await snap(`02-bus-follow-t${step}.png`, { kind: 'bus-follow', bus, step, pose });
      }
    }

    // --- 4. Follow multiple Citizens (walkers, waiting/transit, drivers) with Inspector open over time ---
    const citizenTargets = [];
    // Pick up to 2 pedestrians (preferring waiting/walking) and 2 drivers
    const waitingPed = sceneSurvey.peds.find((p) => (p.flags & 128) && p.citizen >= 0);
    const walkingPed = sceneSurvey.peds.find((p) => !(p.flags & 128) && p.citizen >= 0);
    if (waitingPed) citizenTargets.push({ role: 'waiting-ped', id: waitingPed.citizen });
    if (walkingPed && walkingPed.citizen !== waitingPed?.citizen) citizenTargets.push({ role: 'walking-ped', id: walkingPed.citizen });
    for (const c of sceneSurvey.cars) {
      if (citizenTargets.length >= 4) break;
      if (!citizenTargets.some((x) => x.id === c.citizen)) citizenTargets.push({ role: 'driver', id: c.citizen });
    }

    const citizenLogs = [];
    for (let idx = 0; idx < citizenTargets.length; idx++) {
      const ct = citizenTargets[idx];
      const trace = [];
      await cdp.eval(`(async () => {
        const a = window.app;
        a.setSpeed(10);
        await a.hud.inspector.showCitizen(${ct.id});
        a.followEntity({ kind: 'citizen', id: ${ct.id} });
      })()`);
      for (let step = 0; step < 3; step++) {
        await sleep(1800);
        const info = await cdp.eval(`(async () => {
          const a = window.app;
          const d = await a.inspect('citizen', ${ct.id});
          const p = a.agents.citizenPos(${ct.id});
          if (p) {
            a.enterFree(false);
            a.controls.target.set(p.p.x, p.p.y + 1, p.p.z);
            a.rig.camera.position.set(p.p.x + 24, p.p.y + 28, p.p.z + 24);
            a.controls.update();
            for (let k = 0; k < 4; k++) await new Promise((r) => requestAnimationFrame(r));
          }
          return { info: d ? { name: d.name, tourist: d.tourist, home: d.home, job: d.job, state: d.state, mode: d.mode, speedKmh: d.speedKmh, money: d.money, insideBuilding: d.insideBuilding } : null, pos: p ? { x: p.p.x, z: p.p.z, inside: p.inside } : null, time: a.timeLabel() };
        })()`);
        trace.push(info);
        await snap(`03-citizen-${idx + 1}-${ct.role}-t${step}.png`, { kind: 'citizen-follow', role: ct.role, citizenId: ct.id, step, ...info });
      }
      citizenLogs.push({ ...ct, trace });
    }
    report.observations.citizenLogs = citizenLogs;

    // --- 5. Dense central junction overhead view (checking vehicle spacing, crosswalks, sidewalks) ---
    const centerPos = await cdp.eval(`(() => {
      const a = window.app;
      a.hud.inspector.close();
      // Find busiest intersection node near city center
      const cc = a.cityCenter;
      let best = null, bd = Infinity;
      for (const n of a.roads.nodes.values()) {
        const d = Math.hypot(n.x - cc.x, n.z - cc.z);
        if (d < bd) { bd = d; best = n; }
      }
      return best ? { x: best.x, z: best.z } : cc;
    })()`);
    await cdp.eval(`(() => { window.app.setSpeed(1); })()`);
    await lookAtPoint(centerPos.x, centerPos.z, 55, 58);
    await sleep(900);
    await snap('04-central-junction-t0.png', { kind: 'central-junction', center: centerPos, t: 0 });
    await sleep(2200);
    await snap('04-central-junction-t1.png', { kind: 'central-junction', center: centerPos, t: 2.2 });

    writeFileSync(resolve(outDir, 'field-report.json'), JSON.stringify(report, null, 2));
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
