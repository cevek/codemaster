// The repo's declared workspace-EXCLUSION globs — the negative (`!`-prefixed) entries of
// `pnpm-workspace.yaml` / `package.json` `workspaces` (spec Task G / dogfood-jul Ask 1 / t-865312).
// Package discovery (`packageConfigs`, ./discover) anchors on a dir holding its OWN `package.json`, so
// positive member globs are NOT needed to FIND packages — but a `!`-negated dir is an EXPLICIT
// exclusion both ecosystems honor, so a package.json-anchored dir the manifest excludes must stay
// unindexed. This reads ONLY those exclusions.
//
// Both sources are plain data files (never a boundary that trusts external types — but read
// best-effort, so a missing/malformed manifest yields NO exclusions rather than throwing, mirroring
// `referencePaths`' malformed-config handling in ./discover):
//   1. `pnpm-workspace.yaml` — a top-level `packages:` string list;
//   2. `package.json` `workspaces` — an array, or the yarn `{ packages: [...] }` object form.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

/** Read the repo's workspace-EXCLUSION globs (the `!`-prefixed entries, `!` stripped) from
 *  `pnpm-workspace.yaml` + `package.json`. Best-effort: any read/parse failure contributes no
 *  exclusions (never throws). Called ONCE per host structural reindex from `packageConfigs`, never
 *  per query (§19). */
export function readWorkspaceExclusions(root: string): string[] {
  const raw = [...pnpmPackages(root), ...packageJsonWorkspaces(root)];
  const negative: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.startsWith('!')) continue;
    const glob = normalizeGlob(entry.slice(1));
    if (glob.length > 0) negative.push(glob);
  }
  return negative;
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
