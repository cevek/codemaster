// Stage D edit-safety oracle for rename_symbol (§16.4), git-backed. Oracles, independent of
// the warm LS that performed the rename:
//   · dry-run leaves `git status` clean (zero writes);
//   · diff(dry) === diff(apply);
//   · post-apply a COLD ts.Program compiles clean — and because a missed import rewrite
//     would surface as "no exported member", that cold compile IS the semantic oracle;
//   · the §2.8 NEGATIVE gate: a colliding rename is refused with an unclean typecheck and
//     leaves every file byte-identical (no apply without a clean post-edit typecheck).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { coldDiagnostics as coldTscErrors, coldDeclarationAt } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';

type Envelope = {
  mode: string;
  diff: string;
  touched: string[];
  typecheck: { clean: boolean };
  applied?: boolean;
  reason?: string;
  captures?: { at: string; kind: string; detail: string }[];
  rollback?: { performed: boolean };
};
type Proj = Awaited<ReturnType<typeof project>>;

/** Drive rename_symbol via a full OpRequest so the `apply` flag rides at the top level
 *  (it is an OpFlag, not an op arg — the strict args schema rejects it inside `args`). */
async function rename(p: Proj, args: JsonValue, apply = false): Promise<Envelope> {
  const [r] = await p.request([{ name: 'rename_symbol', args, ...(apply ? { apply: true } : {}) }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

test('rename_symbol: applies despite an UNRELATED pre-existing type error (narrow gate)', async () => {
  // rename's changeset is LS-complete, so the §2.8 gate checks only the TOUCHED files — a
  // pre-existing error elsewhere must NOT block it (the hot path stays usable on real repos
  // that don't fully compile). Only shape-based codemod widens to the whole program.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts': 'export const greet = (n: string): string => n;\n',
    'src/use.ts': "import { greet } from './api';\nexport const a = greet('hi');\n",
    'src/broken.ts': "export const bad: number = 'not a number';\n", // pre-existing, unrelated
  });
  try {
    const env = await rename(p, { name: 'greet', newName: 'greet2' }, true);
    assert.equal(env.applied, true); // not blocked by broken.ts
    assert.match(readFileSync(path.join(p.root, 'src/use.ts'), 'utf8'), /greet2\(['"]hi['"]\)/);
  } finally {
    await p.dispose();
  }
});

test('rename_symbol: dry-run zero-write, diff parity, cold-tsc-clean apply', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/math.ts': 'export const add = (a: number, b: number): number => a + b;\n',
    'src/use.ts': "import { add as plus } from './math';\nexport const r: number = plus(1, 2);\n",
  });
  try {
    // Dry-run: previews both the declaration and the aliased import specifier; writes nothing.
    const dry = await rename(p, { name: 'add', newName: 'sum' });
    assert.equal(dry.mode, 'dry-run');
    assert.equal(dry.typecheck.clean, true);
    assert.deepEqual([...dry.touched].sort(), ['src/math.ts', 'src/use.ts']);
    assert.match(dry.diff, /sum/);
    assert.equal(p.git('status', '--porcelain'), ''); // zero writes

    // Apply: identical diff, committed, post-apply typecheck clean, no rollback.
    const applied = await rename(p, { name: 'add', newName: 'sum' }, true);
    assert.equal(applied.mode, 'applied');
    assert.equal(applied.typecheck.clean, true);
    assert.equal(applied.rollback?.performed, false);
    assert.equal(applied.diff, dry.diff); // diff(dry) === diff(apply)

    // On-disk result + the INDEPENDENT cold compile (a missed import rewrite would fail it).
    assert.match(readFileSync(path.join(p.root, 'src/math.ts'), 'utf8'), /export const sum/);
    assert.match(readFileSync(path.join(p.root, 'src/use.ts'), 'utf8'), /import \{ sum as plus \}/);
    assert.deepEqual(coldTscErrors(p.root), []);
  } finally {
    await p.dispose();
  }
});

test('rename_symbol: a shorthand property keeps its key (foo → { foo: bar }, not { bar })', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts': 'const foo = 1;\nexport const o = { foo };\nexport const u = o.foo;\n',
  });
  try {
    const applied = await rename(p, { name: 'foo', newName: 'bar' }, true);
    assert.equal(applied.typecheck.clean, true);
    assert.deepEqual(coldTscErrors(p.root), []);
    const a = readFileSync(path.join(p.root, 'src/a.ts'), 'utf8');
    assert.match(a, /\{ foo: bar \}/); // the KEY stays foo; only the value renames
    assert.doesNotMatch(a, /\{ bar \}/); // NOT a key rename (would change the object shape)
  } finally {
    await p.dispose();
  }
});

test('rename_symbol: CAPTURE guard — a shadowing rename surfaces captures on the envelope + refuses apply', async () => {
  // The typecheck can't catch this: renaming slugify→upper rewrites the call `slugify(name)` to
  // `upper(name)`, which now binds to the LOCAL `const upper` (type-compatible string→string), so
  // the function silently stops calling slugify. Not a duplicate-identifier → the LS won't flag it.
  // The reference-set check over the post-edit program must surface a `captures` site and refuse
  // apply — but still SHOW the diff (the agent sees the edit it asked for). Oracle below confirms
  // the rewritten call genuinely re-binds to a DIFFERENT declaration.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts':
      'export function slugify(s: string): string {\n  return s.toLowerCase();\n}\n' +
      'export function makeLabel(name: string): string {\n' +
      '  const upper = (s: string): string => s.toUpperCase();\n' +
      '  return slugify(name) + upper(name);\n}\n',
  });
  try {
    // Dry-run: captures is non-empty, the diff is still shown (not failed away).
    const dry = await rename(p, { name: 'slugify', newName: 'upper' });
    assert.ok(dry.captures !== undefined && dry.captures.length > 0, 'dry-run must carry captures');
    assert.equal(dry.captures[0]?.kind, 'forward');
    assert.match(dry.diff, /upper/); // the rewrite is visible to the agent

    // Apply: refused, mode/applied reflect it, nothing written.
    const ap = await rename(p, { name: 'slugify', newName: 'upper' }, true);
    assert.notEqual(ap.applied, true, 'a capturing rename must refuse apply');
    assert.match(String(ap.reason), /CAPTURE|capture/);
    assert.equal(p.git('status', '--porcelain'), ''); // nothing written
  } finally {
    await p.dispose();
  }
});

