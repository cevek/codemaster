// Col-less symbol addressing at the shared resolver (resolve-target.ts) — the two additive forms
// an agent reaches for when it pasted a `file:line` (no column) or knows a `name` + its `file`:
//   · `file+line` (no col)  → the declaration ON that line (one → taken; several → honest pick-list)
//   · `name+file`           → the top-level declaration of that name IN that file, RANK-INDEPENDENT
//                             (never navto's fuzzy case-insensitive search, which floods an exact
//                             but low-rank symbol past its cap)
// Plus `find_usages symbols:[…]` accepting a SymbolId per element (the held-handle chain premise).
//
// Independent oracle: the canonical, UNCHANGED `{file,line,col}` / `{symbolId}` resolution. The
// SymbolId a resolution mints encodes its declaration site, so equality of definition ids proves
// two addressing forms landed on the SAME symbol — without a second LS (§16). Each test is
// discriminating: the pre-change resolver FAILED the col-less / name+file forms outright.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { project, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

function defId(r: OpResult): string {
  assert.ok('result' in r && r.result.ok, `expected ok: ${JSON.stringify(r)}`);
  const id = (r.result.data as { definition?: { id?: string } }).definition?.id;
  assert.ok(typeof id === 'string' && id.startsWith('ts:'), `expected a ts: SymbolId, got ${id}`);
  return id;
}
function failMsg(r: OpResult): string {
  assert.ok('result' in r && !r.result.ok, `expected a FAIL, got ${JSON.stringify(r)}`);
  return r.result.failure.message;
}
type Usage = { span: { file: string; line: number; col: number }; role: string };
function usagesOf(r: OpResult): Usage[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return (r.result.data as { usages?: Usage[] }).usages ?? [];
}
const projset = (u: Usage[]): string[] =>
  u.map((x) => `${x.span.file}:${x.span.line}:${x.role}`).sort();

const M = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/m.ts':
    'export const alpha = 1;\n' + // line 1: one decl `alpha` (col 14)
    'export const beta = 2, gamma = 3;\n' + // line 2: TWO decls (beta col 14, gamma col 24)
    'export function helper(): number {\n' + // line 3: one decl `helper`
    '  return alpha + beta + gamma;\n' + // line 4: ZERO decls (only usages)
    '}\n',
};

test('file+line (no col) resolves the lone declaration on that line — identical to file+line+col', async () => {
  const p: TestProject = await project(M);
  try {
    const byLine = defId(await p.op('find_usages', { file: 'src/m.ts', line: 1 }));
    // Oracle: the canonical col-based form (unchanged code) — `alpha` starts at col 14.
    const byCol = defId(await p.op('find_usages', { file: 'src/m.ts', line: 1, col: 14 }));
    assert.equal(byLine, byCol, 'col-less file+line landed on the same symbol as file+line+col');

    // `helper` on line 3 (a different declaration kind) resolves too.
    const helper = defId(await p.op('find_usages', { file: 'src/m.ts', line: 3 }));
    assert.match(helper, /helper@src\/m\.ts:3:/, 'resolved the function declaration on line 3');
  } finally {
    await p.dispose();
  }
});

test('file+line (no col) on a line with SEVERAL declarations → honest pick-list, never a guess', async () => {
  const p: TestProject = await project(M);
  try {
    const msg = failMsg(await p.op('find_usages', { file: 'src/m.ts', line: 2 }));
    assert.match(msg, /2 declarations/, 'reports the count');
    assert.match(msg, /beta at col 14/, 'lists beta with its column');
    assert.match(msg, /gamma at col 24/, 'lists gamma with its column');
    assert.match(msg, /file:line:col/, 'tells the agent how to disambiguate');
  } finally {
    await p.dispose();
  }
});

test('file+line (no col) on a line with NO declaration fails honestly (not a fabricated position)', async () => {
  const p: TestProject = await project(M);
  try {
    const msg = failMsg(await p.op('find_usages', { file: 'src/m.ts', line: 4 }));
    assert.match(msg, /no declaration.*on src\/m\.ts:4/, 'honest "no declaration on this line"');
  } finally {
    await p.dispose();
  }
});

test('name+file+line scopes the line to that name (line-scoped, not a workspace search)', async () => {
  const p: TestProject = await project(M);
  try {
    // Line 2 is ambiguous bare, but `name:'gamma'` picks the gamma declarator on it.
    const id = defId(await p.op('find_usages', { name: 'gamma', file: 'src/m.ts', line: 2 }));
    assert.match(id, /gamma@src\/m\.ts:2:24/, 'name filter selected gamma on the shared line');
  } finally {
    await p.dispose();
  }
});

