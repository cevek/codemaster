// The host↔engine-child wire protocol (process-mode isolation, §2). Parent (the
// `process`-mode `ProjectHost`) ↔ child (`serveEngineChild`) over `child_process.fork`'s
// built-in IPC (default JSON serialization — the same round-trip the daemon↔bridge socket
// already proves safe for `OpResult[]` / `WorkspaceStatusView`, protocol.ts). Each request
// carries a connection-local `id` so many can be in flight and replies match by id.
//
// Boundary validation (CONTRIBUTING "zod at the edges"): an IPC channel is an outside
// boundary in BOTH directions — the child validates inbound requests, the parent validates
// inbound replies. A corrupt envelope fails honestly (→ an error reply / a settled request),
// never an unchecked cast that throws deep in routing. The envelope SHAPE is the guard; the
// inner `OpResult[]` / `WorkspaceStatusView` / `FreshnessNote` are produced by trusted
// codemaster code and pass through as data (the child folds the exact same version — one repo,
// one source tree — so cross-version can't occur, mirroring the socket path §19).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { FreshnessNote } from '../core/result.ts';
import type { BatchOptions, OpRequest, OpResult } from '../ops/contracts.ts';
import type { WorkspaceStatusView } from '../format/render/render-status.ts';

// ── parent → child ──────────────────────────────────────────────────────────────
export type EngineRequest =
  | { id: number; kind: 'request'; reqs: readonly OpRequest[]; batch?: BatchOptions }
  | { id: number; kind: 'produceSql'; reqs: readonly OpRequest[] }
  | { id: number; kind: 'status' }
  | { id: number; kind: 'dispose' };

// ── child → parent ──────────────────────────────────────────────────────────────
export type EngineReply =
  | { id: number; kind: 'request'; results: readonly OpResult[] }
  | { id: number; kind: 'produceSql'; results: readonly OpResult[]; freshness?: FreshnessNote }
  | { id: number; kind: 'status'; view: WorkspaceStatusView }
  | { id: number; kind: 'dispose' }
  | { id: number; kind: 'error'; message: string };

/** Startup handshake (id-less): the child announces its engine built (`ready`) or failed to
 *  (`fatal`), so `createProcessHost` returns an honest spawn ok/fail instead of racing the
 *  first request against an unbuilt engine. */
export type EngineStartup = { kind: 'ready' } | { kind: 'fatal'; message: string };

const opRequestSchema = z.object({ name: z.string().min(1) }).passthrough();
const batchSchema = z
  .object({ sql: z.string().optional(), return: z.enum(['sql', 'all']).optional() })
  .strict();

const requestSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.number(),
    kind: z.literal('request'),
    reqs: z.array(opRequestSchema),
    batch: batchSchema.optional(),
  }),
  z.object({ id: z.number(), kind: z.literal('produceSql'), reqs: z.array(opRequestSchema) }),
  z.object({ id: z.number(), kind: z.literal('status') }),
  z.object({ id: z.number(), kind: z.literal('dispose') }),
]);

const replySchema = z.discriminatedUnion('kind', [
  z.object({ id: z.number(), kind: z.literal('request'), results: z.array(z.unknown()) }),
  z.object({
    id: z.number(),
    kind: z.literal('produceSql'),
    results: z.array(z.unknown()),
    freshness: z.unknown().optional(),
  }),
  z.object({ id: z.number(), kind: z.literal('status'), view: z.unknown() }),
  z.object({ id: z.number(), kind: z.literal('dispose') }),
  z.object({ id: z.number(), kind: z.literal('error'), message: z.string() }),
]);

const startupSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('fatal'), message: z.string() }),
]);

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validate an inbound request envelope (child side). */
export function parseEngineRequest(raw: JsonValue): Parsed<EngineRequest> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, value: parsed.data as unknown as EngineRequest };
}

/** Validate an inbound reply envelope (parent side). A `ready`/`fatal` startup frame is a
 *  distinct shape; the parent tries it first (it has no `id`), then the reply union. */
export function parseEngineFrame(raw: JsonValue): Parsed<EngineReply | EngineStartup> {
  const startup = startupSchema.safeParse(raw);
  if (startup.success) return { ok: true, value: startup.data as EngineStartup };
  const parsed = replySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, value: parsed.data as unknown as EngineReply };
}
