// The shared input for the condition-chain oracles (t-933867): ONE case table + one op call, imported
// by both the fixture oracle (usages-condition-chain.test.ts) and the independent descent oracle
// (usages-condition-descent.test.ts). Shared because it is the INPUT; the two oracles' rule logic is
// deliberately NOT shared — a common helper between them would make the differential a tautology (§16).

import assert from 'node:assert/strict';
import { project } from '../../helpers/project.ts';

/** One fixture line: the statement, and the chain the site inside it sits under (outermost →
 *  innermost). `partial` = the op must flag an unstated branch. */
export type Case = { code: string; conditions: string[]; partial?: true };

export const CASES: Case[] = [
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
  {
    code:
      'export function b(o: { n?: number; b?: () => boolean; c?: { d: (v: boolean) => boolean }; ' +
      'e?: Record<string, (v: boolean) => boolean>; f?: boolean[]; g?: boolean; h?: boolean }, ' +
      'k: string, x: boolean, arr: boolean[]): void {',
    conditions: [],
  },
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
  // Optional-chain short-circuit: the ARGUMENT is not evaluated at all when the link is nullish.
  { code: '  o.b?.(F());', conditions: ['o.b != null'] },
  { code: '  o.c?.d(F());', conditions: ['o.c != null'] },
  { code: '  o.e?.[k](F());', conditions: ['o.e != null'] },
  { code: '  void o.f?.[F() ? 0 : 1];', conditions: ['o.f != null'] },
  { code: '  void arr[F()];', conditions: [] }, // a plain index is not a branch
  // Logical assignment short-circuits like its non-assigning twin.
  { code: '  o.g ||= F();', conditions: ['!(o.g)'] },
  { code: '  o.g &&= F();', conditions: ['o.g'] },
  { code: '  o.h ??= F();', conditions: ['o.h == null'] },
  { code: '  F();', conditions: [] }, // measured: no enclosing branch
  { code: '  if (x) { const cb = (): void => { F(); }; cb(); }', conditions: [] }, // closure boundary
  // Class boundary: a property initializer runs at construction, not under the enclosing branch.
  { code: '  if (x) { const C = class { p = F(); }; void new C(); }', conditions: [] },
  {
    code: '  if (x) { const D = class { get q(): boolean { return F(); } }; void D; }',
    conditions: [],
  },
  { code: '  void n1;', conditions: [] },
  { code: '}', conditions: [] },
];

export const SITE_FILE = 'src/site.ts';
export const SITE_SRC = `import { F } from './f';\n${CASES.map((c) => c.code).join('\n')}\n`;

export const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"es2022"}}',
  'src/f.ts': 'export const F = (): boolean => true;\n',
  [SITE_FILE]: SITE_SRC,
};

/** Expected chain per 1-based line of the fixture (line 1 is the import). */
export function expectedByLine(): Map<number, Case> {
  const m = new Map<number, Case>();
  CASES.forEach((c, i) => {
    if (c.code.includes('F()')) m.set(i + 2, c);
  });
  return m;
}

export type ChainRow = { line: number; conditions: string[]; partial: boolean };

export async function opChains(): Promise<{ rows: ChainRow[]; dispose: () => Promise<void> }> {
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

