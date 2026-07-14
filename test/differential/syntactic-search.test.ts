// t-515730 — the honesty gate for `search_symbol { syntactic: true }`: the raw AST scan must be a
// SUPERSET of the LS navto provider FOR SOURCE UNDER THE GIT ROOT (≥ recall there, NEVER a silent
// under-root miss — that would be a §3.4 lie), on both a loose-root monorepo AND a local-heavy
// single-config repo. The oracle is the navto path itself (ts.searchSymbol) — a real independent
// oracle, since the two code paths share no logic (navto = LS program + checker dedup; syntactic =
// git surface + getNamedDeclarations, no program). We assert per (name, file, line): every navto
// site is present in the syntactic result. Keying on the NAME (not "inside some enclosing range") is
// what stops an enclosing different-name decl from masking a real miss (a name-token line is stable
// across the two anchoring strategies even where the column differs — the `X as Yprefix` / expando
// straggler cases). We also assert the flag builds NO program (the plugin stays cold), the
// §10-surface cache invalidates on an untracked add→modify→remove (§16 inv.3 cold==warm), the honest
// outside-root scope DISCLOSURE is always present, and every emitted proof span is valid (§16 inv.1).
//
// NOT hermetic here (BLOCK 1): the true outside-root DIFFERENTIAL — navto follows a tsconfig
// `include: ["../shared"]` above the git root while the syntactic git-walk cannot see it — needs a
// file ABOVE the single git root this harness mounts (it would land in the shared tmpdir → a
// cross-fixture collision). It is verified LIVE via the CLI instead; the disclosure that scopes it
// (always-on) IS asserted below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { project, assertSpansValid, type TestProject } from '../helpers/project.ts';
import type { JsonValue } from '../../src/core/json.ts';

const LOCAL_HEAVY: Record<string, string> = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"nodenext","moduleResolution":"nodenext"}}',
  'src/widget.ts': [
    'export const WidgetOption = 1;',
    'export function widgetFactoryFn() { return WidgetOption; }',
    'export class WidgetBase {}',
    'export interface WidgetProps { size: string }',
    'export type WidgetKind = "a" | "b";',
    'export enum WidgetColor { Red, Blue }',
  ].join('\n'),
  'src/app.ts': [
    // aliased import (renamed) + a plain import (same name) + a re-export — the exact surface where
    // navto's checker dedup and the syntactic scan diverge (syntactic keeps the extra sites).
    'import { WidgetBase as Base, WidgetProps } from "./widget.ts";',
    'export { WidgetKind } from "./widget.ts";',
    'const w: WidgetProps = { size: "lg" };',
    'export const useWidget = () => { void w; return new Base(); };',
  ].join('\n'),
};

// Loose-root monorepo: the root tsconfig references a member package with its OWN tsconfig; a symbol
// lives ONLY in the member. navto fans across both programs (Task G); the syntactic scan walks the
// whole-repo git surface — it must not miss the member symbol.
const MONOREPO: Record<string, string> = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"composite":true},"references":[{"path":"packages/lib"}],"include":["src"]}',
  'packages/lib/tsconfig.json':
    '{"compilerOptions":{"strict":true,"composite":true},"include":["."]}',
  'packages/lib/index.ts': 'export const LibOption = 42;\nexport type LibKind = string;',
  'src/main.ts': 'export const MainOption = 1;\nexport function useOption() { return MainOption; }',
};

// A tracked source file in a NAME-ignored dir (`dist/`), import-reached from src. The TS program
// includes it (import resolves INTO the excluded dir — §10), so navto returns its decl; the
// syntactic scan must too (BLOCK 2: no name-based ignore filter on the git surface). Guards against a
// regression re-adding a `hasIgnoredDirSegment` filter that would silently drop it (a §3.4 miss).
const NAME_IGNORED_DIR: Record<string, string> = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src","dist"]}',
  'src/app.ts': 'import { GenThing } from "../dist/gen.ts";\nexport const useIt = GenThing;',
  'dist/gen.ts': 'export const GenThing = 99;',
};

