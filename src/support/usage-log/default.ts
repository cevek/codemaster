// Default usage-logger wiring for the MCP serve path. On by default, writing to
// `~/.codemaster/usage/{success,fail}.jsonl`; opt out with `CODEMASTER_USAGE_LOG=0`
// (also `off`/`false`/`no`). Override the directory with `CODEMASTER_USAGE_DIR`.

import * as path from 'node:path';
import { createFileUsageLogger, noopUsageLogger } from './create.ts';
import type { UsageLogger } from './entry.ts';

const OFF = new Set(['0', 'off', 'false', 'no']);

export function defaultUsageLogger(env: NodeJS.ProcessEnv = process.env): UsageLogger {
  const flag = env['CODEMASTER_USAGE_LOG'];
  if (flag !== undefined && OFF.has(flag.toLowerCase())) return noopUsageLogger;
  const home = env['HOME'] ?? env['USERPROFILE'] ?? '/tmp';
  const dir = env['CODEMASTER_USAGE_DIR'] ?? path.join(home, '.codemaster', 'usage');
  return createFileUsageLogger(dir);
}
