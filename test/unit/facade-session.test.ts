// The repeat-`status` catalogue memory (§11): a catalogue counts as known only when the block that
// stated it — the full list, or the diff against the one shown — reached the reader whole.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFacadeSession } from '../../src/mcp/facade-session.ts';
import { renderCatalogue } from '../../src/format/render/render-status-recall.ts';
import type { StatusView, WorkspaceStatusView } from '../../src/format/render/render-status.ts';

const op = (name: string, summary: string) => ({
  name,
  summary,
  mutating: false,
  argsHint: '{}',
});

function view(ops: ReturnType<typeof op>[]): StatusView {
  const workspace = { root: '/r', ops } as unknown as WorkspaceStatusView;
  return { workspace } as unknown as StatusView;
}

test('a diff cut after its header does not replace the known catalogue', () => {
  const session = createFacadeSession();
  const a = view([op('find_usages', 'refs')]);
  const s1 = session.begin();
  s1.noteStatus(a);
  s1.commit(renderCatalogue(a.workspace as WorkspaceStatusView, s1.statusRecall()).join('\n'));

  const b = view([op('find_usages', 'refs'), op('new_op', 'x'.repeat(200))]);
  const s2 = session.begin();
  s2.noteStatus(b);
  const diff = renderCatalogue(b.workspace as WorkspaceStatusView, s2.statusRecall());
  assert.match(diff[0] ?? '', /changed since shown earlier/);
  s2.commit(diff[0] ?? ''); // the `+ new_op` line was cut

  const s3 = session.begin();
  const again = renderCatalogue(b.workspace as WorkspaceStatusView, s3.statusRecall());
  assert.ok(
    again.some((l) => l.startsWith('+ new_op')),
    'the undelivered change is stated again',
  );

  s3.noteStatus(b);
  s3.commit(again.join('\n'));
  const s4 = session.begin();
  assert.match(
    renderCatalogue(b.workspace as WorkspaceStatusView, s4.statusRecall())[0] ?? '',
    /same as shown earlier/,
  );
});