test('rename_symbol: CAPTURE oracle — a cold checker confirms the rewritten call re-binds to the local', async () => {
  // Independent oracle (NOT golden): write the POST-edit content the capturing rename WOULD produce
  // (slugify→upper applied) and ask a fresh-from-cold checker which declaration the rewritten call
  // binds to. It must resolve to the LOCAL `const upper` (line 5), NOT the top-level function
  // (line 1) — proof the refusal guards a genuine semantic capture, type-compatible and clean to tsc.
  const post = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts':
      'export function upper(s: string): string {\n  return s.toLowerCase();\n}\n' + // line 1: decl
      'export function makeLabel(name: string): string {\n' +
      '  const upper = (s: string): string => s.toUpperCase();\n' + // line 5: the local shadow
      '  return upper(name) + upper(name);\n}\n', // line 6: the captured calls
  });
  try {
    assert.deepEqual(
      coldTscErrors(post.root),
      [],
      'the captured rewrite is type-clean (gate-blind)',
    );
    // occurrence 0 = `function upper`, 1 = `const upper`, 2 = first `upper(name)` call.
    const decl = coldDeclarationAt(post.root, 'src/a.ts', 'upper', 2);
    assert.equal(
      decl.line,
      5,
      'the rewritten call binds to the local `const upper`, not the function',
    );
  } finally {
    await post.dispose();
  }
});

test('rename_symbol: capture guard does NOT over-refuse — aliased multi-file + unrelated-scope names still apply', async () => {
  // GUARD against the over-refusal trap (the worse regression): the symbol's references reached via
  // an alias (`import {slugify as sg}` … `sg()`) are legitimately NOT rewritten and must NOT read as
  // a "capture"; and a `newName` that exists only in an unrelated non-overlapping scope is fine.
  const aliased = await project({
    'tsconfig.json':
      '{"compilerOptions":{"strict":true,"module":"preserve","baseUrl":".","paths":{"@/*":["src/*"]},"ignoreDeprecations":"6.0"}}',
    'src/slug.ts': 'export function slugify(s: string): string {\n  return s.toLowerCase();\n}\n',
    'src/use.ts': "import { slugify as sg } from '@/slug';\nexport const r = sg('A');\n",
  });
  try {
    const r = await rename(aliased, { name: 'slugify', newName: 'toSlug' });
    // typecheck.clean is NOT sufficient here — a CAPTURING rename is also clean. The real guard is
    // that NO capture is flagged (the aliased `sg()` usage is not rewritten and must not read as one)
    // and that the rename APPLIES.
    assert.equal(
      r.captures,
      undefined,
      'an aliased multi-file rename must NOT be flagged a capture',
    );
    assert.equal(r.typecheck.clean, true);
    assert.match(r.diff, /toSlug/);
    const ap = await rename(aliased, { name: 'slugify', newName: 'toSlug' }, true);
    assert.equal(ap.applied, true, 'a non-capturing aliased rename must apply');
    assert.deepEqual(coldTscErrors(aliased.root), []);
  } finally {
    await aliased.dispose();
  }

  const unrelated = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts':
      'export function slugify(s: string): string {\n  return s.toLowerCase();\n}\n' +
      'export const y = slugify("a");\n' +
      'export function other(): string {\n  const upper = "x";\n  return upper;\n}\n',
  });
  try {
    // `upper` exists only inside `other` — renaming slugify→upper does not reach it.
    const r = await rename(unrelated, { name: 'slugify', newName: 'upper' });
    assert.equal(
      r.captures,
      undefined,
      'a newName confined to an unrelated scope is not a capture',
    );
    assert.equal(r.typecheck.clean, true);
    const ap = await rename(unrelated, { name: 'slugify', newName: 'upper' }, true);
    assert.equal(ap.applied, true, 'a non-overlapping rename must apply');
    assert.deepEqual(coldTscErrors(unrelated.root), []);
  } finally {
    await unrelated.dispose();
  }
});

test('rename_symbol: §2.8 gate — a colliding rename is refused, every file byte-identical', async () => {
  const before = {
    math: 'export const add = (a: number, b: number): number => a + b;\nexport const sum = (a: number, b: number): number => a * b;\n',
    use: "import { add } from './math';\nexport const r: number = add(1, 2);\n",
  };
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/math.ts': before.math,
    'src/use.ts': before.use,
  });
  try {
    // add -> sum collides with the existing `sum`; the post-edit typecheck must catch it.
    const r = await rename(p, { name: 'add', newName: 'sum' }, true);
    assert.equal(r.typecheck.clean, false); // duplicate-identifier diagnostic
    assert.notEqual(r.applied, true); // apply refused (§2.8) — never wrote
    assert.notEqual(r.mode, 'applied');
    assert.equal(p.git('status', '--porcelain'), ''); // zero writes
    assert.equal(readFileSync(path.join(p.root, 'src/math.ts'), 'utf8'), before.math);
    assert.equal(readFileSync(path.join(p.root, 'src/use.ts'), 'utf8'), before.use);
  } finally {
    await p.dispose();
  }
});
