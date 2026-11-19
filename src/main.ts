import { App } from './app';
import { DEFAULT_PARAMS, type SimParams } from './shared/params';

function paramsFromUrl(): SimParams {
  const p = { ...DEFAULT_PARAMS };
  const q = new URLSearchParams(location.search);
  for (const [k, v] of q.entries()) {
    if (!(k in p)) continue;
    const cur = (p as unknown as Record<string, unknown>)[k];
    (p as unknown as Record<string, unknown>)[k] = typeof cur === 'number' ? Number(v) : typeof cur === 'boolean' ? v === '1' || v === 'true' : v;
  }
  return p;
}

const app = new App(document.getElementById('c') as HTMLCanvasElement, document.getElementById('ui')!);
app.start(paramsFromUrl());
(window as unknown as { app: App }).app = app;
