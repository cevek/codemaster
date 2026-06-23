// trace_field_to_render — the field→render trace must count ONLY the components that render a field
// in a host element, and must NEVER pass off a read it cannot prove as a render. The independent
// oracle is the HAND-CURATED expected set per trap (the fixture is input; ground truth is written
// here, NOT read back from the seam's own classifier — that would be circular, §16). The
// discriminating traps: a value-element pass, a destructure binding, and a COMPUTED access must each
// stay OUT of `renderedBy` — proof the op floors the dynamic cases instead of over-claiming a render.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid } from '../helpers/project.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const PKG = JSON.stringify({ dependencies: { react: '18' } });
const TSCONFIG = '{"compilerOptions":{"strict":true,"jsx":"react-jsx","module":"preserve"}}';

type Hop = { from: { label: string }; to: { label: string }; relation: string; confidence: string };

function data(r: OpResult): Record<string, JsonValue> {
  if ('error' in r) throw new Error(`dispatch error: ${r.error.message}`);
  assert.ok(r.result.ok, 'expected ok result');
  return r.result.data as Record<string, JsonValue>;
}

function hops(d: Record<string, JsonValue>): Hop[] {
  return (d['hops'] as unknown as Hop[]) ?? [];
}

/** Components targeted by a `rendered-in` hop — the proven host-renderers. */
function renderedLabels(d: Record<string, JsonValue>): Set<string> {
  return new Set(
    hops(d)
      .filter((h) => h.relation === 'rendered-in')
      .map((h) => h.to.label),
  );
}

test('field→render: counts host renderers only; value-pass / destructure / computed are NOT renders', async () => {
  const p = await project({
    'package.json': PKG,
    'tsconfig.json': TSCONFIG,
    'src/types.ts': 'export interface User { id: string; email: string }\n',
    // host CHILD render → counts (Card)
    'src/Card.tsx':
      "import type { User } from './types';\n" +
      'export const Card = (props: { user: User }) => <span>{props.user.email}</span>;\n',
    // host ATTRIBUTE render → counts (Badge), flagged as an attribute bind
    'src/Badge.tsx':
      "import type { User } from './types';\n" +
      'export const Badge = (props: { user: User }) => <input value={props.user.email}/>;\n',
    // value-element pass → passed-to, NOT a render here (the #1 trust point)
    'src/Outer.tsx':
      "import type { User } from './types';\n" +
      'declare const Avatar: (p: { email: string }) => any;\n' +
      'export const Outer = (props: { user: User }) => <div><Avatar email={props.user.email}/></div>;\n',
    // destructure → downstream local render is invisible to member refs → floored, NOT a render
    'src/List.tsx':
      "import type { User } from './types';\n" +
      'export const List = (props: { user: User }) => {\n' +
      '  const { email } = props.user;\n' +
      '  return <b>{email}</b>;\n' +
      '};\n',
    // COMPUTED access → member references do not link `u[k]` → invisible → NOT a render
    'src/Dyn.tsx':
      "import type { User } from './types';\n" +
      'export const Dyn = (props: { user: User; k: keyof User }) => <span>{props.user[props.k]}</span>;\n',
    // plain logic read → non-render
    'src/logic.ts':
      "import type { User } from './types';\n" +
      'export function send(u: User) { return u.email.length; }\n',
  });
  try {
    const line = 'export interface User { id: string; email: string }';
    const col = line.indexOf('email') + 1;
    const r = await p.op('trace_field_to_render', { field: `src/types.ts:1:${col}` });
    const d = data(r);

    // Headline verdict: exactly the two host-renderers, nothing else.
    assert.equal(d['found'], 1, 'field resolved');
    assert.equal(d['renderedBy'], 2, 'renderedBy = Card + Badge only');
    assert.deepEqual([...renderedLabels(d)].sort(), ['Badge', 'Card'], 'proven host-renderers');

    // OVER-CLAIM GUARDS — the discriminating half. None of these may be a rendered-in hop.
    const rendered = renderedLabels(d);
    for (const notRendered of ['Outer', 'List', 'Dyn']) {
      assert.ok(!rendered.has(notRendered), `${notRendered} must NOT be counted as a render`);
    }

    // Each non-render trap surfaces honestly, flagged partial / floored.
    const passed = hops(d).filter((h) => h.relation === 'passed-to');
    assert.equal(passed.length, 1, 'Avatar pass surfaced');
    assert.equal(passed[0]?.confidence, 'partial', 'passed-to is partial, never certain');
    assert.equal(
      passed[0]?.to.label,
      '<Avatar/>',
      'passed to the value element, not the enclosing div',
    );

    const destructured = hops(d).filter((h) => h.relation === 'destructured-at');
    assert.equal(d['destructuredReads'], 1, 'List destructure counted');
    assert.equal(
      destructured[0]?.confidence,
      'partial',
      'destructure is partial, never a certain render',
    );

    // The computed `props.user[props.k]` is invisible to member refs — it must not appear at all,
    // and the standing floor note must state the lower-bound honestly.
    assert.equal(d['nonRenderReads'], 1, 'only the logic read is a non-render member access');
    const notes = (d['notes'] as string[]).join(' ');
    assert.match(notes, /LOWER BOUND/, 'floor note states renderedBy is a lower bound');

    assert.ok(assertSpansValid(p.root, r) > 0, 'hop proof spans validated against source');
  } finally {
    await p.dispose();
  }
});

test('field→render: unresolved/ambiguous field is an honest found:0, never a faked trace', async () => {
  const p = await project({
    'package.json': PKG,
    'tsconfig.json': TSCONFIG,
    'src/types.ts':
      'export interface User { email: string }\nexport interface Org { email: string }\n',
  });
  try {
    // bare `email` is shared by two types → ambiguous → honest miss (no guessed pick).
    const r = await p.op('trace_field_to_render', { field: 'email' });
    const d = data(r);
    assert.equal(d['found'], 0, 'ambiguous name does not resolve');
    assert.equal(d['renderedBy'], 0, 'no render claimed on a miss');
    assert.equal((d['hops'] as JsonValue[] | undefined)?.length ?? 0, 0, 'no faked hops');
  } finally {
    await p.dispose();
  }
});
