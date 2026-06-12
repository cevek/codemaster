// A zod validator for `JsonValue` — the recursive any-JSON shape. Shared by the MCP
// boundary (op/batch args) and any op that accepts an arbitrary JSON payload (e.g.
// `feedback`'s `example`), so the recursive definition lives in exactly one place.

import { z } from 'zod';
import type { JsonValue } from '../../core/json.ts';

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
