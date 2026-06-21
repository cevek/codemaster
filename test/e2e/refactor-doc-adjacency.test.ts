// Oracle for FIX A (dogfood, amiro 2026-06-21): the TS "Move to a new file" / "Move to file"
// refactors insert a SPURIOUS blank line between a relocated symbol's ADJACENT leading JSDoc and its
// declaration (`*/\n\nexport const X`), detaching the doc from what it documents. Typecheck-clean (a
// comment) → the §2.8 gate never catches it → silent degradation of the moved code.
//
// Two oracles, neither golden:
//   ADJACENCY (discriminating, red→green) — after move AND extract, the moved decl's doc is ADJACENT
//     (no blank line between `*/` and `export`). Fails on the pre-fix code (LS emits the blank line).
//   NO OVER-GLUE (the guard the manager required) — a comment the SOURCE had blank-line-DETACHED from
//     the symbol stays detached after the move; we remove only the LS's spurious insertion, never glue
//     a floating comment (which would be a NEW lie about the author's intent). The LS does carry such a
//     comment with the symbol, so a blind collapse would fail this.
//   COMPILES — an independent cold `ts.Program` over the post-apply tree is clean.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { coldDiagnostics } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project, type TestProject } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';

async function applyOp(p: TestProject, name: string, args: JsonValue): Promise<void> {
  const [r] = await p.request([{ name, args, apply: true }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r.result).slice(0, 300)}`);
}

const read = (p: TestProject, rel: string): string => readFileSync(path.join(p.root, rel), 'utf8');

test('extract_symbol: adjacent JSDoc stays attached to the moved decl', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/lib.ts': 'export const wrap = (n: number): number => n;\n',
    'src/source.ts':
      "import { wrap } from './lib';\n\n" +
      '/** Fetch the sales list. */\n' +
      'export const useSales = (): number => wrap(1);\n',
  });
  try {
    await applyOp(p, 'extract_symbol', { name: 'useSales', dest: 'src/useSales.ts' });
    const dest = read(p, 'src/useSales.ts');
    // The doc sits on the line immediately above its decl — no blank line between them.
    assert.match(dest, /\/\*\* Fetch the sales list\. \*\/\nexport const useSales/, dest);
    assert.doesNotMatch(
      dest,
      /\*\/\n\n+export const useSales/,
      `doc detached by a blank line:\n${dest}`,
    );
    assert.deepEqual(coldDiagnostics(p.root), []);
  } finally {
    await p.dispose();
  }
});

test('move_symbol: adjacent JSDoc stays attached to the moved decl', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/lib.ts': 'export const wrap = (n: number): number => n;\n',
    'src/dest.ts': "import { wrap } from './lib';\n\nexport const ex = (): number => wrap(0);\n",
    'src/source.ts':
      "import { wrap } from './lib';\n\n/** Fetch refunds. */\nexport const useRefunds = (): number => wrap(2);\n",
  });
  try {
    await applyOp(p, 'move_symbol', { name: 'useRefunds', dest: 'src/dest.ts' });
    const dest = read(p, 'src/dest.ts');
    assert.match(dest, /\/\*\* Fetch refunds\. \*\/\nexport const useRefunds/, dest);
    assert.doesNotMatch(
      dest,
      /\*\/\n\n+export const useRefunds/,
      `doc detached by a blank line:\n${dest}`,
    );
    assert.deepEqual(coldDiagnostics(p.root), []);
  } finally {
    await p.dispose();
  }
});

test('extract_symbol: a blank-line-DETACHED comment is NOT glued to the decl (no over-glue)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/lib.ts': 'export const wrap = (n: number): number => n;\n',
    // `// floating note` is separated from `target` by a blank line in the SOURCE — the author did not
    // attach it. The LS carries it with the symbol; our fix must preserve that gap, not collapse it.
    'src/source.ts':
      "import { wrap } from './lib';\n\n" +
      'export const a = (): number => 1;\n\n' +
      '// floating note\n\n' +
      'export const target = (): number => wrap(2);\n',
  });
  try {
    await applyOp(p, 'extract_symbol', { name: 'target', dest: 'src/target.ts' });
    const dest = read(p, 'src/target.ts');
    // The blank line the source had between the comment and the decl is still there.
    assert.match(
      dest,
      /\/\/ floating note\n\nexport const target/,
      `comment wrongly glued:\n${dest}`,
    );
    assert.deepEqual(coldDiagnostics(p.root), []);
  } finally {
    await p.dispose();
  }
});

test('transaction: splitting a file into siblings keeps each moved doc adjacent (the amiro repro)', async () => {
  // The literal reported workflow — `transaction([extract, extract])` splitting one hooks file into
  // sibling files — which threads the `overlay` path the single-op tests don't. Each extracted sibling
  // must carry its JSDoc ADJACENT to the decl.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/lib.ts': 'export const wrap = (n: number): number => n;\n',
    'src/hooks.ts':
      "import { wrap } from './lib';\n\n" +
      '/** List sales. */\nexport const useSalesList = (): number => wrap(1);\n\n' +
      '/** Create a sale. */\nexport const useCreateSale = (): number => wrap(2);\n\n' +
      '/** Update a sale. */\nexport const useUpdateSale = (): number => wrap(3);\n',
  });
  try {
    const [r] = await p.request([
      {
        name: 'transaction',
        args: {
          steps: [
            {
              name: 'extract_symbol',
              args: { name: 'useCreateSale', dest: 'src/useCreateSale.ts' },
            },
            {
              name: 'extract_symbol',
              args: { name: 'useUpdateSale', dest: 'src/useUpdateSale.ts' },
            },
          ],
        },
        apply: true,
      },
    ]);
    if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
    assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r.result).slice(0, 300)}`);
    const created = read(p, 'src/useCreateSale.ts');
    const updated = read(p, 'src/useUpdateSale.ts');
    assert.match(created, /\/\*\* Create a sale\. \*\/\nexport const useCreateSale/, created);
    assert.match(updated, /\/\*\* Update a sale\. \*\/\nexport const useUpdateSale/, updated);
    assert.doesNotMatch(created, /\*\/\n\n+export const/, `doc detached:\n${created}`);
    assert.doesNotMatch(updated, /\*\/\n\n+export const/, `doc detached:\n${updated}`);
    assert.deepEqual(coldDiagnostics(p.root), []);
  } finally {
    await p.dispose();
  }
});
