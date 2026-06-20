// `target` as the SymbolId alias of `symbolId` (DX feedback): agents naturally address a held
// handle under `target`, and the old strictObject rejected it as bad_args. The alias is collapsed
// to `symbolId` at the one resolver chokepoint, so EVERY symbol-addressed op accepts either spelling.
//
// Oracle: the alias must produce the SAME answer as the canonical `symbolId` form AND match the
// hand-curated semantic ground truth (the fixture is input; the expected set is written here, not
// read back from a second LS — §16). An alias that silently changed the result would be the §3 lie
// this guards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type Usage = { span: { file: string; line: number; col: number }; role: string };

const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}',
  'src/Button.tsx':
    'export interface Props { size: string }\n' +
    'export const Button = (p: Props) => <button>{p.size}</button>;\n',
  'src/App.tsx':
    "import { Button as B } from './Button';\n" + 'export const App = () => <B size="lg" />;\n',
};

function usagesOf(r: OpResult): Usage[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return (r.result.data as { usages?: Usage[] }).usages ?? [];
}
function definitionId(r: OpResult): string {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  const id = (r.result.data as { definition?: { id?: string } }).definition?.id;
  assert.ok(typeof id === 'string' && id.startsWith('ts:'), `expected a ts: SymbolId, got ${id}`);
  return id;
}
const projset = (u: Usage[]): string[] =>
  u.map((x) => `${x.span.file}:${x.span.line}:${x.role}`).sort();

test('find_usages accepts target as the alias of symbolId — identical to the symbolId form and to ground truth', async () => {
  const p: TestProject = await project(FILES);
  try {
    // Mint a real SymbolId via the canonical `symbolId`-yielding path.
    const id = definitionId(await p.op('find_usages', { name: 'Button', collapseImports: false }));

    const bySymbol = usagesOf(await p.op('find_usages', { symbolId: id, collapseImports: false }));
    const byTarget = usagesOf(await p.op('find_usages', { target: id, collapseImports: false }));

    // Equivalence: the alias resolves to the same symbol, same answer.
    assert.deepEqual(projset(byTarget), projset(bySymbol), 'target form == symbolId form');

    // Independent oracle: the hand-read semantic set for Button under this fixture.
    assert.deepEqual(
      projset(byTarget),
      [
        'src/App.tsx:1:import',
        'src/App.tsx:1:import',
        'src/App.tsx:2:jsx',
        'src/Button.tsx:2:decl',
      ].sort(),
      'target form returns EXACTLY the hand-curated semantic set',
    );
  } finally {
    await p.dispose();
  }
});

test('the alias is honored across symbol-addressed ops (not just find_usages) and no longer bad_args', async () => {
  const p: TestProject = await project(FILES);
  try {
    const id = definitionId(await p.op('find_usages', { name: 'Button', collapseImports: false }));

    // A DIFFERENT op proves the alias lives at the shared resolver, not in find_usages alone.
    const def = await p.op('find_definition', { target: id });
    assert.ok(
      'result' in def && def.result.ok,
      `target accepted by find_definition: ${JSON.stringify(def)}`,
    );
    const defs =
      (def.result.data as { definitions?: { span: { file: string } }[] }).definitions ?? [];
    assert.ok(
      defs.some((d) => d.span.file === 'src/Button.tsx'),
      'find_definition by target resolves to the declaration',
    );

    // The old failure mode: {target:'ts:…'} rejected as bad_args. It must now dispatch.
    const r = await p.op('find_usages', { target: id });
    assert.ok('result' in r, `target must dispatch, never bad_args: ${JSON.stringify(r)}`);
  } finally {
    await p.dispose();
  }
});

