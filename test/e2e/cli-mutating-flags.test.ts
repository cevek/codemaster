// Task J rider — the CLI `op` command must forward `--apply` and `--summaryOnly`, so a mutating op
// can be dogfooded from the shell (feedback friction 11:35: `bin.ts op` only forwarded {name,args},
// so every CLI mutation could only ever dry-run). Driven as a real subprocess against a temp git
// fixture (`project()` gives a clean committed tree the dirty-gate accepts), reading the files on
// disk as the independent oracle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from '../helpers/project.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(repoRoot, 'src', 'bin.ts');
const TSCONFIG = '{"compilerOptions":{"strict":true}}';
const SOURCE =
  'export function Helper(n: number): number { return n + 1; }\n' +
  'export const main = (): number => Helper(41);\n';

function runCli(root: string, args: string[]): string {
  return execFileSync('node', [BIN, 'op', 'extract_symbol', ...args, '--root', root], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}
const EXTRACT = JSON.stringify({ name: 'Helper', dest: 'src/helper.ts' });

test('CLI op without --apply dry-runs: prints a diff, writes NOTHING', async () => {
  const p = await project({ 'tsconfig.json': TSCONFIG, 'src/main.ts': SOURCE });
  try {
    const out = runCli(p.root, [EXTRACT]);
    assert.match(out, /@@/, 'dry-run output carries the unified diff');
    // Source unchanged, no dest created — a pure preview.
    assert.equal(readFileSync(path.join(p.root, 'src/main.ts'), 'utf8'), SOURCE);
    assert.equal(existsSync(path.join(p.root, 'src/helper.ts')), false);
  } finally {
    await p.dispose();
  }
});

test('CLI op --apply reaches the op: the edit is WRITTEN to disk', async () => {
  const p = await project({ 'tsconfig.json': TSCONFIG, 'src/main.ts': SOURCE });
  try {
    runCli(p.root, [EXTRACT, '--apply']);
    // Helper moved to its own file; the source now imports it from there.
    assert.equal(existsSync(path.join(p.root, 'src/helper.ts')), true, 'dest file written');
    const main = readFileSync(path.join(p.root, 'src/main.ts'), 'utf8');
    assert.match(main, /import \{ Helper \} from ["']\.\/helper["']/);
    assert.match(
      readFileSync(path.join(p.root, 'src/helper.ts'), 'utf8'),
      /export function Helper/,
    );
  } finally {
    await p.dispose();
  }
});

test('CLI op --summaryOnly reaches the op: verdict without the unified diff body', async () => {
  const p = await project({ 'tsconfig.json': TSCONFIG, 'src/main.ts': SOURCE });
  try {
    const full = runCli(p.root, [EXTRACT]);
    const summary = runCli(p.root, [EXTRACT, '--summaryOnly']);
    assert.match(full, /@@/, 'the full dry-run shows the diff hunks');
    assert.doesNotMatch(summary, /@@/, 'summaryOnly omits the unified diff body');
    assert.ok(summary.length < full.length, 'summaryOnly is strictly smaller than the full diff');
    // The safety verdict still rides along (the point of summaryOnly).
    assert.match(summary, /typecheck|clean|touched|diffstat/i);
  } finally {
    await p.dispose();
  }
});
