// `find_usages {conditions:true}` — the per-site enclosing-condition chain (t-933867).
//
// TWO independent oracles, because the failure mode here is a WRONG FACT about the code, not mere
// incompleteness: a swapped then/else branch would report a site as guarded by the condition that
// actually EXCLUDES it (§3 never-lie), which a "did we emit something" test passes happily.
//   1. The fixture: every site is written with the chain it sits under, by construction.
//   2. A DESCENT oracle: the same rules applied top-down from a freshly parsed `ts.createSourceFile`
//      (a condition stack pushed as it descends), versus the op's bottom-up climb from the site.
//      Different traversal, different mechanics (no cap, no reversal), same claim — so a climb that
//      attributes the wrong ancestor, drops a level, or misses a site disagrees here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { project } from '../helpers/project.ts';

/** One fixture line: the statement, and the chain the site inside it sits under (outermost →
 *  innermost). `partial` = the op must flag an unstated branch. */
type Case = { code: string; conditions: string[]; partial?: true };

const CASES: Case[] = [
  { code: 'export function a(x: boolean, y: boolean): void {', conditions: [] },
  { code: '  if (x) { F(); }', conditions: ['x'] },
  { code: '  if (x) { } else { F(); }', conditions: ['!(x)'] },
  { code: '  if (!x) { } else { F(); }', conditions: ['x'] }, // !x negated back to x
  { code: '  if (x) { if (y) { F(); } }', conditions: ['x', 'y'] }, // outermost → innermost
  { code: '  if (x) { } else if (y) { F(); }', conditions: ['!(x)', 'y'] },
  { code: '  if (x) { } else if (y) { } else { F(); }', conditions: ['!(x)', '!(y)'] },
  { code: '  const t1 = x ? F() : y;', conditions: ['x'] },
  { code: '  const t2 = x ? y : F();', conditions: ['!(x)'] },
  { code: '  const t3 = x && F();', conditions: ['x'] },
  { code: '  const t4 = x || F();', conditions: ['!(x)'] },
  { code: '  const t5 = F() && x;', conditions: [] }, // the LHS always evaluates
  { code: '  if (F()) { }', conditions: [] }, // the site IS the condition, not under it
  { code: '  void [t1, t2, t3, t4, t5];', conditions: [] },
  { code: '}', conditions: [] },
  { code: 'export function b(o: { n?: number }, k: string, x: boolean): void {', conditions: [] },
  { code: '  const n1 = o.n ?? F();', conditions: ['o.n == null'] }, // NOT !(o.n): 0 ?? F() skips F
  { code: '  while (k.length > 0) { F(); break; }', conditions: ['k.length > 0'] },
  { code: '  for (let i = 0; i < 3; i++) { F(); }', conditions: ['i < 3'] },
  { code: '  for (const c of k) { F(); void c; }', conditions: [] }, // iteration is not a branch
  { code: '  do { F(); } while (x);', conditions: [] }, // the body runs at least once
  { code: '  switch (k) { case "a": F(); break; }', conditions: ['k === "a"'] },
  {
    code: '  switch (k) { case "a": case "b": F(); break; }',
    conditions: ['k === "a" || k === "b"'],
  },
  {
    code: '  switch (k) { case "a": x; case "b": F(); break; }',
    conditions: ['k === "b"'],
    partial: true,
  },
  { code: '  switch (k) { case "a": return; case "b": F(); break; }', conditions: ['k === "b"'] },
  { code: '  switch (k) { default: F(); }', conditions: [], partial: true },
  // A site in the case EXPRESSION evaluates whenever the switch does — never "guarded" by the
  // comparison it is part of.
  { code: '  switch (F()) { case true: break; }', conditions: [] },
  { code: '  switch (x) { case F(): break; }', conditions: [] },
  { code: '  try { void 0; } catch { F(); }', conditions: [], partial: true },
  { code: '  F();', conditions: [] }, // measured: no enclosing branch
  { code: '  if (x) { const cb = (): void => { F(); }; cb(); }', conditions: [] }, // closure boundary
  { code: '  void n1;', conditions: [] },
  { code: '}', conditions: [] },
];

const SITE_FILE = 'src/site.ts';
const SITE_SRC = `import { F } from './f';\n${CASES.map((c) => c.code).join('\n')}\n`;

const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"es2022"}}',
  'src/f.ts': 'export const F = (): boolean => true;\n',
  [SITE_FILE]: SITE_SRC,
};

/** Expected chain per 1-based line of the fixture (line 1 is the import). */
function expectedByLine(): Map<number, Case> {
  const m = new Map<number, Case>();
  CASES.forEach((c, i) => {
    if (c.code.includes('F()')) m.set(i + 2, c);
  });
  return m;
}

