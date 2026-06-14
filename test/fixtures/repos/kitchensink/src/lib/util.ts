// trap M11 target (dual-spelling import): this same file is imported BOTH with the extension
// (`@/lib/util.ts`, from misc/anchors.ts) AND without it (`@/lib/util`, from
// misc/Showcase.tsx) — both valid under moduleResolution:"bundler" +
// allowImportingTsExtensions. importers_of must resolve both spellings to ONE set; a later
// move_file/rename must rewrite BOTH or leave half dangling. Mined from a real repo (283
// mixed-spelling importers of one module).
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function slug(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '-');
}
