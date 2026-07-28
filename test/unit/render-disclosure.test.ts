// The render half of the envelope-disclosure channel (§3.4/§12). The differential suites read
// `result.disclosures` structurally, which proves the claim is PRODUCED — not that it is ever
// DELIVERED. Those are different failures: a renderer that dropped the field would leave every
// structural arm green while no agent ever saw the line.
//
// Three properties, each with its own way of failing silently: the claim appears at every verbosity
// (a channel visible only at `full` is invisible in practice, since terse is the default); entries
// sharing one claim collapse instead of restating a byte-identical sentence per target (§12 density,
// in the cap-RESERVED tail where every char is taken from the answer's own budget); and the line
// SURVIVES a body large enough to trigger the cap, which is the whole point of putting it in the
// reserved region.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderResult } from '../../src/format/render/render-result.ts';
import { ok } from '../../src/common/result/construct.ts';
import type { Disclosure, Verbosity } from '../../src/core/result.ts';
import type { JsonValue } from '../../src/core/json.ts';

const NOTE = 'the candidate set was cut. Re-address exactly — name+file or file:line:col.';
const claim = (target: string): Disclosure => ({
  unsafe: 'target-is-the-only-symbol-of-this-name',
  target,
  note: NOTE,
});

function render(
  data: JsonValue,
  disclosures: Disclosure[],
  verbosity: Verbosity = 'terse',
): string {
  return renderResult(ok(data, { disclosures }), verbosity);
}

test('the claim reaches rendered text at EVERY verbosity — terse is the default an agent actually reads', () => {
  for (const verbosity of ['terse', 'normal', 'full'] as const) {
    const out = render({ total: 1 }, [claim("name 'Span'")], verbosity);
    assert.match(out, /!! CANNOT CLAIM/, `missing at verbosity=${verbosity}`);
    assert.match(
      out,
      /unsafe=target-is-the-only-symbol-of-this-name/,
      `the machine-readable claim key is missing at verbosity=${verbosity}`,
    );
    assert.match(
      out,
      /target="name 'Span'"/,
      `the attribution is missing at verbosity=${verbosity}`,
    );
  }
});

test('the k=v pairs stay whitespace-splittable even though a target contains a space', () => {
  // §13 house style: `k=v` is machine-greppable. A bare `target=name 'Span'` splits into
  // `target=name` plus a dangling `'Span'` for any consumer that tokenizes on whitespace.
  const line = render({ total: 1 }, [claim("name 'Span'")], 'terse')
    .split('\n')
    .find((l) => l.startsWith('!! CANNOT CLAIM'));
  assert.ok(line !== undefined, 'the disclosure renders as its own line');
  const pairs = Object.fromEntries(
    line
      .split(' ')
      .filter((tok) => tok.includes('='))
      .map((tok) => tok.split('=', 2) as [string, string]),
  );
  assert.equal(pairs['unsafe'], 'target-is-the-only-symbol-of-this-name');
  assert.equal(pairs['target'], '"name');
  assert.ok(line.includes(`target="name 'Span'"`), 'and the full value is quoted, not truncated');
});

test('entries sharing one claim collapse to a single line listing their targets', () => {
  // `source` takes 20 targets; 20 byte-identical sentences in the reserved tail would be pure
  // duplication subtracted from the answer's own budget.
  const many = Array.from({ length: 20 }, (_, i) => claim(`name 'S${i}'`));
  const out = render({ total: 1 }, many);
  const lines = out.split('\n').filter((l) => l.startsWith('!! CANNOT CLAIM'));
  assert.equal(lines.length, 1, 'one claim, one line');
  assert.equal(
    (out.match(new RegExp(NOTE.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? [])
      .length,
    1,
    'and the shared note is stated once, not per target',
  );
  for (const i of [0, 19]) {
    assert.ok(out.includes(`"name 'S${i}'"`), `target S${i} is still named`);
  }
});

test('the claim SURVIVES a body big enough to trigger the cap — that is why it is in the reserved tail', () => {
  // A dropped claim under truncation is the worst case: the answer is capped AND the agent is not
  // told its target may be the wrong symbol.
  const huge = {
    rows: Array.from({ length: 4000 }, (_, i) => `src/f${i}.ts:1:1 some padding text`),
  };
  const out = render(huge as unknown as JsonValue, [claim("name 'Span'")]);
  assert.match(out, /!! OUTPUT CAPPED/, 'precondition: the body must actually overflow the cap');
  assert.match(out, /!! CANNOT CLAIM/, 'the claim is reserved against the cap, never trimmed');
});

test('an envelope with no disclosures renders byte-identically', () => {
  const withField = renderResult(ok({ total: 1 }, { disclosures: [] }), 'terse');
  const without = renderResult(ok({ total: 1 }), 'terse');
  assert.equal(withField, without, 'an empty channel adds nothing to the output');
});
