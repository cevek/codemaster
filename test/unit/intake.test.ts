// The liberal-intake layer (§7 Postel) — each class of off-canonical arg shape from the
// dogfood fail log (~/.codemaster/usage/fail.jsonl) is fed in its "bad" spelling and must
// (a) SUCCEED with the SAME result as the canonical spelling — the canonical-form call is the
// oracle, not a golden — and (b) disclose the rewrite via `Result.intake`. Plus the honesty
// boundary: an UNKNOWN key (not an alias) is rejected with the CLEAN canonical hint + a
// did-you-mean, never silently stripped; and the alias metadata never leaks into status.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { builtinOps } from '../../src/ops/builtins.ts';
import { canonicalKeys, arrayFieldsOf } from '../../src/ops/intake/shape-keys.ts';
import { z } from 'zod';
import { FILES, okResult, dataJson, badArgs, posOf, defId } from '../helpers/intake.ts';
import type { JsonValue } from '../../src/core/json.ts';

test('class A — `symbol` is the alias of `name` (find_usages); same result + note', async () => {
  const p: TestProject = await project(FILES);
  try {
    const bad = await p.op('find_usages', { symbol: 'getInitials', collapseImports: false });
    const canon = await p.op('find_usages', { name: 'getInitials', collapseImports: false });
    assert.equal(dataJson(bad), dataJson(canon), 'symbol form == name form');
    assert.deepEqual(okResult(bad).intake, ['symbol→name']);
    assert.deepEqual(okResult(canon).intake, [], 'canonical form fires no rewrite');
  } finally {
    await p.dispose();
  }
});

test('class B — `path`/`file` are aliases of `module` (importers_of); same result + note', async () => {
  const p: TestProject = await project(FILES);
  try {
    const canon = await p.op('importers_of', { module: 'src/util.ts' });
    const byPath = await p.op('importers_of', { path: 'src/util.ts' });
    const byFile = await p.op('importers_of', { file: 'src/util.ts' });
    assert.equal(dataJson(byPath), dataJson(canon), 'path form == module form');
    assert.equal(dataJson(byFile), dataJson(canon), 'file form == module form');
    assert.deepEqual(okResult(byPath).intake, ['path→module']);
    assert.deepEqual(okResult(byFile).intake, ['file→module']);
  } finally {
    await p.dispose();
  }
});

test('class B misfit — `query`/`name` on importers_of (a module-target op) hard-reject, loud (t-138266)', async () => {
  const p: TestProject = await project(FILES);
  try {
    // The `moduleTarget` flag: a symbol-name spelling is the WRONG addressing mode (never resolves
    // to a path), so it rejects with a pointed steer — NOT a silent alias to `module` (which would
    // return a false "0 importers", §3.6). Driven by the per-op flag now, not a central table.
    for (const key of ['query', 'name']) {
      const msg = badArgs(await p.op('importers_of', { [key]: 'getInitials' }));
      assert.match(msg, /looks like a symbol name/, `${key}: pointed misfit steer`);
      assert.match(msg, /module PATH/, `${key}: names the right addressing mode`);
    }
    // The canonical `module` and its `path`/`file` aliases still pass — the flag rejects ONLY the
    // symbol-name misfit keys, never the legitimate module spellings.
    assert.ok(okResult(await p.op('importers_of', { module: 'src/util.ts' })));
    assert.ok(okResult(await p.op('importers_of', { path: 'src/util.ts' })));
  } finally {
    await p.dispose();
  }
});

test('class C — source `symbols`/`sites` → `targets` (SymbolId + file:line:col elements)', async () => {
  const p: TestProject = await project(FILES);
  try {
    const id = defId(await p.op('find_usages', { name: 'getInitials', collapseImports: false }));
    const pos = posOf(id);

    const canonId = await p.op('source', { targets: [{ symbolId: id }] });
    const bySymbols = await p.op('source', { symbols: [id] });
    assert.equal(
      dataJson(bySymbols),
      dataJson(canonId),
      'symbols[SymbolId] == targets[{symbolId}]',
    );
    assert.ok(okResult(bySymbols).intake.includes('symbols→targets'));

    const canonPos = await p.op('source', {
      targets: [{ file: pos.file, line: pos.line, col: pos.col }],
    });
    const bySites = await p.op('source', { sites: [`${pos.file}:${pos.line}:${pos.col}`] });
    assert.equal(
      dataJson(bySites),
      dataJson(canonPos),
      'sites["f:l:c"] == targets[{file,line,col}]',
    );
    assert.ok(okResult(bySites).intake.includes('sites→targets'));
  } finally {
    await p.dispose();
  }
});

test('class C honesty — a col-less `sites` element resolves the line declaration (col not invented)', async () => {
  const p: TestProject = await project(FILES);
  try {
    // `src/util.ts:1` (no column): the resolver takes the SOLE declaration on line 1 (getInitials)
    // — it does NOT fabricate a column, and it does NOT silently drop the target. Identical to
    // addressing the same symbol by name (the canonical oracle).
    const byLine = await p.op('source', { sites: ['src/util.ts:1'] });
    const byName = await p.op('source', { targets: [{ name: 'getInitials' }] });
    assert.equal(
      dataJson(byLine),
      dataJson(byName),
      'col-less line resolves the line declaration == by-name',
    );
    assert.ok(okResult(byLine).intake.includes('sites→targets'));
  } finally {
    await p.dispose();
  }
});

