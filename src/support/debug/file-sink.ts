// Rotating, size-capped debug log — the primary surface the building agent greps
// (§13: `~/.codemaster/<repoId>/debug.log`). Rotation is single-step: on crossing the
// cap, `debug.log` → `debug.log.1` (replacing any previous `.1`), then a fresh file.
// Sink failures degrade silently by design: tracing must never take the daemon down
// or leak onto stdout (the agent-facing payload).

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import * as path from 'node:path';

export interface DebugSink {
  write(line: string): void;
  dispose(): void;
}

const DEFAULT_LOG_MAX_BYTES = 16 * 1024 * 1024;

export function createRotatingFileSink(
  logPath: string,
  maxBytes: number = DEFAULT_LOG_MAX_BYTES,
): DebugSink {
  let bytes = currentSize(logPath);
  let broken = false;

  return {
    write(line) {
      if (broken) return;
      const payload = `${line}\n`;
      try {
        if (bytes + payload.length > maxBytes) {
          rotate(logPath);
          bytes = 0;
        }
        if (bytes === 0) mkdirSync(path.dirname(logPath), { recursive: true });
        appendFileSync(logPath, payload, 'utf8');
        bytes += payload.length;
      } catch {
        broken = true; // disk gone / permissions — stop trying, never crash
      }
    },
    dispose() {
      broken = true;
    },
  };
}

function currentSize(logPath: string): number {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

function rotate(logPath: string): void {
  try {
    renameSync(logPath, `${logPath}.1`);
  } catch {
    // Nothing to rotate, or rotation impossible — appending continues either way.
  }
}
