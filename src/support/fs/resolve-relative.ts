// The single relative-specifier resolver shared by every cross-tier path link (a TS file's
// `import s from './x.module.scss'` and a stylesheet's `composes: y from './other'`). One copy
// so the TS plugin and the scss plugin can never disagree on which provider a relative specifier
// names — a disagreement would let one tier prove a class dead that the other still reaches
// (the §3 lie this resolver guards against). Relative-only: an aliased (`@/…`) or bare specifier
// returns `undefined` (Phase-3 module-resolve territory), and the caller treats that
// conservatively rather than guessing a provider. Pure path-string math, no filesystem access —
// the caller checks existence against its own index.

import * as path from 'node:path';
import type { RepoRelPath } from '../../core/brands.ts';

/** Resolve a relative specifier (`./x`, `../y`) against the importer's repo-relative path to the
 *  target's repo-relative path; `undefined` for a non-relative (aliased / bare) specifier. */
export function resolveRelativeSpecifier(
  fromRel: RepoRelPath,
  spec: string,
): RepoRelPath | undefined {
  if (!spec.startsWith('.')) return undefined;
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec)) as RepoRelPath;
}
