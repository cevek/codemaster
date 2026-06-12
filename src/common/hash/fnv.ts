// FNV-1a 64-bit — the house non-cryptographic hash: fingerprint rollups, short stable
// keys for per-repo directories and socket names. Change *detection* and naming, never
// integrity or security.

const OFFSET_BASIS = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

export function fnv1a64Hex(input: string): string {
  let hash = OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}
