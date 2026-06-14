// Stage 6 DX riders. (1) Daemon self-staleness (§3.6 applied to the tool): when
// codemaster's OWN source moves after spawn, `status` and the MCP op banner say "reconnect"
// — but NEVER on an unchanged tree (a false positive would train the agent to ignore it).
// (2) The `root`-placement docs clarification: `root` is top-level; the schema is unchanged,
// so `root` inside `args` still fails with a self-correcting `bad_args` (docs improved, not
// validation loosened).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { staleBanner, opBanner } from '../../src/mcp/server.ts';
import {
  defaultSourceFingerprint,
  createSourceStaleTracker,
} from '../../src/daemon/source-fingerprint.ts';
import { CONCEPTS_LINES } from '../../src/format/render/concepts.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true}}';
const FILES = { 'tsconfig.json': TSCONFIG, 'src/x.ts': 'export const x = 1;\n' };

test('self-staleness: status is SILENT when the daemon source is unchanged (no false positive)', async () => {
  const p = await project(FILES, { sourceFingerprint: () => 'v1' });
  try {
    assert.doesNotMatch(await p.status(), /behind source/, 'a fresh daemon must not nag');
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
    assert.match(
      await p.status(),
      /daemon code behind source — reconnect MCP/,
      'a daemon serving pre-edit behavior must say so',
    );
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
    assert.doesNotMatch(await p.status(), /behind source/, 'unknown baseline disables the signal');
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
      /behind source/,
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

test('staleBanner: empty when fresh, a reconnect line when stale (the MCP op surface)', () => {
  assert.equal(staleBanner(false), '', 'fresh → no banner, never noise on the using agent');
  assert.match(staleBanner(true), /reconnect MCP/);
});

test('opBanner: suppressed for format:json so the JSON payload is never corrupted (§12)', () => {
  assert.equal(opBanner('json', true), '', 'a stale daemon must NOT prepend to a json op result');
  assert.match(opBanner('text', true), /reconnect MCP/, 'text mode still warns');
  assert.equal(opBanner('text', false), '', 'fresh text mode stays silent');
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
