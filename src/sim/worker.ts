/// <reference lib="webworker" />
import { MOTION_DT } from '../shared/constants';
import type { FromWorker, ToWorker } from '../shared/protocol';
import { World } from './world';
import { SimHost } from './host';

declare const self: DedicatedWorkerGlobalScope;

let host: SimHost | null = null;

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  if (m.type === 'init') {
    host?.stop();
    const world = new World(m.params);
    host = new SimHost(world, post);
    post({ type: 'init', world: world.initMessage() }, []);
    host.start();
    return;
  }
  host?.handle(m);
};

export { MOTION_DT };
