// Render the `status` first-contact manifest (§11): active plugins, the per-repo op
// catalogue (schema + examples ARE the documentation — §7), debug namespaces, and the
// honest state of the machinery (watcher degraded? freshness mode? zero plugins?).
// `StatusView` is the render contract; the daemon builds it, this module formats it.

import type { JsonValue } from '../../core/json.ts';
import type { OpExample } from '../../core/op-example.ts';
import { CONCEPTS_LINES } from './concepts.ts';

/** How THIS process serves codemaster — the one fact that decides which remedy is real, and the
 *  only discrimination the self-staleness banner makes. Known exactly and locally by whoever wires
 *  the server (`bin.ts`), never inferred: `daemon` = the bridge forwarding to the shared singleton
 *  (spec-daemon-singleton), `in-process` = a local orchestrator with no daemon at all (the
 *  `mcp --in-process` dev path, the daemon-unreachable fallback, and the CLI one-shot).
 *
 *  It deliberately does NOT discriminate the AUDIENCE. Who is reading — the agent editing
 *  codemaster, or one in an unrelated repo sharing the daemon — cannot be decided mechanically: a
 *  codemaster worktree lives OUTSIDE the serving process's own source tree, so a "is the caller
 *  inside our src/" test labels the codemaster-editing agent a stranger, withholding the one remedy
 *  it needs. The banner states the criterion instead and lets the reader apply it in one glance. */
export type ServingMode = 'daemon' | 'in-process';

/** The self-staleness banner (§3.6 applied to the tool itself): codemaster's OWN `src/**` moved
 *  since this process started, so it answers with code older than its checkout. ONE home for the two
 *  AGENT-facing surfaces — `status` (in its header block) and the MCP op/batch prefix — so they cannot drift.
 *  (The `codemaster daemon status` management verb states its own, shorter line: a human typed that
 *  command about the daemon, so the audience and the remedy are right by construction and the
 *  one-shot clause below would be noise there.)
 *
 *  Three facts, none droppable (t-034392 / t-793745):
 *  1. WHAT is stale — the analysis code, not the inspected repo: files are still re-read per call
 *     (§3.5), so the answer may lack a fix newer code has, but it is not computed over stale data.
 *     Without this an external reader cannot tell whether the answer in hand is degraded.
 *  2. The CHEAP remedy — a CLI one-shot is fresh by construction (~2 s, measured) and needs no
 *     restart. Naming only the restart taught dogfooders to leave the tool for grep.
 *  3. WHAT the restart actually does HERE — under `daemon` it works, but it costs the reader their
 *     own session too: the restart drops the socket and `RemoteOrchestrator` latches closed, so a
 *     RECONNECT is part of the remedy, not an afterthought, and every OTHER connection pays for it
 *     with its warm LS. Under `in-process` the daemon verb cannot reach this server at all — only
 *     this server's own restart un-stales it, which is the MCP client's action, not the reader's.
 *     A lever that cannot change the outcome is not a remedy, and this is the most-read place the
 *     tool has (`ops/guard/navigate.ts` states the same rule for refusals: name a lever that works
 *     HERE). */
export function sourceStaleBanner(serving: ServingMode): string {
  // The one-shot leads in BOTH variants: it is the remedy the READER can execute in-session, whoever
  // they are. The restart clause then states what that lever does here — never suppressed (a daemon
  // restart genuinely works, and hiding it would be the §3.6 lie inverted) and never recommended
  // (its cost falls on connections the reader cannot see, and on their own session).
  //
  // Neither clause claims more than this process can know. The `in-process` arm says the verb will
  // not touch THIS server — not that no daemon exists: `--in-process` bypasses the socket, it does
  // not imply the machine has no singleton, and a reader who ran the verb "because it is inert"
  // would evict some other agent's warm LS.
  const remedy =
    serving === 'daemon'
      ? '. `codemaster daemon restart`+reconnect fixes it; hits every connection.'
      : "; `daemon restart` won't touch this server — only its own restart will.";
  return (
    '!! PRE-EDIT codemaster (src/ moved since start): your data is re-read fresh, the ANALYSIS is old. ' +
    "Editing it? `node src/bin.ts op <name> '<json>'` — one-shot, current src, ~2s" +
    remedy
  );
}

