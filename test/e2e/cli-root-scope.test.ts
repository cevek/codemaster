// spec §2 routing + §10 config: the CLI one-shot `op`/`status` path must scope config-load AND
// plugin-activation to the resolved `--root`, NOT the process cwd. The MCP per-request `root`
// already does this (orchestrator.route → getOrSpawn → loadConfig(root)); this pins the CLI path
// so a regression — loading config from cwd — cannot creep back. The oracle is the config-gated
// i18n plugin (present iff `config.i18n` is set, spec spec-i18n-plugin): running the op against an
// i18n repo via `--root` from a cwd that has NO i18n config must SUCCEED (root's config governs),
// and the same op WITHOUT `--root` from that cwd must report `unavailable` (cwd's config governs).
// A real subprocess (`node src/bin.ts`) is the genuine CLI path — not the in-process orchestrator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from '../helpers/project.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(repoRoot, 'src', 'bin.ts');

const I18N_CONFIG =
  "import {defineConfig} from 'codemaster';\n" +
  "export default defineConfig({ i18n: { locales: ['locales/*.json'] } });\n";

/** Run `op find_unused_i18n_keys` from `cwd`, optionally with `--root`, capturing stdout.
 *  A DISPATCH error (e.g. `unavailable` when i18n is inactive) exits NON-zero (§3, t-337633 — the
 *  CLI mirror of the MCP `isError`), so execFileSync throws; the rendered marker still lands on the
 *  child's stdout, which we read from the thrown error. This arm tests `--root` SCOPING (which repo's
 *  config governs), not the exit code — so reading stdout on either exit path keeps the subject. */
function runI18nOp(cwd: string, root?: string): string {
  const args = [BIN, 'op', 'find_unused_i18n_keys', '{}', ...(root ? ['--root', root] : [])];
  try {
    return execFileSync('node', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  } catch (e) {
    const stdout = (e as { stdout?: string }).stdout;
    if (typeof stdout === 'string') return stdout;
    throw e;
  }
}

/** `status` is a DISTINCT CLI call-site (`orchestrator.status(cwd, root)`) from `op`
 *  (`request(cwd, root, …)`), so it needs its own arm: a regression scoping only `status`
 *  to cwd would slip past the `op` checks. Returns the rendered manifest. */
function runStatus(cwd: string, root?: string): string {
  const args = [BIN, 'status', ...(root ? ['--root', root] : [])];
  return execFileSync('node', args, { cwd, encoding: 'utf8', timeout: 60_000 });
}

test('CLI `op`/`status --root` scopes config + plugin-activation to the root, not cwd', async () => {
  // The i18n repo: config opts into i18n, with a locale file + a t() usage.
  const i18nRepo = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'codemaster.config.ts': I18N_CONFIG,
    'locales/en.json': JSON.stringify({ greeting: 'hi', orphan: 'x' }),
    'src/app.ts': "const t = (k: string) => k;\nexport const x = t('greeting');\n",
  });
  // The cwd repo: a DIFFERENT workspace with NO i18n config (pure defaults → no i18n plugin).
  const cwdRepo = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/index.ts': 'export const y = 1;\n',
  });
  try {
    // root governs: run from the no-i18n cwd, target the i18n repo via --root → i18n is ACTIVE.
    const withRoot = runI18nOp(cwdRepo.root, i18nRepo.root);
    assert.match(withRoot, /keys=/, '--root must load the root repo config → i18n plugin active');
    assert.doesNotMatch(
      withRoot,
      /unavailable/i,
      'i18n must NOT be reported inactive when --root points at the i18n repo',
    );

    // cwd governs: same cwd, NO --root → cwd repo config (no i18n) → op honestly unavailable.
    const noRoot = runI18nOp(cwdRepo.root);
    assert.match(
      noRoot,
      /unavailable.*\[i18n\]|\[i18n\].*not active/i,
      'without --root the cwd config governs → i18n plugin inactive (honest unavailable)',
    );

    // The `status` call-site is separate from `op` — same property, its own arm: `status --root`
    // at the i18n repo from the no-i18n cwd must list the i18n plugin (root's config governs).
    const statusWithRoot = runStatus(cwdRepo.root, i18nRepo.root);
    assert.match(
      statusWithRoot,
      /plugins:[^\n]*\bi18n@/,
      'status --root must load the root config → i18n plugin listed in the manifest',
    );
    const statusNoRoot = runStatus(cwdRepo.root);
    assert.doesNotMatch(
      statusNoRoot,
      /plugins:[^\n]*\bi18n@/,
      'without --root the cwd config governs → no i18n plugin in the manifest',
    );
  } finally {
    await i18nRepo.dispose();
    await cwdRepo.dispose();
  }
});
