// t-487095: the three `elide(s, cap)` twins (find_unused_props / impact_type_error /
// trace_type_widening) were consolidated onto the `common/truncate` chokepoint and now carry a §3.4
// LENGTH marker on a cut type string — `… (type elided: N chars)` — where the OLD idiom emitted a
// bare `… (type elided)` with no length (a partial-honesty gap: the agent could not tell HOW much
// was cut). This exercises the `first-param-member-type` twin end-to-end through `find_unused_props`.
//
// Oracle = a fresh-from-cold `ts.Program` (`coldMembers`, §16): the cold checker's NoTruncation
// member-type string is the ground-truth text — its length is what the marker must report, and its
// first 200 chars are the verbatim prefix the shown text must reproduce. Non-circular: the op's own
// checker never supplies the expected value.
//
// The twin is `length-only` on purpose: `find_unused_props` does NOT thread `verbosity:full`, so a
// `verbosity:full` recovery steer would be a lie (§3.6). The marker therefore reports length ALONE —
// asserted here by the ABSENCE of `verbosity:full` in the cut string.

import test from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { coldMembers } from '../helpers/cold-ls.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import type { JsonValue } from '../../src/core/json.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"jsx":"react-jsx","module":"preserve"}}';
const PKG = JSON.stringify({ dependencies: { react: '18' } });

// A component whose props carry a DEAD member (`heavy`, never passed) with a wide string-literal
// union type — comfortably over the 200-char default cap. `used` is passed at the render site, so
// `heavy` is the lone unused prop and its rendered type string is the one that gets elided.
const HEAVY = Array.from({ length: 24 }, (_, i) => `'opt_${i}_xxxxxxxx'`).join(' | ');
const FIXTURE = {
  'package.json': PKG,
  'tsconfig.json': TSCONFIG,
  'src/Card.tsx':
    `export interface CardProps { used: string; heavy: ${HEAVY} }\n` +
    'export const Card = (p: CardProps) => <div>{p.used}</div>;\n',
  'src/App.tsx': 'import { Card } from \'./Card\';\nexport const App = () => <Card used="x"/>;\n',
};

function unusedRows(r: OpResult): { name: string; type?: string }[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  const d = r.result.data as Record<string, JsonValue>;
  return (d['unused'] as { name: string; type?: string }[]) ?? [];
}

test('find_unused_props: a cut member type carries the §3.4 length marker `(type elided: N chars)`, length-only (oracle=cold)', async () => {
  const p = await project(FIXTURE);
  try {
    // Independent ground truth: the complete member type a cold checker reports for `heavy`.
    const cold = coldMembers(p.root, 'src/Card.tsx', 'CardProps').find((m) => m.name === 'heavy');
    assert.ok(cold !== undefined, 'oracle located the heavy member');
    assert.ok(
      cold.type.length > 200,
      `precondition: the member type exceeds the 200 cap (was ${cold.type.length})`,
    );

    const r = await p.op('find_unused_props', { component: 'Card' });
    const heavy = unusedRows(r).find((u) => u.name === 'heavy');
    assert.ok(heavy !== undefined, 'heavy is reported unused');
    const t = heavy.type ?? '';

    const m = /… \(type elided: (\d+) chars\)$/.exec(t);
    assert.ok(m !== null, `the cut type must carry the length marker (was: ${t})`);
    assert.equal(
      Number(m[1]),
      cold.type.length,
      'marker reports the true full length (§3.4 total)',
    );
    assert.equal(
      t.slice(0, 200),
      cold.type.slice(0, 200),
      'shown prefix is the cold type verbatim',
    );
    // length-only: this op does not thread verbosity:full, so it must NOT be offered as recovery.
    assert.ok(!t.includes('verbosity:full'), 'no verbosity:full steer on a length-only twin');
  } finally {
    await p.dispose();
  }
});
