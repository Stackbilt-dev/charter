/**
 * ADF Manifest — module routing, sync, cadence, and metric source types.
 */

export interface Manifest {
  version: '0.1';
  role?: string;
  defaultLoad: string[];
  onDemand: ManifestModule[];
  rules: string[];
  tokenBudget?: number;
  sync: SyncEntry[];
  cadence: CadenceEntry[];
  metrics: MetricSource[];
  /**
   * Raw VENDORS list items (#318). Permissive: strings only, with no knowledge
   * of vendor file names or which modes a file allows. The CLI validates them.
   */
  vendors: ManifestVendorEntry[];
}

/**
 * One VENDORS list item, e.g. `CLAUDE.md: pointer`. `file` and `mode` are null
 * when the item does not have the `<file>: <pointer|compiled|unmanaged>` shape.
 */
export interface ManifestVendorEntry {
  raw: string;
  file: string | null;
  mode: string | null;
}

export interface SyncEntry {
  source: string;
  target: string;
}

export interface ManifestModule {
  path: string;
  triggers: string[];
  loadPolicy: 'DEFAULT' | 'ON_DEMAND';
  tokenBudget?: number;
}

export interface CadenceEntry {
  check: string;
  frequency: string;
}

export interface MetricSource {
  key: string;
  path: string;
}
