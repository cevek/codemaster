// `find_usages {name, file}` member / re-export fallback (t-755152): a bare name+file that resolves
// NO top-level declaration is not a dead-end. The op resolves `name` as a class/type MEMBER, enum
// member, or re-exported binding IN that file and re-issues by position, disclosing the resolution.
//
// Oracle: a cold, whole-program LS — `getReferencesAtPosition` at the member/specifier declaration
// (the first word-boundary occurrence in the file). The op's reference set must equal exactly that,
// proving the fallback resolves to the SAME symbol a cold LS would and follows a re-export to its
// target (a DIFFERENT LS than the warm daemon's, §16).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { coldReferenceSites } from '../helpers/cold-ls.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type Usage = { span: { file: string; line: number } };
type Data = { usages?: Usage[]; notes?: string[] };

function okData(r: OpResult): Data {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as Data;
}
const sites = (u: Usage[] = []): string[] => u.map((x) => `${x.span.file}:${x.span.line}`).sort();

// A type-alias object MEMBER (`IdGen.next`) — exactly the reported case. `find_usages {name:'next',
// file}` found NO top-level `next` and dead-ended; now it resolves the member and finds its accesses.
const MEMBER_FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/gen.ts':
    'export type IdGen = { next(size: number): string };\n' +
    'export const gen: IdGen = { next: (n) => String(n) };\n',
  'src/use.ts':
    "import { gen } from './gen';\n" +
    'export const y = gen.next(3);\n' +
    'export const z = gen.next(4);\n',
};

test('member fallback: {name,file} on a type MEMBER resolves + finds accesses == cold refs, disclosed', async () => {
  const p: TestProject = await project(MEMBER_FILES);
  try {
    const data = okData(await p.op('find_usages', { name: 'next', file: 'src/gen.ts' }));
    // Independent oracle: cold refs at the member declaration (first `next` in gen.ts).
    const oracle = coldReferenceSites(p.root, 'src/gen.ts', 'next').sort();
    assert.deepEqual(sites(data.usages), oracle, 'member usages == cold reference sites');
    // The two accesses in use.ts are present — the whole point (not just the decl).
    assert.equal((data.usages ?? []).filter((u) => u.span.file === 'src/use.ts').length, 2);
    // The resolution is disclosed as a leading note (§3.6 — agent asked for a top-level, got a member).
    assert.ok(
      (data.notes ?? [])[0]?.includes("resolved 'next' as method of IdGen"),
      `disclosure note leads: ${JSON.stringify(data.notes)}`,
    );
  } finally {
    await p.dispose();
  }
});

// A RE-EXPORTED name (`export { X } from`) — the second reported case. The fallback must FOLLOW the
// specifier to the target symbol and find its DOWNSTREAM usages, not just the barrel line.
const REEXPORT_FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/impl.ts': 'export function useThing(): number {\n  return 1;\n}\n',
  'src/barrel.ts': "export { useThing } from './impl';\n",
  'src/consumer.ts': "import { useThing } from './barrel';\n" + 'export const a = useThing();\n',
};

test('member fallback: {name,file} on a RE-EXPORT follows the specifier to downstream usages == cold refs', async () => {
  const p: TestProject = await project(REEXPORT_FILES);
  try {
    const data = okData(
      await p.op('find_usages', {
        name: 'useThing',
        file: 'src/barrel.ts',
        collapseImports: false,
      }),
    );
    const oracle = coldReferenceSites(p.root, 'src/barrel.ts', 'useThing').sort();
    assert.deepEqual(sites(data.usages), oracle, 're-export usages == cold reference sites');
    // The downstream consumer usage is found — the load-bearing assertion (not only the barrel line).
    assert.ok(
      (data.usages ?? []).some((u) => u.span.file === 'src/consumer.ts'),
      `downstream usage found: ${JSON.stringify(data.usages)}`,
    );
    assert.ok(
      (data.notes ?? [])[0]?.includes("resolved 'useThing' as re-export"),
      `re-export disclosed: ${JSON.stringify(data.notes)}`,
    );
  } finally {
    await p.dispose();
  }
});

// TWO same-named members in one file → an honest pick-list, never a silent pick-one; with a
// member_usages redirect naming a containing type.
const MULTI_FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/multi.ts': 'export class One { doit(): void {} }\nexport class Two { doit(): void {} }\n',
};

test('member fallback: several same-named members → pick-list + member_usages redirect (no silent pick)', async () => {
  const p: TestProject = await project(MULTI_FILES);
  try {
    const r = await p.op('find_usages', { name: 'doit', file: 'src/multi.ts' });
    assert.ok('result' in r && !r.result.ok, JSON.stringify(r));
    const msg = JSON.stringify(r.result.failure);
    assert.match(msg, /2 member\/re-export bindings named 'doit'/);
    assert.match(msg, /member_usages/);
  } finally {
    await p.dispose();
  }
});

test('member fallback: a genuinely-absent name+file keeps the honest top-level dead-end (no phantom member)', async () => {
  const p: TestProject = await project(MEMBER_FILES);
  try {
    const r = await p.op('find_usages', { name: 'noSuchThingXyz', file: 'src/gen.ts' });
    assert.ok('result' in r && !r.result.ok, JSON.stringify(r));
    assert.match(
      JSON.stringify(r.result.failure),
      /no top-level declaration named 'noSuchThingXyz'/,
    );
  } finally {
    await p.dispose();
  }
});
