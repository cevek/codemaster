// `list_endpoints` — the generated API surface as endpoint cards (method · path ·
// path-params · query · body · response), so an agent asks "what endpoints exist / what's
// the shape of this request" in one call instead of reading a 1000-line generated file
// (spec §1). The cards are the schema plugin's; each type is a proof-carrying REFERENCE —
// `expand_type` at a card's response/body span resolves its members (the §1 chain). Parse
// failures and unresolved operations are reported, never hidden (§3.6).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import type { EndpointCard, SchemaPluginApi } from '../plugins/schema/plugin.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';

const HTTP_METHODS = ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE'] as const;

const listEndpointsTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'method', type: 'text' },
    { name: 'path', type: 'text' },
    { name: 'path_params', type: 'text' },
    { name: 'query', type: 'text' },
    { name: 'body', type: 'text' },
    { name: 'response', type: 'text' },
    { name: 'status', type: 'int' },
    { name: 'confidence', type: 'text' },
  ],
  rows(data) {
    const cards = (data as { endpoints?: EndpointCard[] }).endpoints ?? [];
    return cards.map((c): readonly Cell[] => [
      c.method,
      c.path,
      c.pathParams.length > 0 ? c.pathParams.join(',') : null,
      c.query?.text ?? null,
      c.body?.text ?? null,
      c.response?.text ?? null,
      c.status ?? null,
      c.confidence,
    ]);
  },
  notes(data) {
    const cards = (data as { endpoints?: EndpointCard[] }).endpoints ?? [];
    return cards
      .filter((c) => c.note !== undefined)
      .map((c) => `${c.method} ${c.path}: ${c.note ?? ''}`);
  },
};

const argsSchema = z.strictObject({
  pathInclude: z.string().optional(),
  method: z.enum(HTTP_METHODS).optional(),
});

export const listEndpointsOp = defineOp({
  name: 'list_endpoints',
  summary: 'Generated API surface as endpoint cards (method · path · params · body · response)',
  mutating: false,
  requires: ['schema'],
  argsSchema,
  argsHint: "{ pathInclude?: string (substring), method?: 'GET'|'POST'|… }",
  example: { args: { pathInclude: '/users' } },
  notes: [
    'each query/body/response is a type REFERENCE (text + proof span); expand_type at the span resolves its members.',
    'a type that cannot be resolved is `unresolved`, listed in notes, never a guessed card.',
    'reads openapi-typescript output only; orval/custom clients are not yet parsed (zero cards, never a guess).',
  ],
  table: listEndpointsTable,
  async run(ctx, args) {
    const schema = ctx.plugins.get<SchemaPluginApi>('schema');
    try {
      const all = schema.endpoints();
      const needle = args.pathInclude?.toLowerCase();
      const endpoints = all.filter(
        (c) =>
          (needle === undefined || c.path.toLowerCase().includes(needle)) &&
          (args.method === undefined || c.method === args.method),
      );
      const failures = [...schema.parseFailures()].map(([file, message]) => ({ file, message }));
      return ok({
        endpoints,
        total: endpoints.length,
        ...(endpoints.length !== all.length ? { filteredFrom: all.length } : {}),
        ...(failures.length > 0 ? { parseFailures: failures } : {}),
      });
    } catch (thrown) {
      return failFromThrown('schema', thrown);
    }
  },
});
