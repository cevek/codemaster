// Render the `status` first-contact manifest (§11): active plugins, the per-repo op
// catalogue (schema + examples ARE the documentation — §7), debug namespaces, and the
// honest state of the machinery (watcher degraded? freshness mode? zero plugins?).
// `StatusView` is the render contract; the daemon builds it, this module formats it.

import type { OpExample } from '../../core/op-example.ts';
import { CONCEPTS_LINES } from './concepts.ts';

/** The self-staleness line (§3.6 applied to the tool). Shared by `status` (first line) and
 *  the MCP op/batch banner so the two surfaces never drift in wording. */
export const SOURCE_STALE_LINE =
  '!! daemon code behind source — reconnect MCP (running pre-edit behavior)';

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
  /** Why no workspace resolved (§4c) — a bad/unresolvable root, or a folder that isn't a TS
   *  project. Surfaced instead of the generic "none resolved" so the agent learns the cause. */
  workspaceError: string | undefined;
  debugTopics: readonly string[];
  /** True when codemaster's own source changed since the daemon spawned — it is serving
   *  behavior older than the code on disk (§3.6 applied to the tool itself). */
  sourceStale: boolean;
}

/** Render dials for `status` (spec-agent-surface-ergonomics §1). The FULL render is the
 *  default + the golden; `brief`/`op` are opt-in token-savers an agent reaches for once it
 *  knows the catalogue:
 *  - `brief` — header + warm roots + plugins + per-op NAME+summary + freshness only; no arg
 *    schemas, no per-op notes, no concepts dump (the heavy two-thirds of the full render).
 *  - `op` — one op's full block (schema + notes + columns + example) on demand. Beats
 *    re-emitting the whole catalogue to re-read a single op. */
export interface RenderStatusOptions {
  brief?: boolean | undefined;
  /** Render only this op's full detail. Takes precedence over `brief`. */
  op?: string | undefined;
}

export function renderStatus(view: StatusView, options?: RenderStatusOptions): string {
  const header = renderHeader(view);
  if (options?.op !== undefined) return [...header, ...renderSingleOp(view, options.op)].join('\n');
  if (options?.brief === true) return renderBrief(view, header).join('\n');
  return renderFull(view, header).join('\n');
}

/** The daemon line (+ self-staleness banner + warm roots) — shared verbatim by every render
 *  mode so the brief/op surfaces never drift from full in the header. */
function renderHeader(view: StatusView): string[] {
  const lines: string[] = [
    `codemaster v${view.daemonVersion} pid=${view.pid} isolation=${view.isolation} engines=${view.engines}`,
  ];
  // §3.6 applied to the tool itself: if our own source moved since spawn, say so loudly and
  // first — the agent is otherwise talking to a daemon serving pre-edit behavior.
  if (view.sourceStale) lines.push(SOURCE_STALE_LINE);
  // Warm engines by root (cross-repo §2): a query/batch request may carry `root` to target
  // any of these sibling repos; this is the agent's signal that multi-root is live.
  if (view.engineRoots.length > 0) lines.push(`warm roots: ${view.engineRoots.join(' · ')}`);
  return lines;
}

/** The workspace identity + freshness line (or the §4c "why no workspace" line). Shared by
 *  full + brief. */
function renderWorkspaceLines(view: StatusView): string[] {
  const ws = view.workspace;
  if (ws === undefined) {
    // §4c: name the cause (bad root / not a TS project) instead of a bare "none resolved".
    return [
      view.workspaceError !== undefined
        ? `workspace: none resolved — ${view.workspaceError}`
        : 'workspace: none resolved (pass root, or call from inside a repo)',
    ];
  }
  return [
    `workspace: ${ws.root}`,
    `  freshness=${ws.freshnessMode} watcher=${renderWatcher(ws.watcher)} config=${ws.configSource ?? 'defaults (no codemaster.config.*)'}`,
  ];
}

function renderFull(view: StatusView, header: string[]): string[] {
  const lines = [...header, ...renderWorkspaceLines(view)];
  const ws = view.workspace;
  if (ws !== undefined) {
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
  // No GUIDANCE tail: the steer ships once per session in the MCP `initialize` response
  // (SERVER_INSTRUCTIONS) — re-emitting it on every status was a verbatim duplicate
  // (spec-agent-surface-ergonomics §2).
  return lines;
}

/** Brief render (§1): the daemon/workspace/plugins frame + a one-line-per-op catalogue
 *  (name + summary), dropping arg schemas, per-op notes, columns, examples and the concepts
 *  dump. The agent learns WHICH ops exist; `status {op:"<name>"}` fetches one's full detail. */
function renderBrief(view: StatusView, header: string[]): string[] {
  const lines = [...header, ...renderWorkspaceLines(view)];
  const ws = view.workspace;
  if (ws !== undefined) {
    lines.push(renderPlugins(ws.plugins));
    if (ws.ops.length === 0) {
      lines.push('ops: none (no plugins active; op catalogue grows with each plugin)');
    } else {
      lines.push(
        `ops (${ws.ops.length}) — names+summaries; \`status {op:"<name>"}\` for full schema:`,
      );
      for (const op of ws.ops) {
        lines.push(`  ${op.name}${op.mutating ? ' [mutating]' : ''} — ${op.summary}`);
      }
    }
  }
  return lines;
}

/** Single-op render (§1): one op's full catalogue block on demand. An unknown name lists the
 *  available ops so the agent self-corrects without a second `status` round-trip. */
function renderSingleOp(view: StatusView, name: string): string[] {
  const ws = view.workspace;
  if (ws === undefined) return renderWorkspaceLines(view);
  const op = ws.ops.find((o) => o.name === name);
  if (op === undefined) {
    const names = ws.ops.map((o) => o.name).join(', ');
    return [`op '${name}' not in this repo's catalogue (${ws.ops.length} ops): ${names}`];
  }
  return renderOps([op]);
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
