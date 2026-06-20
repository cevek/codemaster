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

/** A CLEAN mutating-op typecheck verdict: { clean:true, preExisting? }. Collapses the
 *  `typecheck:` header + lone `clean=true` line (emitted on EVERY mutating call — the common
 *  case) to one token: `clean` / `clean preExisting=N`. The dirty case stays an untagged object
 *  block so its `introduced` ts-diagnostic rows ride beneath. The `clean:true` field is kept in
 *  the data (json strips the tag → the pre-tag `{clean:true,…}` shape), only text collapses. */
export const typecheckClean: ShapeRenderer = (v) => {
  const pre = v['preExisting'];
  return typeof pre === 'number' && pre > 0 ? `clean preExisting=${pre}` : 'clean';
};
