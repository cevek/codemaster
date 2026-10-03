// move_symbol / extract_symbol for a consumer that reaches the moved symbol through a namespace
// import (`import * as M from './model'` + `M.moved()`), t-932492. The LS inserts its own namespace
// import of the dest under a preferred name while repointing refs to a uniquified one, and never
// reuses a namespace import of the dest the consumer already has. Oracle: a cold `ts.Program` over the
// post-apply tree — compile errors, how many value namespace imports of dest the consumer holds, and
// which file each `X.moved` access binds to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { coldDiagnostics, coldProgram } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project, type TestProject } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';
const MODEL =
  'export interface Model { name: string; desc: string }\n' +
  'export function setName(m: Model, v: string): Model { return { ...m, name: v }; }\n' +
  'export function setDesc(m: Model, v: string): Model { return { ...m, desc: v }; }\n' +
  'export function keep(m: Model): Model { return m; }\n';

async function applyOp(p: TestProject, name: string, args: JsonValue): Promise<void> {
  const [r] = await p.request([{ name, args, apply: true }]);
  assert.ok(r !== undefined && 'result' in r && r.result.ok, JSON.stringify(r));
  const env = r.result.data as unknown as { typecheck: { clean: boolean }; applied?: boolean };
  assert.equal(env.typecheck.clean, true, JSON.stringify(env));
  assert.equal(env.applied, true);
}

interface NsView {
  destNsImports: number; // value `import * as X` in the consumer resolving to dest
  boundTo: Map<string, string>; // moved member → repo-rel file its `X.member` access binds to
}

function nsView(root: string, consumerRel: string, destRel: string, moved: string[]): NsView {
  const { program, checker } = coldProgram(root);
  const real = (f: string): string => realpathSync(f);
  const destAbs = real(path.join(root, destRel));
  const sf = program.getSourceFile(path.join(root, consumerRel));
  assert.ok(sf !== undefined, `${consumerRel} not in the cold program`);
  let destNsImports = 0;
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const clause = stmt.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    if (clause.namedBindings === undefined || !ts.isNamespaceImport(clause.namedBindings)) continue;
    const decl = checker.getSymbolAtLocation(stmt.moduleSpecifier)?.declarations?.[0];
    if (decl !== undefined && real(decl.getSourceFile().fileName) === destAbs) destNsImports++;
  }
  const boundTo = new Map<string, string>();
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && moved.includes(n.name.text)) {
      const file = checker.getSymbolAtLocation(n.name)?.declarations?.[0]?.getSourceFile().fileName;
      boundTo.set(n.name.text, file === undefined ? '?' : path.relative(root, real(file)));
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return { destNsImports, boundTo };
}

function assertBoundToDest(view: NsView, destRel: string, moved: string[]): void {
  for (const m of moved) assert.equal(view.boundTo.get(m), destRel, `${m} binds to dest`);
}

test('move_symbol into a dest the consumer already namespace-imports reuses that import', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/model.ts': MODEL,
    'src/i18n.ts': 'export const other = 1;\n',
    'src/ui/use.ts':
      "import * as M from '../model';\nimport * as i18n from '../i18n';\n" +
      'export const run = (m: M.Model): M.Model => M.keep(M.setName(m, String(i18n.other)));\n',
  });
  try {
    await applyOp(p, 'move_symbol', { name: 'setName', file: 'src/model.ts', dest: 'src/i18n.ts' });
    assert.deepEqual(coldDiagnostics(p.root), []);
    const view = nsView(p.root, 'src/ui/use.ts', 'src/i18n.ts', ['setName']);
    assert.equal(view.destNsImports, 1, 'no second namespace import of dest');
    assertBoundToDest(view, 'src/i18n.ts', ['setName']);
  } finally {
    await p.dispose();
  }
});

test('move_symbol reuses an existing namespace import of dest under a different alias', async () => {
  // typecheck-clean even without the fix — only the import count discriminates here.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/model.ts': MODEL,
    'src/i18n.ts': 'export const other = 1;\n',
    'src/ui/use.ts':
      "import * as M from '../model';\nimport * as I from '../i18n';\n" +
      'export const run = (m: M.Model): M.Model => M.setName(m, String(I.other));\n',
  });
  try {
    await applyOp(p, 'move_symbol', { name: 'setName', file: 'src/model.ts', dest: 'src/i18n.ts' });
    assert.deepEqual(coldDiagnostics(p.root), []);
    const view = nsView(p.root, 'src/ui/use.ts', 'src/i18n.ts', ['setName']);
    assert.equal(view.destNsImports, 1);
    assertBoundToDest(view, 'src/i18n.ts', ['setName']);
  } finally {
    await p.dispose();
  }
});

