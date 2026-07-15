// Shared fixture + result narrowers for the liberal-intake tests (§7 Postel). The intake suite
// is split across files (300-line cap); these helpers live once here so both halves address the
// same fixture and read results identically (the canonical-form call is the oracle, not a golden).

import assert from 'node:assert/strict';
import type { OpResult } from '../../src/ops/contracts.ts';

export const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}',
  'src/util.ts':
    'export function getInitials(name: string) { return name[0] ?? ""; }\n' +
    'export const self = getInitials("x");\n',
  'src/consumer.ts': "import { getInitials } from './util';\nexport const a = getInitials('y');\n",
  'src/Button.tsx':
    'export interface Props { size: string }\n' +
    'export const Button = (p: Props) => <button>{p.size}</button>;\n',
  'src/App.tsx':
    'import { Button } from \'./Button\';\nexport const App = () => <Button size="lg" />;\n',
};

export function okResult(r: OpResult): { data: unknown; intake: readonly string[] } {
  assert.ok('result' in r && r.result.ok, `expected success, got ${JSON.stringify(r)}`);
  return { data: r.result.data, intake: r.result.intake ?? [] };
}

export const dataJson = (r: OpResult): string => JSON.stringify(okResult(r).data);

export function badArgs(r: OpResult): string {
  assert.ok(
    'error' in r && r.error.kind === 'bad_args',
    `expected bad_args, got ${JSON.stringify(r)}`,
  );
  return r.error.message;
}

/** Parse `{file,line,col}` out of a `ts:Name@path:line:col` SymbolId (robust, no col-guessing). */
export function posOf(id: string): { file: string; line: number; col: number } {
  const m = /@(.+):(\d+):(\d+)(?:~|$)/.exec(id);
  assert.ok(m !== null, `not a ts SymbolId: ${id}`);
  return { file: m[1] ?? '', line: Number(m[2]), col: Number(m[3]) };
}

export function defId(r: OpResult): string {
  const id = (okResult(r).data as { definition?: { id?: string } }).definition?.id;
  assert.ok(
    typeof id === 'string' && id.startsWith('ts:'),
    `expected a ts: SymbolId, got ${String(id)}`,
  );
  return id;
}
