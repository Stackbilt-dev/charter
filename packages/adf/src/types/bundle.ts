/**
 * ADF Bundle Output — result shape from bundleModules().
 */

import type { AdfDocument } from './ast';
import type { Manifest } from './manifest';

export interface BundleResult {
  manifest: Manifest;
  resolvedModules: string[];
  mergedDocument: AdfDocument;
  tokenEstimate: number;
  tokenBudget: number | null;
  tokenUtilization: number | null;
  perModuleTokens: Record<string, number>;
  moduleBudgetOverruns: Array<{
    module: string;
    tokens: number;
    budget: number;
  }>;
  triggerMatches: Array<{
    module: string;
    trigger: string;
    matched: boolean;
    matchedKeywords: string[];
    loadReason: 'default' | 'trigger';
  }>;
  unmatchedModules: string[];
  advisoryOnlyModules: string[];
}
