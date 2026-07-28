// The CLI flag reader (src/cli/flags.ts). Oracle = the argv the caller wrote: after parsing, what
// the command runs on must be what was typed, or the command must refuse — never a third thing.
//
// The failure this pins is quiet by nature: `--sql --root /x` reading `--root` AS the sql text runs
// a composed query the caller never wrote, on a root that silently vanished. That is the §3
// silent-swallow, and it is invisible in any test that only checks the happy path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argValue, enumFlag, flagIssue, flagValue, hasFlag } from '../../src/cli/flags.ts';

test('a value-flag never consumes a following FLAG as its value', () => {
  const args = ['--sql', '--root', '/x'];
  assert.equal(flagValue(args, '--sql'), undefined, 'no value — the next token is a flag');
  assert.deepEqual(args, ['--sql', '--root', '/x'], '--sql is left in place, not spliced');
  // …and the root that would have been eaten is still readable.
  assert.equal(argValue(args, '--root'), '/x');
  // The leftover then reports the REAL cause, not "unrecognized" (t-141874's shape).
  assert.match(flagIssue(args, ['--sql', '--root']) ?? '', /without a value/);
});

test('both spellings parse and splice; an empty `--flag=` is refused, not read as absent', () => {
  const spaced = ['--format', 'json', 'rest'];
  assert.equal(flagValue(spaced, '--format'), 'json');
  assert.deepEqual(spaced, ['rest']);

  const equals = ['--format=json', 'rest'];
  assert.equal(flagValue(equals, '--format'), 'json');
  assert.deepEqual(equals, ['rest']);

  // Spliced out, `--format=` would read as "not passed" and run on a default the caller did not
  // choose; left in, it is reported.
  const empty = ['--format='];
  assert.equal(flagValue(empty, '--format'), undefined);
  assert.deepEqual(empty, ['--format=']);
  assert.match(flagIssue(empty, ['--format']) ?? '', /without a value/);
});

test('flagIssue separates the two causes, and is silent when nothing is stray', () => {
  assert.equal(flagIssue(['positional'], ['--sql']), undefined);
  assert.match(flagIssue(['--bogus'], ['--sql']) ?? '', /unrecognized flag\(s\): --bogus/);
  assert.match(flagIssue(['--sql'], ['--sql']) ?? '', /without a value: --sql/);
});

test('hasFlag splices; enumFlag distinguishes absent from out-of-enum', () => {
  const args = ['--apply', 'x'];
  assert.equal(hasFlag(args, '--apply'), true);
  assert.deepEqual(args, ['x']);
  assert.equal(hasFlag(args, '--apply'), false);

  assert.equal(enumFlag(undefined, ['sql', 'all']), undefined, 'absent');
  assert.equal(enumFlag('all', ['sql', 'all']), 'all');
  assert.equal(enumFlag('nope', ['sql', 'all']), null, 'present but invalid — caller must reject');
});
