// §3.6 disclosure for `list {registry}` when NO plugin owning the registry is active at the queried
// root (`available` is empty) yet the repo has NESTED PACKAGES (a dir with its own `package.json`).
// Framework plugins autodetect off a package.json (§10 `frameworkPlugins`), so a registry's owner may
// be active ONLY when one of those nested packages is itself the root — a bare `found=false /
// available(0)` at the outer root then reads as "the repo has none", the silent miss (§3.6). The
// signal is the nested-PACKAGE set, not the undiscovered-tsconfig set: loading a nested package's TS
// program does NOT activate its framework plugins (activation is a per-root package.json autodetect),
// and a nested tsconfig WITHOUT a package.json can activate nothing — so only a package.json dir is a
// candidate `root:<dir>`. Plugin-NEUTRAL: keyed on the REQUESTED registry (components / routes /
// queries / stores alike), never hard-coded to react. We deliberately do NOT filter to packages whose
// package.json declares the specific activating dependency (that registry→dep map lives in the daemon
// layer, above `ops/`): an over-hint ("try root:<dir>" on a package that turns out not to own it) is
// far cheaper than a silent miss (§3.6), so when in doubt we disclose wider.

import type { PluginRegistry } from '../core/plugin.ts';
import { nameWithMore } from '../common/truncate/name-with-more.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';

const MAX_NAMED = 3;

/** The directory a nested package config lives in (`web/tsconfig.json` → `web`) — the actionable
 *  `root:<dir>` an agent re-runs with; a root-level `tsconfig.json` yields `.`. */
function configDir(label: string): string {
  const slash = label.lastIndexOf('/');
  return slash === -1 ? '.' : label.slice(0, slash);
}

/** Build the disclosure, or `undefined` to stay silent. `undefined` when the repo has no nested
 *  package (no false hint — the answer stays byte-identical), when `ts` is absent, or when the label
 *  read faults (a fault must NOT sink a `found=false` answer — degrade to no disclosure, never a
 *  crash, §3.6). The caller gates on `available.length === 0` (no owning plugin at all); a non-empty
 *  `available` is a did-you-mean case, not this silent miss. */
export function inactiveRegistryDisclosure(
  plugins: PluginRegistry,
  registry: string,
): string | undefined {
  if (!plugins.has('ts')) return undefined;
  let labels: readonly string[];
  try {
    labels = plugins.get<TsPluginApi>('ts').nestedPackageLabels();
  } catch {
    return undefined;
  }
  if (labels.length === 0) return undefined;
  const dirs = [...new Set(labels.map(configDir))];
  // `root:` takes ONE dir — so a single `root:<dir>` when there's one candidate, else name the choices
  // ("root: at one of: …") rather than emit `root:<a, b>` which reads as an (invalid) multi-dir arg.
  const remedy =
    dirs.length === 1
      ? `root:<${dirs[0]}>`
      : `root: at one of: ${dirs.slice(0, MAX_NAMED).join(', ')}`;
  return `!! no plugin owning registry '${registry}' is active at this root — a framework plugin (autodetected off each package's OWN package.json) may own it only inside a nested package: ${dirs.length} nested package(s) (${nameWithMore(dirs, MAX_NAMED)}). Re-run with ${remedy} to activate that package's plugins. This is NOT proof the repo has no '${registry}'.`;
}
