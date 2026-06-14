// trap T13 (`const enum` with cross-file member refs): const-enum members are INLINED at
// each use (no runtime object) — find_usages / rename / expand_type must follow member refs
// through inlining, not assume a runtime enum object. Members are referenced from ≥2 files
// (forms/, dashboard/). Mirrors generated const-enum files mined from a real monorepo.
export const enum Code {
  Ok = 0,
  Retry = 1,
  Fatal = 2,
}
