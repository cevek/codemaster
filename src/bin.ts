#!/usr/bin/env node
// codemaster — CLI / process entry (composition root). Wires clock + debug + watcher
// + built-in plugins/ops into an orchestrator, then serves MCP over stdio
// (`codemaster mcp`) or answers one-shot CLI queries (`status`, `op`).
//
// stdout carries ONLY the agent-facing payload; all tracing goes to stderr/file via
// the debug subsystem (§13).

import process from 'node:process';
import type { CodemasterConfig } from './config/config.ts';
import type { Plugin } from './core/plugin.ts';
import { systemClock } from './common/async/clock.ts';
import { createDebugSystem } from './support/debug/system.ts';
import { createStderrSink } from './support/debug/stderr-sink.ts';
import { createChokidarWatcher } from './support/watch/chokidar.ts';
import { Orchestrator } from './daemon/orchestrator.ts';
import { createTsPlugin } from './plugins/ts/plugin.ts';
import { createScssPlugin } from './plugins/scss/plugin.ts';
import type { AnyOpDefinition } from './ops/registry.ts';
import { searchSymbolOp } from './ops/search-symbol.ts';
import { findDefinitionOp } from './ops/find-definition.ts';
import { findUsagesOp } from './ops/find-usages.ts';
import { expandTypeOp } from './ops/expand-type.ts';
import { scssClassesOp } from './ops/scss-classes.ts';
import { importersOfOp } from './ops/importers-of.ts';
import { findUnusedScssClassesOp } from './ops/find-unused-scss-classes.ts';
import { renderResult } from './format/render/render-result.ts';
import { renderStatus } from './format/render/render-status.ts';
import { serveMcp } from './mcp/server.ts';

const VERSION = '0.1.0';

function builtinPlugins(config: CodemasterConfig, root: string): readonly Plugin[] {
  return [createTsPlugin(root, config.ts?.tsconfig), createScssPlugin(root)];
}

function builtinOps(): readonly AnyOpDefinition[] {
  return [
    searchSymbolOp,
    findDefinitionOp,
    findUsagesOp,
    expandTypeOp,
    importersOfOp,
    scssClassesOp,
    findUnusedScssClassesOp,
  ];
}

function buildOrchestrator(): Orchestrator {
  const debug = createDebugSystem(systemClock, process.env['CODEMASTER_DEBUG'] ?? '');
  if (process.env['CODEMASTER_DEBUG'] !== undefined) debug.addSink(createStderrSink());
  return new Orchestrator({
    clock: systemClock,
    debug,
    watcher: createChokidarWatcher(systemClock),
    version: VERSION,
    pluginsFor: builtinPlugins,
    opsFor: () => builtinOps(),
  });
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  args.splice(idx, 2);
  return value;
}

async function main(): Promise<number> {
  // §3.6: a stray rejection must never take the front door down.
  process.on('uncaughtException', (err) => process.stderr.write(`codemaster: ${err.message}\n`));
  process.on('unhandledRejection', (err) =>
    process.stderr.write(`codemaster: unhandled rejection: ${String(err)}\n`),
  );

  const args = process.argv.slice(2);
  const command = args.shift();
  const root = argValue(args, '--root');

  switch (command) {
    case 'mcp': {
      const orchestrator = buildOrchestrator();
      await serveMcp(orchestrator, VERSION);
      return -1; // stays alive serving stdio
    }
    case 'status': {
      const orchestrator = buildOrchestrator();
      const view = await orchestrator.status(process.cwd(), root);
      out(renderStatus(view));
      await orchestrator.dispose();
      return 0;
    }
    case 'op': {
      const name = args.shift();
      if (name === undefined) {
        process.stderr.write('usage: codemaster op <name> [json-args] [--root <dir>]\n');
        return 2;
      }
      let opArgs: unknown = {};
      const rawArgs = args.find((a) => !a.startsWith('--'));
      if (rawArgs !== undefined) {
        try {
          opArgs = JSON.parse(rawArgs);
        } catch {
          process.stderr.write(`args is not valid JSON: ${rawArgs}\n`);
          return 2;
        }
      }
      const orchestrator = buildOrchestrator();
      const outcome = await orchestrator.request(process.cwd(), root, [
        { name, args: opArgs as never },
      ]);
      if (!outcome.ok) {
        process.stderr.write(`${outcome.message}\n`);
        await orchestrator.dispose();
        return 1;
      }
      for (const r of outcome.results) {
        if ('error' in r) out(`DISPATCH ${r.error.kind}: ${r.error.message}`);
        else out(renderResult(r.result));
      }
      await orchestrator.dispose();
      return 0;
    }
    case undefined:
    default:
      process.stderr.write(
        `codemaster v${VERSION}\nusage:\n  codemaster mcp            serve MCP over stdio\n  codemaster status [--root <dir>]\n  codemaster op <name> [json-args] [--root <dir>]\n`,
      );
      return command === undefined || command === 'help' ? 0 : 2;
  }
}

main().then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`codemaster: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
