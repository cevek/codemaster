// E-g regression (spec-transactional-mutation §2.4 / §refactor-capture-safety): the import-capture
// gate for a transaction step ≥2 must resolve rewritten specifiers against the CUMULATIVE prior-step
// overlay, not pre-transaction disk. A same-named, type-compatible export that a PRIOR step's move
// places onto the rewritten specifier's resolution path is a silent re-bind the §2.8 whole-program
// typecheck waves through (both sides type-check) — exactly the class the capture gate exists for.
//
// RED-first: the positive repro is paired with an INDEPENDENT cold-checker oracle proving the
// rewritten import really binds to the prior-moved decoy (not the step's own extract target), plus
// the #1-risk over-refusal guard — a clean two-step chain of the same flavor still applies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coldDiagnostics as coldTscErrors, coldDeclarationAt } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project, type TestProject } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';
type Proj = TestProject;

type Envelope = {
  mode: string;
  applied?: boolean;
  typecheck: { clean: boolean };
  captures?: { at: string; kind: string; detail: string }[];
};

async function txn(
  p: Proj,
  steps: JsonValue,
  apply = false,
): Promise<{ ok: true; env: Envelope } | { ok: false; message: string }> {
  const [r] = await p.request([
    { name: 'transaction', args: { steps }, ...(apply ? { apply: true } : {}) },
  ]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  if (!r.result.ok) return { ok: false, message: r.result.failure.message };
  return { ok: true, env: r.result.data as unknown as Envelope };
}

test('transaction CAPTURE: a step-2 extract import re-binds to a decoy a prior step MOVED into place — refused (E-g)', async () => {
  // `src/legacy/widget.ts` is a type-compatible DECOY (`Helper(): string`), NOT at `src/widget.ts`
  // on disk. Step 1 MOVES it to `src/widget.ts`. Step 2 extracts the REAL `Helper` from page.ts to
  // `src/widget.tsx`, rewriting page's import to extensionless `./widget`. Post-transaction that
  // resolves to the `.ts` decoy (extension priority), NOT the extracted `.tsx`. The resolver must
  // see step 1's move (the decoy at src/widget.ts) — against pre-tx disk the decoy isn't there yet,
  // so the capture SLIPS (the bug). Both export `Helper(): string` → the §2.8 typecheck is blind.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/legacy/widget.ts': "export const Helper = (): string => 'decoy';\n",
    'src/page.ts':
      "export const Helper = (): string => 'real';\nexport const Page = (): string => Helper();\n",
  });
  try {
    const steps = [
      { name: 'move_file', args: { source: 'src/legacy/widget.ts', dest: 'src/widget.ts' } },
      // Target `Helper` by position — the decoy shares the name (ambiguous on purpose).
      {
        name: 'extract_symbol',
        args: { file: 'src/page.ts', line: 1, col: 14, dest: 'src/widget.tsx' },
      },
    ];
    const dry = await txn(p, steps);
    assert.ok(dry.ok, `dry-run failed: ${JSON.stringify(dry)}`);
    assert.ok(
      dry.env.captures !== undefined && dry.env.captures.length > 0,
      `the cross-step path-capture must surface: ${JSON.stringify(dry.env)}`,
    );
    assert.equal(dry.env.captures[0]?.kind, 'forward');

    const ap = await txn(p, steps, true);
    assert.ok(ap.ok, `expected a gated envelope, not a hard fail: ${JSON.stringify(ap)}`);
    assert.notEqual(ap.env.applied, true, 'a capturing transaction must refuse apply');
    assert.equal(p.git('status', '--porcelain'), ''); // nothing written
  } finally {
    await p.dispose();
  }
});

test('transaction CAPTURE oracle: post-apply, page imports the prior-moved decoy, not the extract target (E-g)', async () => {
  // The world the slipping transaction WOULD write, by hand: the decoy now lives at src/widget.ts,
  // the extracted Helper at src/widget.tsx, page imports extensionless `./widget`. An independent
  // cold checker proves page's `Helper` binds to the .ts decoy — a type-clean silent re-bind.
  const post = await project({
    'tsconfig.json': TSCONFIG,
    'src/widget.ts': "export const Helper = (): string => 'decoy';\n",
    'src/widget.tsx': "export const Helper = (): string => 'real';\n",
    'src/page.ts':
      "import { Helper } from './widget';\nexport const Page = (): string => Helper();\n",
  });
  try {
    assert.deepEqual(
      coldTscErrors(post.root),
      [],
      'the captured re-bind is type-clean (gate-blind)',
    );
    const decl = coldDeclarationAt(post.root, 'src/page.ts', 'Helper', 1); // 0=import, 1=usage
    assert.equal(decl.file, 'src/widget.ts', 'page bound to the .ts decoy, not the extracted .tsx');
  } finally {
    await post.dispose();
  }
});

test('transaction CAPTURE OVER-REFUSAL guard: a clean move→extract chain still applies (E-g)', async () => {
  // Same shape, NO decoy: step 1 moves an unrelated file, step 2 extracts to a fresh dest with no
  // same-named shadow. The overlay-aware resolver must NOT fabricate a capture (§1: a false refusal
  // on a legit transaction is the worse regression).
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/other.ts': 'export const other = (n: number): number => n;\n',
    'src/page.ts':
      "export const Helper = (): string => 'h';\nexport const Page = (): string => Helper();\n",
  });
  try {
    const steps = [
      { name: 'move_file', args: { source: 'src/other.ts', dest: 'src/moved/other.ts' } },
      { name: 'extract_symbol', args: { name: 'Helper', dest: 'src/helper.ts' } },
    ];
    const ap = await txn(p, steps, true);
    assert.ok(ap.ok && ap.env.applied === true, `expected clean apply: ${JSON.stringify(ap)}`);
    assert.equal(ap.env.captures, undefined, 'no capture should be fabricated');
    assert.equal(ap.env.typecheck.clean, true);
    assert.deepEqual(coldTscErrors(p.root), []);
  } finally {
    await p.dispose();
  }
});