export interface PluginStatusView {
  id: string;
  version: string;
  fingerprint: string;
  pendingFiles: number;
  /** Optional plugin self-describe line (e.g. the `ts` plugin's loaded tsconfigs). */
  detail?: string;
}

export interface OpStatusView {
  name: string;
  summary: string;
  mutating: boolean;
  /** Compact args description, e.g. '{ symbolId: SymbolId, limit?: number }'. */
  argsHint: string;
  /** Structured example call (§1.1); the display string is composed here, never
   *  hand-written, so it can't drift from the real tool-args shape. */
  example?: OpExample;
  /** Comma-joined column names when the op is tabular (usable under sql) — §6. */
  columns?: string;
  /** Short per-op usage notes — `status` is the documentation, so these ride on the op
   *  and render under it (spec-status-as-the-doc §2). */
  notes?: readonly string[];
  /** The op's advertised `tools/list` `inputSchema`, verbatim (t-981812). Typed as `JsonValue`
   *  because `format/` may not import `ops/` (layering); rendered as parseable JSON on the
   *  SINGLE-op path only — the terse/full catalogue must not re-dump N schemas the tool-list
   *  already carries every session (§11). */
  inputSchema?: JsonValue;
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

/** Render dials for `status` (spec-agent-surface-ergonomics §1, task t-523883). The DEFAULT is
 *  TERSE — the per-repo frame + a one-line-per-op catalogue + the shared `concepts` block — because
 *  the MCP tool-list ALREADY carries each op's typed inputSchema + description every session (§11),
 *  so a default that re-dumps all N arg schemas + multi-paragraph notes is largely redundant (and on
 *  a 36-op repo overruns the harness output ceiling — t-523883). Opt-in dials:
 *  - `full` — the whole catalogue: every op's arg schema + per-op notes + columns + example. The
 *    old default; capped at the MCP seam so nothing is silently lost.
 *  - `op` — one op's full block (schema + notes + columns + example) on demand. Beats re-emitting
 *    the whole catalogue to re-read a single op.
 *  - `brief` — back-compat alias of the terse default (accepted so an existing caller never breaks).
 *  `op` takes precedence over `full`/`brief`. */
export interface RenderStatusOptions {
  /** How this process serves codemaster — REQUIRED, because it decides which remedy the
   *  self-staleness banner may name (§3.6). Not defaulted: a wrong default would print a lever that
   *  cannot change the outcome, which is the defect the banner exists to avoid. */
  serving: ServingMode;
  brief?: boolean | undefined;
  /** Render the full per-op catalogue (arg schemas + notes + examples + concepts) — the opt-in
   *  heavyweight dump the terse default replaces. */
  full?: boolean | undefined;
  /** Render only this op's full detail. Takes precedence over `full`/`brief`. */
  op?: string | undefined;
}

export function renderStatus(view: StatusView, options: RenderStatusOptions): string {
  const header = renderHeader(view, options.serving);
  if (options.op !== undefined) return [...header, ...renderSingleOp(view, options.op)].join('\n');
  if (options.full === true) return renderFull(view, header).join('\n');
  return renderTerse(view, header).join('\n');
}

/** The daemon line (+ self-staleness banner + warm roots) — shared verbatim by every render
 *  mode so the brief/op surfaces never drift from full in the header. */
function renderHeader(view: StatusView, serving: ServingMode): string[] {
  const lines: string[] = [
    `codemaster v${view.daemonVersion} pid=${view.pid} isolation=${view.isolation} engines=${view.engines}`,
  ];
  // §3.6 applied to the tool itself: if our own source moved since spawn, say so loudly and
  // first — the agent is otherwise reading answers from a server running pre-edit behavior.
  if (view.sourceStale) lines.push(sourceStaleBanner(serving));
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
    lines.push(...renderPlugins(ws.plugins));
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

/** Terse render (the DEFAULT, task t-523883): the daemon/workspace/plugins frame + a one-line-per-op
 *  catalogue (name + summary) + the shared `concepts` block, dropping the per-op arg schemas, notes,
 *  columns and examples (redundant with the tool-list's inputSchemas, §11). The agent learns WHICH
 *  ops exist and how to read the honesty markers; `status {op:"<name>"}` (or `full:true`) fetches
 *  per-op detail. The `concepts` block stays — it is load-bearing for interpreting truncation /
 *  confidence / FAIL markers, and is small. */
function renderTerse(view: StatusView, header: string[]): string[] {
  const lines = [...header, ...renderWorkspaceLines(view)];
  const ws = view.workspace;
  if (ws !== undefined) {
    lines.push(...renderPlugins(ws.plugins));
    if (ws.ops.length === 0) {
      lines.push('ops: none (no plugins active; op catalogue grows with each plugin)');
    } else {
      lines.push(
        `ops (${ws.ops.length}) — names+summaries; \`status {op:"<name>"}\` for one op's full schema, \`status {full:true}\` for all:`,
      );
      for (const op of ws.ops) {
        lines.push(`  ${op.name}${op.mutating ? ' [mutating]' : ''} — ${op.summary}`);
      }
      lines.push('concepts:');
      for (const concept of CONCEPTS_LINES) lines.push(`  ${concept}`);
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
  return renderOps([op], { schema: true });
}

function renderWatcher(watcher: WorkspaceStatusView['watcher']): string {
  if (typeof watcher === 'string') return watcher;
  return `DEGRADED(${watcher.degraded})`;
}

function renderPlugins(plugins: readonly PluginStatusView[]): string[] {
  if (plugins.length === 0) {
    return ['plugins: none active (Phase 0 foundation — the ts plugin lands in Phase 1)'];
  }
  const rendered = plugins.map(
    (p) => `${p.id}@${p.version}${p.pendingFiles > 0 ? ` pending=${p.pendingFiles}` : ''}`,
  );
  const lines = [`plugins: ${rendered.join(' · ')}`];
  // Per-plugin self-describe sub-lines (e.g. the ts plugin's loaded tsconfigs — Task G).
  for (const p of plugins) {
    if (p.detail !== undefined) lines.push(`  ${p.id}: ${p.detail}`);
  }
  return lines;
}

function renderOps(ops: readonly OpStatusView[], options?: { schema: boolean }): string[] {
  if (ops.length === 0) {
    return ['ops: none (no plugins active; op catalogue grows with each plugin)'];
  }
  const lines = [`ops (${ops.length}):`];
  for (const op of ops) {
    lines.push(`  ${op.name}${op.mutating ? ' [mutating]' : ''} ${op.argsHint} — ${op.summary}`);
    for (const note of op.notes ?? []) lines.push(`    · ${note}`);
    if (op.columns !== undefined) lines.push(`    columns: ${op.columns}`);
    if (op.example !== undefined) lines.push(`    e.g. ${renderExample(op.name, op.example)}`);
    // Emitted as PARSEABLE JSON, not a prettified re-description: the value of this block is that
    // it IS the tools/list contract (a consumer can diff it), so a condensed rendering would
    // degrade the anti-drift pin to eyeballing (t-981812).
    if (options?.schema === true && op.inputSchema !== undefined) {
      lines.push(`    inputSchema (verbatim, as advertised in tools/list):`);
      lines.push(`    ${JSON.stringify(op.inputSchema)}`);
    }
  }
  return lines;
}

/** Compose an op example into the EXACT per-op tool call an agent would make: `<op> <json>`,
 *  where the tool-name IS the op-name and `<json>` is the FLAT `{...args, ...flags}` (no
 *  `name`/`args` envelope — §11). One canonical shape, machine-derived from the structured
 *  `OpExample` — so the printed example can never drift from the real tool schema. */
function renderExample(name: string, example: OpExample): string {
  const flatArgs =
    typeof example.args === 'object' && example.args !== null && !Array.isArray(example.args)
      ? example.args
      : {};
  const call = { ...flatArgs, ...(example.flags ?? {}) };
  return `${name} ${JSON.stringify(call)}`;
}
