#!/usr/bin/env node
/**
 * Automated multi-angle & multi-situation screenshot capture for Cidade Viva 3D Workbench.
 *
 * Usage:
 *   node scripts/capture-workbench.mjs --family kit [--out .review/kit] [--variants id1,id2]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import net from 'node:net';

function parseArgs(argv) {
  const args = { family: 'kit', out: '', variants: '', width: 1600, height: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--family' && argv[i + 1]) args.family = argv[++i];
    else if (a === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (a === '--variants' && argv[i + 1]) args.variants = argv[++i];
    else if (a === '--width' && argv[i + 1]) args.width = Number(argv[++i]);
    else if (a === '--height' && argv[i + 1]) args.height = Number(argv[++i]);
  }
  if (!args.out) args.out = `.review/${args.family}`;
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

async function waitForServer(url, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Vite server did not respond at ${url} within ${timeoutMs}ms`);
}

function runChromium(url, outFile, width, height, profileDir) {
  return new Promise((res, rej) => {
    const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
    const child = spawn(chrome, [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      `--user-data-dir=${profileDir}`,
      `--window-size=${width},${height}`,
      '--virtual-time-budget=2500',
      `--screenshot=${outFile}`,
      url,
    ], {
      env: { ...process.env, TMPDIR: '/tmp' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', rej);
    child.on('close', (code) => {
      if (code === 0) res();
      else rej(new Error(`Chromium exited ${code} for ${url}:\n${stderr.slice(-600)}`));
    });
  });
}

function dumpMeta(url, profileDir) {
  return new Promise((res, rej) => {
    const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
    const child = spawn(chrome, [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      `--user-data-dir=${profileDir}`,
      '--virtual-time-budget=2500',
      '--dump-dom',
      url,
    ], {
      env: { ...process.env, TMPDIR: '/tmp' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return rej(new Error(`Chromium dump-dom exited ${code}: ${stderr.slice(-400)}`));
      res(stdout);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(process.cwd(), args.out);
  mkdirSync(outDir, { recursive: true });
  const profileDir = `/tmp/cv-wb-${process.pid}`;
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}/workbench.html`;

  const vite = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(baseUrl);
    const shots = [];

    // 1. Full lineup (Day + Night)
    const lineupDay = resolve(outDir, '01-lineup-day.png');
    await runChromium(`${baseUrl}?family=${encodeURIComponent(args.family)}&mode=lineup&time=day`, lineupDay, args.width, 900, profileDir);
    shots.push({ file: lineupDay, kind: 'lineup-day' });

    const lineupNight = resolve(outDir, '02-lineup-night.png');
    await runChromium(`${baseUrl}?family=${encodeURIComponent(args.family)}&mode=lineup&time=night`, lineupNight, args.width, 900, profileDir);
    shots.push({ file: lineupNight, kind: 'lineup-night' });

    // Discover how many variants & default hero/LOD lists exist from lineup DOM
    const dom = await dumpMeta(`${baseUrl}?family=${encodeURIComponent(args.family)}&mode=lineup&time=day`, profileDir);
    const countMatch = dom.match(/\((\d+)\s+variantes/);
    const totalVariants = countMatch ? Number(countMatch[1]) : 1;
    const pages = Math.max(1, Math.ceil(totalVariants / 6));
    const heroAttrMatch = dom.match(/data-hero-variants="([^"]+)"/);
    const lodAttrMatch = dom.match(/data-lod-variants="([^"]+)"/);

    // 2. Close-up grids covering every variant in the family
    for (let p = 0; p < pages; p++) {
      const f = resolve(outDir, `03-closeups-p${p + 1}.png`);
      await runChromium(`${baseUrl}?family=${encodeURIComponent(args.family)}&mode=closeup-grid&page=${p}&time=day`, f, args.width, args.height, profileDir);
      shots.push({ file: f, kind: `closeup-grid-p${p + 1}` });
    }

    // 3. Multi-angle 2x3 hero sheets for requested variants (or family's heroVariants if defined)
    const defaultHeroes = heroAttrMatch ? heroAttrMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [''];
    const heroIds = args.variants ? args.variants.split(',').map((s) => s.trim()).filter(Boolean) : defaultHeroes;
    for (let i = 0; i < heroIds.length; i++) {
      const vid = heroIds[i];
      const suffix = vid || 'default';
      const f = resolve(outDir, `04-sheet-${suffix}.png`);
      const q = vid ? `&variant=${encodeURIComponent(vid)}` : '';
      await runChromium(`${baseUrl}?family=${encodeURIComponent(args.family)}&mode=sheet${q}`, f, args.width, args.height, profileDir);
      shots.push({ file: f, kind: `sheet-${suffix}` });
    }

    // 4. Real-time LOD side-by-side comparison sheet (high | med | low) when family defines lodCompareVariants
    if (lodAttrMatch) {
      const lodFile = resolve(outDir, '05-lod-compare.png');
      await runChromium(`${baseUrl}?family=${encodeURIComponent(args.family)}&mode=lod-compare&time=day`, lodFile, args.width, args.height, profileDir);
      shots.push({ file: lodFile, kind: 'lod-compare' });
    }

    const manifest = {
      family: args.family,
      capturedAt: new Date().toISOString(),
      totalVariants,
      shots,
    };
    writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`Captured ${shots.length} contact sheets to ${outDir}`);
    for (const s of shots) console.log(`  - ${s.file}`);
  } finally {
    vite.kill('SIGTERM');
    rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
