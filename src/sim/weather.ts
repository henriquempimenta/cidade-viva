import { Noise2D } from '../shared/rng';
import type { RNG } from '../shared/rng';

export class Weather {
  rain = 0; // 0..1
  fog = 0;
  snow = 0;
  wind = 0.6; // cells per update
  temperature = 22;
  storm = 0; // forced storm time left (s)
  private targetRain = 0;
  private noise: Noise2D;
  constructor(private rng: RNG, seed: number) { this.noise = new Noise2D(seed + 99); }

  label(): string {
    if (this.storm > 0) return 'Tempestade';
    if (this.snow > 0.3) return 'Neve';
    if (this.rain > 0.6) return 'Chuva forte';
    if (this.rain > 0.2) return 'Chuva';
    if (this.fog > 0.4) return 'Neblina';
    return this.rain > 0.05 ? 'Nublado' : 'Céu limpo';
  }

  update(dt: number, dayFrac: number, season: number, raininess: number, snowAllowed: boolean, t: number) {
    const seasonTemp = [21, 28, 19, 12][season];
    this.temperature = seasonTemp + Math.sin((dayFrac - 0.3) * Math.PI * 2) * 5 + this.noise.noise(t / 9000, 1) * 3;
    const seasonRain = [1, 1.4, 0.8, 0.6][season];
    const n = this.noise.noise(t / 5000, 4.2) * 0.5 + 0.5;
    this.targetRain = this.storm > 0 ? 1 : Math.max(0, (n - (1 - raininess * seasonRain * 0.9)) * 3);
    this.rain += (Math.min(1, this.targetRain) - this.rain) * Math.min(1, dt / 120);
    const morning = dayFrac > 0.18 && dayFrac < 0.36 ? 1 : 0;
    const fogN = this.noise.noise(t / 7000, 9.1);
    this.fog += ((morning && fogN > 0.1 ? 0.7 : season === 3 && fogN > 0.4 ? 0.5 : 0) - this.fog) * Math.min(1, dt / 200);
    const cold = snowAllowed && this.temperature < 8;
    this.snow += ((cold && this.rain > 0.2 ? 1 : 0) - this.snow) * Math.min(1, dt / 300);
    this.wind = 0.5 + (this.noise.noise(t / 4000, 7) * 0.5 + 0.5) * 0.7 + this.storm * 0 + (this.storm > 0 ? 0.8 : 0);
    if (this.storm > 0) this.storm -= dt;
  }
}
