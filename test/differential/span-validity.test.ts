// §16 invariant 1 made UNIVERSAL: every span-bearing read op's proof text equals the live
// source at its range. Previously opt-in, checked on a handful of ops; this sweep runs a
// representative call of every read op in `builtinOps()` through `assertSpansValid`.
//
// Three guards keep the green honest:
//  1. Coverage — every `builtinOps()` entry is either swept or in EXCLUSIONS with a reason;
//     a newly added op that is neither fails the test (never a hand-maintained phantom list).
//  2. Non-vacuous — each swept op must emit ≥1 proof span (`assertSpansValid` passes
//     vacuously on zero spans, so the count is asserted, not just validity).
//  3. Negative control — a deliberately drifted span is caught, proving the sweep bites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid, type TestProject } from '../helpers/project.ts';
import { builtinOps } from '../../src/ops/builtins.ts';
import type { JsonValue } from '../../src/core/json.ts';

const CONFIG =
  `import { defineConfig } from 'codemaster';\n` +
  `export default defineConfig({\n` +
  `  i18n: { locales: ['locales/*.json'], functions: ['t'] },\n` +
  `  schema: { entrypoint: 'src/api/openapi.d.ts' },\n` +
  `});\n`;
const TSCONFIG = '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}';
// `extra` lives in en only (→ missing in de); `unused_key` is referenced by nobody (→ unused).
const EN = JSON.stringify({ greeting: 'Hi', extra: 'x', unused_key: 'u' }, null, 2);
const DE = JSON.stringify({ greeting: 'Hallo' }, null, 2);
const SCSS = `.used { color: red; }\n.dead { color: blue; }\n`;
const BUTTON =
  `import styles from './styles.module.scss';\n` +
  `const t = (k: string): string => k;\n` +
  `export interface Props { size: string; label?: string }\n` +
  `export const Button = (p: Props) =>\n` +
  `  <button className={styles.used}>{t('greeting')}{t('extra')}{p.size}</button>;\n`;
const APP =
  `import { Button } from './Button';\n` + `export const App = () => <Button size="lg" />;\n`;
const OPENAPI =
  `export interface paths {\n` +
  `  "/users/{id}": {\n` +
  `    parameters: { query?: never; header?: never; path?: never; cookie?: never };\n` +
  `    get: operations["getUser"];\n` +
  `    put?: never; post?: never; delete?: never; options?: never; head?: never; patch?: never; trace?: never;\n` +
  `  };\n}\n` +
  `export interface operations {\n` +
  `  getUser: {\n` +
  `    parameters: { query?: never; header?: never; path: { id: number }; cookie?: never };\n` +
  `    requestBody?: never;\n` +
  `    responses: { 200: { headers: { [name: string]: unknown }; content: { "application/json": components["schemas"]["UserDto"] } } };\n` +
  `  };\n}\n` +
  `export interface components { schemas: { UserDto: { id: number; name: string } } }\n`;

function sweepProject(): Promise<TestProject> {
  return project({
    'codemaster.config.ts': CONFIG,
    'tsconfig.json': TSCONFIG,
    'locales/en.json': EN,
    'locales/de.json': DE,
    'src/styles.module.scss': SCSS,
    'src/Button.tsx': BUTTON,
    'src/App.tsx': APP,
    'src/api/openapi.d.ts': OPENAPI,
  });
}

/** Args chosen to make every op resolve to ≥1 proof span against the fixture above. */
const SWEEP: Record<string, JsonValue> = {
  search_symbol: { query: 'Button' },
  find_definition: { name: 'Button' },
  find_usages: { name: 'Button' },
  // The target descriptor carries the type's name-token span — validated here; assignable
  // SITE spans (factory/array/var/call) are exhaustively span-checked in construction-sites.test.ts.
  construction_sites: { name: 'Props' },
  source: { targets: [{ name: 'Button' }] },
  scss_classes: { file: 'src/styles.module.scss' },
  css_cascade: { file: 'src/styles.module.scss', class: 'used' },
  // `App` is exported but never imported → a certain-unused row with a name-token span.
  find_unused_exports: {},
  find_unused_scss_classes: {},
  i18n_lookup: { key: 'greeting' },
  find_unused_i18n_keys: {},
  find_missing_i18n_keys: {},
  list_endpoints: {},
};

/** Read ops that legitimately carry no proof `Span`, and the mutating family the refactor
 *  port owns (spec §1 boundary — edit-safety is tested there, not re-tested here). */
