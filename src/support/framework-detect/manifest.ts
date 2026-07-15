// Read a `package.json`'s `name` + the union of its declared dependency names — the manifest facts
// the `find_phantom_deps` join needs per importer package (name → self-import exclusion; deps →
// declared-vs-phantom diff). Shares its dependency-field reading with `installedDependencies` (the
// framework autodetect, `installed.ts`), which delegates here so there is ONE parser for the four
// dep sections. Best-effort + honest (§3.6): a missing / unreadable / malformed `package.json` yields
// `{ name: undefined, deps: <empty> }`, never a throw.

import * as path from 'node:path';
import { readTextOrAbsent } from '../fs/read-or-absent.ts';

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

export interface PackageManifest {
  /** The package's own `name`, or `undefined` when absent/unreadable. */
  name: string | undefined;
  /** Every dependency name across the four dep sections. */
  deps: ReadonlySet<string>;
}

/** Parse `<absDir>/package.json`. `absDir` is an absolute directory; the read is done relative to it
 *  via `readTextOrAbsent(absDir, 'package.json')`. Never throws. */
export function manifestOf(absDir: string): PackageManifest {
  const deps = new Set<string>();
  const outcome = readTextOrAbsent(absDir, 'package.json');
  if (outcome.kind !== 'text') return { name: undefined, deps };
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.text);
  } catch {
    return { name: undefined, deps };
  }
  if (typeof parsed !== 'object' || parsed === null) return { name: undefined, deps };
  const pkg = parsed as Record<string, unknown>;
  for (const field of DEP_FIELDS) {
    const section = pkg[field];
    if (typeof section === 'object' && section !== null) {
      for (const name of Object.keys(section)) deps.add(name);
    }
  }
  return { name: typeof pkg['name'] === 'string' ? pkg['name'] : undefined, deps };
}

/** The nearest `package.json` at or above `absDir` (walking up to `root` inclusive), or `undefined`
 *  when none exists in that chain. The unit the phantom-deps join governs an importer by: a file's
 *  OWN package is the nearest enclosing manifest, so a root file and a nested-package file are handled
 *  uniformly. Bounded by path depth. */
export function nearestManifestDir(absFile: string, root: string): string | undefined {
  let dir = path.dirname(absFile);
  const rootNorm = path.resolve(root);
  for (;;) {
    if (readTextOrAbsent(dir, 'package.json').kind === 'text') return dir;
    if (path.resolve(dir) === rootNorm) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
