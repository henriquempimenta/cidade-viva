import type { AssetBuildResult, AssetDetail } from '../render/meshKit';

export interface PedShowcaseConfig {
  skinColor: number;
  hairColor: number;
  bottomColor: number;
  /** Deterministic animation vector: [phase, strideAmp, mode (0=idle,1=walk,2=cyclist), umbrellaLift]. */
  anim?: [number, number, number, number];
  /** Optional companion asset rendered alongside the primary variant (e.g. bicycle beneath cyclist). */
  companion?: {
    build: (detail?: AssetDetail) => AssetBuildResult;
    color: number;
  };
}

export interface WorkbenchVariant {
  id: string;
  label: string;
  category: string;
  /** Default representative instanceColor hex. */
  defaultColor: number;
  /** Representative swatches (3–4 colors) used to verify aTint behavior in contact sheets. */
  swatches: number[];
  /** Build geometry at the requested detail level. */
  build: (detail?: AssetDetail) => AssetBuildResult;
  /** Multi-zone & vertex-shader pose config for `people` family assets. */
  pedShowcase?: PedShowcaseConfig;
}

export interface WorkbenchFamily {
  id: string;
  title: string;
  description: string;
  /** Recommended max triangle budget per variant (for automated audit warnings). */
  triangleBudget: number;
  /** Which variant IDs to include in automated per-variant hero contact sheets. */
  heroVariants?: string[];
  /** Optional variant IDs for automated LOD comparison sheets (high / med / low side-by-side). */
  lodCompareVariants?: string[];
  /** Optional HUD hint text describing real-time LOD distance thresholds in the city. */
  lodHint?: string;
  variants: () => WorkbenchVariant[];
}
