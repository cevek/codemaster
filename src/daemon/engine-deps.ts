// The `EngineDeps` contract — everything one workspace engine is constructed with (§2: the engine is
// transport-agnostic, so every seam it needs arrives here rather than being reached for). Split out
// of `engine.ts` so the engine implementation stays under the line cap.

import type { RepoId } from '../core/brands.ts';
import type { Plugin } from '../core/plugin.ts';
import type { Clock } from '../common/async/clock.ts';
import type { AnyOpDefinition } from '../ops/registry.ts';
import type { Isolation, IsolationReason } from '../core/isolation.ts';
import type { DebugSystemHandle } from '../support/debug/system.ts';
import type { Watcher } from '../support/watch/seam.ts';
import type { GitRunner } from '../support/git/run.ts';
import type { TextScanner } from '../support/text-search/scan.ts';
import type { SqlBounds } from './sql-batch.ts';
import type { createSqliteRunner } from '../support/sql/better-sqlite3.ts';

export interface EngineDeps {
  repoId: RepoId;
  /** Canonical workspace root (from `canonicalizeRoot`). */
  root: string;
  configSource: string | undefined;
  /** Codemaster version, surfaced to the `feedback` op's auto-context. */
  version: string;
  /** State base (`~/.codemaster` by default; a temp dir under test) — where the
   *  `feedback` inbox lives. The same seam the per-repo debug log uses. */
  stateDir: string;
  /** How this engine is hosted (§2) — `in-process` shares the orchestrator's heap (an OOM is
   *  uncatchable → kills the daemon, §1), `process` runs in a killable forked child. Fixed by the
   *  construction path (host-build in-process vs engine-child fork); surfaced via
   *  `ctx.daemon.isolation` so the semantic-fanout guard (t-679091) refuses only in-process.
   *  Optional, default `in-process` (a stray direct-createEngine test call). */
  isolation?: Isolation;
  /** WHY that isolation (t-754922, decided at spawn in `escalate.ts`) — surfaced so the fan-out
   *  refusal names the one cause that applies; omitted where no decision was made (a consumer then
   *  says so, never guesses). */
  isolationReason?: IsolationReason;
  plugins: readonly Plugin[];
  ops: readonly AnyOpDefinition[];
  clock: Clock;
  /** Per-op cooperative wall-clock budget in ms (§1 never-hang). The engine builds a fresh
   *  `Deadline` off `clock` per op and hands it to the op via `OpContext.deadline`. Generous by
   *  design (the orchestrator passes `daemon.opDeadlineSeconds`, default 120 s) — it must fire on a
   *  runaway whole-repo call, not a legitimately slow one (§1: a 5–60 s answer is fine). Omitted →
   *  unbounded (never expires), so a direct `createEngine` that never wired it keeps its exact
   *  behaviour; a `0` budget is immediately expired — how a test forces the timeout path
   *  deterministically under a frozen manual clock (§16). */
  opDeadlineMs?: number;
  debug: DebugSystemHandle;
  watcher: Watcher;
  /** Row bounds for sql-mode (§2.3/§2.4). Test seam — lowered to avoid 100k-row
   *  fixtures (spec §7.3/§7.4). Defaults: 100_000 / 1_000. */
  sqlBounds?: Partial<SqlBounds>;
  /** SQL evaluator factory (§4). Test seam; defaults to the lazy better-sqlite3 impl. */
  createSqlRunner?: () => ReturnType<typeof createSqliteRunner>;
  /** Text-scanner factory for `find_usages text:true` (§ text-overlay). Test seam;
   *  defaults to the pure-JS scanner. */
  createTextScanner?: () => TextScanner;
  /** Git runner for the freshness path (§3.6). Test seam; defaults to the real `runGit`.
   *  A faulting runner proves the read-time backstop degrades honestly, never crashes. */
  gitRunner?: GitRunner;
}
