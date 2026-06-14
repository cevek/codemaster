// `projectFromDir()` — mount a committed mini-repo (test/fixtures/repos/<name>) through the
// REAL pipeline, exactly like the inline `project()` map-fixture (spec §6). It reads the
// committed tree into a `{ path: content }` map and hands it to `project()`, which does the
// temp-dir copy + `git init`/commit and wires the i18n-aware `pluginsFor`. Reading the tree
// into a map (rather than copying the directory) drops any nested `.git` for free and reuses
// the one harness that conditionally loads the i18n plugin from `codemaster.config.ts`.

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, type ProjectOptions, type TestProject } from './project.ts';

const REPOS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'repos',
);

function readTree(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Skip VCS/deps and ALL dotfiles (.git, .DS_Store, …) — a fixture is its source tree,
    // not editor/OS cruft; a stray dotfile would otherwise be read lossily as utf8 and
    // committed into the VFS the ops index.
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const abs = path.join(dir, entry.name);
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, readTree(abs, rel));
    else if (entry.isFile()) out[rel] = readFileSync(abs, 'utf8');
  }
  return out;
}

/** Load `test/fixtures/repos/<name>` as a hermetic `TestProject`. */
export function projectFromDir(name: string, options?: ProjectOptions): Promise<TestProject> {
  const dir = path.join(REPOS_DIR, name);
  return project(readTree(dir), options);
}
