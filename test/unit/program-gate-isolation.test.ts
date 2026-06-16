// The cross-program write gate's THROW ISOLATION contract (§3.6). A SIBLING program whose LS throws
// (a broken sibling tsconfig) must degrade to "no diagnostics + a note" so one bad sibling can't sink
// every cross-program rename/move — a regression vs the old single-program gate. The PRIMARY is the
// catastrophe guard: if IT throws, the gate has verified nothing, so the throw MUST propagate (the
// caller turns it into an honest `ts-ls` failure) — swallowing it would be a silent `clean:true`, a
// false success worse than the bug. Driven with stub programs so the throw is deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type ts from 'typescript';
import type { RepoRelPath } from '../../src/core/brands.ts';
import type { SingleProgram } from '../../src/plugins/ts/program/single.ts';
import {
  gateAcross,
  diagnosticsAcross,
  type GateHostCtx,
} from '../../src/plugins/ts/program-gate.ts';

const ROOT = '/root';

/** A stub program: its LS returns one positionless diagnostic, or throws on diagnostics. Only the
 *  methods the gate touches are implemented (the rest are never called on this path). */
function stubProgram(label: string, opts: { throws?: boolean } = {}): SingleProgram {
  const diag = { messageText: `${label}-diag` } as unknown as ts.Diagnostic;
  const service = {
    getProgram: () => ({ getSourceFile: () => ({}) }) as unknown as ts.Program,
    getSyntacticDiagnostics: () => [],
    getSemanticDiagnostics: () => {
      if (opts.throws === true) throw new Error(`${label} LS exploded`);
      return [diag];
    },
  } as unknown as ts.LanguageService;
  return {
    service,
    label,
    containsFile: () => true, // every stub owns the anchor → all are affected
    mayContain: () => false,
    setOverlay: () => undefined,
    clearOverlay: () => undefined,
  } as unknown as SingleProgram;
}

function ctxOf(primary: SingleProgram, ...siblings: SingleProgram[]): GateHostCtx {
  return {
    primary,
    programs: [primary, ...siblings],
    relOf: (abs) => abs as RepoRelPath,
    absOf: (rel) => `${ROOT}/${rel}`,
  };
}

const SCOPE = { anchor: ['x.ts'] as RepoRelPath[], check: ['x.ts'] as RepoRelPath[] };
const FILES = [{ path: 'x.ts' as RepoRelPath, content: 'export const x = 1;' }];

test('gateAcross: a throwing SIBLING degrades to a note — primary verdict survives', () => {
  const primary = stubProgram('tsconfig.json');
  const broken = stubProgram('tsconfig.broken.json', { throws: true });
  const g = gateAcross(ctxOf(primary, broken), FILES, SCOPE);

  assert.deepEqual(g.programs, ['tsconfig.json'], 'only the primary was actually checked');
  assert.equal(g.degraded.length, 1, 'the broken sibling is recorded as degraded');
  assert.match(
    g.degraded[0] ?? '',
    /tsconfig\.broken\.json.*exploded/,
    'the note names the sibling + reason',
  );
  // Primary's diagnostics are present on BOTH sides (baseline + overlay) — the gate still works.
  assert.ok(
    g.baseline.some((d) => d.message.includes('tsconfig.json-diag')),
    'primary baseline diagnostics survive the sibling throw',
  );
  assert.ok(g.overlay.some((d) => d.message.includes('tsconfig.json-diag')));
  assert.ok(
    !g.baseline.some((d) => d.message.includes('broken')),
    'the broken sibling contributes nothing (no half-counted asymmetry)',
  );
});

test('gateAcross: a throwing PRIMARY propagates (never a silent clean) — the catastrophe guard', () => {
  const primary = stubProgram('tsconfig.json', { throws: true });
  const sibling = stubProgram('tsconfig.test.json');
  assert.throws(
    () => gateAcross(ctxOf(primary, sibling), FILES, SCOPE),
    /tsconfig\.json LS exploded/,
    'a primary throw must escape to the caller (→ honest ts-ls failure), not be swallowed',
  );
});

test('diagnosticsAcross: a throwing SIBLING post-apply is skipped, a throwing PRIMARY propagates', () => {
  const primary = stubProgram('tsconfig.json');
  const broken = stubProgram('tsconfig.broken.json', { throws: true });
  // Sibling skipped → only primary's diagnostics, no throw.
  const diags = diagnosticsAcross(ctxOf(primary, broken), SCOPE, [
    'tsconfig.json',
    'tsconfig.broken.json',
  ]);
  assert.ok(diags.some((d) => d.message.includes('tsconfig.json-diag')));
  assert.ok(!diags.some((d) => d.message.includes('broken')));

  const brokenPrimary = stubProgram('tsconfig.json', { throws: true });
  assert.throws(
    () => diagnosticsAcross(ctxOf(brokenPrimary), SCOPE),
    /tsconfig\.json LS exploded/,
    'a primary throw post-apply must propagate (→ rollback), never a silent clean',
  );
});
