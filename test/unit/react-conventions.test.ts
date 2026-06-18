// Unit: the React naming conventions (plugins/react/conventions.ts). Pure predicates, so the
// oracle is hand-curated truth — the boundary cases (lowercase, bare `use`, `useful`) are the point.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isComponentName, isHookName } from '../../src/plugins/react/conventions.ts';

test('isComponentName: uppercase-initial only', () => {
  for (const n of ['Button', 'App', 'MyDialog', 'X']) assert.equal(isComponentName(n), true, n);
  for (const n of ['button', 'useThing', 'lowerThing', 'x', '_Private']) {
    assert.equal(isComponentName(n), false, n);
  }
});

test('isHookName: `use` + uppercase letter', () => {
  for (const n of ['useState', 'useTodos', 'useX']) assert.equal(isHookName(n), true, n);
  // boundary: bare `use`, lowercase-after-use, non-hook `use…`, too short
  for (const n of ['use', 'useful', 'used', 'user', 'usB', 'User', 'Use']) {
    assert.equal(isHookName(n), false, n);
  }
});
