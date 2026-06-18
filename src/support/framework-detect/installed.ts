// `installedDependencies` — the set of dependency names declared in a repo's
// `package.json` (`dependencies` + `devDependencies` + `peerDependencies` +
// `optionalDependencies`). The composition root uses it to AUTODETECT which framework
// plugins to load (a plugin is enabled iff its npm dep is present, §10) — `react`,
// `react-query` (`@tanstack/react-query`), `zustand`, … all share this one reader.
//
// Best-effort and honest (§3.6): a missing / unreadable / malformed `package.json` yields
// an EMPTY set (no framework autodetected), never a throw — autodetection that crashes the
// daemon would be worse than one that simply detects nothing.

import { readTextOrAbsent } from '../fs/read-or-absent.ts';

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** Names of every dependency declared in `<root>/package.json`. Empty on any read/parse
 *  failure (autodetection then loads no framework plugin — config can still force-enable). */
export function installedDependencies(root: string): ReadonlySet<string> {
  const names = new Set<string>();
  const outcome = readTextOrAbsent(root, 'package.json');
  if (outcome.kind !== 'text') return names;
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.text);
  } catch {
    return names; // malformed package.json — detect nothing, never crash.
  }
  if (typeof parsed !== 'object' || parsed === null) return names;
  const pkg = parsed as Record<string, unknown>;
  for (const field of DEP_FIELDS) {
    const section = pkg[field];
    if (typeof section === 'object' && section !== null) {
      for (const name of Object.keys(section)) names.add(name);
    }
  }
  return names;
}
