// The build id of THIS process: `<package version> @<sha9>[+dirty]`, or `<version> @unknown` when
// codemaster's own checkout cannot be read. Distinct from the package version on purpose: that
// version keys the daemon socket and pidfile, and a per-commit key would spawn a daemon per commit.
// Computed EAGERLY when a process starts (the daemon, an in-process server, an engine child): a lazy
// read would report the HEAD on disk at first use, not the code this process loaded.

import { realpathSync } from 'node:fs';
import { runGitSync } from '../git/run.ts';
import { PACKAGE_ROOT, packageVersion } from './package-version.ts';

const GIT_TIMEOUT_MS = 2_000;

export function computeBuildId(root: string = PACKAGE_ROOT, version = packageVersion()): string {
  return `${version} @${checkoutRef(root)}`;
}

function checkoutRef(root: string): string {
  const top = runGitSync(root, ['rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT_MS });
  // Installed under another project's node_modules, git answers for THAT project: its HEAD is not
  // our version. Only a checkout whose toplevel IS the package root speaks for codemaster.
  if (!top.ok || !samePath(top.data.trim(), root)) return 'unknown';
  const head = runGitSync(root, ['rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
  if (!head.ok) return 'unknown';
  const dirty = runGitSync(root, ['status', '--porcelain'], { timeoutMs: GIT_TIMEOUT_MS });
  if (!dirty.ok) return 'unknown';
  return `${head.data.trim().slice(0, 9)}${dirty.data.trim().length > 0 ? '+dirty' : ''}`;
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}
