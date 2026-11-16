// `name+file` that anchors no TOP-LEVEL declaration (t-406178): the miss names what the file does
// declare under that name, and prints a pasteable `file:line:col` only where that position resolves
// back to the listed declaration on the checker path.
//
// Oracle: round-trip through the canonical, unchanged `find_definition {file,line,col}`. A printed
// position must mint the SymbolId of exactly that position (the id encodes its declaration site); an
// entry printed by line only must, at its name token, resolve to a DIFFERENT site — the reason it is
// not offered as an address.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const A =
  "import { helper } from './b';\n" + // 1: an import specifier
  'export interface Shape { area(): number }\n' + // 2: a method signature
  'export class Box implements Shape {\n' + // 3
  '  get size(): number { return 1; }\n' + // 4: a getter
  '  area(): number { return 2; }\n' + // 5: a class method
  '}\n' + // 6
  'export const shapeLike: Shape = { area() { return 3; } };\n' + // 7: contextually typed literal method
  'export function outer(): number {\n' + // 8
  '  function inner(): number { return helper(); }\n' + // 9: a nested function
  '  return inner();\n' + // 10
  '}\n' + // 11
  'export const api = { load: async (): Promise<number> => 1 };\n' + // 12: an arrow-valued property
  "export const r1 = { run: () => 1 }, r2 = { 'run': () => 2 };\n" + // 13: ident + string-literal keys
  'export const { value } = {} as Record<string, number>;\n'; // 14: go-to-definition returns nothing
const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/a.ts': A,
  'src/b.ts': 'export function helper(): number { return 0; }\n',
};

function failMsg(r: OpResult): string {
  assert.ok('result' in r && !r.result.ok, `expected a FAIL, got ${JSON.stringify(r)}`);
  return r.result.failure.message;
}
function defId(r: OpResult): string {
  assert.ok('result' in r && r.result.ok, `expected ok: ${JSON.stringify(r)}`);
  // The FIRST definition is what `source` prints for the same address.
  const id = (r.result.data as { definitions?: { id?: string }[] }).definitions?.[0]?.id;
  assert.ok(typeof id === 'string', `no definition id: ${JSON.stringify(r)}`);
  return id;
}
const positions = (msg: string): { line: number; col: number }[] =>
  [...msg.matchAll(/@src\/a\.ts:(\d+):(\d+)/g)].map((m) => ({
    line: Number(m[1]),
    col: Number(m[2]),
  }));
const byLine = (msg: string): number[] =>
  [...msg.matchAll(/ at line (\d+)/g)].map((m) => Number(m[1]));

async function roundTrip(p: TestProject, name: string, msg: string): Promise<void> {
  for (const { line, col } of positions(msg)) {
    const id = defId(await p.op('find_definition', { file: 'src/a.ts', line, col }));
    assert.ok(id.startsWith(`ts:${name}@src/a.ts:${line}:${col}`), `${line}:${col} → ${id}`);
  }
  for (const line of byLine(msg)) {
    const col = (A.split('\n')[line - 1] ?? '').indexOf(name) + 1;
    assert.ok(col > 0, `line ${line} holds '${name}'`);
    const id = defId(await p.op('find_definition', { file: 'src/a.ts', line, col }));
    assert.ok(!id.startsWith(`ts:${name}@src/a.ts:${line}:`), `line ${line} self-resolves: ${id}`);
  }
}

test('name+file miss lists below-top-level declarations; printed positions round-trip, the rest do not', async () => {
  const p: TestProject = await project(FILES);
  try {
    const area = failMsg(await p.op('find_definition', { name: 'area', file: 'src/a.ts' }));
    assert.match(area, /found 3 'area'/, area);
    assert.match(area, /a floor/, 'the count is not claimed as a total');
    assert.deepEqual(
      positions(area).map((x) => x.line),
      [2, 5],
      'signature + class method are addresses',
    );
    assert.deepEqual(byLine(area), [7], 'the contextually typed literal method is line-only');
    assert.match(area, /Box\.area \(method\)/);
    await roundTrip(p, 'area', area);

    for (const [name, line] of [
      ['size', 4],
      ['inner', 9],
      ['load', 12],
    ] as const) {
      const msg = failMsg(await p.op('find_definition', { name, file: 'src/a.ts' }));
      assert.deepEqual(
        positions(msg).map((x) => x.line),
        [line],
        msg,
      );
      await roundTrip(p, name, msg);
    }

    const run = failMsg(await p.op('find_definition', { name: 'run', file: 'src/a.ts' }));
    assert.match(run, /found 2 'run'/, `a string-literal key is the same name: ${run}`);

    // No definition at all is not "a different declaration": the line-only reason must hold for both.
    const value = failMsg(await p.op('find_definition', { name: 'value', file: 'src/a.ts' }));
    assert.deepEqual(byLine(value), [14], value);
    assert.ok(!/DIFFERENT/.test(value), `claims a definition it never saw: ${value}`);

    const helper = failMsg(await p.op('find_definition', { name: 'helper', file: 'src/a.ts' }));
    assert.deepEqual(positions(helper), [], 'an import is never offered as an address');
    assert.deepEqual(byLine(helper), [1], helper);
    assert.ok(!/Address one by/.test(helper), 'no address advice when none is addressable');
    await roundTrip(p, 'helper', helper);

    const none = failMsg(await p.op('find_definition', { name: 'zzz', file: 'src/a.ts' }));
    assert.match(none, /NOT proof of absence/, 'an empty list keeps the blind-spot caveat');
  } finally {
    await p.dispose();
  }
});

type SourceData = { unresolved?: unknown[]; redirect?: string };
function sourceData(r: OpResult): SourceData {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as SourceData;
}

test('source: name+file misses get ONE syntactic redirect carrying exactly those targets', async () => {
  const p: TestProject = await project(FILES);
  try {
    const d = sourceData(
      await p.op('source', {
        targets: [
          { name: 'area', file: 'src/a.ts' },
          { name: 'inner', file: 'src/a.ts' },
          { file: 'src/a.ts', line: 99, col: 1 },
          { name: 'outer', file: 'src/a.ts' },
        ],
      }),
    );
    assert.equal(d.unresolved?.length, 3, JSON.stringify(d));
    const redirect = d.redirect ?? '';
    const call = /source \{targets:(\[.*?\]),syntactic:true\}/.exec(redirect);
    assert.ok(call?.[1] !== undefined, redirect);
    assert.deepEqual(
      JSON.parse(call[1]),
      [
        { name: 'area', file: 'src/a.ts' },
        { name: 'inner', file: 'src/a.ts' },
      ],
      'exactly the name+file misses, not the position miss nor the resolved target',
    );

    const byPos = sourceData(
      await p.op('source', { targets: [{ file: 'src/a.ts', line: 99, col: 1 }] }),
    );
    assert.equal(byPos.unresolved?.length, 1);
    assert.equal(byPos.redirect, undefined, 'a position miss is not a name+file miss');
  } finally {
    await p.dispose();
  }
});