/** (name, file, line) site set from a search_symbol result's `matches`. */
async function sites(
  p: TestProject,
  query: string,
  syntactic: boolean,
  extra?: Record<string, JsonValue>,
): Promise<Set<string>> {
  const [res] = await p.request([
    {
      name: 'search_symbol',
      args: { query, limit: 500, ...(syntactic ? { syntactic: true } : {}), ...(extra ?? {}) },
    },
  ]);
  assert.ok(res !== undefined && 'result' in res, `dispatch for "${query}"`);
  assert.ok(res.result.ok, `search_symbol "${query}" ok`);
  const data = res.result.data as { matches?: readonly Record<string, JsonValue>[] };
  const set = new Set<string>();
  for (const m of data.matches ?? []) {
    const span = m['span'] as { file: string; line: number };
    set.add(`${String(m['name'])}|${span.file}|${span.line}`);
  }
  return set;
}

async function assertSuperset(p: TestProject, queries: readonly string[]): Promise<void> {
  for (const q of queries) {
    const navto = await sites(p, q, false);
    const syn = await sites(p, q, true);
    const missing = [...navto].filter((s) => !syn.has(s));
    assert.equal(
      missing.length,
      0,
      `syntactic MUST ⊇ navto (under-root) for "${q}" — missing: ${missing.join(', ')}`,
    );
    // The scan is a SUPERSET, not an equality: it must surface at least as many sites (the extra
    // import/re-export re-mentions) — a discriminating check that it isn't accidentally the navto
    // path. (Only asserted where navto found something.)
    if (navto.size > 0) assert.ok(syn.size >= navto.size, `syntactic ≥ navto count for "${q}"`);
  }
}

test('syntactic ⊇ navto (under-root) — local-heavy single-config repo', async () => {
  const p = await project(LOCAL_HEAVY);
  try {
    await assertSuperset(p, [
      'Widget',
      'WidgetOption',
      'widgetFactoryFn',
      'WidgetProps',
      'WidgetKind',
      'Base',
    ]);
    // The renamed alias (`Base`) is a site the syntactic scan surfaces — proof it is a real superset.
    const base = await sites(p, 'Base', true);
    assert.ok(base.size > 0, 'syntactic surfaces the renamed-import alias site');
  } finally {
    await p.dispose();
  }
});

test('syntactic ⊇ navto (under-root) — loose-root monorepo (member-only symbol)', async () => {
  const p = await project(MONOREPO);
  try {
    // Prove the oracle is non-vacuous: navto DOES see the member-only symbol (fans across programs),
    // so the superset assertion is actually exercised on cross-program symbols.
    const navtoLib = await sites(p, 'LibOption', false);
    assert.ok(navtoLib.size > 0, 'navto sees the member-only LibOption (Task G fan-out)');
    await assertSuperset(p, ['Option', 'LibOption', 'LibKind', 'MainOption', 'useOption']);
  } finally {
    await p.dispose();
  }
});

test('syntactic scans a tracked source file in a NAME-ignored dir (dist/) that navto returns — BLOCK 2', async () => {
  const p = await project(NAME_IGNORED_DIR);
  try {
    // navto returns it (import-reached into the program); the syntactic git-surface scan must too.
    const navto = await sites(p, 'GenThing', false);
    assert.ok(
      [...navto].some((s) => s.includes('dist/gen.ts')),
      'navto returns the real decl in dist/ (import-reached, non-vacuous oracle)',
    );
    const syn = await sites(p, 'GenThing', true);
    assert.ok(
      [...syn].some((s) => s.includes('dist/gen.ts')),
      'syntactic includes the real decl in the name-ignored dist/ (not dropped by a name filter)',
    );
  } finally {
    await p.dispose();
  }
});

