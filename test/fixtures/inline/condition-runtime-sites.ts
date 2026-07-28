// An EXECUTABLE fixture for the condition-chain runtime oracle (t-933867). Every `F(n)` is a
// reference site whose enclosing branch chain `find_usages {conditions:true}` reports; `n` is the
// site id, and the test derives id → line from this file's own text, so the two views cannot drift.
//
// Two rules keep the oracle sound, and a change here must preserve both:
//   1. Every branch condition mentions ONLY the parameters (`x`/`y`/`k`/`o`), never a local — the
//      test evaluates the REPORTED chain text against the same argument values it ran with, so a
//      condition over a local would not be evaluable.
//   2. No site's guard reads state an EARLIER site mutates (hence the separate `w`/`z` props), and
//      there is no early `return`/`throw`, so "empty chain" and "always fired" must coincide.
//   3. No site may sit in an expression that can THROW before reaching it (e.g. `(o.m?.g).call(null,
//      F())` when `o.m` is nullish). `sites()` runs unguarded, so such a site aborts the whole run with
//      a TypeError; the danger is the repair that follows — swallow the throw, and the `⟺` assertion
//      then reads the non-call as a wrong chain, whose "obvious" fix is to invent a guard. Those
//      shapes belong in `condition-cases.ts`, which analyses without executing.

/** Call recorder — `sites()` pushes each site id it actually reaches. */
export const fired: number[] = [];

export const F = (id: number): boolean => {
  fired.push(id);
  return true;
};

export type Bag = {
  v?: boolean;
  w?: boolean;
  z?: boolean;
  f?: (b: boolean) => boolean;
  /** For the MULTI-LINK optional-chain sites: each link is independently absent-able, which is what
   *  makes "nearest link" vs "leftmost link" observable at run time. */
  m?: { g?: (b: boolean) => boolean };
};

export function sites(x: boolean, y: boolean, k: string, o: Bag): void {
  if (x) F(1);
  if (x) {
  } else F(2);
  if (!x) {
  } else F(3);
  if (x) {
    if (y) F(4);
  }
  if (x) {
  } else if (y) F(5);
  const a = x ? F(6) : y;
  const b = x ? y : F(7);
  const c = x && F(8);
  const d = x || F(9);
  const e = o.v ?? F(10);
  o.f?.(F(11));
  o.w ||= F(12);
  o.z &&= F(13);
  switch (k) {
    case 'a':
      F(14);
      break;
  }
  switch (k) {
    case 'a':
    case 'b':
      F(15);
      break;
  }
  while (x) {
    F(16);
    break;
  }
  for (let i = 0; x; ) {
    F(17);
    break;
  }
  F(18);
  o.m?.g?.(F(19));
  o.m?.g?.call(null, F(20));
  void [a, b, c, d, e];
}
