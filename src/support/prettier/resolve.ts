// Resolve the prettier to format with. The project's OWN prettier comes first — a
// different version emits a different style and would fight the repo's lint setup (a kind
// of lie about "we kept your formatting"); codemaster's bundled copy is the fallback only,
// and which one is active is always reported (ARCHITECTURE.md §5-L1). The project copy is
// loaded with `createRequire` rooted at the project (so its `node_modules` wins); the
// bundled copy via a lazy `import('prettier')`, so a read-only session never pays for it.

import { createRequire } from 'node:module';
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
  | { available: true; source: 'project' | 'bundled'; version: string; api: PrettierApi }
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
    const req = createRequire(path.join(projectRoot, 'package.json'));
    const mod: unknown = req('prettier');
    // Unwrap a `.default` (ESM-interop) wrapper, same as the bundled path — else a project
    // prettier exposed under `.default` silently falls through to the bundled copy and is
    // mis-reported as `source: 'bundled'`.
    return asPrettierApi(mod) ?? asPrettierApi((mod as { default?: unknown }).default);
  } catch {
    return undefined;
  }
}

async function loadBundledPrettier(): Promise<PrettierApi | undefined> {
  try {
    const mod: unknown = await import('prettier');
    return asPrettierApi(mod) ?? asPrettierApi((mod as { default?: unknown }).default);
  } catch {
    return undefined;
  }
}

/** Resolve prettier for `projectRoot`: the project's own copy if present, else codemaster's
 *  bundled fallback, else an honest `available: false`. Never throws. */
export async function resolvePrettier(projectRoot: string): Promise<ResolvedPrettier> {
  const project = loadProjectPrettier(projectRoot);
  if (project)
    return { available: true, source: 'project', version: project.version, api: project };
  const bundled = await loadBundledPrettier();
  if (bundled)
    return { available: true, source: 'bundled', version: bundled.version, api: bundled };
  return { available: false, reason: 'prettier not resolvable from the project or the bundle' };
}
