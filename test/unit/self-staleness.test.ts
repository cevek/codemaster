// Stage 6 DX riders. (1) Daemon self-staleness (§3.6 applied to the tool): when codemaster's OWN
// source moves after spawn, `status` and the MCP op banner say so — but NEVER on an unchanged tree
// (a false positive would train the agent to ignore it). What the banner then SAYS is pinned
// below: what is stale (the analysis, not the repo's data), the cheap one-shot remedy, and what a
// restart does in THIS topology (t-034392 / t-793745).
// (2) The `root`-placement docs clarification: `root` is top-level; the schema is unchanged,
// so `root` inside `args` still fails with a self-correcting `bad_args` (docs improved, not
// validation loosened).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { staleBanner, opResultText } from '../../src/mcp/server.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import {
  defaultSourceFingerprint,
  createSourceStaleTracker,
} from '../../src/daemon/source-fingerprint.ts';
import { CONCEPTS_LINES } from '../../src/format/render/concepts.ts';
import { sourceStaleBanner } from '../../src/format/render/render-status.ts';

/** The banner's opening marker, written out rather than imported: these tests assert WHETHER the
 *  signal fires, so anchoring them on the very function they guard would make silence and a
 *  reworded banner indistinguishable. */
const STALE_MARKER = /!! PRE-EDIT codemaster/;

const TSCONFIG = '{"compilerOptions":{"strict":true}}';
const FILES = { 'tsconfig.json': TSCONFIG, 'src/x.ts': 'export const x = 1;\n' };

test('self-staleness: status is SILENT when the daemon source is unchanged (no false positive)', async () => {
  const p = await project(FILES, { sourceFingerprint: () => 'v1' });
  try {
    assert.doesNotMatch(await p.status(), STALE_MARKER, 'a fresh daemon must not nag');
  } finally {
    await p.dispose();
  }
});

test('self-staleness: status warns once the daemon source moved after spawn', async () => {
  let fingerprint = 'v1';
  const p = await project(FILES, { sourceFingerprint: () => fingerprint });
  try {
    // The daemon recorded `v1` at spawn; now its own source is edited (rebuild/edit loop).
    fingerprint = 'v2';
    assert.match(await p.status(), STALE_MARKER, 'a daemon serving pre-edit behavior must say so');
  } finally {
    await p.dispose();
  }
});

test('self-staleness: an unknowable source fingerprint never false-positives (§19 global/npx)', async () => {
  // `unknown` (source tree not locatable) must DISABLE the signal, not fire it forever.
  let fingerprint = 'unknown';
  const p = await project(FILES, { sourceFingerprint: () => fingerprint });
  try {
    fingerprint = 'unknown-2'; // even if a later read differs, an `unknown` baseline stays quiet
    assert.doesNotMatch(await p.status(), STALE_MARKER, 'unknown baseline disables the signal');
  } finally {
    await p.dispose();
  }
});

test('self-staleness: a transient unreadable source (current=unknown) is NOT a false positive', async () => {
  // Spawned with a real fingerprint, then a later read fails (EMFILE/ENOENT mid-walk →
  // `unknown`). That must stay SILENT — firing "behind source" on a transient fs blip is the
  // exact lie the signal exists to prevent (a false positive trains the agent to ignore it).
  let fingerprint = 'real-v1';
  const p = await project(FILES, { sourceFingerprint: () => fingerprint });
  try {
    fingerprint = 'unknown'; // a transient walk failure on this read, not a real source move
    assert.doesNotMatch(
      await p.status(),
      STALE_MARKER,
      'a momentary unreadable source must not nag',
    );
  } finally {
    await p.dispose();
  }
});

