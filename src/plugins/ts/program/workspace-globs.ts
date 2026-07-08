// The repo's declared workspace-member globs — the THIRD tsconfig-discovery source (spec Task G /
// dogfood-jul Ask 1). A pnpm/vite/yarn monorepo wires its packages by workspace GLOBS
// (`packages/*`, `apps/*`), NOT by tsconfig `references`, so member configs are neither adjacent to
// the primary nor referenced → today they read as UNDISCOVERED and every cross-package query is
// floored. This reads the two standard declarations so `discoverSiblingConfigs` can load member
// configs as independent programs.
//
// Two sources, both plain data files (never a boundary that trusts external types — but read
// best-effort, so a missing/malformed manifest yields NO globs rather than throwing, mirroring
// `referencePaths`' malformed-config handling in ./discover):
//   1. `pnpm-workspace.yaml` — a top-level `packages:` string list;
//   2. `package.json` `workspaces` — an array, or the yarn `{ packages: [...] }` object form.
// A `!`-prefixed entry is an EXCLUSION (both ecosystems honor it), split into `negative`.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface WorkspaceGlobs {
  /** Member-dir globs (repo-relative posix, no leading `./`). */
  positive: string[];
  /** Exclusion globs (`!`-prefixed entries, `!` stripped). */
  negative: string[];
}

/** Read the repo's workspace-member globs from `pnpm-workspace.yaml` + `package.json`. Best-effort:
 *  any read/parse failure contributes no globs (never throws). Called ONCE per host structural
 *  reindex from the memoized `discoverSiblingConfigs`, never per query (§19). */
export function readWorkspaceGlobs(root: string): WorkspaceGlobs {
  const raw = [...pnpmPackages(root), ...packageJsonWorkspaces(root)];
  const positive: string[] = [];
  const negative: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    const negated = entry.startsWith('!');
    const glob = normalizeGlob(negated ? entry.slice(1) : entry);
    if (glob.length === 0) continue;
    (negated ? negative : positive).push(glob);
  }
  return { positive, negative };
}

/** Strip a leading `./` and any trailing slash so a member-DIR glob compares cleanly against a
 *  repo-relative dirname — picomatch treats a leading `./` or a trailing slash as distinct. */
function normalizeGlob(glob: string): string {
  let g = glob.trim();
  if (g.startsWith('./')) g = g.slice(2);
  while (g.endsWith('/')) g = g.slice(0, -1);
  return g;
}

/** `packages:` from `pnpm-workspace.yaml` — a string list, else nothing. */
function pnpmPackages(root: string): string[] {
  const parsed = readAndParse(path.join(root, 'pnpm-workspace.yaml'), (text) => parseYaml(text));
  return stringList((parsed as { packages?: unknown } | undefined)?.packages);
}

/** `workspaces` from `package.json` — an array, or the yarn `{ packages: [...] }` object form. */
function packageJsonWorkspaces(root: string): string[] {
  const parsed = readAndParse(
    path.join(root, 'package.json'),
    (text) => JSON.parse(text) as unknown,
  );
  const ws = (parsed as { workspaces?: unknown } | undefined)?.workspaces;
  if (Array.isArray(ws)) return stringList(ws);
  return stringList((ws as { packages?: unknown } | undefined)?.packages);
}

/** Read a file and run `parse`; any failure (missing file, malformed content) → `undefined`. */
function readAndParse(file: string, parse: (text: string) => unknown): unknown {
  try {
    return parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Coerce a value to a string array, dropping non-strings; a non-array yields `[]`. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}
