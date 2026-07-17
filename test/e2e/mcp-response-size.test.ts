// The MCP-seam total-size cap, end-to-end (§3.4/§12, t-287999): every response that leaves the
// daemon — driven through the REAL `serveMcp` over an in-memory transport + a genuine `project()`
// orchestrator — MUST stay under the harness output ceiling (above it the harness persists the
// response to a file and the agent sees only a ~2KB preview). This is the CI guard that keeps the
// universal invariant from regressing as ops / notes grow.
//
// Two halves: (1) a per-op × per-mode SWEEP asserting the invariant holds on normal output; (2)
// DISCRIMINATING over-cap cases per path (text: status full on a 36-op repo; bare-json: a huge
// find_usages json; batch: many big sections) — without these the sweep would pass even if the cap
// code were deleted, since nothing on a small fixture exceeds the ceiling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { serveMcp } from '../../src/mcp/server.ts';
import { builtinOps } from '../../src/ops/builtins.ts';
import { opToolExample } from '../../src/mcp/op-tools.ts';
import { HARNESS_CEILING_BYTES, CAP_MARKER } from '../../src/common/truncate/cap-response.ts';
import { project, type TestProject } from '../helpers/project.ts';

process.setMaxListeners(100);

/** The real serialized frame the harness measures. */
function frameBytes(r: CallToolResult): number {
  return Buffer.byteLength(JSON.stringify(r), 'utf8');
}
function textOf(r: CallToolResult): string {
  const f = r.content[0];
  return f !== undefined && f.type === 'text' ? f.text : '';
}

async function wire(p: TestProject): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await serveMcp(p.orchestrator, 'test', { transport: serverT });
  const client = new Client({ name: 'size-test', version: '0' });
  await client.connect(clientT);
  return client;
}

// A repo activating all five built-in plugins → the full 36-op catalogue, so `status {full:true}`
// genuinely overruns the ceiling (the acute t-523883 case) and the sweep covers every op.
const RICH_FILES = {
  'tsconfig.json':
    '{"compilerOptions":{"jsx":"react-jsx","strict":true,"module":"esnext","moduleResolution":"bundler"}}',
  'codemaster.config.ts':
    "import {defineConfig} from 'codemaster';\n" +
    "export default defineConfig({ i18n:{ locales:['locales/*.json'] }, plugins:['react','react-query'] });\n",
  'locales/en.json': '{"greeting":"hi"}',
  'src/a.module.scss': '.x{color:red}',
  'src/App.tsx': 'export const App=()=>null;\n',
};

// Hundreds of exported symbols → a search_symbol result whose bare-JSON render (uncapped by the
// per-op char cap) exceeds the ceiling: the bare-json replacement path.
const BIG_SYMBOLS = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/big.ts':
    Array.from(
      { length: 400 },
      (_, i) => `export function fn${i}(a:number,b:string){ return a+b+${i}; }`,
    ).join('\n') + '\n',
};

// A symbol used hundreds of times → a find_usages result whose bare-JSON render (uncapped by the
// per-op char cap) exceeds the ceiling, exercising the batch text path (many big json sections).
const MANY_USAGES = {
  'tsconfig.json':
    '{"compilerOptions":{"jsx":"react-jsx","strict":true,"module":"esnext","moduleResolution":"bundler"}}',
  'src/Button.tsx': 'export const Button=(p:{s:string})=><button>{p.s}</button>;\n',
  'src/uses.tsx':
    "import {Button} from './Button';\n" +
    Array.from({ length: 600 }, (_, i) => `export const U${i}=()=><Button s="v${i}"/>;`).join(
      '\n',
    ) +
    '\n',
};

test('SWEEP: every op × every mode stays under the harness ceiling', async () => {
  const p = await project(RICH_FILES);
  try {
    const client = await wire(p);
    const modes: Array<{ verbosity?: string; format?: string }> = [
      { verbosity: 'terse' },
      { verbosity: 'normal' },
      { verbosity: 'full' },
      { format: 'json' },
    ];
    // status: terse (default), brief, full, and one op detail.
    for (const args of [{}, { brief: true }, { full: true }, { op: 'find_usages' }]) {
      const r = (await client.callTool({
        name: 'status',
        arguments: { ...args, root: p.root },
      })) as CallToolResult;
      assert.ok(
        frameBytes(r) < HARNESS_CEILING_BYTES,
        `status ${JSON.stringify(args)} under ceiling`,
      );
    }
    // Each op tool with its advertised example (an error response is fine — it, too, must be capped).
    for (const op of builtinOps()) {
      const example = opToolExample(op);
      const baseArgs = (example ?? {}) as Record<string, unknown>;
      for (const mode of modes) {
        const r = (await client.callTool({
          name: op.name,
          arguments: { ...baseArgs, ...mode, root: p.root },
        })) as CallToolResult;
        assert.ok(
          frameBytes(r) < HARNESS_CEILING_BYTES,
          `${op.name} ${JSON.stringify(mode)} = ${frameBytes(r)}B exceeds the ceiling`,
        );
      }
    }
  } finally {
    await p.dispose();
  }
});