test('defaultSourceFingerprint: the REAL fingerprinter resolves its own src/ (not silently unknown)', () => {
  // The production default (import.meta.url → src/, walk, rollup) is otherwise exercised by
  // nothing — every other test injects the seam, and `node src/bin.ts status` is blind to
  // this (a one-shot spawn has spawn==current → silent whether the walk works or returns
  // `unknown`). So pin it directly: it must yield a stable, non-`unknown` value, proving
  // resolution + walk + rollup are live — else the whole signal is inert in production.
  const a = defaultSourceFingerprint();
  assert.notEqual(a, 'unknown', 'codemaster must locate + walk its own src/ tree');
  assert.equal(a, defaultSourceFingerprint(), 'a stat rollup of an unchanged tree is stable');
  // The rollup ends with the file count (`fnv1a64:<hash>:<count>`). The WHOLE `src/` tree is
  // many dozens of files; `src/daemon/` alone is ~a dozen — so a narrowed root (e.g. a
  // `new URL('.', …)` regression resolving to `src/daemon/`) would silently shrink the
  // signal and miss edits elsewhere. Assert breadth so that narrowing can't pass green.
  const count = Number(a.split(':').pop());
  assert.ok(count > 50, `expected the whole src/ tree walked, got count=${count} (${a})`);
});

test('createSourceStaleTracker: TTL-caches the verdict, recomputes after it elapses, recovers', () => {
  let now = 0;
  let fp = 'v1';
  const tracker = createSourceStaleTracker(
    () => now,
    () => fp,
    1000,
  );
  assert.equal(tracker.stale(), false, 'fresh at spawn (baseline v1 == v1)');

  fp = 'v2'; // source moved
  assert.equal(tracker.stale(), false, 'within the TTL the cached (fresh) verdict is reused');

  now = 1000; // TTL elapsed → recompute
  assert.equal(tracker.stale(), true, 'after the TTL the moved source is detected');

  fp = 'v1'; // source matches the baseline again
  now = 2000;
  assert.equal(tracker.stale(), false, 'recovers — the verdict is never a permanent latch');
});

test('staleBanner: empty when fresh, the full banner when stale (the MCP op surface)', () => {
  assert.equal(
    staleBanner(false, 'daemon'),
    '',
    'fresh → no banner, never noise on the using agent',
  );
  assert.equal(
    staleBanner(true, 'daemon'),
    `${sourceStaleBanner('daemon')}\n`,
    'the MCP prefix is the shared line + a newline — one home for the wording',
  );
});

test('banner carries all THREE facts, in both topologies (t-034392 / t-793745)', () => {
  // Each fact answers a question a reader had to guess before. None is droppable:
  //  1. WHAT is stale — the analysis code, not the repo's data (the external agent's verbatim
  //     ask: "I cannot tell whether that degrades the answers I am about to get");
  //  2. the CHEAP remedy — a one-shot on current source (the dogfooders' missing lever);
  //  3. what the RESTART does HERE (machine-wide vs a plain no-op).
  for (const serving of ['daemon', 'in-process'] as const) {
    const line = sourceStaleBanner(serving);
    assert.match(line, /^!! /, `${serving}: leads with the !! honesty marker`);
    assert.match(line, /re-read fresh/, `${serving}: says the inspected repo is NOT stale`);
    assert.match(line, /ANALYSIS is old/, `${serving}: says WHAT is stale instead`);
    assert.match(line, /node src\/bin\.ts op/, `${serving}: names the one-shot remedy`);
  }
});

