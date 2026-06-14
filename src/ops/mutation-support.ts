// Shared building blocks for the mutating ops (rename / move / …) so the dry-run-apply
// contract is implemented once. Each piece wraps its external tool → never throws across the
// boundary (§3.6); the orchestration (which differs per op — content writes vs git mv) stays
// in the op / its apply helper.

import * as path from 'node:path';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import type { RepoRelPath } from '../core/brands.ts';
import { ok, fail } from '../common/result/construct.ts';
import { isOk } from '../common/result/narrow.ts';
import { gitStatus } from '../support/git/status.ts';
import { resolvePrettier, type ResolvedPrettier } from '../support/prettier/resolve.ts';
import { formatContent } from '../support/prettier/format.ts';
import type { TsDiagnostic } from '../plugins/ts/plugin.ts';

/** Repo-relative path → absolute (posix `/` → OS separators for the filesystem). */
export const absOf = (root: string, rel: RepoRelPath): string => path.join(root, ...rel.split('/'));

/** TS diagnostics → JSON rows for the result envelope. */
export function diagsToJson(ds: readonly TsDiagnostic[]): JsonValue[] {
  const out: JsonValue[] = [];
  for (const d of ds) out.push({ file: String(d.file), line: d.line, message: d.message });
  return out;
}

/** Format one file's content with the project prettier in-memory — so a dry-run preview is
 *  byte-identical to what apply writes (§16.4). A prettier failure keeps the unformatted
 *  (already type-checkable) content and is reported, never fatal. */
export async function formatOne(
  prettier: ResolvedPrettier,
  root: string,
  rel: RepoRelPath,
  content: string,
): Promise<{ content: string; note?: string }> {
  if (!prettier.available) return { content };
  const r = await formatContent(prettier.api, absOf(root, rel), content);
  if (r.ok && r.data !== null) return { content: r.data };
  if (!r.ok) return { content, note: `prettier could not format ${rel}: ${r.failure.message}` };
  return { content };
}

export { resolvePrettier };

/** Which of `touched` have uncommitted changes (the dirty-gate subset). Surfaces a git
 *  failure honestly rather than guessing the tree is clean. */
export async function dirtyAmong(
  root: string,
  touched: readonly RepoRelPath[],
): Promise<Result<RepoRelPath[]>> {
  const status = await gitStatus(root);
  if (!isOk(status)) return fail(status.failure);
  const dirtySet = new Set(status.data.dirtyPaths);
  return ok(touched.filter((p) => dirtySet.has(p)));
}
