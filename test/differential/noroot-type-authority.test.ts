// No-root type-authority routing (t-593802 / t-608842), oracle-backed (§16). In a repo with NO root
// tsconfig the primary is the "(no tsconfig)" FALLBACK, which globs the WHOLE repo under DEFAULT
// options — so its type-space wrongly absorbs a whole-repo `declare global` augmentation stray, and a
// TYPE query on a MEMBER src symbol reports a type the member's real tsconfig never yields (the
// never-lie §3 violation). The fix routes every type-PRODUCING read (expand_type, construction_sites,
// discrimination_sites, firstParamTypeMembers, wideningSinksAt) through `host.typeAuthorityFor(abs)`,
// which returns the DEEPEST-ENCLOSING real-config program owning the file instead of the fallback.
//
// The independent oracle is a fresh-from-cold `ts.Program` over the MEMBER's OWN tsconfig — the
// ground-truth type the member's real options yield (a DIFFERENT program than the warm daemon's
// fallback), so a routing miss surfaces as a member-vs-fallback drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { project, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const C = '{"strict":true,"module":"esnext","moduleResolution":"bundler"}';

function data(r: OpResult): Record<string, unknown> {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as Record<string, unknown>;
}
type Member = { name: string };
const memberNames = (d: Record<string, unknown>): string[] =>
  ((d.members as Member[] | undefined) ?? []).map((m) => m.name).sort();

/** Cold oracle: the property names a fresh `ts.Program` over `configRel` yields for the global
 *  interface `typeName` (the member's OWN options — its type-space excludes the whole-repo stray). */
function coldGlobalInterfaceProps(root: string, configRel: string, typeName: string): string[] {
  const configPath = path.join(root, configRel);
  const raw = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'));
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const props = new Set<string>();
  const visit = (node: ts.Node): void => {
    // The interface may sit inside `declare global { … }` (a ModuleDeclaration) — recurse, don't
    // scan top-level only. getDeclaredTypeOfSymbol yields the MERGED type within THIS program.
    if (ts.isInterfaceDeclaration(node) && node.name.text === typeName) {
      const sym = checker.getSymbolAtLocation(node.name);
      if (sym !== undefined) {
        const t = checker.getDeclaredTypeOfSymbol(sym);
        for (const p of checker.getApparentType(t).getProperties()) props.add(p.getName());
      }
    }
    node.forEachChild(visit);
  };
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    visit(sf);
  }
  return [...props].sort();
}

// A member `packages/a` with a global `interface Widget { real }` + a member-resident const `w:
// Widget`; a ROOT-LEVEL stray `aug.ts` (globbed by the fallback, owned by NO member) augments Widget
// with `polluted`. The member's own program never sees the stray → Widget = { real }.
const NOROOT_FIXTURE = {
  'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
  'package.json': '{"name":"root","private":true}', // NO root tsconfig → fallback primary
  'packages/a/package.json': '{"name":"pkg-a"}',
  'packages/a/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
  'packages/a/src/model.ts': [
    'declare global { interface Widget { real: string } }',
    "export const w: Widget = { real: 'x' };",
    'export function useWidget(o: Widget) { return o.real; }',
    "type Kind = { tag: 'a'; n: number } | { tag: 'b'; s: string };",
    "export function pick(k: Kind) { switch (k.tag) { case 'a': return k.n; case 'b': return k.s; } }",
    '',
  ].join('\n'),
  'aug.ts': 'export {};\ndeclare global { interface Widget { polluted: number } }\n',
};

test('(A) expand_type of a member const routes to the member program — un-polluted (vs cold member oracle)', async () => {
  const p: TestProject = await project(NOROOT_FIXTURE);
  try {
    const d = data(await p.op('expand_type', { name: 'w' }));
    // The member's own program has Widget = { real } — the whole-repo `polluted` stray is absent.
    assert.deepEqual(
      memberNames(d),
      ['real'],
      `member type must be un-polluted: ${JSON.stringify(d)}`,
    );
    assert.ok(
      !memberNames(d).includes('polluted'),
      'the fallback-only `polluted` augmentation must NOT leak into a member symbol type',
    );
    // Cold oracle over the MEMBER's own tsconfig — the ground-truth member view.
    const oracle = coldGlobalInterfaceProps(p.root, 'packages/a/tsconfig.json', 'Widget');
    assert.deepEqual(
      memberNames(d),
      oracle,
      'warm member-routed type matches the cold member oracle',
    );
  } finally {
    await p.dispose();
  }
});

