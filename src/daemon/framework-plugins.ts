// Framework-plugin AUTODETECTION (§10) — the shared composition step both the CLI entry
// (`bin.ts`) and the test harness (`test/helpers/project.ts`) use, so tests exercise the
// SAME enable rule the daemon runs. A framework plugin is loaded iff its npm dependency is
// present in the repo's `package.json` (`installedDependencies`) OR `config.plugins` names
// it (a force-enable for a dep autodetect missed). Each framework adds ONE entry to
// `FRAMEWORK_PLUGINS` — the mechanism is shared, the per-plugin wiring additive.

import type { Plugin } from '../core/plugin.ts';
import type { CodemasterConfig } from '../config/config.ts';
import { installedDependencies } from '../support/framework-detect/installed.ts';
import { createReactPlugin } from '../plugins/react/plugin.ts';

/** A framework plugin + the npm dependency that autodetects it. */
interface FrameworkSpec {
  readonly dep: string;
  readonly create: () => Plugin;
}

const FRAMEWORK_PLUGINS: Record<string, FrameworkSpec> = {
  react: { dep: 'react', create: () => createReactPlugin() },
  // 'react-query': { dep: '@tanstack/react-query', create: () => createReactQueryPlugin() },
};

/** The framework plugins to load for `root`: dep-present OR config-named. */
export function frameworkPlugins(config: CodemasterConfig, root: string): readonly Plugin[] {
  const installed = installedDependencies(root);
  const configured = new Set((config.plugins ?? []).map((p) => (typeof p === 'string' ? p : p.id)));
  const out: Plugin[] = [];
  for (const [id, spec] of Object.entries(FRAMEWORK_PLUGINS)) {
    if (installed.has(spec.dep) || configured.has(id)) out.push(spec.create());
  }
  return out;
}
