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
