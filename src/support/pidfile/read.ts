// Read + validate a daemon pidfile (t-000051). The file is data crossing a boundary — it may be
// stale (a SIGKILLed daemon's leftover), truncated (a crash mid-write, though the atomic write
// makes that rare), or written by another codemaster version — so it is zod-validated on the way in
// (CONTRIBUTING "zod at the edges"). A missing / unreadable / malformed / schema-invalid file is
// NOT an error: it means "no usable kill-target hint", returned as `undefined` so the caller falls
// back to its honest "kill the pid manually" path — never a throw, never a guessed pid.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { JsonValue } from '../../core/json.ts';
import type { PidfileRecord } from './write.ts';

const pidfileSchema = z
  .object({
    pid: z.number().int().positive(),
    socket: z.string().min(1),
    version: z.string(),
    startedAt: z.number(),
  })
  .strict();

/** Read the pidfile at `pidfilePath`. Returns the validated record, or `undefined` when there is
 *  no usable hint (absent / unreadable / corrupt / invalid). Never throws. */
export function readPidfile(pidfilePath: string): PidfileRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(pidfilePath, 'utf8');
  } catch {
    return undefined; // ENOENT (no daemon wrote one) or an unreadable file — no hint.
  }
  let json: JsonValue;
  try {
    json = JSON.parse(raw) as JsonValue;
  } catch {
    return undefined; // truncated / non-JSON — treat as no hint, not a crash.
  }
  const parsed = pidfileSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
