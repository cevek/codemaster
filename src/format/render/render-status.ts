// Render the `status` first-contact manifest (§11): active plugins, the per-repo op
// catalogue (schema + examples ARE the documentation — §7), debug namespaces, and the
// honest state of the machinery (watcher degraded? freshness mode? zero plugins?).
// `StatusView` is the render contract; the daemon builds it, this module formats it.

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
  example?: string;
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
  workspace: WorkspaceStatusView | undefined;
  debugTopics: readonly string[];
  guidance: readonly string[];
}

export function renderStatus(view: StatusView): string {
  const lines: string[] = [
    `codemaster v${view.daemonVersion} pid=${view.pid} isolation=${view.isolation} engines=${view.engines}`,
  ];

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
    if (op.example !== undefined) lines.push(`    e.g. ${op.example}`);
  }
  return lines;
}
