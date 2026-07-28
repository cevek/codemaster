// Shared fixtures + message readers for the name-resolution honesty suites (ambiguity candidates,
// search truncation). Kept in one place so the two suites cannot drift on what a fixture declares —
// the fixture's construction IS the oracle both assert against.

import assert from 'node:assert/strict';
import type { OpResult } from '../../src/ops/contracts.ts';

export function failMsg(r: OpResult): string {
  assert.ok('result' in r && !r.result.ok, `expected a FAIL, got ${JSON.stringify(r)}`);
  return r.result.failure.message;
}

export function defId(r: OpResult): string {
  assert.ok('result' in r && r.result.ok, `expected ok: ${JSON.stringify(r)}`);
  const id = (r.result.data as { definition?: { id?: string } }).definition?.id;
  assert.ok(typeof id === 'string' && id.startsWith('ts:'), `expected a ts: SymbolId, got ${id}`);
  return id;
}

/** No wording may assert that the symbol is ABSENT — this resolver anchors bare-identifier
 *  declarations only, so a miss is a capability limit (t-561552). Matched as a PROPERTY (any
 *  phrasing of "there is no such thing"), because a blacklist of one sentence is satisfied by
 *  rewording the same lie — the failure mode this suite exists to catch. */
export function assertNoAbsenceClaim(msg: string, name: string): void {
  const claims = [
    /no top-level declaration named/i,
    new RegExp(`declares no (such )?\\S*\\s?'?${name}'?`, 'i'),
    new RegExp(
      `no (such )?(symbol|declaration)[^.]*'${name}'[^.]*(exists|anywhere|in the (file|repo))`,
      'i',
    ),
    /does not exist/i,
    /\bnot declared\b/i,
  ];
  for (const c of claims) {
    assert.ok(!c.test(msg), `an absence this resolver cannot prove (${String(c)}): ${msg}`);
  }
}

/** The offered addressing is named WITHOUT a promise that it lands — the property the
 *  unconditional offer rests on. Scanned over the whole message, not a suffix. */
export function assertNoPromise(msg: string): void {
  const promises = [
    /\bwill\b/i,
    /\bguarantee/i,
    /\balways (lands|works|resolves)/i,
    /\bresolves it\b/i,
    /\bis guaranteed\b/i,
  ];
  for (const pr of promises) {
    assert.ok(!pr.test(msg), `a promise about the outcome (${String(pr)}): ${msg}`);
  }
}

/** N barrels, each `export { default as Widget } from './implK'` (a DISTINCT declaration apiece —
 *  they cannot collapse into one definition), plus ONE real `export function Widget`. The real
 *  declaration lives under `src/z/` so it is discovered LAST: rank, not file order, must surface it. */
export function barrelRepo(n: number): Record<string, string> {
  const files: Record<string, string> = {
    'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"es2022","module":"esnext"}}',
    'src/z/widget.ts': 'export function Widget(label: string): string {\n  return label;\n}\n',
  };
  for (let i = 1; i <= n; i++) {
    files[`src/a/impl${i}.ts`] =
      `export default function WidgetImpl${i}(): number {\n  return ${i};\n}\n`;
    files[`src/a/barrel${i}.ts`] = `export { default as Widget } from './impl${i}';\n`;
  }
  return files;
}

/** `lowercase` × `export const span` (a case-insensitive collision that navto ranks in the SAME
 *  `exact` bucket as `Span`) + `uppercase` × `export interface Span`. The flood is what pushes real
 *  declarations off the LS's page. */
export function floodRepo(lowercase: number, uppercase: number): Record<string, string> {
  const files: Record<string, string> = {
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  };
  for (let i = 0; i < lowercase; i++) files[`src/f${i}.ts`] = `export const span = ${i};\n`;
  for (let i = 0; i < uppercase; i++) {
    files[`src/t${i}.ts`] = `export interface Span {\n  start${i}: number;\n}\n`;
  }
  return files;
}

/** `shown X of [≥]Y distinct declaration sites` — the §3.4 {shown, total} channel. */
export function counts(message: string): { shown: number; total: number; lowerBound: boolean } {
  const m = message.match(/shown (\d+) of (≥?)(\d+) distinct declaration sites/);
  assert.ok(m !== null, `ambiguity message must state shown/total, got: ${message}`);
  return { shown: Number(m[1]), total: Number(m[3]), lowerBound: m[2] === '≥' };
}

/** The SymbolIds the message enumerates, in listed order. The `@` is required: a plain
 *  `path/x.ts:1:25` (an alias target) also contains `ts:` and must not count as an id. */
export function listedIds(message: string): string[] {
  return [...message.matchAll(/ts:[^\s(),]*@[^\s(),]+/g)].map((m) => m[0]);
}
