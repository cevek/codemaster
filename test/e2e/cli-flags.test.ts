// CLI-seam robustness (t-713862 + t-607963): the one-shot `op`/`status` path must
//  (1) accept the global `--root` flag on EITHER side of the subcommand,
//  (2) support `--format json` / `--format=json` — routed through the SAME `renderResultJson`
//      the MCP path uses, so the WHOLE stdout is one clean JSON envelope (no prefix banner
//      corrupting a bare-JSON payload, §11), and
//  (3) REJECT an unrecognized flag loudly (exit 2, flag named) instead of silently dropping it
//      (§3 silent-swallow) — on both `op` and `status`,
//  (4) serialize a DISPATCH error under `--format json` as a valid JSON envelope on a NON-zero exit
//      (t-337633 — no `| jq` trap on a success exit code), and
//  (5) REJECT a stray positional after the JSON args (t-865108 — the §3 positional half).
// The oracle is a real subprocess (`node src/bin.ts`) — the genuine CLI path — with JSON.parse of
// the full stdout as the structural check and the process exit code as the reject check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from '../helpers/project.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(repoRoot, 'src', 'bin.ts');
const TSCONFIG = '{"compilerOptions":{"strict":true}}';

type Run = { status: number | null; stdout: string; stderr: string };
function runCli(args: string[]): Run {
  const r = spawnSync('node', [BIN, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function fixture() {
  return project({ 'tsconfig.json': TSCONFIG, 'src/app.ts': 'export const Widget = 1;\n' });
}

test('t-713862: `--root` BEFORE the `op` subcommand parses (op runs, not usage)', async () => {
  const p = await fixture();
  try {
    const before = runCli(['--root', p.root, 'op', 'search_symbol', '{"name":"Widget"}']);
    // Repro-negative: on the bug this printed the top-level usage and never ran the op.
    assert.equal(before.status, 0, 'op exits 0 when --root precedes the subcommand');
    assert.doesNotMatch(
      before.stdout,
      /^codemaster v/m,
      'must NOT fall through to top-level usage',
    );
    assert.match(before.stdout, /Widget/, 'the op actually ran against the --root repo');

    // Parity: --root AFTER the subcommand still works (unchanged path).
    const after = runCli(['op', 'search_symbol', '{"name":"Widget"}', '--root', p.root]);
    assert.equal(after.status, 0);
    assert.match(after.stdout, /Widget/);
  } finally {
    await p.dispose();
  }
});

test('t-607963: `--format json` and `--format=json` emit ONE clean JSON envelope', async () => {
  const p = await fixture();
  try {
    for (const fmt of [['--format', 'json'], ['--format=json']]) {
      const r = runCli(['op', 'search_symbol', '{"name":"Widget"}', ...fmt, '--root', p.root]);
      assert.equal(r.status, 0, `${fmt.join(' ')} exits 0`);
      // The whole stdout must be a single JSON value: JSON.parse throws if a prefix banner or any
      // non-JSON line leaked in (§11 — a bare-JSON payload must not be corrupted).
      let env: unknown;
      assert.doesNotThrow(
        () => {
          env = JSON.parse(r.stdout);
        },
        `${fmt.join(' ')}: whole stdout parses as one JSON envelope`,
      );
      const e = env as { ok?: unknown; data?: { matches?: unknown[] } };
      assert.equal(e.ok, true, 'a proper Result envelope, ok:true');
      assert.ok(
        Array.isArray(e.data?.matches) && e.data.matches.length > 0,
        'the json envelope carries the op data (parity with the text render)',
      );
    }
  } finally {
    await p.dispose();
  }
});

test('t-607963: an invalid `--format` value is rejected, not silently coerced', async () => {
  const p = await fixture();
  try {
    const r = runCli([
      'op',
      'search_symbol',
      '{"name":"Widget"}',
      '--format',
      'xml',
      '--root',
      p.root,
    ]);
    assert.equal(r.status, 2, 'invalid --format value exits 2');
    assert.match(r.stderr, /--format must be/, 'stderr explains the accepted values');
    assert.equal(r.stdout, '', 'the op never ran (no data emitted)');
  } finally {
    await p.dispose();
  }
});

test('t-607963: an unrecognized flag on `op` is REJECTED, not dropped (§3)', async () => {
  const p = await fixture();
  try {
    const r = runCli([
      'op',
      'search_symbol',
      '{"name":"Widget"}',
      '--bogus-flag',
      '--root',
      p.root,
    ]);
    assert.equal(r.status, 2, 'unrecognized flag exits 2');
    assert.match(r.stderr, /--bogus-flag/, 'stderr names the offending flag');
    // Repro-negative: on the bug the op ran to completion and printed matches, dropping the flag.
    assert.equal(r.stdout, '', 'the op did NOT run');
  } finally {
    await p.dispose();
  }
});

test('t-607963: an unrecognized flag on `status` is REJECTED, not dropped (§3)', async () => {
  const p = await fixture();
  try {
    const r = runCli(['status', '--bogus-flag', '--root', p.root]);
    assert.equal(r.status, 2, 'unrecognized flag exits 2');
    assert.match(r.stderr, /--bogus-flag/, 'stderr names the offending flag');
    assert.equal(r.stdout, '', 'the manifest was NOT rendered');
  } finally {
    await p.dispose();
  }
});

test('t-337633: a DISPATCH error under `--format json` is valid JSON on a NON-zero exit', async () => {
  const p = await fixture();
  try {
    const r = runCli(['op', 'no_such_op', '{}', '--format', 'json', '--root', p.root]);
    // The whole stdout must parse — on the bug this was a plain `DISPATCH unknown_op: …` line that
    // threw in JSON.parse, on a success exit code (§3: a `| jq` trap).
    let env: unknown;
    assert.doesNotThrow(() => {
      env = JSON.parse(r.stdout);
    }, 'the dispatch error stdout parses as one JSON envelope');
    const e = env as { ok?: unknown; dispatch?: { kind?: unknown } };
    assert.equal(e.ok, false, 'a dispatch error is an ok:false envelope');
    assert.equal(
      e.dispatch?.kind,
      'unknown_op',
      'the dispatch cause is machine-recoverable via .dispatch.kind',
    );
    assert.notEqual(
      r.status,
      0,
      'a dispatch error exits non-zero (mirrors MCP isError) — no success-code trap',
    );
  } finally {
    await p.dispose();
  }
});

test('t-865108: a stray positional after the JSON args is REJECTED, not dropped (§3)', async () => {
  const p = await fixture();
  try {
    const r = runCli(['op', 'search_symbol', '{"name":"Widget"}', 'EXTRA_JUNK', '--root', p.root]);
    // Repro-negative: on the bug `args.find(!--)` picked the JSON positional and silently dropped
    // EXTRA_JUNK, running the op to a success exit.
    assert.equal(r.status, 2, 'a second positional exits 2');
    assert.match(r.stderr, /EXTRA_JUNK/, 'stderr names the stray positional');
    assert.equal(r.stdout, '', 'the op did NOT run');
  } finally {
    await p.dispose();
  }
});
