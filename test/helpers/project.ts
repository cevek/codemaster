// `project()` — the honesty-harness fixture mount (§16): a temp git repo built from a
// `{ path: source }` map, driving the REAL pipeline (orchestrator → engine → plugins)
// with the watcher silenced (nullWatcher) so every test exercises the read-time
// freshness backstop, and an injected manual clock so nothing sleeps.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Clock } from '../../src/common/async/clock.ts';
import { createDebugSystem } from '../../src/support/debug/system.ts';
import { nullWatcher } from '../../src/support/watch/seam.ts';
import { Orchestrator } from '../../src/daemon/orchestrator.ts';
import { createTsPlugin } from '../../src/plugins/ts/plugin.ts';
import { createScssPlugin } from '../../src/plugins/scss/plugin.ts';
import { createI18nPlugin } from '../../src/plugins/i18n/plugin.ts';
import { builtinOps } from '../../src/ops/builtins.ts';
import { renderStatus } from '../../src/format/render/render-status.ts';
import type { BatchOptions, OpRequest, OpResult } from '../../src/ops/contracts.ts';
import type { SqlBounds } from '../../src/daemon/sql-batch.ts';
import type { createSqliteRunner } from '../../src/support/sql/better-sqlite3.ts';
import type { TextScanner } from '../../src/support/text-search/scan.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { Result } from '../../src/core/result.ts';
import { extractText } from '../../src/common/span/extract-text.ts';

export interface TestProject {
  root: string;
  op(name: string, args: JsonValue): Promise<OpResult>;
  /** The rendered `status` reply for this workspace (the per-repo documentation). */
  status(): Promise<string>;
  /** Drive a (sql-)batch directly: returns the engine's ordered results, unrendered. */
  request(reqs: readonly OpRequest[], batch?: BatchOptions): Promise<readonly OpResult[]>;
  write(rel: string, content: string): void;
  remove(rel: string): void;
  git(...args: string[]): string;
  clock: Clock & { advance(ms: number): void };
  dispose(): Promise<void>;
}

export interface ProjectOptions {
  /** Lower the sql-mode row bounds to avoid 100k-row fixtures (spec §7.3/§7.4). */
  sqlBounds?: Partial<SqlBounds>;
  /** Swap the SQL evaluator (e.g. to force the native-load failure path). */
  createSqlRunner?: () => ReturnType<typeof createSqliteRunner>;
  /** Swap the text scanner (e.g. to force the text-scan failure path, §text-overlay). */
  createTextScanner?: () => TextScanner;
  /** Override the state base (feedback inbox + debug log). Defaults under `root`; tests
   *  that assert the repo tree is untouched point this OUTSIDE the repo (as production's
   *  `~/.codemaster` is). */
  stateDir?: string;
}

export function manualClock(): Clock & { advance(ms: number): void } {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    schedule(ms, fn) {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => {
        const i = timers.indexOf(timer);
        if (i !== -1) timers.splice(i, 1);
      };
    },
    advance(ms) {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now) {
          const i = timers.indexOf(t);
          if (i !== -1) timers.splice(i, 1);
          t.fn();
        }
      }
    },
  };
}

export async function project(
  files: Record<string, string>,
  options?: ProjectOptions,
): Promise<TestProject> {
  const root = mkdtempSync(path.join(tmpdir(), 'codemaster-fixture-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });

  const write = (rel: string, content: string): void => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture');

  const clock = manualClock();
  const debug = createDebugSystem(clock);
  const orchestrator = new Orchestrator({
    clock,
    debug,
    watcher: nullWatcher, // silenced on purpose: the read-time backstop must carry it
    version: 'test',
    stateDir: options?.stateDir ?? path.join(root, '.codemaster-state'),
    ...(options?.sqlBounds !== undefined ? { sqlBounds: options.sqlBounds } : {}),
    ...(options?.createSqlRunner !== undefined ? { createSqlRunner: options.createSqlRunner } : {}),
    ...(options?.createTextScanner !== undefined
      ? { createTextScanner: options.createTextScanner }
      : {}),
    pluginsFor: (config, repoRoot) => [
      createTsPlugin(repoRoot, config.ts?.tsconfig),
      createScssPlugin(repoRoot),
      ...(config.i18n !== undefined
        ? [createI18nPlugin(repoRoot, config.i18n.locales, config.i18n.functions)]
        : []),
    ],
    opsFor: () => builtinOps(),
  });

  return {
    root,
    clock,
    git,
    write,
    remove: (rel) => rmSync(path.join(root, rel)),
    async op(name, args) {
      const outcome = await orchestrator.request(root, root, [{ name, args }]);
      if (!outcome.ok) throw new Error(`dispatch failed: ${outcome.message}`);
      const result = outcome.results[0];
      if (result === undefined) throw new Error('no result');
      return result;
    },
    async status() {
      return renderStatus(await orchestrator.status(root, root));
    },
    async request(reqs, batch) {
      const outcome = await orchestrator.request(root, root, reqs, batch);
      if (!outcome.ok) throw new Error(`dispatch failed: ${outcome.message}`);
      return outcome.results;
    },
    async dispose() {
      await orchestrator.dispose();
      debug.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** §16 invariant 1 — proof-span validity: every emitted `Span.text` equals the live
 *  source at its range. The oracle is the file on disk, read independently. */
type SpanLike = {
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  text: string;
  elided?: boolean;
};

export function assertSpansValid(root: string, result: OpResult): void {
  if (!('result' in result)) return;
  const spans: SpanLike[] = [];
  collectSpans(resultData(result.result), spans);
  for (const span of spans) {
    const source = readFileSync(path.join(root, span.file), 'utf8');
    const actual = extractText(source, span);
    if (actual === undefined) {
      throw new Error(`span out of range: ${span.file}:${span.line}:${span.col}`);
    }
    if (span.elided === true) {
      const head = span.text.replace(/…$/, '');
      if (!actual.startsWith(head)) {
        throw new Error(`elided span text drifted at ${span.file}:${span.line}`);
      }
    } else if (actual !== span.text) {
      throw new Error(
        `span text drifted at ${span.file}:${span.line}:${span.col} — span says ${JSON.stringify(span.text)}, source says ${JSON.stringify(actual)}`,
      );
    }
  }
  if (spans.length === 0) return;
}

function resultData(result: Result<JsonValue>): JsonValue {
  return (result.ok ? result.data : (result.data ?? null)) ?? null;
}

function collectSpans(value: JsonValue, out: SpanLike[]): void {
  if (isJsonArray(value)) {
    for (const v of value) collectSpans(v, out);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, JsonValue>;
    if (
      typeof v['file'] === 'string' &&
      typeof v['line'] === 'number' &&
      typeof v['col'] === 'number' &&
      typeof v['endLine'] === 'number' &&
      typeof v['endCol'] === 'number' &&
      typeof v['text'] === 'string'
    ) {
      // Structure verified field-by-field right above.
      out.push(v as SpanLike);
    }
    for (const child of Object.values(v)) collectSpans(child, out);
  }
}

// `Array.isArray` narrows a readonly union member to `any[]`; keep the element type.
function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}
