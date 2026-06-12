// The MCP facade (§11): exactly three tools — op / status / batch — over stdio.
// Low-level SDK API (tools/list + tools/call handlers) with handwritten JSON Schemas;
// arguments are re-validated with our own zod boundary (schema.ts). Usage guidance
// ships in the initialize response (`instructions`), not in a CLAUDE.md bolt-on.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { Orchestrator } from '../daemon/orchestrator.ts';
import type { OpRequest, OpResult } from '../ops/contracts.ts';
import { renderResult } from '../format/render/render-result.ts';
import { renderStatus } from '../format/render/render-status.ts';
import {
  SERVER_INSTRUCTIONS,
  TOOL_DESCRIPTORS,
  batchToolSchema,
  opToolSchema,
  statusToolSchema,
} from './schema.ts';

export async function serveMcp(orchestrator: Orchestrator, version: string): Promise<void> {
  const server = new Server(
    { name: 'codemaster', version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  // The MCP client owns our lifetime: when it closes stdin (session over), dispose
  // engines (watchers would otherwise keep the event loop alive — a zombie per
  // session) and exit.
  const shutdown = (): void => {
    void orchestrator
      .dispose()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  server.onclose = shutdown;
  process.stdin.on('end', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DESCRIPTORS.map((t) => ({ ...t })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const cwd = process.cwd();
    try {
      switch (request.params.name) {
        case 'status': {
          const parsed = statusToolSchema.safeParse(request.params.arguments ?? {});
          if (!parsed.success) return badArgs(parsed.error.message);
          const view = await orchestrator.status(cwd, parsed.data.root);
          return text(renderStatus(view));
        }
        case 'op': {
          const parsed = opToolSchema.safeParse(request.params.arguments ?? {});
          if (!parsed.success) return badArgs(parsed.error.message);
          const { root, sql, return: returnMode, ...req } = parsed.data;
          if (sql !== undefined) {
            // §2.6: single-op sql sugar = a batch of one request aliased `t`.
            const outcome = await orchestrator.request(
              cwd,
              root,
              [{ ...(req as OpRequest), as: 't' }],
              { sql, ...(returnMode !== undefined ? { return: returnMode } : {}) },
            );
            if (!outcome.ok) return errorText(outcome.message);
            return text(renderResults(outcome.results, req.format, req.verbosity));
          }
          const outcome = await orchestrator.request(cwd, root, [req as OpRequest]);
          if (!outcome.ok) return errorText(outcome.message);
          const result = outcome.results[0];
          if (result === undefined) return errorText('no result (codemaster bug)');
          return opResultText(result, req.format, req.verbosity);
        }
        case 'batch': {
          const parsed = batchToolSchema.safeParse(request.params.arguments ?? {});
          if (!parsed.success) return badArgs(parsed.error.message);
          const { sql, return: returnMode, format, verbosity } = parsed.data;
          const outcome = await orchestrator.request(
            cwd,
            parsed.data.root,
            parsed.data.requests as OpRequest[],
            sql !== undefined
              ? { sql, ...(returnMode !== undefined ? { return: returnMode } : {}) }
              : undefined,
          );
          if (!outcome.ok) return errorText(outcome.message);
          return text(
            renderBatch(outcome.results, parsed.data.requests, {
              sqlPresent: sql !== undefined,
              format,
              verbosity,
            }),
          );
        }
        default:
          return errorText(`unknown tool '${request.params.name}' (tools: op, status, batch)`);
      }
    } catch (thrown) {
      // §3.6 applied to ourselves: never an escaped exception, the daemon stays up.
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      return errorText(`codemaster internal error: ${message} (daemon still up; please report)`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function opResultText(
  result: OpResult,
  format: 'text' | 'json' | undefined,
  verbosity: 'terse' | 'normal' | 'full' | undefined,
): CallToolResult {
  if ('error' in result) {
    return errorText(`${result.error.kind}: ${result.error.message}`);
  }
  return text(renderOne(result, format, verbosity));
}

function renderOne(
  result: OpResult,
  format: 'text' | 'json' | undefined,
  verbosity: 'terse' | 'normal' | 'full' | undefined,
): string {
  if ('error' in result) return `DISPATCH ${result.error.kind}: ${result.error.message}`;
  if (format === 'json') return JSON.stringify(result.result);
  return renderResult(result.result, verbosity ?? 'terse');
}

/** Render one-or-more op results (the op-sql sugar yields 1 with return:'sql', or N+1
 *  with return:'all'). A single result renders bare; several get `[i] name` headers. */
function renderResults(
  results: readonly OpResult[],
  format: 'text' | 'json' | undefined,
  verbosity: 'terse' | 'normal' | 'full' | undefined,
): string {
  if (results.length === 1 && results[0] !== undefined) {
    return renderOne(results[0], format, verbosity);
  }
  return results.map((r, i) => `[${i}] ${r.name}\n${renderOne(r, format, verbosity)}`).join('\n\n');
}

type ReqFlags = {
  format?: 'text' | 'json' | undefined;
  verbosity?: 'terse' | 'normal' | 'full' | undefined;
};
type BatchFlags = { sqlPresent: boolean } & ReqFlags;

/** Render a batch's ordered results. The synthetic `sql` result (the join output) renders
 *  with the BATCH-level `format`/`verbosity` — the per-request flags belong to the
 *  producers, not the join (review fix #2). Exported so the flag routing is unit-tested. */
export function renderBatch(
  results: readonly OpResult[],
  requests: readonly ReqFlags[],
  batch: BatchFlags,
): string {
  return results
    .map((r, i) => {
      const isSqlResult = batch.sqlPresent && r.name === 'sql';
      const format = isSqlResult ? batch.format : requests[i]?.format;
      const verbosity = isSqlResult ? batch.verbosity : requests[i]?.verbosity;
      return `[${i}] ${r.name}\n${renderOne(r, format, verbosity)}`;
    })
    .join('\n\n');
}

function text(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }] };
}

function errorText(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function badArgs(message: string): CallToolResult {
  return errorText(`bad args: ${message}`);
}
