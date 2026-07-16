// Resolve the prettier to format with — the project's OWN copy, and ONLY that. A different
// prettier emits a different style; formatting a repo with codemaster's bundled copy would
// reformat files the project never asked to touch (a project that deliberately doesn't run
// prettier would get every file restyled — a lie about "we kept your formatting"). So there
// is no bundled fallback: if the inspected repo doesn't ship prettier, we report
// `available: false` and the mutating ops write the (already type-checked) content
// unformatted. Resolution is BOUNDED to the inspected repo's own `node_modules/prettier` and
// never escapes upward into an ancestor / `NODE_PATH` / global copy (ARCHITECTURE.md §5-L1).

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

/** Hand-rolled surface of the prettier module we use — avoids an `@types/prettier` dep
 *  and pins exactly the methods our format path calls. */
export interface PrettierApi {
  readonly version: string;
  format(source: string, options?: PrettierOptions): Promise<string> | string;
  resolveConfig(filePath: string): Promise<PrettierOptions | null>;
  getFileInfo(
    filePath: string,
    options?: { resolveConfig?: boolean },
  ): Promise<{ ignored: boolean; inferredParser: string | null }>;
}

/** Prettier's open option bag — the per-file `filepath` is the only field we set. */
type PrettierOptions = Record<string, unknown> & { filepath?: string };

export type ResolvedPrettier =
  | { available: true; version: string; api: PrettierApi }
  | { available: false; reason: string };

/** Narrow an opaque module export to the prettier surface we rely on. */
function asPrettierApi(mod: unknown): PrettierApi | undefined {
  if (typeof mod !== 'object' || mod === null) return undefined;
  const m = mod as Record<string, unknown>;
  const ok =
    typeof m.format === 'function' &&
    typeof m.resolveConfig === 'function' &&
    typeof m.getFileInfo === 'function' &&
    typeof m.version === 'string';
  return ok ? (mod as PrettierApi) : undefined;
}

function loadProjectPrettier(projectRoot: string): PrettierApi | undefined {
  try {
    // Bound resolution to the inspected repo's OWN `node_modules/prettier`. We deliberately do
    // NOT resolve the bare `'prettier'` specifier: Node's bare-specifier lookup walks up the dir
    // tree AND falls back to `NODE_PATH` / global folders, so an ancestor / env-leaked / global
    // prettier outside the repo would satisfy it — restyling a repo that ships none (the §5-L1
    // lie). Instead: confirm the project's own copy exists, then load it via a relative `'.'`
    // require rooted at that package.json, which stays inside the package dir by construction
    // (no NODE_PATH / no ancestor escape). A monorepo is unaffected — its hoisted prettier lives
    // at `<inspected-root>/node_modules/prettier`, INSIDE the root callers pass.
    const pkg = path.join(projectRoot, 'node_modules', 'prettier', 'package.json');
    if (!existsSync(pkg)) return undefined;
    const req = createRequire(pkg);
    const mod: unknown = req('.');
    // Unwrap a `.default` (ESM-interop) wrapper — else a project prettier exposed under
    // `.default` would fail the surface check and read as not-available.
    return asPrettierApi(mod) ?? asPrettierApi((mod as { default?: unknown }).default);
  } catch {
    return undefined;
  }
}

/** Resolve prettier for `projectRoot`: the project's own copy if present, else an honest
 *  `available: false` (NO bundled fallback — see the file header). Never throws. */
export async function resolvePrettier(projectRoot: string): Promise<ResolvedPrettier> {
  const project = loadProjectPrettier(projectRoot);
  if (project) return { available: true, version: project.version, api: project };
  return { available: false, reason: 'the inspected project does not ship prettier' };
}
