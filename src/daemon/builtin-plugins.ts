// The built-in plugin set (§5-L2), factored out of the composition root so BOTH the in-process
// orchestrator (bin.ts) and the `process`-mode engine child (`serveEngineChild`) construct the
// SAME plugins from config — the two isolation modes must be behavior-identical (the parity
// contract). Importable without side effects (bin.ts runs `main()` on import, so it can't be the
// home for a shared builder).

import type { CodemasterConfig } from '../config/config.ts';
import type { Plugin } from '../core/plugin.ts';
import { createTsPlugin } from '../plugins/ts/plugin.ts';
import { createScssPlugin } from '../plugins/scss/plugin.ts';
import { createI18nPlugin } from '../plugins/i18n/plugin.ts';
import { createSchemaPlugin } from '../plugins/schema/plugin.ts';
import { frameworkPlugins } from './framework-plugins.ts';

export function builtinPlugins(config: CodemasterConfig, root: string): readonly Plugin[] {
  // The i18n + schema plugins are config-gated (no autodetection v1): enabled iff their config
  // section is present. The gate lives HERE in pluginsFor, never in opsFor — the ops register
  // unconditionally and are gated by plugin presence via `requires` (§ spec-i18n/schema-plugin).
  return [
    createTsPlugin(root, config.ts?.tsconfig, {
      searchWarmMaxFiles: config.ts?.searchWarmMaxFiles,
    }),
    createScssPlugin(root),
    ...(config.i18n !== undefined
      ? [
          createI18nPlugin(root, config.i18n.locales, config.i18n.functions, {
            module: config.i18n.module,
            hook: config.i18n.hook,
          }),
        ]
      : []),
    // Only the `openapi-typescript` shape is parsed; `generator: 'custom'` (orval etc.) is a stated
    // follow-up, so don't load a parser that can't read it — keep `list_endpoints` out of the
    // catalogue honestly rather than offer an op that yields zero cards.
    ...(config.schema !== undefined && config.schema.generator !== 'custom'
      ? [createSchemaPlugin(root, [config.schema.entrypoint])]
      : []),
    ...frameworkPlugins(config, root),
  ];
}