test('class D — scalar coerced to array for an array field (construction_sites pathInclude)', async () => {
  const p: TestProject = await project(FILES);
  try {
    const canon = await p.op('construction_sites', { name: 'Props', pathInclude: ['src'] });
    const scalar = await p.op('construction_sites', { name: 'Props', pathInclude: 'src' });
    assert.equal(dataJson(scalar), dataJson(canon), 'scalar pathInclude == one-element array');
    assert.ok(okResult(scalar).intake.includes('pathInclude→[…]'));
  } finally {
    await p.dispose();
  }
});

// class D is no longer an opt-in allowlist: the coercion is DERIVED from each op's argsSchema
// (a pure ZodArray field), so it fires for ops that never declared `arrayFields`. Oracle =
// equality of the scalar call vs the explicit one-element-array call (the canonical form), per
// op. RED before the fix (each scalar → `bad_args: expected array, received string`).
const AUTO_ARRAY_CASES: ReadonlyArray<{
  op: string;
  base: Record<string, JsonValue>;
  field: string;
}> = [
  { op: 'find_unused_scss_classes', base: {}, field: 'pathInclude' },
  { op: 'search_symbol', base: { query: 'getInitials' }, field: 'pathInclude' },
  { op: 'find_unused_exports', base: {}, field: 'pathExclude' },
];
for (const { op, base, field } of AUTO_ARRAY_CASES) {
  test(`class D (auto) — ${op} ${field} scalar coerced from schema (no per-op allowlist)`, async () => {
    const p: TestProject = await project(FILES);
    try {
      const canon = await p.op(op, { ...base, [field]: ['src'] });
      const scalar = await p.op(op, { ...base, [field]: 'src' });
      assert.equal(dataJson(scalar), dataJson(canon), `scalar ${field} == one-element array`);
      assert.ok(okResult(scalar).intake.includes(`${field}→[…]`), 'rewrite disclosed');
    } finally {
      await p.dispose();
    }
  });
}

test('arrayFieldsOf — detects pure ZodArray (incl. optional/default/nullable wraps), skips union/scalar', () => {
  const schema = z.strictObject({
    plain: z.array(z.string()),
    opt: z.array(z.string()).optional(),
    def: z.array(z.string()).default([]),
    nul: z.array(z.string()).nullable(),
    nested: z.array(z.string()).default([]).optional(),
    // a field that ALREADY accepts a scalar — must NOT be coerced (would break the legit scalar)
    union: z.union([z.string(), z.array(z.string())]).optional(),
    scalar: z.string().optional(),
    obj: z.strictObject({ pathInclude: z.array(z.string()) }).optional(),
  });
  const fields = arrayFieldsOf(schema);
  assert.deepEqual([...fields].sort(), ['def', 'nested', 'nul', 'opt', 'plain']);
  assert.ok(!fields.has('union'), 'a scalar|array union field is left untouched');
  assert.ok(!fields.has('scalar') && !fields.has('obj'), 'non-array fields are not coerced');
});

test('arrayFieldsOf — a non-object (union) schema yields the empty set, never throws', () => {
  assert.equal(arrayFieldsOf(z.union([z.string(), z.number()])).size, 0);
});

test('class D (auto) — find_usages bare-name `symbols:"X"` scalar coerced to array', async () => {
  const p: TestProject = await project(FILES);
  try {
    const canon = await p.op('find_usages', { symbols: ['getInitials'] });
    const scalar = await p.op('find_usages', { symbols: 'getInitials' });
    assert.equal(dataJson(scalar), dataJson(canon), 'scalar symbols == one-element array');
    assert.ok(okResult(scalar).intake.includes('symbols→[…]'), 'rewrite disclosed');
  } finally {
    await p.dispose();
  }
});

test('class E — OpFlags placed inside args are lifted (extract_symbol summaryOnly/apply)', async () => {
  const p: TestProject = await project(FILES);
  try {
    // summaryOnly is OBSERVABLE (omits the diff), so this proves the lift actually ROUTES to
    // ctx.flags, not just that it was accepted: args-placed == top-level-placed.
    const lifted = (
      await p.request([
        {
          name: 'extract_symbol',
          args: { name: 'getInitials', dest: 'src/initials.ts', summaryOnly: true },
        },
      ])
    )[0];
    const canon = (
      await p.request([
        {
          name: 'extract_symbol',
          args: { name: 'getInitials', dest: 'src/initials.ts' },
          summaryOnly: true,
        },
      ])
    )[0];
    assert.ok(lifted !== undefined && canon !== undefined);
    assert.equal(
      dataJson(lifted),
      dataJson(canon),
      'args-placed summaryOnly == top-level summaryOnly',
    );
    assert.deepEqual(okResult(lifted).intake, ['summaryOnly→flag']);

    // apply:false in args lifts too (dry-run, no writes) — note fires, dry-run output matches.
    const applyInArgs = (
      await p.request([
        {
          name: 'extract_symbol',
          args: { name: 'getInitials', dest: 'src/initials.ts', apply: false },
        },
      ])
    )[0];
    assert.ok(applyInArgs !== undefined);
    assert.deepEqual(okResult(applyInArgs).intake, ['apply→flag']);
  } finally {
    await p.dispose();
  }
});

