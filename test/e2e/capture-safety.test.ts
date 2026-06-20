// Capture-safety regression corpus (§ spec-refactor-capture-safety). Every mutating op that
// rewrites references/imports must guarantee: after the edit, each rewritten site still resolves to
// the SAME symbol/module — and no pre-existing token silently binds to the mutated one. A capture is
// type-compatible (invisible to the §2.8 gate) and not a redeclaration (invisible to the LS), so it
// needs its own gate. These tests pair, for codemod / move / extract:
//   · a capture repro that surfaces `captures` and REFUSES apply, with an INDEPENDENT cold-checker
//     oracle proving the rewritten reference really binds to a different declaration; and
//   · the #1-risk over-refusal guards — a CLEAN edit of the same flavor still APPLIES, cold-compiles
//     clean, and reports no captures (a false refusal on a legit refactor is the worse regression).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coldDiagnostics as coldTscErrors, coldDeclarationAt } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';

type Envelope = {
  mode: string;
  diff?: string;
  diffstat?: Record<string, string>;
  touched: string[];
  typecheck: { clean: boolean };
  applied?: boolean;
  reason?: string;
  captures?: { at: string; kind: string; detail: string }[];
};
type Proj = Awaited<ReturnType<typeof project>>;

async function op(
  p: Proj,
  name: string,
  args: JsonValue,
  flags: JsonValue = {},
): Promise<Envelope> {
  const [r] = await p.request([{ name, args, ...(flags as object) }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

// ─────────────────────────────── codemod ───────────────────────────────

test('codemod CAPTURE: a metavar identifier landing in a new lambda re-binds to the param — refused', async () => {
  // `identity($X)` → `pick((tag) => $X)` moves the captured `tag` INTO a lambda whose param is also
  // `tag`, so the rewritten reference binds to the PARAM, not the import. Both `string` → the §2.8
  // gate is clean; the capture gate must catch it.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts': "export const tag: string = 'A';\n",
    'src/main.ts':
      "import { tag } from './a';\n" +
      'const identity = (s: string): string => s;\n' +
      'const pick = (cb: (tag: string) => string): string => cb("x");\n' +
      'export const r = identity(tag);\n',
  });
  try {
    const dry = await op(p, 'codemod', { pattern: 'identity($X)', rewrite: 'pick((tag) => $X)' });
    assert.ok(
      dry.captures !== undefined && dry.captures.length > 0,
      'codemod must surface a capture',
    );
    assert.equal(dry.captures[0]?.kind, 'forward');

    const ap = await op(
      p,
      'codemod',
      { pattern: 'identity($X)', rewrite: 'pick((tag) => $X)' },
      { apply: true },
    );
    assert.notEqual(ap.applied, true, 'a capturing codemod must refuse apply');
    assert.equal(p.git('status', '--porcelain'), ''); // nothing written
  } finally {
    await p.dispose();
  }
});

test('codemod CAPTURE oracle: a cold checker confirms the rewritten `tag` binds to the lambda param', async () => {
  // Independent oracle on the POST-edit content: the body `tag` resolves to the lambda param
  // (its line), NOT the import (line 1) — proof the refusal guards a real capture.
  const post = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts': "export const tag: string = 'A';\n",
    'src/main.ts':
      "import { tag } from './a';\n" + // line 1: the import binding
      'const identity = (s: string): string => s;\n' +
      'const pick = (cb: (tag: string) => string): string => cb("x");\n' +
      'export const r = pick((tag) => tag);\n', // line 4: param + captured body ref
  });
  try {
    assert.deepEqual(
      coldTscErrors(post.root),
      [],
      'the captured rewrite is type-clean (gate-blind)',
    );
    // occurrences of `tag`: 0=import, 1=type-sig param, 2=lambda param, 3=lambda body ref.
    const decl = coldDeclarationAt(post.root, 'src/main.ts', 'tag', 3);
    assert.equal(
      decl.line,
      4,
      'the body `tag` binds to the lambda param (line 4), not the import (1)',
    );
  } finally {
    await post.dispose();
  }
});

