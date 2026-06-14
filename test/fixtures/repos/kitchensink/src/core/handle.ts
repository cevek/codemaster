// trap T4 (same-name collision, source #1 of 3): `handle` is ALSO exported from
// features/forms/handlers.ts and shadowed by a local `handle` in features/forms/Form.tsx.
// Grep can't disambiguate the three; rename_symbol must target exactly one. Stub body.
export function handle(event: string): void {
  void event;
}