test('class E honesty — a wrong-typed lifted flag is rejected, never silently coerced', async () => {
  const p: TestProject = await project(FILES);
  try {
    const r = await p.op('extract_symbol', {
      name: 'getInitials',
      dest: 'src/initials.ts',
      apply: 'yes',
    });
    assert.match(badArgs(r), /apply: expected boolean/);
  } finally {
    await p.dispose();
  }
});

test('class F — a `name` string of "path:line:col" / "ts:…" is parsed to the right field', async () => {
  const p: TestProject = await project(FILES);
  try {
    const id = defId(await p.op('find_usages', { name: 'getInitials', collapseImports: false }));
    const pos = posOf(id);

    const canon = await p.op('find_definition', { file: pos.file, line: pos.line, col: pos.col });
    const byString = await p.op('find_definition', { name: `${pos.file}:${pos.line}:${pos.col}` });
    assert.equal(dataJson(byString), dataJson(canon), 'name="f:l:c" == file+line+col');
    assert.deepEqual(okResult(byString).intake, ['name→file:line:col']);

    // name carrying a SymbolId → symbolId
    const bySymbolId = await p.op('find_definition', { name: id });
    assert.deepEqual(okResult(bySymbolId).intake, ['name→symbolId']);

    // a plain name is NOT rewritten
    assert.deepEqual(okResult(await p.op('find_definition', { name: 'getInitials' })).intake, []);
  } finally {
    await p.dispose();
  }
});

test('unknown field — rejected with the clean canonical hint + did-you-mean, never stripped', async () => {
  const p: TestProject = await project(FILES);
  try {
    const typo = badArgs(await p.op('find_usages', { symbpl: 'getInitials' }));
    assert.match(typo, /symbpl/, 'the offending key is named');
    assert.match(typo, /did you mean 'symbolId'\?/, 'a close canonical key is suggested');
    assert.match(typo, /symbolId\?: 'ts:…'/, 'the clean canonical argsHint closes the message');
    assert.doesNotMatch(typo, /alias/, 'no alias annotation leaks into the reject');

    const garbage = badArgs(await p.op('find_usages', { zzzqqq: 1 }));
    assert.match(garbage, /zzzqqq/, 'a far-off key is still named (no false suggestion required)');
  } finally {
    await p.dispose();
  }
});

test('INVARIANT — every tsTarget op declares the shared target intake (advisor #1)', () => {
  const checked: string[] = [];
  for (const op of builtinOps()) {
    const keys = canonicalKeys(op.argsSchema);
    if (!(keys.has('symbolId') && keys.has('name'))) continue; // not a top-level tsTarget op
    checked.push(op.name);
    const aliases = op.intake?.aliases ?? {};
    assert.equal(aliases['target'], 'symbolId', `${op.name}: target→symbolId alias missing`);
    assert.equal(aliases['symbol'], 'name', `${op.name}: symbol→name alias missing`);
    assert.equal(aliases['query'], 'name', `${op.name}: query→name alias missing`);
    assert.equal(op.intake?.locationTarget, true, `${op.name}: locationTarget not enabled`);
  }
  // Non-vacuity (advisor): if `canonicalKeys` ever returned empty for a tsTarget op, that op
  // would be silently skipped and its missing intake never caught — the exact failure this
  // guard exists to prevent. Assert the known tsTarget ops were actually reached.
  assert.ok(checked.length >= 7, `expected ≥7 tsTarget ops checked, reached ${checked.join(', ')}`);
});

// An arg-alias leak in any form — `(alias: target)`, a bare `alias target`, `alias symbolId` —
// must fail LOUD. Matches "alias" + separator + a real alias/canonical key, so it catches the
// paren AND non-paren phrasings WITHOUT false-positiving on the legitimate domain uses of the
// word ("@/… aliases resolve via tsconfig paths", "aliased import { X as Y }", the sql `as` alias).
const ALIAS_LEAK = /alias[:\s]+\(?(?:target|symbol|symbolId|module|path|sites)\b/i;

test('ANTI-LEAK — no op argsHint carries an alias annotation; status hides intake', async () => {
  for (const op of builtinOps()) {
    // argsHint is the advertised shape — it must never say "alias" in ANY form.
    assert.doesNotMatch(op.argsHint, /alias/i, `${op.name}: argsHint leaks an alias annotation`);
  }
  const p: TestProject = await project(FILES);
  try {
    const status = await p.status();
    assert.doesNotMatch(status, ALIAS_LEAK, 'status leaks an arg alias (paren or bare)');
    assert.doesNotMatch(status, /\bintake\b/, 'status leaks the internal intake metadata');
  } finally {
    await p.dispose();
  }
});