test('the two topologies say DIFFERENT things about restart — each true where it prints', () => {
  const daemon = sourceStaleBanner('daemon');
  const inProcess = sourceStaleBanner('in-process');
  // The discrimination must be REAL: two variants that render the same string would pass any
  // per-variant regex while telling an `--in-process` reader to run a command that cannot help.
  assert.notEqual(daemon, inProcess, 'the topologies must not collapse to one wording');
  // daemon: the restart works, and its blast radius is the fact the reader needs (t-793745 —
  // it discards every connection's warm state, including third parties who staled nothing).
  assert.match(daemon, /codemaster daemon restart/);
  assert.match(daemon, /every connection/);
  // The restart takes the reader's OWN session down with it: the daemon exits, the bridge's socket
  // closes and the remote orchestrator latches closed (`daemon/remote-orchestrator.ts` — every later
  // call answers "never sent, reconnect and retry"). A remedy that leaves the reader unable to ask
  // again is not the whole remedy, so the reconnect is named as part of it.
  assert.match(daemon, /\+reconnect/);
  // in-process: the daemon verb cannot reach THIS server, so it is named as the lever that will not
  // help — never as an action. The claim stays scoped to this process: `--in-process` bypasses the
  // socket, it does not prove the machine has no singleton, and a reader who ran the verb "because
  // it is inert" would evict some other agent's warm state.
  assert.match(inProcess, /won't touch this server/);
  assert.doesNotMatch(
    inProcess,
    /no daemon\b/,
    'never a claim about the machine, only this server',
  );
  // ...and it still says what WOULD fix it, so "will not help" never reads as "nothing can".
  assert.match(inProcess, /only its own restart/);
  // A regression that pasted the daemon clause into this arm would claim a working lever where
  // none reaches this server — so assert the daemon arm's own promise is absent here, by the words
  // that carry it ("fixes it"), not by a pattern the in-process text could never have matched.
  assert.doesNotMatch(inProcess, /fixes it/);
});

test('banner stays within its per-response budget (it prefixes EVERY stale answer)', () => {
  // §12 tokens-are-scarce: this line is prepended to every op/batch/status response for as long as
  // the source is behind, so its size is a standing tax, not a one-off. 250 CHARS is the agreed
  // ceiling (a couple of multi-byte glyphs put the serialized cost a few bytes above it — the
  // budget is about token/read cost, not the §12 seam, which measures bytes and has ~15KB of
  // headroom here). A fact added later must displace prose, not widen the channel.
  for (const serving of ['daemon', 'in-process'] as const) {
    const len = sourceStaleBanner(serving).length;
    // The message carries the REMEDY, because the headroom is a few characters and the cheapest way
    // to make this pass is the one that destroys it: a guard that gets raised on contact stops
    // guarding. Displace prose instead — the ceiling is the point, not an obstacle to it.
    assert.ok(
      len <= 250,
      `${serving}: banner is ${len} chars, over the 250 budget. DISPLACE PROSE, do NOT raise this ceiling: ` +
        'the banner prefixes EVERY response for as long as the source is behind, so its size is a ' +
        'tax on the whole session, not on one message — a clause worth adding is worth cutting one for.',
    );
  }
});

test('§3.6 always-on: an op-level ERROR result carries the staleness banner too (not just success)', () => {
  // §3.6 is always-on: the banner thunk is consumed on BOTH branches. A stale-daemon `unknown_op`
  // (a freshly-added op the daemon never loaded) is exactly where "restart" matters most, so the
  // error text picks up the prefix as well — never marker-less.
  let calls = 0;
  const thunk = (): string => {
    calls++;
    return 'STALE-BANNER\n';
  };
  const textOf = (r: ReturnType<typeof opResultText>): string =>
    (r.content[0] as { text?: string } | undefined)?.text ?? '';

  const errResult: OpResult = { name: 'find_usages', error: { kind: 'unknown_op', message: 'x' } };
  const errOut = opResultText(errResult, 'text', 'terse', thunk);
  assert.equal(calls, 1, 'an error result consumes the banner exactly once');
  assert.match(textOf(errOut), /STALE-BANNER/, 'the prefix ships on the error branch');
  assert.match(textOf(errOut), /unknown_op: x/, 'the underlying error text is preserved');

  const okResult: OpResult = { name: 'find_usages', result: { ok: true, data: 'ok-body' } };
  const okOut = opResultText(okResult, 'text', 'terse', thunk);
  assert.equal(calls, 2, 'a success result consumes the banner once more');
  assert.match(textOf(okOut), /STALE-BANNER/);
});

test('root-placement: docs say top-level, and `root` inside `args` still fails bad_args (schema unchanged)', async () => {
  // The concepts line now teaches the top-level placement (the inbox friction fix)...
  const crossRepo = CONCEPTS_LINES.find((l) => l.startsWith('cross-repo:'));
  assert.ok(crossRepo !== undefined);
  assert.match(crossRepo, /TOP-LEVEL/);
  assert.match(crossRepo, /NOT inside `args`/);

  // ...without loosening validation: `root` smuggled into an op's args is still a pointed
  // bad_args (find_usages' strictObject rejects the unknown key), so the docs fix is honest.
  const p = await project(FILES);
  try {
    const r = await p.op('find_usages', { name: 'x', root: '/elsewhere' } as never);
    assert.ok('error' in r && r.error.kind === 'bad_args', JSON.stringify(r));
  } finally {
    await p.dispose();
  }
});
