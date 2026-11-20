import type { AssetBuildResult, AssetDetail } from '../render/meshKit';

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
}

export interface WorkbenchFamily {
  id: string;
  title: string;
  description: string;
  /** Recommended max triangle budget per variant (for automated audit warnings). */
  triangleBudget: number;
  /** Which variant IDs to include in automated per-variant hero contact sheets. */
  heroVariants?: string[];
  variants: () => WorkbenchVariant[];
}
