// trap T2 (skeleton seed): high-fan-in function — will be called from ≥6 sites across ≥4
// files. Stub body. Serves: find_usages blast radius, change_signature.
export function formatLabel(text: string, upper = false): string {
  return upper ? text.toUpperCase() : text;
}
