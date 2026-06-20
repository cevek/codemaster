// Cross-domain diagnostic rows: a TS typecheck diagnostic (mutating-op `typecheck.introduced`)
// and a parser parse-failure (scss/i18n `parseFailures`). Both flatten a multi-line message to
// one line — a newline would split it into unanchored orphan lines.

import type { ShapeRenderer } from './types.ts';
import { flat } from './helpers.ts';

/** TsDiagnostic: { file, line, message }. `file:line` is clickable; message flattened. */
export const tsDiagnostic: ShapeRenderer = (v) =>
  `${String(v['file'])}:${String(v['line'])} · ${flat(v['message'])}`;

/** ParseFailure (scss/i18n): { file, message }. */
export const parseFailure: ShapeRenderer = (v) => `${String(v['file'])} · ${flat(v['message'])}`;
