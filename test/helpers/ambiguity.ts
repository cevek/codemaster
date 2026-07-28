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

/** Rejects the KNOWN SHAPES of an absence claim — this resolver anchors bare-identifier
 *  declarations only, so a miss is a capability limit (t-561552) and no wording may present it as
 *  proof that the symbol does not exist.
 *
 *  HONEST SCOPE, because overstating a guard is the same class of lie it guards against: this is a
 *  blacklist, not a proof. It catches the phrasings that actually occurred plus near neighbours,
 *  and a name-free rewording ("nothing named that is declared here", "'X' is absent from this
 *  file") walks through it — verified, not assumed. The load-bearing pins are the POSITIVE,
 *  execution-anchored assertions at the call sites (run the call the message names; establish the
 *  ground truth by resolving the symbol, then require the message not to contradict it). Treat a
 *  pass here as "no known lie shape", never as "this message is honest". */
export function assertNoAbsenceClaim(msg: string, name: string): void {
  const SCOPE = `(exist|anywhere|in (the|this) (file|repo|project)|on (that|this) line|any column)`;
  const claims = [
    /no top-level declaration named/i,
    // "declares no X" / "contains no X" / "has no X" — any verb, any filler before the name.
    new RegExp(`\\b(declares|contains|has|holds)\\s+no\\b[^.;)]{0,40}'?${name}'?`, 'i'),
    // "no <thing> 'X' … <scope>" — the negation closed by a scope word makes it an absence claim.
    new RegExp(`\\bno\\b[^.;)]{0,40}'?${name}'?[^.;)]{0,60}${SCOPE}`, 'i'),
    // …and the same with the scope word BEFORE the name ("nothing anywhere named X").
    new RegExp(`\\bno(thing|ne)?\\b[^.;)]{0,40}${SCOPE}[^.;)]{0,40}'?${name}'?`, 'i'),
    /does not exist/i,
    /\bnot declared\b/i,
    // NO generic "no column" ban here: on an OUT-OF-RANGE line "so NO column resolves there" is
    // TRUE and load-bearing (it is what stops the agent hunting columns). The column claim is
    // banned at the call sites where a column provably reaches — where the ground truth is run.
  ];
  for (const c of claims) {
    assert.ok(!c.test(msg), `an absence this resolver cannot prove (${String(c)}): ${msg}`);
  }
}

/** An addressing may be NAMED but never promised — neither "it will resolve" nor "it settles the
 *  question". The second half matters as much: naming one call as the DISCRIMINATOR between
 *  absent and unanchorable is the defect that recurred twice, and no name-based call here is one. */
export function assertNoPromise(msg: string): void {
  const promises = [
    /\bwill\b/i,
    /\bguarantee/i,
    /\balways (lands|works|resolves)/i,
    /\b(resolves|reaches|finds|lands) it\b/i,
    /\bthat (lands|resolves|reaches)\b/i,
    /\bis guaranteed\b/i,
    // discriminator promises
    /tells (the two|them) apart/i,
    /\b(settles|proves) (it|absence|the question)\b/i,
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
