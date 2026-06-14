// trap T11 (.d.ts ambient module declaration / loose-key augmentation): `virtual:config` is
// an AMBIENT module — there is no file behind it. find_usages/move_file must treat it
// honestly: its members are referenced (Showcase.tsx imports `labels`) but it is NOT a
// relocatable file and rename can't retarget a string-keyed loose lookup. Mirrors an i18n
// loose-key signature mined from a real repo.
declare module 'virtual:config' {
  /** loose-key map — any string indexes to a label (the augmentation trap). */
  export const labels: { readonly [key: string]: string };
  export const version: string;
}
