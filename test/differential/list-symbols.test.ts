// t-143952 — the honesty gate for `list_symbols` (the flat, no-program, per-tsconfig symbol-name
// catalogue). Four claims, each against an INDEPENDENT oracle (never grep, never golden-only):
//   1. ⊇ oracle — the syntactic catalogue (default exportedOnly) is a SUPERSET of a cold `ts.Program`
//      checker's exported-symbol names (a genuinely independent path: checker vs our getNamedDeclarations
//      syntactic scan). A miss would be a §3.4 completeness lie.
//   2. group-per-tsconfig + shared-file — a src file included by BOTH tsconfig.json and
//      tsconfig.test.json lands under ONE primary group (tsconfig.json, the same-dir base tie-break),
//      flagged `(shared: also in …)`, NEVER double-counted into the test group, NEVER dropped from the
//      global set. A test-only file lands under the test config.
//   3. cap — a per-group `limit` returns a `+N more` marker + the envelope truncation, never a silent cut.
//   4. no-warm + determinism — the op NEVER warms the LS (the OOM-safe invariant), and two calls agree
//      (cold == warm is trivially held since it never warms; determinism is the observable proof).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { project, type TestProject } from '../helpers/project.ts';
import type { JsonValue } from '../../src/core/json.ts';

/** A repo included by two configs: `src/shared.ts` is in BOTH (tsconfig + tsconfig.test); `test/only.ts`
 *  is in the test config only. Enough top-level exports to exercise the per-group cap. */
const REPO: Record<string, string> = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'tsconfig.test.json': '{"compilerOptions":{"strict":true},"include":["src","test"]}',
  'src/shared.ts': [
    'export const SharedThing = 1;',
    'export function sharedFn() { return SharedThing; }',
    'export interface SharedProps { a: string }',
    'const localOnly = 3;', // a NON-exported local — must be absent under default exportedOnly
    'export type SharedKind = "x" | "y";',
    'void localOnly;',
  ].join('\n'),
  'test/only.ts': [
    'export const TestOnlyThing = 2;',
    'export function testHelper() { return TestOnlyThing; }',
  ].join('\n'),
};

interface GroupRow {
  config: string;
  shown: number;
  total: number;
  names: string;
  alsoIn?: string[];
  more?: string;
}
interface CatalogueData {
  names: number;
  groups: number;
  catalogue: GroupRow[];
}

async function listSymbols(p: TestProject, args: JsonValue): Promise<CatalogueData> {
  const [res] = await p.request([{ name: 'list_symbols', args }]);
  assert.ok(res !== undefined && 'result' in res, 'list_symbols dispatched');
  assert.ok(res.result.ok, 'list_symbols ok');
  return res.result.data as unknown as CatalogueData;
}

/** The names in a group, split back out of the flat comma blob (`''` → `[]`). */
function namesOf(group: GroupRow | undefined): string[] {
  if (group === undefined || group.names.length === 0) return [];
  return group.names.split(', ');
}
function groupFor(data: CatalogueData, config: string): GroupRow | undefined {
  return data.catalogue.find((g) => g.config === config);
}
/** Every name across every group (the global surface the flat blob dedups). */
function allNames(data: CatalogueData): Set<string> {
  const out = new Set<string>();
  for (const g of data.catalogue) for (const n of namesOf(g)) out.add(n);
  return out;
}

/** INDEPENDENT oracle: a cold `ts.Program` checker's exported-symbol names, unioned across the
 *  program's own (non-lib, in-root) source files. Checker-based — no shared logic with the syntactic
 *  getNamedDeclarations scan under test. `default` is dropped (an anonymous default export has no name
 *  in the syntactic scan, so it is not part of the name catalogue). */
function coldExportedNames(root: string, configRel: string): Set<string> {
  const configPath = path.join(root, configRel);
  const { config } = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8')) as {
    config: unknown;
  };
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const rootPrefix = `${root.replace(/\\/g, '/')}/`;
  const out = new Set<string>();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!sf.fileName.replace(/\\/g, '/').startsWith(rootPrefix)) continue;
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (moduleSymbol === undefined) continue;
    for (const exp of checker.getExportsOfModule(moduleSymbol)) {
      if (exp.name !== 'default') out.add(exp.name);
    }
  }
  return out;
}

test('list_symbols ⊇ cold-checker exported names (§3.4 completeness, independent oracle)', async () => {
  const p = await project(REPO);
  try {
    const data = await listSymbols(p, { limit: 1000 });
    const got = allNames(data);
    // Oracle over BOTH programs (the test config is a superset that also covers test/only.ts).
    const oracle = coldExportedNames(p.root, 'tsconfig.test.json');
    assert.ok(oracle.size > 0, 'oracle non-vacuous (cold checker found exports)');
    const missing = [...oracle].filter((n) => !got.has(n));
    assert.equal(
      missing.length,
      0,
      `catalogue MUST ⊇ cold-checker exports — missing: ${missing.join(', ')}`,
    );
    // Discriminating: a NON-exported local must NOT appear under the default (exportedOnly) surface —
    // proves exportedOnly is really filtering, not dumping everything.
    assert.ok(!got.has('localOnly'), 'non-exported local absent under default exportedOnly');
    // …and IS present with all:true (proves the flag widens the surface, not a coincidental absence).
    const all = allNames(await listSymbols(p, { all: true, limit: 1000 }));
    assert.ok(all.has('localOnly'), 'all:true adds the non-exported local');
  } finally {
    await p.dispose();
  }
});

