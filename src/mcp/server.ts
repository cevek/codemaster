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
          const { root, ...req } = parsed.data;
          const outcome = await orchestrator.request(cwd, root, [req as OpRequest]);
          if (!outcome.ok) return errorText(outcome.message);
          const result = outcome.results[0];
          if (result === undefined) return errorText('no result (codemaster bug)');
          return opResultText(result, req.format, req.verbosity);
        }
        case 'batch': {
          const parsed = batchToolSchema.safeParse(request.params.arguments ?? {});
          if (!parsed.success) return badArgs(parsed.error.message);
          const outcome = await orchestrator.request(
            cwd,
            parsed.data.root,
            parsed.data.requests as OpRequest[],
          );
          if (!outcome.ok) return errorText(outcome.message);
          const blocks = outcome.results.map(
            (r, i) =>
              `[${i}] ${r.name}\n${renderOne(r, parsed.data.requests[i]?.format, parsed.data.requests[i]?.verbosity)}`,
          );
          return text(blocks.join('\n\n'));
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

function text(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }] };
}

function errorText(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function badArgs(message: string): CallToolResult {
  return errorText(`bad args: ${message}`);
}
