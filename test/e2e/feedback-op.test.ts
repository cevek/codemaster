// spec-feedback-channel §5: the `feedback` op records to an append-only global inbox with
// daemon-attached context, never touches the inspected repo's tree, and degrades to a
// ToolFailure (not a crash) when the inbox is unwritable. Oracle = read the file back +
// `git status --porcelain` for the untouched-tree claim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { project } from '../helpers/project.ts';
import { renderResult } from '../../src/format/render/render-result.ts';
import { ok, fail, partial } from '../../src/common/result/construct.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true}}';

test('feedback appends a templated entry with auto-context; append-only', async () => {
  const p = await project({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a = 1;\n' });
  try {
    const r1 = await p.op('feedback', {
      kind: 'wish',
      title: 'regex name matching',
      detail: 'wanted Use* in one call',
      example: { name: 'find_usages', args: { name: 'Use*' } },
    });
    assert.ok('result' in r1 && r1.result.ok, JSON.stringify(r1));
    const at = (r1.result.data as { recorded: boolean; at: string }).at;
    assert.equal((r1.result.data as { recorded: boolean }).recorded, true);

    const first = readFileSync(at, 'utf8');
    assert.match(first, /## \[wish\] regex name matching — \d{4}-\d\d-\d\dT/, 'templated heading');
    assert.match(first, /repo=.+ · cm=test · plugins=ts@.+,scss@/, 'daemon-attached context line');
    assert.match(first, /\nops=.*\bfeedback\b/, 'the op catalogue at filing time is attached');
    assert.match(first, /wanted Use\* in one call/);
    assert.match(first, /```json example\n{\n {2}"name": "find_usages"/, 'example block');

    // A second entry must not clobber the first (append-only).
    await p.op('feedback', { kind: 'bug', title: 'second', detail: 'another note' });
    const both = readFileSync(at, 'utf8');
    assert.match(both, /## \[wish\] regex name matching/, 'first entry intact');
    assert.match(both, /## \[bug\] second/, 'second entry appended');
  } finally {
    await p.dispose();
  }
});

test('feedback never touches the inspected repo tree (inbox lives outside it)', async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'cm-feedback-state-'));
  const p = await project(
    { 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a = 1;\n' },
    { stateDir },
  );
  try {
    const r = await p.op('feedback', { kind: 'friction', title: 't', detail: 'd' });
    assert.ok('result' in r && r.result.ok);
    // The §7 edit-safety oracle: a clean working tree after the call.
    assert.equal(p.git('status', '--porcelain').trim(), '', 'repo tree must be untouched');
  } finally {
    await p.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an unwritable inbox returns a ToolFailure, daemon stays up', async () => {
  // Point stateDir at a FILE — mkdir of `<file>/feedback` fails (ENOTDIR), portably.
  const blocker = path.join(mkdtempSync(path.join(tmpdir(), 'cm-block-')), 'not-a-dir');
  writeFileSync(blocker, 'x');
  const p = await project(
    { 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a = 1;\n' },
    { stateDir: blocker },
  );
  try {
    const r = await p.op('feedback', { kind: 'bug', title: 't', detail: 'd' });
    assert.ok('result' in r && !r.result.ok, 'must be a failure, not a crash');
    assert.equal(r.result.failure.tool, 'fs');
    // Daemon still answers afterwards.
    const after = await p.op('feedback', { kind: 'bug', title: 't2', detail: 'd2' });
    assert.ok('result' in after, 'daemon stays up');
  } finally {
    await p.dispose();
    rmSync(path.dirname(blocker), { recursive: true, force: true });
  }
});

test('args boundary: a long title (200+ chars) is accepted and recorded VERBATIM — no cap, no truncation', async () => {
  // The 120-char cap was removed (§1/§3 — be liberal at the boundary, never lose the
  // round-trip on the low-friction capture channel). A natural long title must record
  // as-is. Oracle = read the inbox back and find the exact title, untruncated/unmarked.
  const p = await project({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a = 1;\n' });
  try {
    const title = 'A'.repeat(150) + 'B'.repeat(50); // 200 chars — well over the old cap
    const r = await p.op('feedback', { kind: 'bug', title, detail: 'plain detail' });
    // The whole point of the fix: it succeeds rather than failing with bad_args.
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const at = (r.result.data as { at: string }).at;
    const inbox = readFileSync(at, 'utf8');
    // The full 200-char title appears verbatim in the heading — not truncated.
    assert.ok(inbox.includes(`## [bug] ${title} — `), 'long title recorded verbatim');
    assert.doesNotMatch(inbox, /…/, 'no ellipsis/truncation marker');
    assert.doesNotMatch(inbox, /\[title overflow\]/, 'no overflow fold');
  } finally {
    await p.dispose();
  }
});

test('args boundary: a normal short title is recorded verbatim', async () => {
  const p = await project({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a = 1;\n' });
  try {
    const title = 'a normal short title';
    const r = await p.op('feedback', { kind: 'wish', title, detail: 'plain detail' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const at = (r.result.data as { at: string }).at;
    const inbox = readFileSync(at, 'utf8');
    assert.match(inbox, /## \[wish\] a normal short title — /, 'short title recorded verbatim');
  } finally {
    await p.dispose();
  }
});

test('FAIL trailer points to feedback on a hard FAIL, never on ok or partial', () => {
  const hard = renderResult(fail({ tool: 'ts-ls', message: 'boom' }), 'terse');
  assert.match(hard, /file it: op\(\{name:'feedback'/, 'hard FAIL nudges feedback');

  const partialOut = renderResult(
    partial({ matches: [] }, { tool: 'ts-ls', message: 'boom' }),
    'terse',
  );
  assert.doesNotMatch(partialOut, /file it: op/, 'partial is honest success — no nudge');

  const okay = renderResult(ok({ matches: [] }), 'terse');
  assert.doesNotMatch(okay, /file it: op/, 'ok results carry no nudge');
});
