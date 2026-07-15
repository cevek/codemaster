// importers_of degenerate-primary honesty (t-784222). When the PRIMARY program covers no project
// files (a broken / empty-`include` tsconfig), a module arg fails to resolve → `resolved:false`. The
// op used to render "module unresolved — pass a repo-relative path", BLAMING the arg form when the
// true cause is the empty program. The fix discloses the degenerate program instead.
//
// Oracle: the op's OWN rendered note on two assembled fixtures — the degenerate primary discloses the
// empty program (no arg-blame), while a HEALTHY primary still arg-blames a genuinely unresolvable
// specifier (the fix must not over-trigger).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import type { JsonValue } from '../../src/core/json.ts';

const C = '"strict":true,"module":"esnext","moduleResolution":"bundler","skipLibCheck":true';

function okData(r: OpResult): Record<string, JsonValue> {
  assert.ok('result' in r && r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as Record<string, JsonValue>;
}

test('importers_of: a degenerate primary (empty include, 0 files) discloses the empty program, NOT arg-blame', async () => {
  const p: TestProject = await project({
    'package.json': '{"name":"root","private":true}',
    // include matches nothing → the primary program covers zero project files.
    'tsconfig.json': `{"compilerOptions":{${C}},"include":["nonexistent"]}`,
    'README.md': '# empty\n',
  });
  try {
    // The arg does NOT resolve (no such file on disk) → the empty-program note fires (unresolved).
    const note = String(okData(await p.op('importers_of', { module: 'src/nope.ts' })).note);
    assert.match(note, /primary program covers no files/i, note);
    assert.doesNotMatch(
      note,
      /Pass a repo-relative path/i,
      'the misleading arg-blame steer is NOT shown for a degenerate program',
    );
  } finally {
    await p.dispose();
  }
});

test('importers_of: an EXISTING-file arg under a degenerate primary is resolved:true — the note must NOT claim non-resolution', async () => {
  // `resolveModuleArg` resolves via `ts.sys.fileExists`, INDEPENDENT of the primary's (empty) file
  // set, so an existing file is `resolved:true` even under an empty `include`. The empty-program note
  // (gated on `unresolved`) must NOT fire — it would contradict `resolved:true` (a self-lie, §3).
  const p: TestProject = await project({
    'package.json': '{"name":"root","private":true}',
    'tsconfig.json': `{"compilerOptions":{${C}},"include":["nonexistent"]}`,
    'src/a.ts': 'export const a = 1;\n',
  });
  try {
    const r = await p.op('importers_of', { module: 'src/a.ts' });
    const d = okData(r);
    assert.equal(d.resolved, true, 'the existing file resolves via fileExists');
    const note = String(d.note);
    assert.doesNotMatch(
      note,
      /did not resolve|primary program covers no files/i,
      `no non-resolution claim beside resolved:true: ${note}`,
    );
    assert.match(note, /0 importers/i, note);
  } finally {
    await p.dispose();
  }
});

test('importers_of: a HEALTHY primary still arg-blames a genuinely unresolvable specifier (no over-trigger)', async () => {
  const p: TestProject = await project({
    'package.json': '{"name":"root","private":true}',
    'tsconfig.json': `{"compilerOptions":{${C}},"include":["src"]}`,
    'src/a.ts': 'export const a = 1;\n',
  });
  try {
    const note = String(
      okData(await p.op('importers_of', { module: 'totally/bogus/path.ts' })).note,
    );
    assert.match(note, /module unresolved/i, note);
    assert.doesNotMatch(note, /primary program covers no files/i, 'the program is healthy');
  } finally {
    await p.dispose();
  }
});
