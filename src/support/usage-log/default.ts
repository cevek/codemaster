// Default usage-logger wiring for the MCP serve path. On by default, writing to
// `~/.codemaster/usage/{success,fail}.jsonl`; opt out with `CODEMASTER_USAGE_LOG=0`
// (also `off`/`false`/`no`). Override the directory with `CODEMASTER_USAGE_DIR`.

import * as path from 'node:path';
import { createFileUsageLogger, noopUsageLogger } from './create.ts';
import type { UsageLogger } from './entry.ts';
import { promoteOrphanInflight } from './inflight.ts';

const OFF = new Set(['0', 'off', 'false', 'no']);

export function defaultUsageLogger(env: NodeJS.ProcessEnv = process.env): UsageLogger {
  const flag = env['CODEMASTER_USAGE_LOG'];
  if (flag !== undefined && OFF.has(flag.toLowerCase())) return noopUsageLogger;
  const home = env['HOME'] ?? env['USERPROFILE'] ?? '/tmp';
  const dir = env['CODEMASTER_USAGE_DIR'] ?? path.join(home, '.codemaster', 'usage');
  const logger = createFileUsageLogger(dir);
  // Reconcile crash breadcrumbs left by a process that died mid-call (inflight.ts). Done HERE, at
  // the composition root for the serving paths, rather than inside `createFileUsageLogger` — a
  // constructor must stay free of I/O side effects (every unit test builds one).
  promoteOrphanInflight(dir, (entry) => logger.record(entry), Date.now());
  return logger;
}
