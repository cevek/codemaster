// Load + validate `codemaster.config.{ts,js,cjs,mjs}` (§10). The file is transpiled
// with the TypeScript compiler (module → CommonJS) and evaluated in a `node:vm`
// sandbox whose `require` resolves exactly one specifier — `'codemaster'`, to a local
// `defineConfig` identity — so loading needs neither a build step nor codemaster
// installed in the target repo. The price, stated: config files must be
// self-contained (no relative imports); the loader says so in its error.
//
// No config at all is a valid, working state (defaults honor .gitignore etc.).

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import ts from 'typescript';
import type { Result } from '../../core/result.ts';
import type { CodemasterConfig } from '../../config/config.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { asConfig, configSchema } from './schema.ts';
import { findConfigFile } from './resolve.ts';
import { fingerprintConfigContent, NO_CONFIG_FINGERPRINT } from './fingerprint.ts';

export interface LoadedConfig {
  config: CodemasterConfig;
  /** Absolute path of the file used, or undefined when running on pure defaults. */
  source: string | undefined;
  /** Content fingerprint of the EXACT bytes evaluated here (`'none'` on defaults). The
   *  orchestrator stores this at spawn so a config write that races the spawn is caught
   *  on the next request-entry check — never silently served stale (config-reload). */
  fingerprint: string;
}

export function loadConfig(canonRoot: string): Result<LoadedConfig> {
  const file = findConfigFile(canonRoot);
  if (file === undefined) {
    return ok({ config: {}, source: undefined, fingerprint: NO_CONFIG_FINGERPRINT });
  }

  let source: Buffer;
  try {
    source = readFileSync(file);
  } catch (thrown) {
    return fail({ tool: 'fs', message: `cannot read ${file}: ${describe(thrown)}` });
  }

  const evaluated = evaluateConfigModule(file, source.toString('utf8'));
  if (!evaluated.ok) return fail({ tool: 'config', message: evaluated.message });

  const parsed = configSchema.safeParse(evaluated.value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return fail({ tool: 'config', message: `${path.basename(file)} invalid — ${issues}` });
  }
  return ok({
    config: asConfig(parsed.data),
    source: file,
    fingerprint: fingerprintConfigContent(path.basename(file), source),
  });
}

function evaluateConfigModule(
  file: string,
  sourceText: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const transpiled = ts.transpileModule(sourceText, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: file,
  });

  const moduleShim = { exports: {} as Record<string, unknown> };
  const requireShim = (specifier: string): unknown => {
    if (specifier === 'codemaster') {
      return { defineConfig: (c: unknown) => c };
    }
    throw new Error(
      `codemaster config may only import 'codemaster' — found import of '${specifier}'. ` +
        `Config files must be self-contained.`,
    );
  };

  try {
    const context = vm.createContext({
      module: moduleShim,
      exports: moduleShim.exports,
      require: requireShim,
      console: undefined,
      process: undefined,
    });
    vm.runInContext(transpiled.outputText, context, { filename: file, timeout: 5000 });
  } catch (thrown) {
    return { ok: false, message: `evaluating ${path.basename(file)} failed: ${describe(thrown)}` };
  }

  const exported = moduleShim.exports;
  const value = 'default' in exported ? exported['default'] : exported;
  if (value === undefined || value === null) {
    return { ok: false, message: `${path.basename(file)} has no default export` };
  }
  return { ok: true, value };
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