// ── absolute file addressing (§19 chokepoint / t-614260) ─────────────────────────────────────────
// An agent pastes an ABSOLUTE `file` (a grep/editor hit), not only a repo-relative one. The
// absolute path must brand — through the SAME §19 canonicalization chokepoint (`mintRepoRelPath`:
// realpath + case-fold + symlink/pnpm policy) the relative form reaches — to the SAME symbol. On
// main it double-joined onto the root (`path.join(root, absPath)`) → a nonexistent path → a false
// "file not in the TS project", EVEN with a matching `root` passed. Oracle: the relative form's
// SymbolId (identity by declaration site, §16) — no second LS.

test('absolute file path resolves identically to the relative form (§19 chokepoint)', async () => {
  const p: TestProject = await project(M);
  try {
    const rel = defId(await p.op('find_usages', { file: 'src/m.ts', line: 1 }));
    const abs = defId(await p.op('find_usages', { file: path.join(p.root, 'src/m.ts'), line: 1 }));
    assert.equal(abs, rel, 'absolute file address == relative file address (same symbol)');
  } finally {
    await p.dispose();
  }
});

test('an absolute file OUTSIDE the repo root fails honestly, never guessed', async () => {
  const p: TestProject = await project(M);
  try {
    // A sibling of the repo root (`../not-this-repo/…`) resolves outside → the mint refuses it and
    // absOf passes it through, so `sourceFileAcross` misses and the resolver fails honestly.
    const outside = path.join(path.dirname(p.root), 'not-this-repo', 'src', 'm.ts');
    const msg = failMsg(await p.op('find_usages', { file: outside, line: 1 }));
    assert.match(msg, /file not in the TS project/, 'out-of-root abspath → honest not-in-project');
  } finally {
    await p.dispose();
  }
});

test('a case-variant absolute path folds to the same symbol on a case-insensitive volume', async () => {
  const p: TestProject = await project(M);
  try {
    // The §19 case-fold, end-to-end through absOf's mint routing. Only meaningful on a
    // case-INSENSITIVE volume (APFS/NTFS); probed at runtime so a case-sensitive CI volume skips
    // cleanly rather than failing on a genuinely-absent path. (The fold itself is unit-tested
    // against an injected realpath in support.test.ts; here we prove absOf ROUTES to it.)
    const variant = path.join(p.root, 'SRC', 'M.ts');
    if (!existsSync(variant)) return; // case-sensitive volume — the variant path is truly absent
    const rel = defId(await p.op('find_usages', { file: 'src/m.ts', line: 1 }));
    const folded = defId(await p.op('find_usages', { file: variant, line: 1 }));
    assert.equal(folded, rel, 'a differently-cased abspath brands to the true on-disk key');
  } finally {
    await p.dispose();
  }
});

const DUP = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  // The SAME name declared top-level in two files — bare `{name}` is ambiguous workspace-wide,
  // so file-scoping is what makes the address resolvable (and discriminates vs the old resolver,
  // which ignored `file` and fell into the ambiguous workspace search).
  'src/a.ts': 'export const Thing = (): number => 1;\n',
  'src/b.ts': 'export const Thing = (): string => "x";\n',
  // Two top-level declarations of one name in ONE file (legal interface merging) — the rare
  // name+file ambiguity.
  'src/dup.ts': 'export interface Dup { a: number }\nexport interface Dup { b: number }\n',
};

test('name+file resolves the exact in-file declaration, file-scoped (rank-independent)', async () => {
  const p: TestProject = await project(DUP);
  try {
    const inA = defId(await p.op('find_usages', { name: 'Thing', file: 'src/a.ts' }));
    const inB = defId(await p.op('find_usages', { name: 'Thing', file: 'src/b.ts' }));
    assert.match(inA, /Thing@src\/a\.ts:/, 'name+file resolved a.ts');
    assert.match(inB, /Thing@src\/b\.ts:/, 'name+file resolved b.ts');
    assert.notEqual(inA, inB, 'the file scopes the resolution to different declarations');

    // Discriminating: bare `{name}` (no file) is ambiguous workspace-wide and FAILS — proving
    // name+file is not just falling through to the old workspace search.
    const bare = failMsg(await p.op('find_usages', { name: 'Thing' }));
    assert.match(bare, /ambiguous/, 'bare name is ambiguous; file-scoping is what resolves it');
  } finally {
    await p.dispose();
  }
});

test('name+file with >1 same-named top-level declaration → honest pick-list', async () => {
  const p: TestProject = await project(DUP);
  try {
    const msg = failMsg(await p.op('find_usages', { name: 'Dup', file: 'src/dup.ts' }));
    assert.match(msg, /2 top-level declarations named 'Dup'/, 'reports the in-file ambiguity');
    assert.match(msg, /file:line:col/, 'tells the agent how to disambiguate');
  } finally {
    await p.dispose();
  }
});