type ChainRow = { line: number; conditions: string[]; partial: boolean };

async function opChains(): Promise<{ rows: ChainRow[]; dispose: () => Promise<void> }> {
  const p = await project(FILES);
  // collapseImports:false keeps the import-site reference in the set — it is the site that proves a
  // MEASURED empty chain is emitted (present-but-empty), not silently omitted.
  const r = await p.op('find_usages', {
    name: 'F',
    conditions: true,
    collapseImports: false,
    limit: 500,
  });
  assert.ok('result' in r && r.result.ok, `find_usages failed: ${JSON.stringify(r)}`);
  const view = r.result.data as {
    usages: {
      span: { file: string; line: number };
      condition?: { conditions?: string[]; partial?: true };
    }[];
  };
  const rows = view.usages
    .filter((u) => u.span.file === SITE_FILE)
    .map((u) => {
      assert.ok(u.condition !== undefined, `line ${u.span.line}: no condition annotation`);
      return {
        line: u.span.line,
        conditions: u.condition.conditions ?? [],
        partial: u.condition.partial === true,
      };
    });
  return { rows, dispose: () => p.dispose() };
}

test('oracle 1 (fixture): every site carries the chain it was written under, polarity included', async () => {
  const { rows, dispose } = await opChains();
  try {
    const expected = expectedByLine();
    for (const [line, c] of expected) {
      const row = rows.find((x) => x.line === line);
      assert.ok(row !== undefined, `no usage reported on line ${line}: ${c.code}`);
      assert.deepEqual(row.conditions, c.conditions, `chain on line ${line}: ${c.code}`);
      assert.equal(row.partial, c.partial === true, `partial flag on line ${line}: ${c.code}`);
    }
    // The import specifier is a reference too, and it sits under nothing — a MEASURED empty chain,
    // present rather than absent (absent would mean "not annotated").
    const importRow = rows.find((x) => x.line === 1);
    assert.ok(importRow !== undefined, 'the import-site reference is annotated too');
    assert.deepEqual(importRow.conditions, []);
  } finally {
    await dispose();
  }
});

test('over the chain cap: the INNERMOST conditions are kept and the drop is disclosed', async () => {
  // Five nested branches, four reportable: the nearest ones are the load-bearing ones, and the
  // dropped outer ones must surface as `partial` — a silently shortened chain would read as the
  // whole guard set (§3.4).
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/f.ts': 'export const F = (): boolean => true;\n',
    'src/deep.ts':
      `import { F } from './f';\n` +
      `export function d(a: boolean, b: boolean, c: boolean, e: boolean, g: boolean): void {\n` +
      `  if (a) { if (b) { if (c) { if (e) { if (g) { F(); } } } } }\n}\n`,
  });
  try {
    const r = await p.op('find_usages', { name: 'F', conditions: true, limit: 50 });
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as {
      usages: {
        span: { file: string };
        condition?: { conditions?: string[]; partial?: true };
      }[];
    };
    const site = view.usages.find((u) => u.span.file === 'src/deep.ts');
    assert.ok(site?.condition !== undefined, 'the deep site is annotated');
    assert.deepEqual(
      site.condition.conditions,
      ['b', 'c', 'e', 'g'],
      'innermost four kept, in order',
    );
    assert.equal(site.condition.partial, true, 'the dropped outer condition is disclosed');
  } finally {
    await p.dispose();
  }
});

test('a long predicate is elided with a visible marker, never silently cut', async () => {
  const long = `someVeryLongPredicateName${'X'.repeat(80)}`;
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/f.ts': 'export const F = (): boolean => true;\n',
    'src/long.ts':
      `import { F } from './f';\n` +
      `export function l(${long}: boolean): void {\n  if (${long}) { F(); }\n}\n`,
  });
  try {
    const r = await p.op('find_usages', { name: 'F', conditions: true, limit: 50 });
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as {
      usages: { span: { file: string }; condition?: { conditions?: string[] } }[];
    };
    const site = view.usages.find((u) => u.span.file === 'src/long.ts');
    const cond = site?.condition?.conditions?.[0] ?? '';
    assert.ok(cond.endsWith('…'), `elision marker expected, got: ${cond}`);
    assert.ok(long.startsWith(cond.slice(0, -1)), 'the kept prefix is the real predicate text');
  } finally {
    await p.dispose();
  }
});

