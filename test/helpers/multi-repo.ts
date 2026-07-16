// Cross-repo harness (cross-repo spec §3): several temp-git repos behind ONE orchestrator,
// so a batch can carry per-request `root` and target sibling repos. Mirrors project()'s
// real-pipeline wiring (nullWatcher → read-time backstop; manual clock → no sleeps), but
// routes by root instead of binding to one.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createDebugSystem } from '../../src/support/debug/system.ts';
import { nullWatcher } from '../../src/support/watch/seam.ts';
import { Orchestrator } from '../../src/daemon/orchestrator.ts';
import { createTsPlugin } from '../../src/plugins/ts/plugin.ts';
import { createScssPlugin } from '../../src/plugins/scss/plugin.ts';
import { builtinOps } from '../../src/ops/builtins.ts';
import { renderStatus } from '../../src/format/render/render-status.ts';
import type { BatchOptions, OpRequest, OpResult } from '../../src/ops/contracts.ts';
import { manualClock } from './project.ts';

export interface MultiRepo {
  /** The temp root of a named repo — pass it as a request `root`. */
  root(name: string): string;
  /** Drive a batch through the orchestrator. `toolRoot` is the tool-level default
   *  (cwd-equivalent) for requests that carry no `root` of their own. */
  request(
    reqs: readonly OpRequest[],
    batch?: BatchOptions,
    toolRoot?: string,
  ): Promise<readonly OpResult[]>;
  status(toolRoot?: string): Promise<string>;
  write(name: string, rel: string, content: string): void;
  git(name: string, ...args: string[]): string;
  clock: ReturnType<typeof manualClock>;
  dispose(): Promise<void>;
}

export async function multiRepo(
  repos: Record<string, Record<string, string>>,
  opts?: { maxEngines?: number },
): Promise<MultiRepo> {
  const roots = new Map<string, string>();
  const gitIn = (root: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });

  for (const [name, files] of Object.entries(repos)) {
    const root = mkdtempSync(path.join(tmpdir(), `cm-${name}-`));
    roots.set(name, root);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    gitIn(root, 'init', '-q');
    gitIn(root, 'config', 'user.email', 't@t');
    gitIn(root, 'config', 'user.name', 't');
    gitIn(root, 'config', 'commit.gpgsign', 'false');
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-qm', 'fixture');
  }

  const first = [...roots.values()][0] ?? tmpdir();
  const clock = manualClock();
  const debug = createDebugSystem(clock);
  const orchestrator = new Orchestrator({
    clock,
    debug,
    watcher: nullWatcher,
    version: 'test',
    stateDir: path.join(mkdtempSync(path.join(tmpdir(), 'cm-state-')), 'state'),
    ...(opts?.maxEngines !== undefined ? { maxEngines: opts.maxEngines } : {}),
    pluginsFor: (config, repoRoot) => [
      createTsPlugin(repoRoot, config.ts?.tsconfig, {
        searchWarmMaxFiles: config.ts?.searchWarmMaxFiles,
      }),
      createScssPlugin(repoRoot),
    ],
    opsFor: () => builtinOps(),
  });

  const rootOf = (name: string): string => {
    const r = roots.get(name);
    if (r === undefined) throw new Error(`no repo named ${name}`);
    return r;
  };

  return {
    root: rootOf,
    clock,
    write(name, rel, content) {
      const abs = path.join(rootOf(name), rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    git: (name, ...args) => gitIn(rootOf(name), ...args),
    async request(reqs, batch, toolRoot) {
      const outcome = await orchestrator.request(toolRoot ?? first, toolRoot, reqs, batch);
      if (!outcome.ok) throw new Error(`dispatch failed: ${outcome.message}`);
      return outcome.results;
    },
    async status(toolRoot) {
      return renderStatus(await orchestrator.status(toolRoot ?? first, toolRoot));
    },
    async dispose() {
      await orchestrator.dispose();
      debug.dispose();
      for (const root of roots.values()) rmSync(root, { recursive: true, force: true });
    },
  };
}