// RANK-INDEPENDENCE under a navto flood — the expand_type "Bug C" condition, made DISCRIMINATING:
// 15 top-level `export const span` (EXACT name `span`, a case-insensitive collision with `Span`)
// across files push the type `Span` past the workspace-search cap (10). So bare `{name:'Span'}` —
// the pure navto path, IDENTICAL on main — FAILS "no symbol named 'Span'" (asserted below), while
// `{name:'Span',file}` resolves via the direct AST pass (never navto). On main, where `file` is
// ignored, name+file falls into that SAME flooded search and fails too — so this test is RED there.
const FLOOD = ((): Record<string, string> => {
  const files: Record<string, string> = {
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/types.ts': 'export interface Span { start: number; end: number }\n', // `Span` at 1:18
  };
  for (let i = 0; i < 15; i++) files[`src/flood${i}.ts`] = `export const span = ${i};\n`;
  return files;
})();

test('name+file resolves an exact type the navto flood buries past the cap (rank-independent — expand_type Bug C)', async () => {
  const p: TestProject = await project(FLOOD);
  try {
    // The flood condition AND the discriminator vs main: bare `{name:'Span'}` — pure navto — is
    // pushed past the cap by the 15 lowercase `span`, so it cannot find the exact type.
    const bare = await p.op('expand_type', { name: 'Span' });
    assert.ok(
      'result' in bare && !bare.result.ok,
      `flood must bury bare Span: ${JSON.stringify(bare)}`,
    );
    assert.match(
      bare.result.failure.message,
      /no symbol named 'Span'/,
      'navto flooded past the cap',
    );

    // name+file resolves it anyway (direct AST pass). Oracle: the positional form — `Span` at 1:18.
    const byName = await p.op('expand_type', { name: 'Span', file: 'src/types.ts' });
    assert.ok(
      'result' in byName && byName.result.ok,
      `name+file must resolve Span: ${JSON.stringify(byName)}`,
    );
    const byPos = await p.op('expand_type', { file: 'src/types.ts', line: 1, col: 18 });
    assert.ok('result' in byPos && byPos.result.ok, JSON.stringify(byPos));
    type Member = { name: string };
    const names = (r: typeof byName): string[] =>
      (('result' in r && r.result.ok && (r.result.data as { members?: Member[] }).members) || [])
        .map((m) => m.name)
        .sort();
    assert.deepEqual(names(byName), names(byPos), 'name+file view == file+line+col view');
    assert.deepEqual(names(byName), ['end', 'start'], 'resolved the Span type, not a span const');
  } finally {
    await p.dispose();
  }
});

const BTN = {
  'tsconfig.json': '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}',
  'src/Button.tsx':
    'export interface Props { size: string }\n' +
    'export const Button = (p: Props) => <button>{p.size}</button>;\n',
  'src/App.tsx':
    "import { Button as B } from './Button';\n" + 'export const App = () => <B size="lg" />;\n',
};

test('find_usages symbols:[SymbolId] resolves the held handle — identical to the single-target form', async () => {
  const p: TestProject = await project(BTN);
  try {
    const id = defId(await p.op('find_usages', { name: 'Button', collapseImports: false }));

    // Single-target SymbolId form (the oracle the array element must match).
    const single = usagesOf(await p.op('find_usages', { symbolId: id, collapseImports: false }));

    // Array form: each element classified like the single target — a SymbolId, not a literal name.
    const arr = await p.op('find_usages', { symbols: [id], collapseImports: false });
    assert.ok(
      'result' in arr && arr.result.ok,
      `symbols[SymbolId] must resolve: ${JSON.stringify(arr)}`,
    );
    const data = arr.result.data as {
      targets?: { symbol: string; usages?: Usage[] }[];
      unresolved?: unknown[];
    };
    assert.equal(data.unresolved, undefined, 'a held SymbolId element is NOT unresolved');
    const t0 = data.targets?.[0];
    assert.ok(t0 !== undefined, `expected one target section: ${JSON.stringify(data)}`);
    assert.equal(t0.symbol, id, 'the section is keyed by the original addressing string');
    assert.deepEqual(
      projset(t0.usages ?? []),
      projset(single),
      'symbols:[SymbolId] == single-target {symbolId}',
    );
  } finally {
    await p.dispose();
  }
});

test('find_usages symbols mixes SymbolId + bare name + position in one call', async () => {
  const p: TestProject = await project(BTN);
  try {
    const id = defId(await p.op('find_usages', { name: 'Button', collapseImports: false }));
    const r = await p.op('find_usages', {
      symbols: [id, 'Props', 'src/App.tsx:2:14'],
      collapseImports: false,
    });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const data = r.result.data as { targets?: { symbol: string }[]; unresolved?: unknown[] };
    assert.equal(data.unresolved, undefined, `all three forms resolve: ${JSON.stringify(data)}`);
    assert.equal(data.targets?.length, 3, 'three resolved sections');
  } finally {
    await p.dispose();
  }
});