test('under groupBy the flag cannot apply — the rollup carries no chain, and says so', async () => {
  const p = await project(FILES);
  try {
    const r = await p.op('find_usages', {
      name: 'F',
      conditions: true,
      groupBy: 'enclosing',
      limit: 50,
    });
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as { groups?: Record<string, unknown>[]; notes?: string[] };
    for (const g of view.groups ?? []) {
      assert.ok(!('condition' in g), 'a rollup row must not carry a per-site chain');
    }
    assert.ok(
      (view.notes ?? []).some((n) => n.startsWith('conditions ignored')),
      `the ignored flag must be disclosed, notes: ${JSON.stringify(view.notes)}`,
    );
  } finally {
    await p.dispose();
  }
});

// ── oracle 2: the same rules, applied top-down from a fresh parse ────────────────────────────────

function isBoundary(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isClassDeclaration(n) ||
    ts.isSourceFile(n)
  );
}

/** The condition `child` sits under within `parent`, computed with the parent already in hand (no
 *  climb) — `null` = no branch, `undefined` = a branch we do not state (the op must say `partial`). */
function pushed(parent: ts.Node, child: ts.Node, sf: ts.SourceFile): string | null | undefined {
  const txt = (n: ts.Node): string => n.getText(sf).replace(/\s+/g, ' ').trim();
  const neg = (n: ts.Expression): string =>
    ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken
      ? txt(n.operand)
      : `!(${txt(n)})`;
  if (ts.isIfStatement(parent)) {
    if (parent.thenStatement === child) return txt(parent.expression);
    if (parent.elseStatement === child) return neg(parent.expression);
    return null;
  }
  if (ts.isConditionalExpression(parent)) {
    if (parent.whenTrue === child) return txt(parent.condition);
    if (parent.whenFalse === child) return neg(parent.condition);
    return null;
  }
  if (ts.isBinaryExpression(parent) && parent.right === child) {
    if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      return txt(parent.left);
    if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) return neg(parent.left);
    if (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      return `${txt(parent.left)} == null`;
    return null;
  }
  if (ts.isWhileStatement(parent) && parent.statement === child) return txt(parent.expression);
  if (ts.isForStatement(parent) && parent.statement === child)
    return parent.condition === undefined ? null : txt(parent.condition);
  if (ts.isCaseClause(parent)) {
    if (parent.expression === child) return null; // the case expression itself always evaluates
    const clauses = parent.parent.clauses;
    const scrutinee = txt(parent.parent.parent.expression);
    const exprs = [txt(parent.expression)];
    for (let i = clauses.indexOf(parent) - 1; i >= 0; i--) {
      const prev = clauses[i];
      if (prev === undefined || prev.statements.length > 0) break;
      if (!ts.isCaseClause(prev)) return undefined;
      exprs.unshift(txt(prev.expression));
    }
    return exprs.map((e) => `${scrutinee} === ${e}`).join(' || ');
  }
  if (ts.isDefaultClause(parent) || ts.isCatchClause(parent)) return undefined;
  return null;
}

/** Chains for every `F` identifier, by 1-based line, descending with a condition stack. Lines whose
 *  chain touches an unstated branch are returned as `undefined` (compared only for presence). */
function descentOracle(source: string, name: string): Map<number, string[] | undefined> {
  const sf = ts.createSourceFile('site.ts', source, ts.ScriptTarget.ES2022, true);
  const out = new Map<number, string[] | undefined>();
  const walk = (node: ts.Node, stack: string[] | undefined): void => {
    if (ts.isIdentifier(node) && node.text === name) {
      out.set(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, stack);
    }
    const base = isBoundary(node) ? [] : stack;
    ts.forEachChild(node, (child) => {
      const add = pushed(node, child, sf);
      if (add === undefined) walk(child, undefined);
      else walk(child, base === undefined ? undefined : add === null ? base : [...base, add]);
    });
  };
  walk(sf, []);
  return out;
}

test('oracle 2 (independent descent): the climb agrees site-for-site with a top-down condition stack', async () => {
  const { rows, dispose } = await opChains();
  try {
    const oracle = descentOracle(SITE_SRC, 'F');
    // Every site the descent found must be reported by the op (no dropped site), and vice versa.
    assert.deepEqual(
      rows.map((r) => r.line).sort((a, b) => a - b),
      [...oracle.keys()].sort((a, b) => a - b),
      'the op and the descent oracle must agree on WHICH lines hold a reference',
    );
    for (const row of rows) {
      const expected = oracle.get(row.line);
      if (expected === undefined) {
        // The descent hit a branch it does not state — the op must disclose, not invent.
        assert.equal(row.partial, true, `line ${row.line}: an unstated branch must set partial`);
        continue;
      }
      assert.deepEqual(row.conditions, expected, `line ${row.line}: chain must match the descent`);
    }
  } finally {
    await dispose();
  }
});
