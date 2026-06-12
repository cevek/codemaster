// stderr sink for CLI runs (§13). Never stdout — stdout is the agent-facing payload;
// mixing corrupts MCP framing.

import type { DebugSink } from './file-sink.ts';

export function createStderrSink(): DebugSink {
  return {
    write(line) {
      process.stderr.write(`${line}\n`);
    },
    dispose() {
      // stderr has no resources to release
    },
  };
}