const EXCLUSIONS: Record<string, string> = {
  importers_of: 'emits compact `at:"file:line"` strings, not proof Spans — nothing to validate',
  expand_type:
    'emits a navigational `at:"file:line:col"` loc (the name-token span is density-water at full, §12), not a proof Span — the resolved type/members/signatures proof is the live checker, oracle-tested in expand-type.test.ts vs a cold Program',
  impact:
    'emits encloser rollups (file:line:col + chainable SymbolIds), like find_usages grouped mode — no verbatim Spans; closure correctness is oracle-tested in impact.test.ts',
  impact_type_error:
    'emits a target-ref id + introduced tsc diagnostics (file:line:message), not proof Spans — the diagnostics ARE the proof, cross-checked against a cold ts.Program in impact-type-error.test.ts',
  affected:
    'emits changed-set + test file-path strings (no source Spans); the import-graph→tests trace is oracle-tested in affected.test.ts vs an independent cold reverse-import walk',
  feedback: 'writes the global inbox; carries no source Spans',
  list: 'generic registry dispatcher — emits Spans only when a registry-owning framework plugin is active (none in this fixture); span validity is exercised in react-detect.test.ts',
  invalidations_for:
    'requires the react-query plugin (not enabled in this generic sweep fixture); proof-span validity is oracle-tested in react-query.test.ts via assertSpansValid',
  trace_invalidation:
    'requires the react-query + react plugins (not enabled in this generic sweep fixture); proof-span validity is oracle-tested in trace-invalidation.test.ts via assertSpansValid',
  trace_type_widening:
    'emits proof Spans only along a value’s forward flow-chain (assignment / call / return); the generic sweep fixture has no such chain to trace, so proof-span validity is oracle-tested in trace-type-widening.test.ts via assertSpansValid',
  find_unused_props:
    'requires the react plugin (not enabled in this generic sweep fixture); proof-span validity is oracle-tested in unused-props.test.ts via assertSpansValid',
  trace_prop_through_tree:
    'requires the react plugin (not enabled in this generic sweep fixture); proof-span validity is oracle-tested in trace-prop-through-tree.test.ts via assertSpansValid',
  rename_symbol: 'mutating — edit-safety is the refactor port’s domain (spec §1)',
  move_file: 'mutating — edit-safety is the refactor port’s domain (spec §1)',
  move_symbol: 'mutating — edit-safety is the refactor port’s domain (spec §1)',
  extract_symbol: 'mutating — edit-safety is the refactor port’s domain (spec §1)',
  change_signature: 'mutating — edit-safety is the refactor port’s domain (spec §1)',
  codemod: 'mutating — edit-safety is the refactor port’s domain (spec §1)',
  transaction:
    'mutating — composes the refactor ops; edit-safety is oracle-tested in transaction.test.ts (spec-transactional-mutation)',
};

test('coverage: every builtin op is swept or excluded-with-reason (no phantom list)', () => {
  for (const op of builtinOps()) {
    const swept = op.name in SWEEP;
    const excluded = op.name in EXCLUSIONS;
    assert.ok(
      swept !== excluded,
      `op '${op.name}' must be exactly one of swept / excluded — add it to SWEEP (with span-producing args) or EXCLUSIONS (with a reason)`,
    );
  }
});

test('every swept op’s proof spans equal the live source, and there is ≥1 (non-vacuous)', async () => {
  const p = await sweepProject();
  try {
    for (const [name, args] of Object.entries(SWEEP)) {
      const r = await p.op(name, args);
      assert.ok('result' in r && r.result.ok, `${name} did not succeed: ${JSON.stringify(r)}`);
      const spans = assertSpansValid(p.root, r);
      assert.ok(spans > 0, `${name} emitted no proof span — args do not exercise invariant 1`);
    }
  } finally {
    await p.dispose();
  }
});

test('negative control: a drifted span text is caught (the sweep actually bites)', async () => {
  const p = await sweepProject();
  try {
    const r = await p.op('find_definition', { name: 'Button' });
    assert.ok('result' in r && r.result.ok);
    // Forge a span whose `text` does not match the source at its range.
    const forged = {
      name: 'find_definition',
      result: {
        ok: true,
        data: {
          span: {
            file: 'src/Button.tsx',
            line: 1,
            col: 1,
            endLine: 1,
            endCol: 6,
            text: 'WRONG',
          },
        },
      },
    } as unknown as Awaited<ReturnType<TestProject['op']>>;
    assert.throws(() => assertSpansValid(p.root, forged), /drifted/);
  } finally {
    await p.dispose();
  }
});
