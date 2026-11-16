// The terse `status` catalogue + concepts, and their repeat form within one MCP session (§11): the
// first render lists everything; a repeat states what changed in the catalogue and names the
// concepts by id (`status {concept:"<id>"}` expands one; `full:true` / `op:` always list in full).

import type { Lesson } from '../../common/lesson/lesson.ts';
import type { WorkspaceStatusView } from './render-status.ts';

export interface StatusRecall {
  /** The catalogue this session was already shown — for this root if it was, else the latest one
   *  (a root hop states the delta against it, t-109681). */
  catalogue(root: string): { root: string; lines: readonly string[] } | undefined;
  /** Whether every concept was already shown in full. */
  conceptsShown: boolean;
}

export function catalogueLines(ws: WorkspaceStatusView): string[] {
  return ws.ops.map((op) => `  ${op.name}${op.mutating ? ' [mutating]' : ''} — ${op.summary}`);
}

export function renderCatalogue(
  ws: WorkspaceStatusView,
  recall: StatusRecall | undefined,
): string[] {
  const now = catalogueLines(ws);
  const shown = recall?.catalogue(ws.root);
  if (shown === undefined) {
    return [
      `ops (${ws.ops.length}) — names+summaries; \`status {op:"<name>"}\` for one op's full schema, \`status {full:true}\` for all:`,
      ...now,
    ];
  }
  const before = shown.lines;
  const added = now.filter((l) => !before.includes(l));
  const removed = before.filter((l) => !now.includes(l));
  if (added.length === 0 && removed.length === 0) {
    return [
      `ops (${ws.ops.length}): same as shown earlier this session for ${shown.root} — \`status {full:true}\` re-lists`,
    ];
  }
  return [
    `ops (${ws.ops.length}): changed since shown earlier this session for ${shown.root}:`,
    ...added.map((l) => `+ ${l.trimStart()}`),
    ...removed.map((l) => `- ${l.trimStart()}`),
  ];
}

export function renderConcepts(
  concepts: readonly Lesson[],
  recall: StatusRecall | undefined,
): string[] {
  if (recall?.conceptsShown === true) {
    const ids = concepts.map((c) => c.id).join(', ');
    return [`concepts: shown earlier this session — ids: ${ids} (status {concept:"<id>"})`];
  }
  return ['concepts:', ...concepts.map((c) => `  ${c.full}`)];
}
