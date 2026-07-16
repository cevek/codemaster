// t-246435 — the destructure role classifier, made concrete on both directions the shared
// `destructureRole` verdict must get right (the fixture is input; ground truth is hand-curated here):
//   · a member reference read OUT via a destructuring pattern is a `read`, not a `write` — the LS
//     marks the pattern token `isWriteAccess`, so the classifier's fallthrough would present a read as
//     a `write` (§3 role mislabel; `member_usages` classifies the same token `destructure`).
//   · the fix widened that classifier into the GENERAL find_usages path, which — unlike the
//     always-member `member_usages` path — can target the LOCAL a destructure WRITES; a genuine local
//     write must NOT be fabricated into a `read` (§3). The value token of `({email: local}=u)` and the
//     dual-role SHORTHAND token of `({local}=u)` both stay `write`.
// The DISCRIMINANTS keep a genuine reassignment `u.email = x` a `write` and a plain `u.email` a `read`,
// so the fix is surgical — "destructure ≠ write" is not "all writes → reads".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type Usage = { span: { file: string; line: number; col: number }; role: string };
function usagesOf(r: OpResult): Usage[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return (r.result.data as { usages?: Usage[] }).usages ?? [];
}
const has = (u: Usage[], file: string, line: number, role: string): boolean =>
  u.some((x) => x.span.file === file && x.span.line === line && x.role === role);

test('destructure of a member is `read`, a genuine reassignment stays `write`', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/u.ts':
      'export interface User { email: string }\n' + // property decl, line 1
      'declare const u: User;\n' +
      'const { email } = u;\n' + // line 3: BINDING destructure → read (was mislabeled `write`)
      'let e2 = "";\n' +
      '({ email: e2 } = u);\n' + // line 5: ASSIGNMENT destructure, `email` key → read
      'u.email = "x";\n' + // line 6: genuine write → write (the discriminant)
      'export const r = u.email;\n', // line 7: plain read → read
  });
  try {
    const u = usagesOf(
      await p.op('find_usages', { name: 'email', file: 'src/u.ts', collapseImports: false }),
    );
    assert.ok(has(u, 'src/u.ts', 3, 'read'), 'binding destructure `const {email}=u` is `read`');
    assert.ok(
      has(u, 'src/u.ts', 5, 'read'),
      'assignment destructure key `({email: e}=u)` is `read`',
    );
    assert.ok(
      has(u, 'src/u.ts', 6, 'write'),
      'DISCRIMINANT: the genuine reassignment `u.email = x` stays `write`',
    );
    assert.ok(has(u, 'src/u.ts', 7, 'read'), 'a plain `u.email` read is `read`');
    assert.ok(
      !has(u, 'src/u.ts', 3, 'write'),
      'the destructure is NOT the mislabeled `write` (bug)',
    );
    assert.ok(!has(u, 'src/u.ts', 5, 'write'), 'the assignment destructure key is NOT a `write`');
  } finally {
    await p.dispose();
  }
});

test('find_usages on a LOCAL written via assignment-destructure stays `write`, not `read`', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/l.ts':
      'declare const u: { email: string };\n' +
      'export let stored = "";\n' + // line 2: local decl
      '({ email: stored } = u);\n' + // line 3: `stored` VALUE token is a WRITE of the local
      'export let email = "";\n' + // line 4: local decl
      '({ email } = u);\n', // line 5: SHORTHAND token is a WRITE of the local `email`
  });
  try {
    const us = usagesOf(
      await p.op('find_usages', { name: 'stored', file: 'src/l.ts', collapseImports: false }),
    );
    assert.ok(
      has(us, 'src/l.ts', 3, 'write'),
      'the VALUE token of `({email: stored}=u)` is a genuine local write',
    );
    assert.ok(
      !has(us, 'src/l.ts', 3, 'read'),
      'a local write is NOT fabricated into a `read` (§3)',
    );

    const ue = usagesOf(
      await p.op('find_usages', { file: 'src/l.ts', line: 4, col: 12, collapseImports: false }),
    );
    assert.ok(
      has(ue, 'src/l.ts', 5, 'write'),
      'the SHORTHAND `({email}=u)` token is a genuine write of the local `email`',
    );
    assert.ok(
      !has(ue, 'src/l.ts', 5, 'read'),
      'the ambiguous shorthand local write is NOT a `read`',
    );
  } finally {
    await p.dispose();
  }
});