// H1 regression (BugReviewer-2, §3.6-self-contradiction): the MUTATING ops built a manual target
// literal WITHOUT args.target, so the schema accepted `target` but resolveTarget saw all-undefined
// and failed "target needs symbolId, file+line+col, or name". They now route through `targetOf`. A
// dry-run must RESOLVE the target identically to the `symbolId` spelling, never the self-contradiction.
test('mutating ops resolve `target` identically to `symbolId` (H1: no manual-literal bypass)', async () => {
  const p: TestProject = await project(FILES);
  try {
    const id = definitionId(await p.op('find_usages', { name: 'Button', collapseImports: false }));

    // rename_symbol (run + the referenceSpans path) — dry-run, both spellings.
    const bySymbol = await p.op('rename_symbol', { symbolId: id, newName: 'Renamed' });
    const byTarget = await p.op('rename_symbol', { target: id, newName: 'Renamed' });
    assert.ok('result' in bySymbol && bySymbol.result.ok, JSON.stringify(bySymbol));
    assert.ok(
      'result' in byTarget && byTarget.result.ok,
      `rename_symbol {target} must resolve, not self-contradict: ${JSON.stringify(byTarget)}`,
    );
    // Same plan from either spelling — the alias is purely an addressing synonym.
    assert.deepEqual(
      (byTarget.result.data as { touched?: unknown }).touched,
      (bySymbol.result.data as { touched?: unknown }).touched,
      'target and symbolId produce the same rename plan',
    );

    // A second mutating op proves the fix is not rename-specific.
    const csTarget = await p.op('change_signature', { target: id, removeParam: 0 });
    assert.ok(
      'result' in csTarget,
      `change_signature {target} must dispatch + resolve, never bad_args / self-contradiction: ${JSON.stringify(csTarget)}`,
    );
    // Whatever the plan verdict, it must NOT be the "target needs …" resolution failure.
    assert.doesNotMatch(
      JSON.stringify(csTarget),
      /target needs symbolId, file\+line\+col, or name/,
      'change_signature resolved the target (no manual-literal bypass)',
    );
  } finally {
    await p.dispose();
  }
});

// A bare name under `symbolId` (or its `target` alias) is the friction this hardening fixes: a
// SymbolId has a clear shape (`ts:Name@file:line:col`), so a value with no plugin prefix is
// unambiguously a misplaced name. The op must FAIL with a message that points the agent at `name`,
// never an opaque "not a SymbolId" — and never silently coerce it (that would be input-guessing).
test('a bare name under symbolId/target fails with a pointed "use name" message', async () => {
  const p: TestProject = await project(FILES);
  try {
    for (const key of ['symbolId', 'target'] as const) {
      const r = await p.op('find_usages', { [key]: 'Button' });
      assert.ok(
        'result' in r && !r.result.ok,
        `bare name under ${key} must FAIL: ${JSON.stringify(r)}`,
      );
      const msg = JSON.stringify(r);
      assert.match(msg, /not a SymbolId/, `${key}: states it is not a SymbolId`);
      assert.match(msg, /pass it under 'name'/, `${key}: points the agent at the name field`);
    }
  } finally {
    await p.dispose();
  }
});

// A `file:line:col` position pasted into `symbolId` decodes to a phantom plugin prefix (split on the
// first `:`), but its payload has no `@` — it is NOT a SymbolId. It must be steered to file+line+col,
// never told it "belongs to plugin 'src/Button.tsx'" (a message that names a nonexistent plugin).
test('a file:line:col position under symbolId is steered to file+line+col, not a phantom plugin', async () => {
  const p: TestProject = await project(FILES);
  try {
    const r = await p.op('find_usages', { symbolId: 'src/Button.tsx:14:8' });
    assert.ok('result' in r && !r.result.ok, `a position string must FAIL: ${JSON.stringify(r)}`);
    const msg = JSON.stringify(r);
    assert.match(msg, /not a SymbolId/, 'states it is not a SymbolId');
    assert.match(msg, /file\+line\+col/, 'points the agent at the position fields');
    assert.doesNotMatch(
      msg,
      /belongs to plugin/,
      'never names a phantom plugin for a position string',
    );
  } finally {
    await p.dispose();
  }
});

// A real SymbolId of ANOTHER plugin (scss:/i18n:) DOES decode (its payload carries `@`), so it must
// hit the foreign-plugin branch — named honestly, never confused with the bare-name path.
test('a non-ts SymbolId is rejected as a foreign-plugin id, not as a bare name', async () => {
  const p: TestProject = await project(FILES);
  try {
    const r = await p.op('find_usages', { symbolId: 'scss:.btn@src/x.module.scss:3:1' });
    assert.ok('result' in r && !r.result.ok, `a foreign-plugin id must FAIL: ${JSON.stringify(r)}`);
    const msg = JSON.stringify(r);
    assert.match(msg, /belongs to plugin 'scss'/, 'names the owning plugin');
    assert.doesNotMatch(
      msg,
      /not a SymbolId/,
      'a real foreign SymbolId is not mislabeled a bare name',
    );
  } finally {
    await p.dispose();
  }
});
