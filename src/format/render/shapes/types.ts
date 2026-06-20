// The render-dispatch contract: a `ShapeRenderer` turns one tagged row into its dense
// representation. condense.ts has already recursed into the row's children (bottom-up), so
// nested spans arrive as condensed `file:line:col` strings (terse/normal) — or as verbatim
// span objects at `full` — and nested tagged rows arrive already collapsed. The renderer
// returns a string (the common one-liner) or a structured value (a row with a real nested
// hierarchy, e.g. a react-query edge keeping its `affects` child as a list).

import type { JsonValue } from '../../../core/json.ts';
import type { Verbosity } from '../../../core/result.ts';

export type ShapeRenderer = (row: Record<string, JsonValue>, verbosity: Verbosity) => JsonValue;