test('codemod OVER-REFUSAL guard: a clean shape rewrite still applies (no false capture)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts':
      'export const oldApi = (n: number): number => n;\nexport const newApi = (n: number): number => n + 1;\n',
    'src/use.ts':
      "import { oldApi, newApi } from './api';\nexport const r = oldApi(1);\nvoid newApi;\n",
  });
  try {
    const dry = await op(p, 'codemod', { pattern: 'oldApi($A)', rewrite: 'newApi($A)' });
    assert.equal(dry.captures, undefined, 'a clean codemod must NOT be flagged a capture');
    assert.equal(dry.typecheck.clean, true);
    const ap = await op(
      p,
      'codemod',
      { pattern: 'oldApi($A)', rewrite: 'newApi($A)' },
      { apply: true },
    );
    assert.equal(ap.applied, true, 'a clean codemod must apply');
    assert.deepEqual(coldTscErrors(p.root), []);
  } finally {
    await p.dispose();
  }
});

test('codemod OVER-REFUSAL guard: a PRESERVED reference to a same-file decl below a length-changing rewrite must NOT false-flag', async () => {
  // Regression for the cross-program-state offset bug: a same-file declaration BELOW a rewrite that
  // changes length shifts between the disk (pre-edit) and overlay (post-edit) programs. `$X`=`impl`
  // is PRESERVED and still binds the SAME `function impl` — the detector must compare in one offset
  // space and NOT fabricate a capture. Exercises the detector's positive compare path (a real
  // resolved reference, not a literal arg), so a future regression here is caught.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/main.ts':
      'export const out = wrap(impl);\n' +
      'function impl(): number {\n  return 1;\n}\n' +
      'function wrap(n: () => number): number {\n  return n();\n}\n' +
      'function wrapLonger(n: () => number): number {\n  return n();\n}\n',
  });
  try {
    const ap = await op(
      p,
      'codemod',
      { pattern: 'wrap($X)', rewrite: 'wrapLonger($X)' },
      { apply: true },
    );
    assert.equal(ap.captures, undefined, 'a preserved same-file reference must NOT be flagged');
    assert.equal(ap.applied, true, 'the clean codemod must apply');
    assert.deepEqual(coldTscErrors(p.root), []);
  } finally {
    await p.dispose();
  }
});

test('codemod CAPTURE: an overlapping (nested) match still gates correctly', async () => {
  // commitEdits DROPS the inner of two overlapping matches; the region table must mirror that or its
  // phantom delta desyncs every later window. The outer match commits → `pick((tag) => identity(tag))`
  // and the preserved inner `tag` binds the shadowing lambda param — the capture must still surface.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts': "export const tag: string = 'A';\n",
    'src/main.ts':
      "import { tag } from './a';\n" +
      'const identity = (s: string): string => s;\n' +
      'const pick = (cb: (tag: string) => string): string => cb("x");\n' +
      'export const r = identity(identity(tag));\n',
  });
  try {
    const dry = await op(p, 'codemod', { pattern: 'identity($X)', rewrite: 'pick((tag) => $X)' });
    assert.ok(
      dry.captures !== undefined && dry.captures.length > 0,
      'nested-match capture must surface',
    );
  } finally {
    await p.dispose();
  }
});

// ─────────────────────────────── move_file ───────────────────────────────

test('move_file CAPTURE: a relinked import resolves to a same-named decoy module — refused', async () => {
  // `src/widget.ts` is a type-compatible DECOY. The importer imports the real `src/feat/widget.tsx`
  // extensionless. Moving the real file to `src/widget.tsx` makes the rewritten `./widget` resolve
  // to the `.ts` decoy (extension priority), not the moved `.tsx` — a path-capture the §2.8
  // typecheck (both export `widget: string`) cannot see.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/widget.ts': "export const widget: string = 'decoy';\n",
    'src/feat/widget.tsx': "export const widget: string = 'real';\n",
    'src/app.tsx': "import { widget } from './feat/widget';\nexport const x: string = widget;\n",
  });
  try {
    const dry = await op(p, 'move_file', { source: 'src/feat/widget.tsx', dest: 'src/widget.tsx' });
    assert.ok(dry.captures !== undefined && dry.captures.length > 0, 'move must surface a capture');
    assert.equal(dry.captures[0]?.kind, 'forward');

    const ap = await op(
      p,
      'move_file',
      { source: 'src/feat/widget.tsx', dest: 'src/widget.tsx' },
      { apply: true },
    );
    assert.notEqual(ap.applied, true, 'a capturing move must refuse apply');
    assert.equal(p.git('status', '--porcelain'), ''); // nothing written
  } finally {
    await p.dispose();
  }
});