test('DISCRIMINATING text path: status {full:true} on a 36-op repo is capped in place', async () => {
  const p = await project(RICH_FILES);
  try {
    const client = await wire(p);
    const r = (await client.callTool({
      name: 'status',
      arguments: { full: true, root: p.root },
    })) as CallToolResult;
    // The uncapped full render is ~66KB (proven at unit level) — the seam must have engaged.
    assert.ok(frameBytes(r) < HARNESS_CEILING_BYTES, 'capped under the real ceiling');
    assert.ok(textOf(r).includes(CAP_MARKER), 'carries the !! OUTPUT CAPPED honesty marker');
    assert.ok(
      textOf(r).startsWith('codemaster v'),
      'verdict-first: the header/frame survives the cut',
    );
  } finally {
    await p.dispose();
  }
});

test('DISCRIMINATING bare-json path: a huge find_usages json is replaced with a valid capped envelope', async () => {
  const p = await project(BIG_SYMBOLS);
  try {
    const client = await wire(p);
    const r = (await client.callTool({
      name: 'search_symbol',
      arguments: { query: 'fn', limit: 400, format: 'json', root: p.root },
    })) as CallToolResult;
    assert.ok(frameBytes(r) < HARNESS_CEILING_BYTES, 'capped under the real ceiling');
    // A bare-JSON payload must stay PARSEABLE (a tail-truncation would corrupt it) — replaced whole.
    const parsed = JSON.parse(textOf(r)) as Record<string, unknown>;
    assert.equal(parsed['error'], 'output_capped', 'replaced with the honest capped envelope');
    assert.equal(typeof parsed['hint'], 'string');
  } finally {
    await p.dispose();
  }
});

test('DISCRIMINATING batch path: capped at WHOLE-section boundaries — survivors are complete', async () => {
  const p = await project(MANY_USAGES);
  try {
    const client = await wire(p);
    // Each section is a find_usages json (~26KB); three of them (~80KB) blow the ceiling, so the
    // aggregate is cut at a whole-section boundary — never mid-section (which would drop a surviving
    // section's honesty tail, the §12 lie the bug-reviewer flagged).
    const req = { name: 'find_usages', args: { name: 'Button' }, format: 'json' };
    const r = (await client.callTool({
      name: 'batch',
      arguments: { requests: [req, req, req], root: p.root },
    })) as CallToolResult;
    const body = textOf(r);
    assert.ok(frameBytes(r) < HARNESS_CEILING_BYTES, 'capped under the real ceiling');
    // The omitted-sections marker is present and states the survivors are complete.
    assert.match(body, /!! OUTPUT CAPPED — \d+ more section\(s\) omitted/, 'section-omit marker');
    assert.match(body, /Sections shown are complete/, 'marker asserts survivor completeness');
    assert.ok(body.startsWith('[0] find_usages'), 'the first section survives');
    // Discriminates boundary-cut from a blind seam chop: the first surviving section is a COMPLETE
    // parseable json object (a mid-section byte-chop would leave it corrupt).
    const firstSection = body.split('\n\n')[0] ?? '';
    const jsonStart = firstSection.indexOf('\n') + 1;
    const parsed = JSON.parse(firstSection.slice(jsonStart)) as Record<string, unknown>;
    assert.equal(parsed['ok'], true, 'the surviving section is complete, valid json');
    // The blind seam CAP_MARKER must NOT appear — the structured aggregator handled it, not the seam.
    assert.ok(!body.includes(CAP_MARKER), 'the structured section cap fired, not the blind seam');
  } finally {
    await p.dispose();
  }
});

test('DISCRIMINATING oversized-json-section: a >budget json section becomes a VALID capped envelope, not corrupt JSON', async () => {
  const p = await project(BIG_SYMBOLS);
  try {
    const client = await wire(p);
    // Two search_symbol json producers, each ~66KB serialized — over a single section's budget. Each
    // must be replaced with a valid capped envelope rather than reaching the flat seam (which would
    // mid-chop the JSON into an unparseable payload).
    const req = { name: 'search_symbol', args: { query: 'fn', limit: 400 }, format: 'json' };
    const r = (await client.callTool({
      name: 'batch',
      arguments: { requests: [req, req], root: p.root },
    })) as CallToolResult;
    const body = textOf(r);
    assert.ok(frameBytes(r) < HARNESS_CEILING_BYTES, 'capped under the real ceiling');
    assert.ok(!body.includes(CAP_MARKER), 'the seam did not blind-chop the json');
    // The first section is a VALID, parseable json — the capped envelope, not a corrupt truncation.
    const firstSection = body.split('\n\n')[0] ?? '';
    const jsonStart = firstSection.indexOf('\n') + 1;
    const parsed = JSON.parse(firstSection.slice(jsonStart)) as Record<string, unknown>;
    assert.equal(
      parsed['error'],
      'output_capped',
      'over-budget json section → valid capped envelope',
    );
  } finally {
    await p.dispose();
  }
});
