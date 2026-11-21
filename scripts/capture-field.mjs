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

    const report = {
      params: { seed: args.seed, terrain: args.terrain, warmup: args.warmup, hour: args.hour },
      readyInfo,
      shots: [],
      observations: {},
    };

    // Helper: position overhead angled camera at (x, z) and wait frames so render & culling catch up
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
      await lookAtPoint(bridgePos.x, bridgePos.z, 34, 24);
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
