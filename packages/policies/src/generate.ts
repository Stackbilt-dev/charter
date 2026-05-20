import type { RepoConfig } from './detect';

export function generateCallerWorkflow(config: RepoConfig, policyRepoRef: string): string {
  return `name: Supply Chain

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  sbom:
    uses: Stackbilt-dev/stackbilt_llc/.github/workflows/supply-chain-sbom.yml@${policyRepoRef}
    with:
      node-version: '${config.nodeVersion}'
      package-manager: '${config.packageManager}'
    secrets: inherit

  dep-review:
    if: github.event_name == 'pull_request'
    uses: Stackbilt-dev/stackbilt_llc/.github/workflows/supply-chain-dep-review.yml@${policyRepoRef}
`;
}

// The canonical floating-action-pins drift pattern, embedded so stamp-policies
// can install it into target repos without requiring stackbilt_llc to be present locally.
export const FLOATING_PIN_PATTERN = {
  id: 'floating-action-pins',
  name: 'Floating Action Pins',
  category: 'SECURITY',
  status: 'ACTIVE',
  anti_patterns: 'uses: (?!Stackbilt-dev/)(?!\\./)[^\\s@]+@(?![0-9a-f]{40}(\\s|$|#))[^\\s]',
  blessed_solution:
    'Pin to full commit SHA with a # vX.Y.Z comment: uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4',
  rationale:
    'Any non-SHA ref (@vN, @main, @master, semver tags) is mutable — only a 40-char hex SHA is immutable.',
  created_at: '2026-05-20T00:00:00.000Z',
} as const;

// Minimal charter config patch for enabling YAML drift in a target repo.
// Merges into the existing config or creates a new one.
export function generateCharterConfigPatch(existing: Record<string, unknown> | null): Record<string, unknown> {
  const base = existing ?? {};
  const existingDrift = (base.drift as Record<string, unknown> | undefined) ?? {};
  const existingInclude = (existingDrift.include as string[] | undefined) ?? [];

  const yamlGlob = '.github/workflows/*.yml';
  const include = existingInclude.includes(yamlGlob)
    ? existingInclude
    : [...existingInclude, yamlGlob];

  return {
    ...base,
    drift: {
      ...existingDrift,
      enabled: true,
      include,
    },
  };
}
