// Shared scaffolding for the CSS co-extract e2e suites (spec-css-coextract / Task J #2): the
// `extract_symbol { css:'copy-safe' }` driver over a `project()` fixture, the full-program cold
// `tsc` oracle, and the dense ambient stubs. One copy so the relative-importer and aliased-importer
// suites can never drift on how a co-extract is run or how its result is shaped.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from './project.ts';

export const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve","jsx":"preserve"}}';
export const SCSS_D =
  "declare module '*.module.scss' { const s: { [k: string]: string }; export default s; }";
export const JSX_D =
  'declare namespace JSX { interface Element {} interface IntrinsicElements { [e: string]: unknown } }';

/** Cold full-program typecheck oracle — independent of the warm daemon LS. */
export function coldTscErrors(root: string): string[] {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (configPath === undefined) return ['no tsconfig'];
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    path.dirname(configPath),
  );
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

export type SpanLike = {
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  text: string;
};

export type Report = {
  sourceStylesheet: string;
  targetStylesheet: string;
  moved: string[];
  leftBehind: { class: string; code: string; span?: SpanLike }[];
};

export type Envelope = {
  mode: string;
  applied?: boolean;
  typecheck: { clean: boolean };
  cssCoExtract?: Report[];
};

/** Independent span oracle (§16 inv.1): the source substring at the span's 1-based,
 *  end-exclusive [line,col]→[endLine,endCol] must equal `span.text`. */
export function spanIsValid(source: string, span: SpanLike): boolean {
  const lines = source.split('\n');
  if (span.endLine !== span.line) return false;
  return (lines[span.line - 1] ?? '').slice(span.col - 1, span.endCol - 1) === span.text;
}

/** Mount `files`, run `extract_symbol` with `apply:true`, and return the envelope + a disk reader. */
export async function run(
  files: Record<string, string>,
  args: JsonValue,
): Promise<{
  env: Envelope;
  root: string;
  read: (rel: string) => string;
  dispose: () => Promise<void>;
}> {
  const p = await project(files);
  const [r] = await p.request([{ name: 'extract_symbol', args, apply: true }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return {
    env: r.result.data as unknown as Envelope,
    root: p.root,
    read: (rel) => readFileSync(path.join(p.root, rel), 'utf8'),
    dispose: () => p.dispose(),
  };
}