test('(B) construction_sites on the member-resident type target scans under member options — the member literal IS a site (fallback would excess-fail it)', async () => {
  const p: TestProject = await project(NOROOT_FIXTURE);
  try {
    // Target the Widget declaration IN the member file (model.ts:1) → member authority → Widget={real}
    // → the `{ real: 'x' }` initializer is assignable. Under the fallback (Widget={real,polluted}) it
    // is missing `polluted` and excess-fails → 0 sites. So a non-empty result discriminates the fix.
    const d = data(
      await p.op('construction_sites', { file: 'packages/a/src/model.ts', line: 1, col: 28 }),
    );
    const sites = (d.sites as unknown[] | undefined) ?? [];
    assert.ok(
      sites.length >= 1,
      `member literal must be a construction site under member options: ${JSON.stringify(d)}`,
    );
  } finally {
    await p.dispose();
  }
});

test('(C) discrimination_sites + trace_type_widening on member symbols route to the member program (target resolves, member switch found)', async () => {
  const p: TestProject = await project(NOROOT_FIXTURE);
  try {
    // discrimination_sites: the union Kind + its switch both live in the member; the target must
    // resolve in the member program (not lost to the fallback) and the member switch is found.
    const disc = data(await p.op('discrimination_sites', { name: 'Kind' }));
    const dsites = (disc.sites as unknown[] | undefined) ?? [];
    assert.ok(dsites.length >= 1, `member switch on Kind must be found: ${JSON.stringify(disc)}`);
    // trace_type_widening: the value `w` (typed Widget) — its source type is read in the member
    // program, so the reported type text must not carry the fallback-only `polluted`.
    const wd = data(await p.op('trace_type_widening', { name: 'w' }));
    assert.ok(
      !JSON.stringify(wd).includes('polluted'),
      `widening source type must be the member view (no fallback pollutant): ${JSON.stringify(wd)}`,
    );
  } finally {
    await p.dispose();
  }
});

test('(D) MULTI-OWNER determinism: a file owned by its member (glob) AND another member (import) routes to the DEEPEST-ENCLOSING owner — cold==warm', async () => {
  // pkg-a/src/model.ts is GLOB-owned by pkg-a AND import-owned by pkg-b (which imports it AND augments
  // the global Widget with `polluted`). If routing picked "first containsFile program" it could pick
  // pkg-b (polluting the type) depending on lazy-warm order → cold≠warm. The deterministic rule is
  // nearestConfig → pkg-a (the deepest ENCLOSING tsconfig), never pkg-b (import-only, non-enclosing).
  const p: TestProject = await project({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': '{"name":"root","private":true}',
    'packages/a/package.json': '{"name":"pkg-a"}',
    'packages/a/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/a/src/model.ts':
      "declare global { interface Widget { real: string } }\nexport const w: Widget = { real: 'x' };\n",
    'packages/b/package.json': '{"name":"pkg-b"}',
    'packages/b/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/b/src/use.ts':
      "import { w } from '../../a/src/model';\n" +
      'declare global { interface Widget { polluted: number } }\n' +
      'export const z = w;\n',
  });
  try {
    // Warm pkg-b FIRST (find_usages fans out and builds every sibling) so an order-dependent rule
    // would have pkg-b available as a containsFile owner of model.ts before the type read.
    await p.op('find_usages', { name: 'w' });
    const d = data(await p.op('expand_type', { name: 'w' }));
    assert.deepEqual(
      memberNames(d),
      ['real'],
      `deepest-enclosing owner (pkg-a) must win over the import-owner (pkg-b): ${JSON.stringify(d)}`,
    );
    // Oracle: pkg-a's own program (the deepest owner) yields exactly { real }.
    const oracle = coldGlobalInterfaceProps(p.root, 'packages/a/tsconfig.json', 'Widget');
    assert.deepEqual(memberNames(d), oracle, 'the member-routed type matches pkg-a cold oracle');
  } finally {
    await p.dispose();
  }
});

test('(E) ROOTED repo is unchanged: a real root tsconfig stays the type-authority (short-circuit before built())', async () => {
  // With a REAL root tsconfig the primary has real options → typeAuthorityFor returns it unchanged.
  // The root globs only src, so the `packages/x` file is NOT in the primary; a member const there
  // still expands via its own program. This pins that the rooted short-circuit does not break normal
  // expand_type (and does not force sibling construction for an in-primary symbol).
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'src/root.ts': "export interface Cfg { a: string }\nexport const c: Cfg = { a: 'x' };\n",
  });
  try {
    const d = data(await p.op('expand_type', { name: 'c' }));
    assert.deepEqual(memberNames(d), ['a'], `rooted expand_type unchanged: ${JSON.stringify(d)}`);
  } finally {
    await p.dispose();
  }
});
