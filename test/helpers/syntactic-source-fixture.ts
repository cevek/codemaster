// Shared fixture + accessors for the two `source { syntactic: true }` differential suites (t-229522):
// `syntactic-source.test.ts` (the byte-equality / no-warm / batch / render invariants) and
// `syntactic-source-boundaries.test.ts` (what the path refuses, and why). One fixture, because the two
// suites must reason about the SAME declarations — a second copy would drift and each suite would then
// be asserting about a different repo than the other.

import assert from 'node:assert/strict';
import type { TestProject } from './project.ts';
import type { JsonValue } from '../../src/core/json.ts';

/** One top-level symbol per addressable kind, plus every shape that must NOT print a body: a named
 *  import, a DEFAULT import (which reaches the declaration index as a bare identifier rather than any
 *  import-kind node), a reference, same-named declarations in different scopes, a multi-declarator line,
 *  and a destructured statement. */
export const SYNTACTIC_FIXTURE: Record<string, string> = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"nodenext","moduleResolution":"nodenext"}}',
  'src/widget.ts': [
    'export interface WidgetProps {',
    '  size: string;',
    '}',
    'export function makeWidget(p: WidgetProps) {',
    '  return { size: p.size };',
    '}',
    'export const WidgetLimit = 42;',
    'export class WidgetBase {',
    '  ping() { return 1; }',
    '}',
  ].join('\n'),
  'src/app.ts': [
    'import { makeWidget as build, WidgetLimit } from "./widget.ts";',
    'import WidgetOwner from "./owner.ts";',
    'export const useWidget = () => build({ size: String(WidgetLimit) }) && WidgetOwner();',
  ].join('\n'),
  'src/owner.ts': 'export default function WidgetOwner() {\n  return true;\n}',
  // The MERGE arm — declarations that really ARE one symbol, so a policy that refused everything would
  // be caught too, plus the three shapes that share a scope-enclosing node without sharing a binding
  // scope (two loop headers, two catch clauses, two expandos on different objects).
  'src/merged.ts': [
    'export interface Both { a: string }',
    'export namespace Both { export const k = 1; }',
    'export function Owner() { return 1; }',
    'Owner.tag = 1;',
    'export function Other() { return 2; }',
    'Other.tag = 2;',
    // A property assignment beside a PLAIN declaration of the same name, in one scope: the set diverges on
    // the expando half of the key without both members being expandos, so a two-valued cause mislabels it.
    'export function Third() { return 3; }',
    'Third.mixed = 1;',
    'export const mixed = 9;',
    'export function loops() {',
    '  for (let idx = 0; idx < 2; idx++) { void idx; }',
    '  for (let idx = 5; idx < 9; idx++) { void idx; }',
    '  try { void 0; } catch (err) { void err; }',
    '  try { void 1; } catch (err) { void err; }',
    // NO braces around the clause body: a braced one is a `Block` (already a container), so only the
    // brace-less form reaches the `CaseBlock` — the switch body itself — as its binding region.
    '  switch (idxSeed) { default: let cse = 1; void cse; }',
    '  switch (idxSeed) { default: let cse = 2; void cse; }',
    '}',
    'export const idxSeed = 0;',
    // Merges whose collapse depends on a container OTHER than SourceFile — the two the top-level
    // `Both` case cannot exercise, since that one is decided by the first predicate tested.
    'export namespace Outer {',
    '  export interface Deep { a: string }',
    '  export namespace Deep { export const q = 1; }',
    '}',
    'export class Holder {',
    '  get pair() { return 1; }',
    '  set pair(v: number) { void v; }',
    '}',
  ].join('\n'),
  // A name declared in TWO files, NEITHER of them the file a handle for it records. That is the only way
  // to reach the handle path's workspace-wide rival arm: the own-file arm is tried first and would rebind
  // locally, and it excludes other files by construction (`d.rel !== rel`).
  'src/cross-a.ts': 'export const anchorOnly = 0;',
  'src/cross-b.ts': 'export const farTwin = 1;',
  'src/cross-c.ts': 'export const farTwin = 2;',
  // Every reachable (objects, plain) combination of the assignment cause, so each COUNT and each caveat
  // variant is asserted rather than inferred — plus a cross-file pair at DIFFERENT nesting depths, the
  // shape a within-one-file top-level preference must not silently pick between.
  'src/causes.ts': [
    'export function P() { return 1; }',
    'export function Q() { return 2; }',
    'P.tri = 1;',
    'Q.tri = 2;',
    'export const tri = 3;',
    'export function U() { return 5; }',
    'U.onePlain = 1;',
    'export const onePlain = 9;',
    'export function S() { return 3; }',
    'export function T() { return 4; }',
    'S.dup = 1;',
    'S.dup = 2;',
    'T.dup = 3;',
  ].join('\n'),
  // The SINGLE-FILE analogue of the mixed-depth shape: a top-level declaration and a nested one of the
  // same name in ONE file. A bare name pins nothing, so it must not pick between them; `name+file` pins
  // the file and may prefer the top-level, exactly as the checker path does.
  'src/depth-one.ts': [
    'export const soloDepth = 1;',
    'export function soloHolder(): number {',
    '  const soloDepth = 2;',
    '  return soloDepth;',
    '}',
  ].join('\n'),
  'src/depth-top.ts': 'export const mixedDepth = 1;',
  'src/depth-nested.ts':
    'export function holder() {\n  const mixedDepth = 2;\n  return mixedDepth;\n}',
  'src/rivals.ts': [
    'export class Alpha {',
    '  twin() { return 1; }',
    '}',
    'export class Beta {',
    '  twin() { return 2; }',
    '}',
    'export const pairA = 1, pairB = 2;',
    'export const { deA, deB } = { deA: 1, deB: 2 };',
  ].join('\n'),
};

