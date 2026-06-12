// zod schema for `CodemasterConfig` — the fail-fast boundary for config files (§10).
// Annotated as `z.ZodType<CodemasterConfig>` so the schema drifting from the typed
// shape in `config/config.ts` is a compile error, not a runtime surprise. `.strict()`
// objects: an unknown key fails with a pointed message, not a deep crash later.

import { z } from 'zod';
import type { CodemasterConfig } from '../../config/config.ts';
import type { JsonValue } from '../../core/json.ts';

const tsSection = z.strictObject({
  include: z.array(z.string()).optional(),
  ignore: z.array(z.string()).optional(),
  packages: z.array(z.string()).optional(),
  tsconfig: z.string().optional(),
});

const i18nSection = z.strictObject({
  locales: z.array(z.string()).min(1, 'i18n.locales needs at least one locale JSON path'),
  functions: z.array(z.string()).optional(),
  templateLiterals: z.boolean().optional(),
});

const scssSection = z.strictObject({
  modules: z.array(z.string()).optional(),
  importStyle: z.enum(['default', 'namespace']).optional(),
});

const schemaSection = z.strictObject({
  entrypoint: z.string(),
  generator: z.enum(['openapi-typescript', 'custom']).optional(),
});

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

const pluginEntry = z.union([
  z.string(),
  z.strictObject({ id: z.string(), options: z.record(z.string(), jsonValue).optional() }),
]);

const outputSection = z.strictObject({
  verbosity: z.enum(['terse', 'normal', 'full']).optional(),
  defaultLimit: z.number().int().positive().optional(),
});

const daemonSection = z.strictObject({
  isolation: z.enum(['in-process', 'process']).optional(),
  idleEvictionMinutes: z.number().positive().optional(),
  pathExistenceSweepSeconds: z.number().positive().optional(),
});

const debugSection = z.strictObject({
  namespaces: z.array(z.string()).optional(),
  logMaxMB: z.number().positive().optional(),
});

export const configSchema = z.strictObject({
  ts: tsSection.optional(),
  i18n: i18nSection.optional(),
  scss: scssSection.optional(),
  schema: schemaSection.optional(),
  plugins: z.array(pluginEntry).optional(),
  output: outputSection.optional(),
  daemon: daemonSection.optional(),
  debug: debugSection.optional(),
});

// Drift guard: if the schema's (top-level) shape and `CodemasterConfig` diverge, this
// line stops compiling. The runtime values match exactly; only zod's `| undefined` on
// optional outputs differs from `exactOptionalPropertyTypes`, which is why the parse
// result is funneled through `asConfig` below instead of a type annotation on the
// schema itself.
type DeepRequired<T> = T extends readonly (infer U)[]
  ? readonly DeepRequired<U>[]
  : T extends object
    ? { [K in keyof T]-?: DeepRequired<Exclude<T[K], undefined>> }
    : T;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const schemaMatchesConfigType: MutuallyAssignable<
  DeepRequired<z.infer<typeof configSchema>>,
  DeepRequired<CodemasterConfig>
> = true;
void schemaMatchesConfigType;

/** Narrow a successful parse to `CodemasterConfig`. Safe because zod never *adds*
 *  undefined-valued keys — absent input keys stay absent — so the only mismatch is
 *  the type-level `| undefined` noted above. */
export function asConfig(parsed: z.infer<typeof configSchema>): CodemasterConfig {
  return parsed as CodemasterConfig;
}
