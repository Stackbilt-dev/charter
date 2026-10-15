/**
 * Required ADF manifest wiring.
 *
 * Single source of truth for which modules must be registered under
 * DEFAULT_LOAD in `.ai/manifest.adf`. `charter doctor` (adf required wiring)
 * and `charter bootstrap` (orphan registration) both classify modules through
 * this helper, so every command that places a module agrees with the check
 * that later audits the placement.
 *
 * The criterion is the module's manifest path alone: `core.adf` and
 * `state.adf` at the root of `.ai/` are always loaded. Module content is not
 * consulted — a module named anything else belongs in ON_DEMAND.
 */

/** Modules that must appear in DEFAULT_LOAD rather than ON_DEMAND. */
export const REQUIRED_DEFAULT_LOAD_MODULES: readonly string[] = ['core.adf', 'state.adf'];

const REQUIRED_REASONS: Record<string, string> = {
  'core.adf': 'core.adf holds the always-on project rules and identity',
  'state.adf': 'state.adf holds the live session state every agent reads first',
};

export interface DefaultLoadClassification {
  /** The normalized manifest path that was classified. */
  module: string;
  /** True when the module must be registered under DEFAULT_LOAD. */
  defaultLoad: boolean;
  /** Human-readable explanation, suitable for printing alongside the placement. */
  reason: string;
}

/** Normalize a manifest entry path: forward slashes, no leading `./`. */
function normalizeModulePath(modulePath: string): string {
  return modulePath.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
}

/**
 * Decide whether a module (by its path relative to `.ai/`, e.g. `core.adf`)
 * must be DEFAULT_LOAD, and say why.
 */
export function classifyModuleLoad(modulePath: string): DefaultLoadClassification {
  const module = normalizeModulePath(modulePath);
  const reason = REQUIRED_REASONS[module];
  if (reason !== undefined) {
    return { module, defaultLoad: true, reason: `${reason}; doctor requires it in DEFAULT_LOAD` };
  }
  return {
    module,
    defaultLoad: false,
    reason: `only ${REQUIRED_DEFAULT_LOAD_MODULES.join(' and ')} are required in DEFAULT_LOAD; ${module} can load ON_DEMAND`,
  };
}

/** True when the module must be registered under DEFAULT_LOAD. */
export function isRequiredDefaultLoad(modulePath: string): boolean {
  return classifyModuleLoad(modulePath).defaultLoad;
}

export interface MissingDefaultLoadModule {
  module: string;
  /** True when the module is registered, but under ON_DEMAND instead. */
  inOnDemand: boolean;
}

/** List the required DEFAULT_LOAD modules a parsed manifest lacks. */
export function findMissingDefaultLoad(manifest: {
  defaultLoad: readonly string[];
  onDemand: ReadonlyArray<{ path: string }>;
}): MissingDefaultLoadModule[] {
  const defaultLoad = new Set(manifest.defaultLoad.map(normalizeModulePath));
  const onDemand = new Set(manifest.onDemand.map(m => normalizeModulePath(m.path)));
  return REQUIRED_DEFAULT_LOAD_MODULES
    .filter(mod => !defaultLoad.has(mod))
    .map(mod => ({ module: mod, inOnDemand: onDemand.has(mod) }));
}

/** Doctor-style details line naming the fix for each missing module. */
export function formatMissingDefaultLoad(missing: readonly MissingDefaultLoadModule[]): string {
  const remedies = missing.map(({ module, inOnDemand }) => inOnDemand
    ? `move ${module} from ON_DEMAND to DEFAULT_LOAD in .ai/manifest.adf`
    : `add ${module} to DEFAULT_LOAD in .ai/manifest.adf (or run: charter adf create ${module} --load default)`);
  return `Missing from DEFAULT_LOAD: ${missing.map(m => m.module).join(', ')} — ${remedies.join('; ')}`;
}
