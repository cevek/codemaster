// §3.3 deep expand_type, oracle = a fresh-from-cold `ts.Program` (§16). NOT circular:
// we check the warm daemon's structural view agrees with an independent cold build of the
// same fixture — catching incremental-update drift, not the checker against itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import ts from 'typescript';
import { project } from '../helpers/project.ts';

type Member = {
  name: string;
  optional: boolean;
  type: string;
  inherited?: boolean;
  members?: Member[];
};
type View = { members?: Member[]; constituents?: string[]; notes?: string[] };

const DTO = `export interface Base { id: number; }
export interface User extends Base {
  name: string;
  email?: string;
  address: { city: string; zip: number };
}
export type Status = 'active' | 'inactive';
`;

/** Independent oracle: a cold ts.Program over the same file, reading the same
 *  {name, optional, type} set the warm checker should produce. */
function coldMembers(
  root: string,
  fileRel: string,
  typeName: string,
): Omit<Member, 'inherited' | 'members'>[] {
  const file = path.join(root, fileRel);
  const program = ts.createProgram([file], { strict: true });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(file);
  assert.ok(sf !== undefined);
  let nameNode: ts.Identifier | undefined;
  sf.forEachChild((node) => {
    if (
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      node.name.text === typeName
    ) {
      nameNode = node.name;
    }
  });
  assert.ok(nameNode !== undefined, `oracle could not find ${typeName}`);
  const symbol = checker.getSymbolAtLocation(nameNode);
  assert.ok(symbol !== undefined);
  const type = checker.getApparentType(checker.getDeclaredTypeOfSymbol(symbol));
  return type
    .getProperties()
    .map((p) => ({
      name: p.getName(),
      optional: (p.flags & ts.SymbolFlags.Optional) !== 0,
      type: checker.typeToString(
        checker.getTypeOfSymbolAtLocation(p, nameNode as ts.Node),
        undefined,
        ts.TypeFormatFlags.NoTruncation,
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

test('expand_type members equal a cold ts.Program view; optional + inherited correct', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/dto.ts': DTO,
  });
  try {
    const r = await p.op('expand_type', { name: 'User', depth: 2 });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as View;
    const members = view.members ?? [];

    // Oracle comparison: same {name, optional, type} set as a cold build.
    const warmSet = members
      .map((m) => ({ name: m.name, optional: m.optional, type: m.type }))
      .sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(warmSet, coldMembers(p.root, 'src/dto.ts', 'User'));

    // `id` is inherited from Base; `email` is optional.
    assert.equal(members.find((m) => m.name === 'id')?.inherited, true);
    assert.equal(members.find((m) => m.name === 'email')?.optional, true);

    // depth:2 expanded the anonymous `address` object literal into its own members.
    const address = members.find((m) => m.name === 'address');
    assert.deepEqual(
      (address?.members ?? []).map((m) => m.name).sort(),
      ['city', 'zip'],
      'nested object literal expanded at depth 2',
    );
  } finally {
    await p.dispose();
  }
});

test('alias to a union expands to constituents, one per arm', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/dto.ts': DTO,
  });
  try {
    const r = await p.op('expand_type', { name: 'Status' });
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as View;
    assert.deepEqual(view.constituents, ['"active"', '"inactive"']);
  } finally {
    await p.dispose();
  }
});

test('enum expands to its members, not union arms (enum dispatched before union)', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/e.ts': 'export enum Color {\n  Red,\n  Green,\n  Blue,\n}\n',
  });
  try {
    const r = await p.op('expand_type', { name: 'Color' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as View;
    assert.deepEqual(
      (view.members ?? []).map((m) => m.name),
      ['Red', 'Green', 'Blue'],
      'enum members listed in declaration order',
    );
    assert.equal(view.constituents, undefined, 'an enum is not rendered as union constituents');
  } finally {
    await p.dispose();
  }
});

test('member cap is explicit, never silent', async () => {
  const wide = `export interface Wide { ${Array.from({ length: 8 }, (_, i) => `f${i}: number;`).join(' ')} }\n`;
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/w.ts': wide,
  });
  try {
    const r = await p.op('expand_type', { name: 'Wide', memberLimit: 3 });
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as View;
    assert.equal((view.members ?? []).length, 3, 'only memberLimit members listed');
    assert.ok(
      (view.notes ?? []).some((n) => /… 5 more member\(s\) \(raise memberLimit\)/.test(n)),
      'the 5 hidden members are reported, never silently dropped',
    );
  } finally {
    await p.dispose();
  }
});
