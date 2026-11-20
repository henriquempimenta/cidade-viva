import { App } from './app';
import { DEFAULT_PARAMS, sanitizeParams, type SimParams } from './shared/params';

function paramsFromUrl(): SimParams {
  const raw: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(location.search).entries()) raw[k] = v;
  return sanitizeParams(raw, DEFAULT_PARAMS);
}

const app = new App(document.getElementById('c') as HTMLCanvasElement, document.getElementById('ui')!);
app.start(paramsFromUrl());
(window as unknown as { app: App }).app = app;
