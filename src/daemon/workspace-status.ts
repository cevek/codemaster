// Project a workspace engine's live state into the `WorkspaceStatusView` the formatter
// renders (§11): active plugins (id@version + freshness + pending), and the op catalogue
// filtered to ops whose required plugins are all present — an agent never sees an op it
// can't call. Pure projection, split out of engine.ts to keep that file under the cap.

import type { JsonValue } from '../core/json.ts';
import type { Plugin, PluginRegistry } from '../core/plugin.ts';
import type { AnyOpDefinition } from '../ops/registry.ts';
import type { WorkspaceStatusView } from '../format/render/render-status.ts';
import type { FreshnessMode } from './freshness.ts';
import { buildOpInputSchema } from '../ops/tool-schema/input-schema.ts';

export interface WorkspaceStatusInput {
  repoId: string;
  root: string;
  configSource: string | undefined;
  freshnessMode: FreshnessMode;
  watcher: WorkspaceStatusView['watcher'];
  plugins: readonly Plugin[];
  registry: PluginRegistry;
  ops: readonly AnyOpDefinition[];
}

export function buildWorkspaceStatus(i: WorkspaceStatusInput): WorkspaceStatusView {
  return {
    repoId: i.repoId,
    root: i.root,
    configSource: i.configSource,
    freshnessMode: i.freshnessMode,
    watcher: i.watcher,
    plugins: i.plugins.map((p) => {
      const detail = p.statusDetail?.();
      return {
        id: p.id,
        version: p.version,
        fingerprint: p.freshness(),
        pendingFiles: p.pending().length,
        ...(detail !== undefined ? { detail } : {}),
      };
    }),
    ops: i.ops
      .filter((op) => op.requires.every((id) => i.registry.has(id)))
      .map((op) => ({
        name: op.name,
        summary: op.summary,
        mutating: op.mutating,
        argsHint: op.argsHint,
        // The EXACT `inputSchema` this op advertises in `tools/list` — same builder, same memoized
        // object (t-981812), so `status {op:"X"}` answers "what contract does the harness see?"
        // from codemaster itself and any drift between the two surfaces is impossible, not merely
        // untested. Rendered only on the single-op path (§11: the terse/full catalogue must not
        // re-dump N schemas the tool-list already carries).
        inputSchema: buildOpInputSchema(op) as unknown as JsonValue,
        ...(op.example !== undefined ? { example: op.example } : {}),
        ...(op.notes !== undefined ? { notes: op.notes } : {}),
        ...(op.table !== undefined
          ? { columns: op.table.columns.map((c) => c.name).join(',') }
          : {}),
      })),
  };
}
