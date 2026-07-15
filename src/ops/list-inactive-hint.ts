// §3.6 disclosure for `list {registry}` when NO plugin owning the registry is active at the queried
// root (`available` is empty) yet nested tsconfig(s) exist that codemaster did NOT load as programs.
// Framework plugins gate on the ROOT `package.json`, so a registry's owner may be active ONLY inside
// an unindexed nested package — and a bare `found=false / available(0)` then reads as "the repo has
// none", the silent miss (§3.6). Plugin-NEUTRAL: keyed on the REQUESTED registry + the named nested
// configs, so it serves components / routes / queries / stores alike (the generic `list` dispatcher),
// never hard-coded to react. Sibling of the symbol-addressed `undiscoveredHint` / `definitionFloor`.

import type { PluginRegistry } from '../core/plugin.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';

const MAX_NAMED = 3;

/** The directory a nested tsconfig lives in (`web/tsconfig.json` → `web`) — the actionable
 *  `root:<dir>` an agent re-runs with; a root-level `tsconfig.json` yields `.`. */
function configDir(label: string): string {
  const slash = label.lastIndexOf('/');
  return slash === -1 ? '.' : label.slice(0, slash);
}

/** Build the disclosure, or `undefined` to stay silent. `undefined` when nothing is unloaded (no
 *  false hint — the answer stays byte-identical), when `ts` is absent, or when the label read faults
 *  (an LS-warm fault must NOT sink a `found=false` answer — degrade to no disclosure, never a crash,
 *  §3.6). The caller gates on `available.length === 0` (no owning plugin at all); a non-empty
 *  `available` is a did-you-mean case, not this silent miss. */
export function inactiveRegistryDisclosure(
  plugins: PluginRegistry,
  registry: string,
): string | undefined {
  if (!plugins.has('ts')) return undefined;
  let labels: readonly string[];
  try {
    labels = plugins.get<TsPluginApi>('ts').undiscoveredProgramLabels();
  } catch {
    return undefined;
  }
  if (labels.length === 0) return undefined;
  const named = labels.slice(0, MAX_NAMED).join(', ');
  const more = labels.length > MAX_NAMED ? `, +${labels.length - MAX_NAMED} more` : '';
  const dirs = [...new Set(labels.slice(0, MAX_NAMED).map(configDir))].join(', ');
  return `!! no plugin owning registry '${registry}' is active at this root — a framework plugin (autodetected off the ROOT package.json) may be active ONLY in an unindexed nested package: ${labels.length} repo tsconfig(s) NOT loaded as programs (${named}${more}). Re-run with root:<${dirs}> to index it. This is NOT proof the repo has no '${registry}'.`;
}
