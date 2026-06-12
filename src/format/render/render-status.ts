// Render the `status` first-contact manifest (§11): active plugins, the per-repo op
// catalogue (schema + examples ARE the documentation — §7), debug namespaces, and the
// honest state of the machinery (watcher degraded? freshness mode? zero plugins?).
// `StatusView` is the render contract; the daemon builds it, this module formats it.

import type { OpExample } from '../../core/op-example.ts';
import { CONCEPTS_LINES } from './concepts.ts';

export interface PluginStatusView {
  id: string;
  version: string;
  fingerprint: string;
  pendingFiles: number;
}

export interface OpStatusView {
  name: string;
  summary: string;
  mutating: boolean;
  /** Compact args description, e.g. '{ target: SymbolId, limit?: number }'. */
  argsHint: string;
  /** Structured example call (§1.1); the display string is composed here, never
   *  hand-written, so it can't drift from the real tool-args shape. */
  example?: OpExample;
  /** Comma-joined column names when the op is tabular (usable under sql) — §6. */
  columns?: string;
  /** Short per-op usage notes — `status` is the documentation, so these ride on the op
   *  and render under it (spec-status-as-the-doc §2). */
  notes?: readonly string[];
}

export interface WorkspaceStatusView {
  repoId: string;
  root: string;
  configSource: string | undefined;
  freshnessMode: 'git' | 'mtime-walk';
  watcher: 'active' | 'off' | { degraded: string };
  plugins: readonly PluginStatusView[];
  ops: readonly OpStatusView[];
}

export interface StatusView {
  daemonVersion: string;
  pid: number;
  isolation: 'in-process' | 'process';
  engines: number;
  /** Roots of the currently warm engines (cross-repo §2) — so an agent sees that
   *  multi-root is live and which sibling repos are already loaded. */
  engineRoots: readonly string[];
  workspace: WorkspaceStatusView | undefined;
  debugTopics: readonly string[];
  guidance: readonly string[];
}

export function renderStatus(view: StatusView): string {
  const lines: string[] = [
    `codemaster v${view.daemonVersion} pid=${view.pid} isolation=${view.isolation} engines=${view.engines}`,
  ];
  // Warm engines by root (cross-repo §2): a query/batch request may carry `root` to target
  // any of these sibling repos; this is the agent's signal that multi-root is live.
  if (view.engineRoots.length > 0) {
    lines.push(`warm roots: ${view.engineRoots.join(' · ')}`);
  }

  const ws = view.workspace;
  if (ws === undefined) {
    lines.push('workspace: none resolved (pass root, or call from inside a repo)');
  } else {
    lines.push(`workspace: ${ws.root}`);
    lines.push(
      `  freshness=${ws.freshnessMode} watcher=${renderWatcher(ws.watcher)} config=${ws.configSource ?? 'defaults (no codemaster.config.*)'}`,
    );
    lines.push(renderPlugins(ws.plugins));
    lines.push(...renderOps(ws.ops));
    // The shared mechanics — status IS the documentation, so the concepts that belong to
    // no single op are rendered here, once (spec-status-as-the-doc §2).
    if (ws.ops.length > 0) {
      lines.push('concepts:');
      for (const concept of CONCEPTS_LINES) lines.push(`  ${concept}`);
    }
  }

  if (view.debugTopics.length > 0) lines.push(`debug topics: ${view.debugTopics.join(',')}`);
  lines.push(...view.guidance.map((g) => `> ${g}`));
  return lines.join('\n');
}

function renderWatcher(watcher: WorkspaceStatusView['watcher']): string {
  if (typeof watcher === 'string') return watcher;
  return `DEGRADED(${watcher.degraded})`;
}

function renderPlugins(plugins: readonly PluginStatusView[]): string {
  if (plugins.length === 0) {
    return 'plugins: none active (Phase 0 foundation — the ts plugin lands in Phase 1)';
  }
  const rendered = plugins.map(
    (p) => `${p.id}@${p.version}${p.pendingFiles > 0 ? ` pending=${p.pendingFiles}` : ''}`,
  );
  return `plugins: ${rendered.join(' · ')}`;
}

function renderOps(ops: readonly OpStatusView[]): string[] {
  if (ops.length === 0) {
    return ['ops: none (no plugins active; op catalogue grows with each plugin)'];
  }
  const lines = [`ops (${ops.length}):`];
  for (const op of ops) {
    lines.push(`  ${op.name}${op.mutating ? ' [mutating]' : ''} ${op.argsHint} — ${op.summary}`);
    for (const note of op.notes ?? []) lines.push(`    · ${note}`);
    if (op.columns !== undefined) lines.push(`    columns: ${op.columns}`);
    if (op.example !== undefined) lines.push(`    e.g. ${renderExample(op.name, op.example)}`);
  }
  return lines;
}

/** Compose an op example into the EXACT tool-args JSON an agent would pass to the `op`
 *  tool: `op <json>`, where `<json>` is `{name, args, …flags}` (§1.1). One canonical
 *  shape, machine-derived from the structured `OpExample` — so the printed example can
 *  never drift from the real tool schema (the anti-drift test parses it back). */
function renderExample(name: string, example: OpExample): string {
  const call = { name, args: example.args, ...(example.flags ?? {}) };
  return `op ${JSON.stringify(call)}`;
}