export type SourceEntry = {
  id: string;
  name: string;
  kind: string;
  decl: { file: string; line: number; col: number; text: string };
  provenance?: string;
  /** Other declarations OF THIS SYMBOL (a merged interface+namespace, an overload set) as `file:line`. */
  moreDefinitions?: string[];
};

export type SourceData = {
  note?: string;
  sources?: SourceEntry[];
  unresolved?: { target: string; reason: string }[];
};

/** Run `source` on one target, on either path. The call itself must succeed — a per-target miss comes
 *  back inside `unresolved`, which is what the boundary suite asserts about. */
export async function sourceOf(
  p: TestProject,
  target: Record<string, JsonValue>,
  syntactic: boolean,
): Promise<SourceData> {
  const res = await p.op('source', { ...target, ...(syntactic ? { syntactic: true } : {}) });
  assert.ok('result' in res, `dispatch for ${JSON.stringify(target)}`);
  assert.ok(res.result.ok, `source ${JSON.stringify(target)} ok: ${JSON.stringify(res.result)}`);
  return res.result.data as SourceData;
}

/** The one entry a single-target call must have produced. */
export function sole(data: SourceData, label: string): SourceEntry {
  const entry = data.sources?.[0];
  assert.ok(
    entry !== undefined,
    `${label}: expected a body, got unresolved: ${JSON.stringify(data.unresolved)}`,
  );
  return entry;
}

/** The reason of a single-target MISS — asserted on, so an empty string would silently satisfy a
 *  `match`; the caller gets a loud failure instead when the call unexpectedly resolved. */
export function missReason(data: SourceData, label: string): string {
  const reason = data.unresolved?.[0]?.reason;
  assert.ok(
    reason !== undefined && reason.length > 0,
    `${label}: expected a miss, got sources: ${JSON.stringify(data.sources)}`,
  );
  return reason;
}

/** A 1-based (line, col) of the first occurrence of `needle` in a fixture file — located by SEARCH so an
 *  edit to the fixture cannot silently retarget an assertion at some other line. */
export function locate(file: string, needle: string): { line: number; col: number } {
  const lines = SYNTACTIC_FIXTURE[file]?.split('\n') ?? [];
  const row = lines.findIndex((l) => l.includes(needle));
  const col = lines[row]?.indexOf(needle) ?? -1;
  assert.ok(row >= 0 && col >= 0, `fixture ${file} no longer contains ${needle}`);
  return { line: row + 1, col: col + 1 };
}
