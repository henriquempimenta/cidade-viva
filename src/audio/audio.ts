import * as THREE from 'three';
import type { App } from '../app';
import type { SimEvent } from '../shared/protocol';
import { VEH_FLAG_SIREN, VEH_STRIDE, TRAIN_STRIDE, VType } from '../shared/constants';

/** Fully procedural ambience + adaptive music (Web Audio, no assets). */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private layers: Record<string, GainNode> = {};
  private trafficPan: StereoPannerNode | null = null;
  private sirenPan: StereoPannerNode | null = null;
  private siren!: OscillatorNode;
  private sirenGain!: GainNode;
  private musicGain!: GainNode;
  private musicFilter!: BiquadFilterNode;
  private voices: OscillatorNode[] = [];
  private tmpRight = new THREE.Vector3();
  private tmpFwd = new THREE.Vector3();
  private tmpUp = new THREE.Vector3(0, 1, 0);
  private intensity = 0;
  private chordIdx = 0;
  private nextChord = 0;
  private nextBird = 0;
  private nextHammer = 0;
  private nextHorn = 0;
  enabled = false;

  toggle(): boolean {
    if (!this.ctx) this.init();
    this.enabled = !this.enabled;
    if (this.ctx!.state === 'suspended') this.ctx!.resume();
    this.master.gain.setTargetAtTime(this.enabled ? 0.8 : 0, this.ctx!.currentTime, 0.3);
    return this.enabled;
  }

  private noise(color: 'white' | 'pink' | 'brown'): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (color === 'white') d[i] = w;
      else if (color === 'pink') { b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.032; b2 = 0.95 * b2 + w * 0.048; d[i] = (b0 + b1 + b2) * 2; }
      else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    return src;
  }

  private layer(name: string, color: 'white' | 'pink' | 'brown', type: BiquadFilterType, freq: number, q = 0.7, panner?: StereoPannerNode | null) {
    const ctx = this.ctx!;
    const src = this.noise(color);
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    if (panner) src.connect(f).connect(g).connect(panner).connect(this.master);
    else src.connect(f).connect(g).connect(this.master);
    src.start();
    this.layers[name] = g;
  }

  private init() {
    const ctx = (this.ctx = new AudioContext());
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);
    this.trafficPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    this.sirenPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    this.layer('traffic', 'brown', 'lowpass', 380, 0.7, this.trafficPan);
    this.layer('wind', 'pink', 'bandpass', 600, 0.4);
    this.layer('waves', 'pink', 'lowpass', 900);
    this.layer('rain', 'white', 'highpass', 2500);
    this.layer('rumble', 'brown', 'lowpass', 120);
    // siren
    this.siren = ctx.createOscillator();
    this.siren.type = 'triangle';
    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;
    if (this.sirenPan) this.siren.connect(this.sirenGain).connect(this.sirenPan).connect(this.master);
    else this.siren.connect(this.sirenGain).connect(this.master);
    this.siren.start();
    // music: soft pad of detuned saws through a lowpass
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 700;
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0.05;
    this.musicFilter.connect(this.musicGain).connect(this.master);
    for (let i = 0; i < 6; i++) {
      const o = ctx.createOscillator();
      o.type = i % 2 ? 'sawtooth' : 'triangle';
      o.detune.value = (i - 3) * 6;
      const g = ctx.createGain();
      g.gain.value = 0.12;
      o.connect(g).connect(this.musicFilter);
      o.start();
      this.voices.push(o);
    }
  }

  private chirp(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', slide = 1.6) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    const t = ctx.currentTime;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }
  private knock(gain: number) {
    const ctx = this.ctx!;
    const src = this.noise('white');
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 900 + Math.random() * 600; f.Q.value = 3;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    src.connect(f).connect(g).connect(this.master);
    src.start(t); src.stop(t + 0.15);
  }

  onEvent(e: SimEvent) {
    if (!this.enabled) return;
    const boost: Record<string, number> = { era: 1, fire: 0.6, festival: 0.8, fireworks: 0.9, landmark: 0.9, flood: 0.7, storm: 0.7, police_chase: 0.6, line_opened: 0.5, station: 0.5 };
    if (boost[e.type]) this.intensity = Math.min(1, this.intensity + boost[e.type]);
    if (e.type === 'fireworks') for (let i = 0; i < 6; i++) setTimeout(() => this.knock(0.5), i * 300 + Math.random() * 200);
  }

  update(cam: THREE.Vector3, app: App) {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const paused = app.speed <= 0;
    const timelapse = app.speed >= 100;
    const snap = app.curSnap;
    const h = Math.max(1, cam.y - Math.max(0, app.terrain.heightAt(cam.x, cam.z)));
    const near = Math.max(0, 1 - h / 600);
    // camera right vector on XZ plane for stereo panning
    app.rig.camera.getWorldDirection(this.tmpFwd);
    this.tmpRight.crossVectors(this.tmpFwd, this.tmpUp).normalize();
    const rx = this.tmpRight.x, rz = this.tmpRight.z;
    let veh = 0, panNum = 0, panDen = 0, sirenD = Infinity, sirenPanV = 0, slow = 0;
    if (snap && !paused) {
      for (let i = 0; i < snap.veh.length; i += VEH_STRIDE) {
        const ty = snap.veh[i + 4];
        if (!ty) continue;
        const dx = snap.veh[i] - cam.x, dz = snap.veh[i + 2] - cam.z;
        const d = Math.hypot(dx, snap.veh[i + 1] - cam.y, dz);
        if (d < 250) {
          // weight by vehicle acoustic class (heavy > moto > light), aligned with sim acoustics
          const w = ty === VType.Moto ? 1.75 : ty === VType.Truck || ty === VType.Bus || ty === VType.TourBus || ty === VType.SchoolBus || ty === VType.Fire || ty === VType.Garbage || ty === VType.Construction ? 2.7 : 1;
          const contrib = (1 - d / 250) * w;
          veh += contrib;
          const hd = Math.hypot(dx, dz) || 1;
          panNum += ((dx * rx + dz * rz) / hd) * contrib;
          panDen += contrib;
          if (snap.veh[i + 6] & 4) slow++;
        }
        if (snap.veh[i + 6] & VEH_FLAG_SIREN && d < sirenD) {
          sirenD = d;
          const hd = Math.hypot(dx, dz) || 1;
          sirenPanV = Math.max(-1, Math.min(1, (dx * rx + dz * rz) / hd));
        }
      }
    }
    let trainD = Infinity;
    if (snap && !paused) for (let i = 0; i < snap.trainCount; i++) { const o = i * TRAIN_STRIDE; trainD = Math.min(trainD, Math.hypot(snap.train[o] - cam.x, snap.train[o + 2] - cam.z)); }
    const night = app.rig.night;
    const rain = app.stats?.rain ?? 0;
    const waterNear = this.waterNear(app, cam);
    const set = (k: string, v: number) => this.layers[k].gain.setTargetAtTime(v, t, 0.35);
    const motionGain = paused ? 0 : timelapse ? 0.45 : 1;
    set('traffic', paused ? 0 : (Math.min(0.6, veh * 0.04) * (0.3 + near) + 0.015 * (1 - night * 0.5)) * motionGain);
    if (this.trafficPan) this.trafficPan.pan.setTargetAtTime(panDen > 0.01 ? Math.max(-0.85, Math.min(0.85, panNum / panDen)) : 0, t, 0.25);
    set('wind', paused ? 0.015 : 0.03 + (1 - near) * 0.12 + (app.stats?.weather === 'Tempestade' ? 0.2 : 0));
    set('waves', paused ? 0 : waterNear * 0.25 * (0.4 + near));
    set('rain', paused ? 0 : rain * 0.25);
    set('rumble', !paused && trainD < 400 ? (1 - trainD / 400) * 0.5 * motionGain : 0);
    // siren: classic two-tone wail (muted in pause and suppressed in high-speed time-lapse)
    const sv = !paused && !timelapse && sirenD < 350 ? (1 - sirenD / 350) * 0.12 : 0;
    this.sirenGain.gain.setTargetAtTime(sv, t, 0.2);
    if (this.sirenPan) this.sirenPan.pan.setTargetAtTime(sirenPanV, t, 0.15);
    this.siren.frequency.setTargetAtTime(Math.sin(t * 3) > 0 ? 960 : 700, t, 0.05);
    // birds by day near the ground, horns in jams, hammers near works, train horns (paused/time-lapse quiet)
    if (!paused && !timelapse && t > this.nextBird) {
      this.nextBird = t + 0.4 + Math.random() * 2.5;
      if (night < 0.5 && near > 0.3 && rain < 0.3) { const f = 2200 + Math.random() * 2500; this.chirp(f, 0.08 + Math.random() * 0.1, 0.05 * near); if (Math.random() < 0.5) setTimeout(() => this.chirp(f * 1.1, 0.07, 0.04 * near), 120); }
    }
    if (!paused && !timelapse && t > this.nextHorn) {
      this.nextHorn = t + 1 + Math.random() * 6;
      if (slow > 6 && near > 0.4) this.chirp(420 + Math.random() * 80, 0.35, 0.05, 'square', 1);
      if (trainD < 300 && Math.random() < 0.3) { this.chirp(330, 1.1, 0.08, 'sawtooth', 1); this.chirp(415, 1.1, 0.06, 'sawtooth', 1); }
    }
    if (!paused && !timelapse && t > this.nextHammer) {
      this.nextHammer = t + 0.25 + Math.random() * 0.6;
      const works = app.buildings.all().some((b) => b.state !== 'done' && Math.hypot(b.x - cam.x, b.z - cam.z) < 160);
      if (works && near > 0.3) this.knock(0.15 * near);
    }
    // adaptive music: slow chord changes, brighter & louder when something happens
    this.intensity *= 0.995;
    if (t > this.nextChord) {
      const prog = [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 60], [55, 59, 62, 67]];
      const ch = prog[this.chordIdx++ % prog.length];
      this.voices.forEach((o, i) => o.frequency.setTargetAtTime(440 * Math.pow(2, (ch[i % 4] + (i >= 4 ? 12 : 0) - 69) / 12), t, 0.8));
      this.nextChord = t + 6 - this.intensity * 3;
      if (this.intensity > 0.3) this.chirp(440 * Math.pow(2, (ch[Math.floor(Math.random() * 4)] + 12 - 69) / 12), 0.6, 0.04 * this.intensity, 'triangle', 1);
    }
    this.musicFilter.frequency.setTargetAtTime(500 + this.intensity * 2200 + (1 - night) * 300, t, 1);
    this.musicGain.gain.setTargetAtTime(0.035 + this.intensity * 0.05, t, 1);
  }

  private wnCache = { x: 0, z: 0, v: 0 };
  private waterNear(app: App, cam: THREE.Vector3): number {
    if (Math.hypot(cam.x - this.wnCache.x, cam.z - this.wnCache.z) < 30) return this.wnCache.v;
    let n = 0;
    for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; if (app.terrain.heightAt(cam.x + Math.cos(a) * 120, cam.z + Math.sin(a) * 120) < 0) n++; }
    this.wnCache = { x: cam.x, z: cam.z, v: n / 12 };
    return n / 12;
  }
}
