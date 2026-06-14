// Ambient stub for the `'codemaster'` specifier so codemaster.config.ts typechecks under
// the fixture's own `tsc` (the real loader resolves it in a vm sandbox; spec §5/§6 gate 1).
declare module 'codemaster' {
  export function defineConfig<T>(config: T): T;
}
