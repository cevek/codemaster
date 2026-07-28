// Default usage-logger wiring for BOTH serving paths — `mcp` (the agent-facing process, which owns
// call accounting) and `daemon serve` (which stamps only its own in-flight crash breadcrumbs). On by default, writing to
// `~/.codemaster/usage/{success,fail}.jsonl`; opt out with `CODEMASTER_USAGE_LOG=0`
// (also `off`/`false`/`no`). Override the directory with `CODEMASTER_USAGE_DIR`.

import * as path from 'node:path';
import { createFileUsageLogger, noopUsageLogger } from './create.ts';
import type { UsageLogger } from './entry.ts';
import { promoteOrphanInflight } from './inflight.ts';

const OFF = new Set(['0', 'off', 'false', 'no']);

export function defaultUsageLogger(
  env: NodeJS.ProcessEnv = process.env,
  /** Clock seam (§16): the promotion pass needs "now" to age out abandoned breadcrumbs. */
  now: () => number = Date.now,
): UsageLogger {
  const flag = env['CODEMASTER_USAGE_LOG'];
  if (flag !== undefined && OFF.has(flag.toLowerCase())) return noopUsageLogger;
  const home = env['HOME'] ?? env['USERPROFILE'] ?? '/tmp';
  const dir = env['CODEMASTER_USAGE_DIR'] ?? path.join(home, '.codemaster', 'usage');
  const logger = createFileUsageLogger(dir);
  // Reconcile crash breadcrumbs left by a process that died mid-call (inflight.ts). Done HERE, at
  // the composition root for the serving paths, rather than inside `createFileUsageLogger` — a
  // constructor must stay free of I/O side effects (every unit test builds one).
  const at = now();
  const { deferred } = promoteOrphanInflight(dir, (entry) => logger.record(entry), at);
  // §3.4: a capped pass must not read as a complete one. The deferral is disclosed in the same log
  // the fatals land in, so a reader counting crashes sees that more are still pending.
  if (deferred > 0) {
    logger.record({
      ts: at,
      durationMs: null,
      tool: 'usage-log-promotion',
      ops: [],
      ok: false,
      cwd: dir,
      args: null,
      response: `!! ${deferred} in-flight breadcrumb(s) not examined this start (per-start cap) — they stay on disk and are promoted by a later start; the crash records above are a LOWER BOUND`,
      isError: false,
    });
  }
  return logger;
}