test('group-per-tsconfig: a shared src file is NOT double-counted nor dropped', async () => {
  const p = await project(REPO);
  try {
    const data = await listSymbols(p, { limit: 1000 });
    const base = groupFor(data, 'tsconfig.json');
    const testCfg = groupFor(data, 'tsconfig.test.json');
    assert.ok(base !== undefined, 'a tsconfig.json group exists');
    assert.ok(testCfg !== undefined, 'a tsconfig.test.json group exists');

    // src/shared.ts is in BOTH configs → primary is the same-dir base tsconfig.json; its symbols land
    // there and NOWHERE else. The group is flagged shared.
    assert.ok(namesOf(base).includes('SharedThing'), 'shared symbol in the primary (base) group');
    assert.ok(
      !namesOf(testCfg).includes('SharedThing'),
      'shared symbol NOT double-counted into the test group',
    );
    assert.deepEqual(
      base.alsoIn,
      ['tsconfig.test.json'],
      'primary group flagged (shared: also in tsconfig.test.json)',
    );

    // test/only.ts is in the test config ONLY → its symbols land under tsconfig.test.json.
    assert.ok(namesOf(testCfg).includes('TestOnlyThing'), 'test-only symbol under the test config');
    assert.ok(
      !namesOf(base).includes('TestOnlyThing'),
      'test-only symbol not leaked into the base group',
    );

    // NOT dropped: the shared symbol IS in the global surface exactly once.
    assert.ok(allNames(data).has('SharedThing'), 'shared symbol present globally (never dropped)');
    assert.equal(
      data.catalogue.filter((g) => namesOf(g).includes('SharedThing')).length,
      1,
      'shared symbol appears in exactly one group',
    );
  } finally {
    await p.dispose();
  }
});

test('per-group cap emits a +N more marker + envelope truncation (never a silent cut)', async () => {
  const p = await project(REPO);
  try {
    // The base group has 4 exported names (SharedThing, sharedFn, SharedProps, SharedKind) — cap at 2.
    const [res] = await p.request([{ name: 'list_symbols', args: { limit: 2 } }]);
    assert.ok(res !== undefined && 'result' in res && res.result.ok);
    const data = res.result.data as unknown as CatalogueData;
    const base = groupFor(data, 'tsconfig.json');
    assert.ok(base !== undefined && base.total > base.shown, 'the base group was capped');
    assert.equal(base.shown, 2, 'shown honours the cap');
    assert.match(String(base.more), /\+\d+ more/, 'capped group carries a +N more marker');
    assert.equal(namesOf(base).length, 2, 'only `shown` names emitted');
    // The envelope truncation is the count-only-consumer channel — present whenever any group capped.
    assert.ok(
      (res.result as { truncated?: unknown }).truncated !== undefined,
      'envelope truncation present',
    );
  } finally {
    await p.dispose();
  }
});

// A separately-exported name + members — the two §3.4 recall traps the bug review surfaced.
const SEP_AND_MEMBERS: Record<string, string> = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'src/a.ts': [
    'const Foo = 1;',
    'export { Foo };', // exported by a SEPARATE statement (barrel idiom)
    'export const Bar = 2;',
    'export class Widget {',
    '  render() { return Foo; }',
    '  get val() { return 1; }',
    '}',
    'export enum Color { Red, Blue }',
  ].join('\n'),
};

test('kind filter keeps a separately-exported name (`const Foo; export {Foo}`) — BLOCK 1 §3.4', async () => {
  const p = await project(SEP_AND_MEMBERS);
  try {
    // The decl node carries the kind (`const`), the export-specifier node carries the export — the
    // predicates must be satisfied ACROSS the node set, or Foo is silently dropped under kind:const.
    const names = allNames(await listSymbols(p, { kind: 'const', limit: 1000 }));
    assert.ok(names.has('Foo'), 'separately-exported `const Foo` kept under kind:const');
    assert.ok(names.has('Bar'), 'inline-exported `const Bar` kept');
  } finally {
    await p.dispose();
  }
});

test('members are NOT catalogued; the container IS (BLOCK 2 §3.4 — no confident empty on an advertised kind)', async () => {
  const p = await project(SEP_AND_MEMBERS);
  try {
    const all = allNames(await listSymbols(p, { all: true, limit: 1000 }));
    assert.ok(all.has('Widget'), 'the class Widget is catalogued');
    assert.ok(all.has('Color'), 'the enum Color is catalogued');
    assert.ok(!all.has('render'), 'a method (member) is NOT catalogued');
    assert.ok(!all.has('val'), 'an accessor (member) is NOT catalogued');
    assert.ok(!all.has('Red'), 'an enum member is NOT catalogued');
    // A member kind yields nothing (members out of scope) rather than a silent empty on a query the
    // agent would read as "no methods exist" — the honest behavior is: not catalogued, so no match.
    const methods = allNames(await listSymbols(p, { kind: 'method', all: true, limit: 1000 }));
    assert.equal(methods.size, 0, 'kind:method yields nothing (members not catalogued)');
  } finally {
    await p.dispose();
  }
});

test('list_symbols never warms the LS (OOM-safe) + is deterministic (cold == warm)', async () => {
  const p = await project(REPO);
  try {
    const first = await listSymbols(p, { limit: 1000 });
    // The ts plugin must still be cold: no program built, no LS warmed (the whole OOM-safety point).
    const status = await p.orchestrator.status(p.root, p.root);
    const tsPlugin = status.workspace?.plugins.find((x) => x.id === 'ts');
    assert.equal(
      tsPlugin?.fingerprint,
      'cold',
      'list_symbols must NOT warm the LS / build a program',
    );
    // Determinism: a second identical call returns byte-identical group data.
    const second = await listSymbols(p, { limit: 1000 });
    assert.deepEqual(
      second.catalogue,
      first.catalogue,
      'two calls agree (deterministic → cold == warm)',
    );
  } finally {
    await p.dispose();
  }
});
