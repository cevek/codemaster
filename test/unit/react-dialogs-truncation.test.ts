// Unit: detectDialogs surfaces the findUsages rollup cap as truncation (§3.4) — a dialog
// primitive rendered in more sites than the cap must NOT silently drop the capped dialog
// components. Driven through the `usageLimit` seam + a fake `ts` whose findUsages reports
// `groupTotal > groups.length` (the cap signal), so no 500-site fixture is needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDialogs } from '../../src/plugins/react/dialogs.ts';
import type { FunctionDecl } from '../../src/plugins/ts/function-declarations.ts';
import type { TsPluginApi } from '../../src/plugins/ts/plugin.ts';
import type { GroupRow } from '../../src/plugins/ts/query-types.ts';
import type { Span } from '../../src/core/span.ts';

const span = (file: string): Span => ({
  file: file as Span['file'],
  line: 1,
  col: 7,
  endLine: 1,
  endCol: 18,
  text: 'ContactForm',
});

const decl = (name: string): FunctionDecl => ({
  name,
  kind: 'arrow',
  span: span('src/f.tsx'),
  isExported: true,
  returnsJsx: true,
  returnsJsxConfidence: 'certain',
});

const group = (name: string): GroupRow => ({
  id: `ts:${name}`,
  name,
  file: 'src/f.tsx' as GroupRow['file'],
  line: 1,
  col: 7,
  kind: 'const',
  count: 1,
  roles: 'jsx',
  exported: true,
  confidence: 'certain',
});

/** A fake ts whose `DialogContent` usage answer is CAPPED (one encloser shown, groupTotal claims
 *  two) — the rest unresolved. Only `findUsages` is exercised by detectDialogs. */
function fakeTs(): TsPluginApi {
  const find: TsPluginApi['findUsages'] = (target) => {
    const name = (target as { name?: string }).name;
    if (name === 'DialogContent') {
      return { view: { groups: [group('ContactDialog')], groupTotal: 2, total: 2, excluded: 0 } };
    }
    return `no symbol named ${String(name)}`;
  };
  return { findUsages: find } as unknown as TsPluginApi;
}

test('detectDialogs: rollup cap surfaces as truncation, never a silently-complete set', () => {
  const decls = [decl('ContactDialog'), decl('EditDialog')];
  const { entries, truncation } = detectDialogs(decls, fakeTs(), 1);
  assert.equal(entries.length, 1, 'one dialog shown (the capped group)');
  assert.equal(entries[0]?.name, 'ContactDialog');
  assert.ok(truncation !== undefined, 'truncation MUST be set when a primitive answer was capped');
  assert.equal(truncation.shown, 1);
  assert.equal(truncation.total, 2); // shown + 1 dropped encloser
  assert.match(truncation.hint, /cap|examined|narrow/i);
});

test('detectDialogs: no cap → no truncation', () => {
  const noCap = (): TsPluginApi => {
    const find: TsPluginApi['findUsages'] = (target) => {
      const name = (target as { name?: string }).name;
      if (name === 'DialogContent') {
        return { view: { groups: [group('ContactDialog')], groupTotal: 1, total: 1, excluded: 0 } };
      }
      return 'none';
    };
    return { findUsages: find } as unknown as TsPluginApi;
  };
  const { entries, truncation } = detectDialogs([decl('ContactDialog')], noCap(), 500);
  assert.equal(entries.length, 1);
  assert.equal(truncation, undefined);
});
