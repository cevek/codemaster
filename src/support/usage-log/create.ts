// File-backed usage logger: appends each record as one JSON line, routed by `ok` to
// `success.jsonl` or `fail.jsonl` under `dir`. Both files rotate at the size cap (reusing
// the debug sink's single-step rotate) so telemetry never grows unbounded. Write failures
// degrade silently — telemetry must never take the daemon down or touch the request path.

import * as path from 'node:path';
import { createRotatingFileSink } from '../debug/file-sink.ts';
import type { UsageLogEntry, UsageLogger } from './entry.ts';

/** 64 MB per file before a single-step rotate to `<name>.1`. */
const DEFAULT_USAGE_MAX_BYTES = 64 * 1024 * 1024;

export function createFileUsageLogger(
  dir: string,
  maxBytes: number = DEFAULT_USAGE_MAX_BYTES,
): UsageLogger {
  const success = createRotatingFileSink(path.join(dir, 'success.jsonl'), maxBytes);
  const fail = createRotatingFileSink(path.join(dir, 'fail.jsonl'), maxBytes);
  return {
    record(entry: UsageLogEntry) {
      // JSON.stringify can throw on a circular/oversized value; the args/response we pass are
      // already plain JSON, but guard anyway — a telemetry serialize error must not surface.
      let line: string;
      try {
        line = JSON.stringify(entry);
      } catch {
        return;
      }
      (entry.ok ? success : fail).write(line);
    },
    dispose() {
      success.dispose();
      fail.dispose();
    },
  };
}

/** Telemetry-disabled logger — records nothing. Returned when usage logging is opted out. */
export const noopUsageLogger: UsageLogger = {
  record() {
    /* disabled */
  },
  dispose() {
    /* nothing to release */
  },
};
