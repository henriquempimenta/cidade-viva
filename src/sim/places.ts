import type { Building } from './buildings';

export type PlaceCat = 'shop' | 'eat' | 'park' | 'gym' | 'bar' | 'church' | 'doctor' | 'culture' | 'beach' | 'tourism' | 'hotel' | 'stadium';

const CATS: Record<PlaceCat, (b: Building) => boolean> = {
  shop: (b) => b.kind === 'com' || b.kind === 'mall' || b.kind === 'souvenir',
  eat: (b) => b.kind === 'restaurant' || (b.kind === 'com' && b.level >= 2) || b.kind === 'mall',
  park: (b) => b.kind === 'park' || b.kind === 'plaza',
  gym: (b) => b.kind === 'sportsCenter' || b.kind === 'park',
  bar: (b) => b.kind === 'restaurant' || (b.kind === 'com' && b.level <= 2) || b.kind === 'hostel',
  church: (b) => b.kind === 'church' || b.kind === 'cathedral',
  doctor: (b) => b.kind === 'clinic' || b.kind === 'hospital',
  culture: (b) => b.kind === 'cinema' || b.kind === 'theater' || b.kind === 'museum' || b.kind === 'library' || b.kind === 'mall',
  beach: () => false,
  tourism: (b) => b.def.tourism > 0.2 || b.heritage || b.kind === 'park' || b.kind === 'plaza' || b.def.cat === 'landmark',
  hotel: (b) => b.kind === 'hotel' || b.kind === 'hostel',
  stadium: (b) => b.kind === 'stadium',
};

/** Spatial index of where people can go for each kind of activity. */
export class Places {
  private grids = new Map<PlaceCat, Map<number, Building[]>>();
  lists = new Map<PlaceCat, Building[]>();
  beachSpots: { x: number; z: number }[] = [];
  private C = 250;

  rebuild(buildings: Building[]) {
    this.grids.clear(); this.lists.clear();
    for (const cat of Object.keys(CATS) as PlaceCat[]) { this.grids.set(cat, new Map()); this.lists.set(cat, []); }
    for (const b of buildings) {
      if (b.state !== 'done' || b.abandoned) continue;
      for (const cat of Object.keys(CATS) as PlaceCat[]) {
        if (!CATS[cat](b)) continue;
        this.lists.get(cat)!.push(b);
        const k = Math.floor(b.x / this.C) * 4096 + Math.floor(b.z / this.C);
        const g = this.grids.get(cat)!;
        let a = g.get(k);
        if (!a) g.set(k, (a = []));
        a.push(b);
      }
    }
  }

  /** pick a place: nearby ones are more likely, but not always the nearest (variety) */
  pick(cat: PlaceCat, x: number, z: number, rnd: () => number, maxR = 2500): Building | null {
    const g = this.grids.get(cat);
    if (!g) return null;
    const cands: Building[] = [];
    for (let r = 1; r <= Math.ceil(maxR / this.C) && cands.length < 6; r += 2) {
      cands.length = 0;
      const ci = Math.floor(x / this.C), cj = Math.floor(z / this.C);
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
        const a = g.get(i * 4096 + j);
        if (a) for (const b of a) cands.push(b);
      }
    }
    if (!cands.length) {
      const all = this.lists.get(cat)!;
      return all.length ? all[Math.floor(rnd() * all.length)] : null;
    }
    let best: Building | null = null, bs = -Infinity;
    for (const b of cands) {
      const d = Math.hypot(b.x - x, b.z - z);
      const s = -d / 600 + rnd() * 1.2 + (b.def.tourism + b.level * 0.1);
      if (s > bs) { bs = s; best = b; }
    }
    return best;
  }
  has(cat: PlaceCat) { return (this.lists.get(cat)?.length ?? 0) > 0; }
}