test('syntactic exportedOnly keeps export-specifiers, drops pure imports (recall-gap fix, t-926410)', async () => {
  const p = await project(LOCAL_HEAVY);
  try {
    // `export { WidgetKind } from "./widget.ts"` (app.ts) is a genuine export navto returns under
    // exportedOnly — the syntactic path must KEEP it. Regression guard: dropping it as `!real` (both
    // imports AND export-specifiers) was a §3.4 recall gap UNDER the filter.
    const kind = await sites(p, 'WidgetKind', true, { exportedOnly: true });
    assert.ok(
      [...kind].some((s) => s.includes('app.ts')),
      'export { WidgetKind } re-export site kept under exportedOnly',
    );
    // A pure IMPORT specifier (`import { WidgetProps }` in app.ts) IS dropped under exportedOnly,
    // while its real decl (widget.ts) is kept — and the import site IS present WITHOUT the filter.
    const propsAll = await sites(p, 'WidgetProps', true);
    const propsExp = await sites(p, 'WidgetProps', true, { exportedOnly: true });
    assert.ok(
      [...propsAll].some((s) => s.includes('app.ts')),
      'the import site is present without exportedOnly',
    );
    assert.ok(
      ![...propsExp].some((s) => s.includes('app.ts')),
      'the pure import site is dropped under exportedOnly',
    );
    assert.ok(
      [...propsExp].some((s) => s.includes('widget.ts')),
      'the real decl is kept under exportedOnly',
    );
  } finally {
    await p.dispose();
  }
});

test('syntactic path builds NO program (the ts plugin stays cold) + spans valid', async () => {
  const p = await project(LOCAL_HEAVY);
  try {
    const res = await p.op('search_symbol', { query: 'Widget', syntactic: true, limit: 50 });
    assert.ok('result' in res && res.result.ok, 'syntactic search ok');
    assert.ok(
      assertSpansValid(p.root, res) > 0,
      'every proof span is valid + non-vacuous (§16 inv.1)',
    );

    // No program was built and the LS never warmed → the ts plugin fingerprint is still 'cold'.
    const cold = await p.orchestrator.status(p.root, p.root);
    const tsCold = cold.workspace?.plugins.find((x) => x.id === 'ts');
    assert.equal(
      tsCold?.fingerprint,
      'cold',
      'syntactic search must NOT warm the LS / build a program',
    );

    // Contrast: the default navto path DOES warm it — proves the assertion above is discriminating.
    await p.op('search_symbol', { query: 'Widget', limit: 50 });
    const warm = await p.orchestrator.status(p.root, p.root);
    const tsWarm = warm.workspace?.plugins.find((x) => x.id === 'ts');
    assert.notEqual(tsWarm?.fingerprint, 'cold', 'the default (navto) path warms the LS');
  } finally {
    await p.dispose();
  }
});

