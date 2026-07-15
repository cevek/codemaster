// `installedDependencies` — the set of dependency names declared in a repo's
// `package.json` (`dependencies` + `devDependencies` + `peerDependencies` +
// `optionalDependencies`). The composition root uses it to AUTODETECT which framework
// plugins to load (a plugin is enabled iff its npm dep is present, §10) — `react`,
// `react-query` (`@tanstack/react-query`), `zustand`, … all share this one reader.
//
// A thin projection over `manifestOf` (./manifest) — ONE parser for the four dep sections,
// shared with the phantom-deps join. Best-effort and honest (§3.6): a missing / unreadable /
// malformed `package.json` yields an EMPTY set, never a throw.

import { manifestOf } from './manifest.ts';

/** Names of every dependency declared in `<root>/package.json`. Empty on any read/parse
 *  failure (autodetection then loads no framework plugin — config can still force-enable). */
export function installedDependencies(root: string): ReadonlySet<string> {
  return manifestOf(root).deps;
}
