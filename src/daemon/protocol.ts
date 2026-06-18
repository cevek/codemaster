// The daemon↔bridge wire protocol (spec-daemon-singleton §2/§18). Newline-delimited JSON
// envelopes carried by the `Transport` seam. Each request carries a connection-local `id` so
// many requests can be in flight on one connection and replies match by id.
//
// Boundary validation (CONTRIBUTING "zod at the edges"): a socket is an outside boundary in BOTH
// directions — the daemon validates inbound requests, the bridge validates inbound replies. A
// corrupt or truncated envelope fails honestly (a parse failure → an error reply / a ToolFailure),
// never an unchecked cast that throws deep in routing. The envelope SHAPE is the guard; the inner
// `OpResult[]` / `StatusView` are produced by trusted codemaster code and pass through as data
// (cross-version cannot occur — the socket path folds the daemon version, §19).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { BatchOptions, OpRequest, OpResult } from '../ops/contracts.ts';
import type { StatusView } from '../format/render/render-status.ts';

interface RequestEnvelope {
  id: number;
  kind: 'request';
  cwd: string;
  root?: string;
  reqs: readonly OpRequest[];
  batch?: BatchOptions;
}
interface StatusEnvelope {
  id: number;
  kind: 'status';
  cwd: string;
  root?: string;
}
export type WireRequest = RequestEnvelope | StatusEnvelope;

type RequestOutcome = { ok: true; results: readonly OpResult[] } | { ok: false; message: string };

export type WireReply =
  | { id: number; kind: 'request'; sourceStale: boolean; outcome: RequestOutcome }
  | { id: number; kind: 'status'; sourceStale: boolean; view: StatusView }
  | { id: number; kind: 'error'; message: string };

const batchSchema = z
  .object({ sql: z.string().optional(), return: z.enum(['sql', 'all']).optional() })
  .strict();

// Per-op args are validated downstream by each op's own zod schema (DispatchError bad_args), so the
// envelope only asserts the routing shape: a non-empty op name + an args payload present.
const opRequestSchema = z.object({ name: z.string().min(1) }).passthrough();

const requestSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.number(),
    kind: z.literal('request'),
    cwd: z.string(),
    root: z.string().optional(),
    reqs: z.array(opRequestSchema),
    batch: batchSchema.optional(),
  }),
  z.object({
    id: z.number(),
    kind: z.literal('status'),
    cwd: z.string(),
    root: z.string().optional(),
  }),
]);

const replySchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.number(),
    kind: z.literal('request'),
    sourceStale: z.boolean(),
    outcome: z.union([
      z.object({ ok: z.literal(true), results: z.array(z.unknown()) }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  }),
  z.object({
    id: z.number(),
    kind: z.literal('status'),
    sourceStale: z.boolean(),
    view: z.unknown(),
  }),
  z.object({ id: z.number(), kind: z.literal('error'), message: z.string() }),
]);

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validate an inbound request envelope (daemon side). */
export function parseWireRequest(raw: JsonValue): Parsed<WireRequest> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  // Inner op args are validated per-op downstream; the cast crosses only the trusted shape gap.
  return { ok: true, value: parsed.data as unknown as WireRequest };
}

/** Validate an inbound reply envelope (bridge side). A corrupt/truncated reply fails honestly
 *  (→ the request's failure channel), never an unchecked cast that throws deep in the bridge. */
export function parseWireReply(raw: JsonValue): Parsed<WireReply> {
  const parsed = replySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, value: parsed.data as unknown as WireReply };
}
