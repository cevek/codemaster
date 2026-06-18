// Newline-delimited JSON framing (ARCHITECTURE.md §18). A TCP/unix socket is a byte stream with
// no message boundaries, so we frame each message as one `JSON.stringify(...) + '\n'` line and
// split inbound bytes on '\n'. `JSON.stringify` escapes any newline inside a string, so the only
// raw '\n' is the frame terminator — splitting is unambiguous.
//
// Pure: no I/O, no sockets. The unix-socket impl feeds it raw chunks and forwards decoded values.

import type { JsonValue } from '../../core/json.ts';

/** Encode one message as a single NDJSON line (terminator included). */
export function encodeLine(message: JsonValue): string {
  return `${JSON.stringify(message)}\n`;
}

export interface LineDecoder {
  /** Feed a raw chunk; returns the messages completed by it (zero or more). A trailing partial
   *  line is buffered until its terminator arrives. An undecodable line throws `SyntaxError` with
   *  the offending text — the caller reports it via `onError` and keeps the link alive. */
  push(chunk: string): JsonValue[];
}

/** A stateful line decoder: accumulates bytes across chunks and yields whole-line JSON values.
 *  One instance per connection (it holds that link's partial-line buffer). */
export function createLineDecoder(): LineDecoder {
  let buffer = '';
  return {
    push(chunk: string): JsonValue[] {
      buffer += chunk;
      const messages: JsonValue[] = [];
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        // Tolerate blank keep-alive lines (some peers send them); never parse '' as JSON.
        if (line.trim() !== '') {
          messages.push(JSON.parse(line) as JsonValue);
        }
        newlineIndex = buffer.indexOf('\n');
      }
      return messages;
    },
  };
}
