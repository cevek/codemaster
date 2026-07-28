// Where a process-mode engine child's stderr goes (§13). NOT the parent's terminal: when the
// child dies of OOM, V8 prints a ~110-line fatal dump, and inheriting the stream sprays it over
// the parent's stderr immediately before the honest `FAIL tool=oom` reaches the client. An agent
// sampling CLI output through `head` then reads only the dump and concludes codemaster crashed —
// the exact INVERSE of what happened (the isolated child died on purpose, the daemon survived,
// the tool answered honestly). Verdict-first (§12) cannot hold against an unmanaged writer.
//
// So the child's stderr is relayed into a `child-stderr.log` beside the repo's `debug.log` — the
// directory §13 already names as the place to grep — where the dump is kept, not discarded. Its own
// FILE, because a rotating sink counts bytes in memory: two processes appending to one path rotate
// against each other and each rename destroys the other's `.1`. The relay is line-oriented (stderr
// arrives in arbitrary chunks; a raw chunk written to a line sink interleaves into mush), byte-
// per-line capped with an explicit marker (§3.4: never a silent cut) and NEVER muted for the rest of
// the session — a lifetime budget would drop the dump it exists for. The stream is never paused:
// a full pipe would block the child, trading noise for a hang (§1 ranks that worst).

import type { Readable } from 'node:stream';
import type { DebugSink } from '../support/debug/file-sink.ts';

/** Longest single line relayed verbatim; past it the line is cut with an explicit marker. This is a
 *  PER-LINE bound, deliberately not a per-child total: a lifetime budget mutes the relay for the
 *  rest of the session once a chatty debug run exhausts it, and the very next thing worth keeping —
 *  the fatal dump — would then be dropped with the stream no longer inherited either, i.e. lost
 *  outright. Volume is bounded where volume belongs: the rotating sink's own size cap. */
const RELAY_MAX_LINE = 64 * 1024;

/** Pipe `stderr` into `sink`, one line per write, prefixed so the origin is greppable
 *  (`engine-child:stderr pid=…`). Best-effort by contract: a sink failure or a stream error must
 *  never touch the request path, so everything here is swallowed. */
export function relayChildStderr(
  stderr: Readable | null,
  sink: DebugSink,
  pid: () => number | undefined,
  maxLine: number = RELAY_MAX_LINE,
): void {
  if (stderr === null) return;
  let pending = '';
  const emit = (line: string): void => {
    if (line === '') return;
    const cut = line.length > maxLine;
    const body = cut ? `${line.slice(0, maxLine)} !! line truncated at ${maxLine} chars` : line;
    write(`engine-child:stderr pid=${pid() ?? '?'} ${body}`);
  };
  const write = (line: string): void => {
    try {
      sink.write(line);
    } catch {
      /* the sink already degrades silently; tracing never takes the daemon down */
    }
  };
  stderr.setEncoding('utf8');
  stderr.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? ''; // the trailing partial line waits for its newline
    for (const line of lines) emit(line.replace(/\r$/, ''));
    // A single unterminated monster line must not grow the buffer without bound: emit what we have
    // (marked as cut) and keep going — the stream is never paused, so the child can never block.
    if (pending.length > maxLine) {
      emit(pending);
      pending = '';
    }
  });
  // Flush whatever arrived without a final newline — a fatal dump's last line is exactly that.
  // Disposal rides the STREAM's end, never the child's `exit` event: a dying child's last bytes are
  // still in the pipe when `exit` fires, and disposing there would drop the dump we came for. One
  // sink per fork, released when its stream is done, so a crash/respawn loop cannot accumulate them.
  const flush = (): void => {
    if (pending !== '') emit(pending);
    pending = '';
    sink.dispose();
  };
  stderr.on('end', flush);
  stderr.on('close', flush);
  stderr.on('error', flush); // a broken pipe still leaves what we already read
}