test('move_file CAPTURE oracle: a cold checker confirms the import binds to the decoy module', async () => {
  // POST-move state by hand: app's `./widget` resolves to the `.ts` decoy, not the moved `.tsx`.
  const post = await project({
    'tsconfig.json': TSCONFIG,
    'src/widget.ts': "export const widget: string = 'decoy';\n",
    'src/widget.tsx': "export const widget: string = 'real';\n",
    'src/app.tsx': "import { widget } from './widget';\nexport const x: string = widget;\n",
  });
  try {
    assert.deepEqual(
      coldTscErrors(post.root),
      [],
      'the captured relink is type-clean (gate-blind)',
    );
    const decl = coldDeclarationAt(post.root, 'src/app.tsx', 'widget', 1); // 0=import, 1=usage
    assert.equal(decl.file, 'src/widget.ts', 'the import bound to the .ts decoy, not the .tsx');
  } finally {
    await post.dispose();
  }
});

test('move_file OVER-REFUSAL guard: a clean move still applies (no false capture)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/lib/k.ts': 'export const K = 0;\n',
    'src/lib/math.ts':
      "import { K } from './k';\nexport const add = (a: number, b: number): number => a + b + K;\n",
    'src/user.ts': "import { add } from './lib/math';\nexport const r: number = add(1, 2);\n",
  });
  try {
    const dry = await op(p, 'move_file', { source: 'src/lib/math.ts', dest: 'src/core/math.ts' });
    assert.equal(dry.captures, undefined, 'a clean move must NOT be flagged a capture');
    const ap = await op(
      p,
      'move_file',
      { source: 'src/lib/math.ts', dest: 'src/core/math.ts' },
      { apply: true },
    );
    assert.equal(ap.applied, true, 'a clean move must apply');
    assert.deepEqual(coldTscErrors(p.root), []);
  } finally {
    await p.dispose();
  }
});

// ─────────────────────────────── extract_symbol ───────────────────────────────

test('extract_symbol CAPTURE: the source import lands on a same-named decoy module — refused', async () => {
  // Extracting `Helper` to `src/widget.tsx` makes the source import `./widget` resolve to the
  // type-compatible `.ts` decoy, not the freshly created `.tsx` — a path-capture the gate misses.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/widget.ts': "export const Helper = (): string => 'decoy';\n",
    'src/page.ts':
      "export const Helper = (): string => 'real';\nexport const Page = (): string => Helper();\n",
  });
  // Target by position — `Helper` is intentionally ambiguous (the decoy shares the name).
  const target = { file: 'src/page.ts', line: 1, col: 14 };
  try {
    const dry = await op(p, 'extract_symbol', { ...target, dest: 'src/widget.tsx' });
    assert.ok(
      dry.captures !== undefined && dry.captures.length > 0,
      'extract must surface a capture',
    );
    assert.equal(dry.captures[0]?.kind, 'forward');
    // The specific path-capture: the relinked import resolves to the .ts decoy, not the new .tsx.
    assert.match(String(dry.captures[0]?.detail), /resolves to .*widget\.ts\b/);

    const ap = await op(
      p,
      'extract_symbol',
      { ...target, dest: 'src/widget.tsx' },
      { apply: true },
    );
    assert.notEqual(ap.applied, true, 'a capturing extract must refuse apply');
    assert.equal(p.git('status', '--porcelain'), ''); // nothing written
  } finally {
    await p.dispose();
  }
});

test('extract_symbol OVER-REFUSAL guard: a clean extract still applies (no false capture)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/page.ts':
      "export const Helper = (): string => 'h';\nexport const Page = (): string => Helper();\n",
  });
  try {
    const dry = await op(p, 'extract_symbol', { name: 'Helper', dest: 'src/helper.ts' });
    assert.equal(dry.captures, undefined, 'a clean extract must NOT be flagged a capture');
    const ap = await op(
      p,
      'extract_symbol',
      { name: 'Helper', dest: 'src/helper.ts' },
      { apply: true },
    );
    assert.equal(ap.applied, true, 'a clean extract must apply');
    assert.deepEqual(coldTscErrors(p.root), []);
  } finally {
    await p.dispose();
  }
});

// summaryOnly mode lives in test/e2e/summary-only.test.ts (a distinct output feature).