test('a type-only namespace import of dest is not reused for value refs', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/model.ts': MODEL,
    'src/i18n.ts': 'export type Lang = string;\n',
    'src/ui/use.ts':
      "import * as M from '../model';\nimport type * as I from '../i18n';\n" +
      'export const run = (m: M.Model, l: I.Lang): M.Model => M.setName(m, l);\n',
  });
  try {
    await applyOp(p, 'move_symbol', { name: 'setName', file: 'src/model.ts', dest: 'src/i18n.ts' });
    assert.deepEqual(coldDiagnostics(p.root), []);
    const view = nsView(p.root, 'src/ui/use.ts', 'src/i18n.ts', ['setName']);
    assert.equal(view.destNsImports, 1, 'one VALUE namespace import of dest was added');
    assertBoundToDest(view, 'src/i18n.ts', ['setName']);
  } finally {
    await p.dispose();
  }
});

test('an existing dest alias shadowed at the ref site is not reused; import and refs agree', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/model.ts': MODEL,
    'src/i18n.ts': 'export const other = 1;\n',
    'src/ui/use.ts':
      "import * as M from '../model';\nimport * as i18n from '../i18n';\n" +
      'export const o = i18n.other;\n' +
      'export const run = (m: M.Model, i18n: string): M.Model => M.setName(m, i18n);\n',
  });
  try {
    await applyOp(p, 'move_symbol', { name: 'setName', file: 'src/model.ts', dest: 'src/i18n.ts' });
    assert.deepEqual(coldDiagnostics(p.root), []);
    assertBoundToDest(nsView(p.root, 'src/ui/use.ts', 'src/i18n.ts', ['setName']), 'src/i18n.ts', [
      'setName',
    ]);
  } finally {
    await p.dispose();
  }
});

test('extract_symbol: a preferred namespace name taken at the ref site — import and refs agree', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/model.ts': MODEL,
    'src/ui/use.ts':
      "import * as M from '../model';\n" +
      'export const run = (m: M.Model, i18n: string): M.Model => M.setName(m, i18n);\n',
    'src/ui/other.ts':
      "import * as M from '../model';\nconst i18n = 1;\n" +
      'export const run2 = (m: M.Model): M.Model => M.setName(m, String(i18n));\n',
  });
  try {
    await applyOp(p, 'extract_symbol', {
      name: 'setName',
      file: 'src/model.ts',
      dest: 'src/i18n.ts',
    });
    assert.deepEqual(coldDiagnostics(p.root), []);
    for (const f of ['src/ui/use.ts', 'src/ui/other.ts']) {
      const view = nsView(p.root, f, 'src/i18n.ts', ['setName']);
      assert.equal(view.destNsImports, 1, f);
      assertBoundToDest(view, 'src/i18n.ts', ['setName']);
    }
  } finally {
    await p.dispose();
  }
});

test('transaction: extract + moves into one dest converge on one namespace import', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/model.ts': MODEL,
    'src/ui/use.ts':
      "import * as M from '../model';\n" +
      "export const run = (m: M.Model): M.Model => M.keep(M.setDesc(M.setName(m, 'a'), 'b'));\n",
  });
  try {
    await applyOp(p, 'transaction', {
      steps: [
        {
          name: 'extract_symbol',
          args: { name: 'setName', file: 'src/model.ts', dest: 'src/i18n.ts' },
        },
        {
          name: 'move_symbol',
          args: { name: 'setDesc', file: 'src/model.ts', dest: 'src/i18n.ts' },
        },
      ],
    });
    assert.deepEqual(coldDiagnostics(p.root), []);
    const view = nsView(p.root, 'src/ui/use.ts', 'src/i18n.ts', ['setName', 'setDesc']);
    assert.equal(view.destNsImports, 1);
    assertBoundToDest(view, 'src/i18n.ts', ['setName', 'setDesc']);
  } finally {
    await p.dispose();
  }
});