test('syntactic cache invalidates on untracked add→MODIFY→remove (§10-surface fingerprint, not projectVersion) — §16 inv.3 cold==warm', async () => {
  const p = await project(LOCAL_HEAVY);
  try {
    // Prime the parsed-surface cache with a first syntactic query, so a STALE cache could be served
    // on the following calls — the whole point of the invalidation proof.
    await sites(p, 'WidgetOption', true);
    assert.equal((await sites(p, 'AlphaSym', true)).size, 0, 'absent before it exists');

    // ADD an untracked-not-ignored file → porcelain gains `?? src/fresh.ts` → the surface key
    // changes → rebuild. (Also proves the `--others --exclude-standard` half sees untracked source.)
    p.write('src/fresh.ts', 'export const AlphaSym = 1;');
    assert.ok(
      [...(await sites(p, 'AlphaSym', true))].some((s) => s.startsWith('AlphaSym|')),
      'ADD: seen (untracked included, cache rebuilt)',
    );

    // MODIFY the SAME already-untracked file: its porcelain line is UNCHANGED (`?? src/fresh.ts`
    // before AND after), so `projectVersion` (HEAD+porcelain) would NOT bump — a projectVersion-keyed
    // cache would serve the stale parse. The content hash of the porcelain set is what invalidates.
    // This is the directive-2 merge gate: prove REAL invalidation.
    p.write('src/fresh.ts', 'export const BetaSym = 2;');
    assert.equal(
      (await sites(p, 'AlphaSym', true)).size,
      0,
      'MODIFY: old symbol gone (no stale cache served)',
    );
    assert.ok(
      [...(await sites(p, 'BetaSym', true))].some((s) => s.startsWith('BetaSym|')),
      'MODIFY: new symbol seen (surface fingerprint invalidated where projectVersion would not)',
    );

    // SAME-SIZE edit with the mtime RESET to its prior value — simulates a coarse-mtime FS same-tick
    // edit (BLOCK 2): (mtime, size) are byte-identical, ONLY content differs. A mtime+size key would
    // serve the stale parse here; the §19-style CONTENT hash in the surface key must still invalidate.
    const fp = path.join(p.root, 'src/fresh.ts');
    const before = statSync(fp);
    p.write('src/fresh.ts', 'export const CetaSym = 2;'); // same byte length as the BetaSym line
    utimesSync(fp, before.atime, before.mtime); // restore the identical stamp
    assert.equal(
      (await sites(p, 'BetaSym', true)).size,
      0,
      'SAME-SIZE+reset-mtime: old symbol gone (content hash, not mtime+size)',
    );
    assert.ok(
      [...(await sites(p, 'CetaSym', true))].some((s) => s.startsWith('CetaSym|')),
      'SAME-SIZE+reset-mtime: new symbol seen (content hash closes the §19 coarse-FS window)',
    );

    // REMOVE → porcelain drops the entry → key changes → rebuild → gone.
    p.remove('src/fresh.ts');
    assert.equal((await sites(p, 'CetaSym', true)).size, 0, 'REMOVE: gone again');
  } finally {
    await p.dispose();
  }
});

async function note(p: TestProject, query: string): Promise<string> {
  const [res] = await p.request([
    { name: 'search_symbol', args: { query, syntactic: true, limit: 10 } },
  ]);
  assert.ok(res !== undefined && 'result' in res && res.result.ok);
  return String((res.result.data as { note?: string }).note);
}

test('syntactic result carries provenance + not-navto note + outside-root scope disclosure (guardrail 3/4, BLOCK 1)', async () => {
  const p = await project(LOCAL_HEAVY);
  try {
    const [res] = await p.request([
      { name: 'search_symbol', args: { query: 'WidgetOption', syntactic: true, limit: 10 } },
    ]);
    assert.ok(res !== undefined && 'result' in res && res.result.ok);
    const data = res.result.data as {
      note?: string;
      matches?: readonly Record<string, JsonValue>[];
    };
    assert.match(
      String(data.note),
      /NOT the LS/i,
      'states it is not the navto provider (guardrail 4)',
    );
    assert.ok(
      (data.matches ?? []).every((m) => m['provenance'] === 'syntactic'),
      'every site provenance:syntactic (guardrail 3)',
    );
    // The honest outside-root scope must be disclosed POSITIVELY on EVERY answer — the daemon-
    // independent surface that survives an in-process OOM (BLOCK 1). On a hit AND on an empty.
    assert.match(
      String(data.note),
      /under the workspace root/i,
      'discloses under-root scope on a hit',
    );
    assert.match(String(data.note), /outside/i, 'discloses the outside-root gap on a hit');
    const emptyNote = await note(p, 'NoSuchSymbolXYZ');
    assert.match(emptyNote, /under the workspace root/i, 'empty result states under-root scope');
    assert.match(
      emptyNote,
      /default \(navto\)/i,
      'empty result points outside-root to the default',
    );
  } finally {
    await p.dispose();
  }
});
