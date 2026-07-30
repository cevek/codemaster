// Real temp workspaces behind ONE real orchestrator, with git OPT-IN per workspace (t-810757).
// `multiRepo` always `git init`s, which is exactly what the non-git cases here must not have — and
// a VFS fixture cannot express "no .git on disk" at all, since the mechanism under test is what git
// and the filesystem walk each report about a real directory.
//
// Wiring mirrors multiRepo (nullWatcher → the read-time backstop is what answers; manual clock → no
// sleeps, §16) so an answer here differs from an answer there only by the workspace's own shape.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createDebugSystem } from '../../src/support/debug/system.ts';
import { nullWatcher } from '../../src/support/watch/seam.ts';
import { Orchestrator } from '../../src/daemon/orchestrator.ts';
import { createTsPlugin } from '../../src/plugins/ts/plugin.ts';
import { createScssPlugin } from '../../src/plugins/scss/plugin.ts';
import { builtinOps } from '../../src/ops/builtins.ts';
import type { BatchOptions, OpRequest, OpResult } from '../../src/ops/contracts.ts';
import { manualClock } from './project.ts';

export interface BareWorkspaceSpec {
  /** `true` → `git init` + commit everything; `false` → a plain directory with no `.git`. */
  git: boolean;
  files: Record<string, string>;
}

export interface BareWorkspaces {
  root(name: string): string;
  /** Where the `feedback` inbox lands — asserted against, so it must not be the user's real one. */
  stateDir: string;
  request(
    name: string,
    reqs: readonly OpRequest[],
    batch?: BatchOptions,
  ): Promise<readonly OpResult[]>;
  write(name: string, rel: string, content: string): void;
  dispose(): Promise<void>;
}

export async function bareWorkspaces(
  specs: Record<string, BareWorkspaceSpec>,
): Promise<BareWorkspaces> {
  const roots = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) {
    const root = mkdtempSync(path.join(tmpdir(), `cm-bare-${name}-`));
    roots.set(name, root);
    for (const [rel, content] of Object.entries(spec.files)) {
      const abs = path.join(root, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    if (spec.git) {
      const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd: root, encoding: 'utf8' });
      };
      git('init', '-q');
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
      git('config', 'commit.gpgsign', 'false');
      git('add', '-A');
      git('commit', '-qm', 'fixture');
    }
  }

  const clock = manualClock();
  const debug = createDebugSystem(clock);
  const stateDir = path.join(mkdtempSync(path.join(tmpdir(), 'cm-bare-state-')), 'state');
  const orchestrator = new Orchestrator({
    clock,
    debug,
    watcher: nullWatcher,
    version: 'test',
    stateDir,
    pluginsFor: (config, repoRoot) => [
      createTsPlugin(repoRoot, config.ts?.tsconfig, {
        searchWarmMaxFiles: config.ts?.searchWarmMaxFiles,
        searchWarmPeakMaxFiles: config.ts?.searchWarmPeakMaxFiles,
      }),
      createScssPlugin(repoRoot),
    ],
    opsFor: () => builtinOps(),
  });

  const rootOf = (name: string): string => {
    const r = roots.get(name);
    if (r === undefined) throw new Error(`no workspace named ${name}`);
    return r;
  };

  return {
    root: rootOf,
    stateDir,
    write(name, rel, content) {
      const abs = path.join(rootOf(name), rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    async request(name, reqs, batch) {
      const root = rootOf(name);
      // Explicit `root` — routing a non-git cwd would fall through to `canonicalizeRoot(cwd)`
      // anyway, but pinning it keeps the test about the surface, not about route resolution.
      const outcome = await orchestrator.request(root, root, reqs, batch);
      if (!outcome.ok) {
        // The §4c gate refuses at DISPATCH, before any per-request result exists — surface it as one
        // error result per request so a caller asserts on the refusal instead of on a thrown harness.
        return reqs.map((req) => ({
          name: req.name,
          error: { kind: 'unavailable' as const, message: outcome.message },
        }));
      }
      return outcome.results;
    },
    async dispose() {
      await orchestrator.dispose();
      debug.dispose();
      for (const root of roots.values()) rmSync(root, { recursive: true, force: true });
      rmSync(path.dirname(stateDir), { recursive: true, force: true });
    },
  };
}
