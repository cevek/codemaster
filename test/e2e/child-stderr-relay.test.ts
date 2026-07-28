// The process-mode child's stderr must NOT reach the parent's terminal (§13). A V8 fatal-OOM dump
// (~110 lines) printed there lands immediately ahead of the honest `FAIL tool=oom`, and an agent
// reading CLI output through `head` sees only the dump — concluding "codemaster crashed" when the
// isolated child died on purpose and the tool answered honestly. So the stream is PIPED and relayed
// into the per-repo debug log, where the diagnostic is kept, not discarded.
//
// Oracles: (1) content through a REAL fork — a child bin that prints a dump-shaped stderr block is
// read back out of the per-repo log file, whose path is computed by the SAME `repoLogDir` the
// engine's own sink uses. Under the old `'inherit'` stdio that text goes to the parent's terminal
// and the log stays empty, so this assert is what discriminates the two; (2) the line/cap/flush
// behaviour driven directly over a fake stream + recording sink, so the truncation marker and the
// unterminated-tail flush (a fatal dump's last line has no newline) are asserted without a fork.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { forkEngineChild } from '../../src/daemon/fork-engine.ts';
import { relayChildStderr } from '../../src/daemon/child-stderr-relay.ts';
import { repoLogDir } from '../../src/daemon/repo-log-sink.ts';
import { canonicalizeRoot } from '../../src/support/fs/canonicalize.ts';
import type { RepoId } from '../../src/core/brands.ts';

const GENEROUS_MS = 90_000; // slow CI: cold fork; bounded, never a fixed sleep.

/** Records disposal too: a sink released before the stream's final flush would silently swallow the
 *  last line of a dump, so the tests assert what arrived BEFORE `dispose` (a post-dispose write is
 *  recorded with a marker rather than dropped, which is what makes that assertion falsifiable). */
function recordingSink(): {
  lines: string[];
  disposed: () => boolean;
  write: (l: string) => void;
  dispose: () => void;
} {
  const lines: string[] = [];
  let gone = false;
  return {
    lines,
    disposed: () => gone,
    write: (l) => lines.push(gone ? `AFTER-DISPOSE ${l}` : l),
    dispose: () => {
      gone = true;
    },
  };
}

async function waitUntil(pred: () => boolean, budgetMs = GENEROUS_MS): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

test('the relay writes one line per line and flushes an unterminated tail', async () => {
  const stream = new PassThrough();
  const sink = recordingSink();
  relayChildStderr(stream, sink, () => 4242, 4096);

  // A fatal dump arrives in arbitrary chunks — a line may be split across two of them.
  stream.write('#\n# Fatal error in , line 0\n# ');
  stream.write('ineffective mark-compacts near heap limit\n');
  stream.write('no trailing newline'); // the last line of a dump: never terminated
  stream.end();
  await waitUntil(() => sink.lines.some((l) => l.includes('no trailing newline')), 5_000);

  assert.ok(
    sink.lines.some((l) => l === 'engine-child:stderr pid=4242 # Fatal error in , line 0'),
    `each source line is one sink line, prefixed: ${JSON.stringify(sink.lines)}`,
  );
  assert.ok(
    sink.lines.some((l) => l.endsWith('# ineffective mark-compacts near heap limit')),
    'a line split across chunks is rejoined, not mangled',
  );
  assert.ok(
    sink.lines.some((l) => l.endsWith('no trailing newline')),
    'the unterminated tail is flushed on end — a dump ends exactly like that',
  );
  assert.ok(
    sink.disposed(),
    'the sink is released once its stream is done — one sink per fork, no accumulation',
  );
  assert.ok(
    !sink.lines.some((l) => l.startsWith('AFTER-DISPOSE')),
    'every line was written BEFORE disposal — releasing earlier would drop a dying dump',
  );
});

test('a chatty child never mutes the relay — a later fatal dump still lands; a monster line is cut, marked', async () => {
  const stream = new PassThrough();
  const sink = recordingSink();
  relayChildStderr(stream, sink, () => 7, 256);

  // Well past the stream's 16 KB highWaterMark, so a relay that PAUSED instead of consuming would
  // leave bytes in the writable buffer — the never-hang property, actually falsifiable at this size.
  for (let i = 0; i < 600; i++) stream.write(`chatty debug line ${i} ${'x'.repeat(40)}\n`);
  // Then the thing the relay exists for, AFTER all that volume.
  stream.write('# Fatal error in , line 0 — MARKER-late\n');
  await waitUntil(() => sink.lines.some((l) => l.includes('MARKER-late')), 5_000);

  assert.ok(
    sink.lines.some((l) => l.includes('MARKER-late')),
    'a lifetime budget would have muted the relay before this line — the dump must still arrive',
  );
  assert.equal(
    stream.isPaused(),
    false,
    'the relay never pauses the pipe (a paused pipe wedges the child)',
  );
  assert.equal(
    stream.writableLength,
    0,
    'and it keeps draining — nothing is left stuck in the pipe',
  );

  // A single unterminated monster line is cut with an explicit marker, never silently (§3.4).
  sink.lines.length = 0;
  stream.write(`${'y'.repeat(900)}\n`);
  await waitUntil(() => sink.lines.length > 0, 5_000);
  const cut = sink.lines.find((l) => l.includes('yyy'));
  assert.ok(
    cut !== undefined && / !! line truncated at 256 chars$/.test(cut),
    `the cut is disclosed: ${cut}`,
  );
});

test('a real forked child writing a fatal dump to stderr lands it in the per-repo log', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-stderr-'));
  const stateDir = path.join(dir, '.state');
  mkdirSync(stateDir);
  // A stand-in child bin: the real engine child prints to stderr only when it dies (the V8 fatal
  // dump), which cannot be provoked cheaply — so this one prints exactly that shape and exits. The
  // wiring under test is fork-engine's own (stdio + relay + log path), which is bin-independent.
  const fakeBin = path.join(dir, 'fatal-child.mjs');
  writeFileSync(
    fakeBin,
    "process.stderr.write('#\\n# Fatal error in , line 0\\n# ineffective mark-compacts near heap limit — MARKER-9f3\\n');\n" +
      'setTimeout(() => process.exit(0), 50);\n',
  );
  const canon = canonicalizeRoot(dir);
  assert.ok(canon.ok, 'canonicalize temp root');
  const root = canon.ok ? canon.root : dir;

  const child = forkEngineChild({
    binPath: fakeBin,
    root,
    stateDir,
    version: 'test',
    maxOldSpaceMB: 2048,
    sockDir: undefined,
  });

  try {
    // The path oracle: the repo log DIRECTORY comes from the SAME helper the engine's own sink
    // uses, so the relayed dump is greppable exactly where §13 says to look — in its own file, so
    // the two writers never rotate against each other.
    const logPath = path.join(repoLogDir(stateDir, root as RepoId, root), 'child-stderr.log');
    const relayed = (): boolean =>
      existsSync(logPath) && readFileSync(logPath, 'utf8').includes('MARKER-9f3');
    assert.ok(
      await waitUntil(relayed, 30_000),
      `the child's stderr must be findable in the per-repo log (${logPath})`,
    );
    const log = readFileSync(logPath, 'utf8');
    assert.match(log, /engine-child:stderr pid=\d+ # Fatal error/, 'origin-tagged, line per line');
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
