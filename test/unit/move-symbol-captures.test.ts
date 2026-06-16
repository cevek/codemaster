// Unit coverage for move_symbol's capture-safety reconstruction (`detectMoveSymbolCaptures`).
// The e2e suite can't reliably COAX the LS "Move to file" into emitting a path-capture (the LS
// resolves correctly, so its specifiers land on dest by construction) — so the detection logic is
// pinned here directly, over a hand-built RefactorPlan + in-memory overlay resolution. This proves
// the integration (reconstructRewrites → detectImportCaptures) actually FIRES on a real divergence,
// guards against OVER-refusal on a clean move, and honours the conservative pre-existing-skip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import ts from 'typescript';
import type { RepoRelPath } from '../../src/core/brands.ts';
import type { TsProjectHost } from '../../src/plugins/ts/ls-host.ts';
import type { RefactorPlan } from '../../src/plugins/ts/refactor/plan.ts';
import { detectMoveSymbolCaptures } from '../../src/plugins/ts/refactor/capture/move-symbol.ts';

const ROOT = '/virt';
// detectMoveSymbolCaptures + its callees touch ONLY `host.absOf` — a minimal fake is faithful.
const fakeHost = { absOf: (rel: RepoRelPath) => path.join(ROOT, rel) } as unknown as TsProjectHost;
const OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

const SAME_NAMED = 'export const helper = (): number => 1;\n';
const overlay = (after: string): RefactorPlan['overlayFiles'] => [
  { path: 'src/consumer.ts' as RepoRelPath, content: after },
  { path: 'src/other.ts' as RepoRelPath, content: SAME_NAMED }, // a DIFFERENT same-named helper
  { path: 'src/dest.ts' as RepoRelPath, content: SAME_NAMED }, // the intended dest
];

/** A one-importer plan whose `consumer.ts` went `before` → `after`. */
function planFor(before: string, after: string): RefactorPlan {
  return {
    moves: [],
    newFiles: [],
    contentWrites: [],
    removed: [],
    overlayFiles: overlay(after),
    checkPaths: [],
    diff: [
      {
        from: 'src/consumer.ts' as RepoRelPath,
        to: 'src/consumer.ts' as RepoRelPath,
        before,
        after,
      },
    ],
    captures: [],
  };
}

test('move_symbol capture: a rewritten import resolving to a DIFFERENT same-named export is flagged', () => {
  // The move INTENDED dest (src/dest.ts), but the importer's new specifier points at './other' —
  // a same-named, type-compatible export the §2.8 typecheck would wave through.
  const before = 'export const x = 1;\n';
  const after = "import { helper } from './other';\nexport const x = (): number => helper();\n";
  const captures = detectMoveSymbolCaptures(
    fakeHost,
    OPTIONS,
    planFor(before, after),
    'src/dest.ts' as RepoRelPath,
    'helper',
  );
  assert.equal(captures.length, 1, `expected one capture, got ${JSON.stringify(captures)}`);
  const [c] = captures;
  assert.ok(c !== undefined);
  assert.equal(c.file, 'src/consumer.ts');
  assert.equal(c.kind, 'forward');
  assert.match(c.detail, /other\.ts/);
  assert.match(c.detail, /dest\.ts/);
  assert.ok(c.line >= 1 && c.col >= 1, 'capture carries a 1-based proof coordinate');
});

test('move_symbol capture: a clean move (specifier resolves to dest) flags NOTHING — no over-refusal', () => {
  const before = 'export const x = 1;\n';
  const after = "import { helper } from './dest';\nexport const x = (): number => helper();\n";
  const captures = detectMoveSymbolCaptures(
    fakeHost,
    OPTIONS,
    planFor(before, after),
    'src/dest.ts' as RepoRelPath,
    'helper',
  );
  assert.deepEqual(captures, [], 'a specifier landing on the intended dest is never a capture');
});

test('move_symbol capture: a PRE-EXISTING same-named import (unchanged by the move) is not policed', () => {
  // The importer already imported a DIFFERENT `helper` from './other' before the move; the move did
  // not touch that line, so it is not ours to flag (the conservative §1 over-refusal guard).
  const preExisting =
    "import { helper } from './other';\nexport const x = (): number => helper();\n";
  const captures = detectMoveSymbolCaptures(
    fakeHost,
    OPTIONS,
    planFor(preExisting, preExisting),
    'src/dest.ts' as RepoRelPath,
    'helper',
  );
  assert.deepEqual(captures, [], 'an unchanged pre-existing same-named import is left alone');
});

test('move_symbol capture: an aliased rewritten import {helper as h} is still reconstructed and flagged', () => {
  const before = 'export const x = 1;\n';
  const after = "import { helper as h } from './other';\nexport const x = (): number => h();\n";
  const captures = detectMoveSymbolCaptures(
    fakeHost,
    OPTIONS,
    planFor(before, after),
    'src/dest.ts' as RepoRelPath,
    'helper',
  );
  assert.equal(captures.length, 1, 'an aliased named import of the moved symbol is policed too');
});

test('move_symbol capture: no single moved name → no fabricated captures (typecheck is the backstop)', () => {
  const before = 'export const x = 1;\n';
  const after = "import { helper } from './other';\nexport const x = (): number => helper();\n";
  const captures = detectMoveSymbolCaptures(
    fakeHost,
    OPTIONS,
    planFor(before, after),
    'src/dest.ts' as RepoRelPath,
    undefined,
  );
  assert.deepEqual(captures, [], 'undefined movedName reconstructs nothing, never fabricates');
});
