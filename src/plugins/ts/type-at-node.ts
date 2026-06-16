// The type of the symbol at a node: the DECLARED type for a type/interface/class/enum
// NAME (so a type-only reference surfaces its structure), otherwise the type of the value
// at this location. Shared by `expand_type` (members/constituents) and `construction_sites`
// (the target type whose assignable literals we hunt) so the "what type does this node
// stand for" rule lives in ONE place — a divergence between the two would be an honesty bug
// (§3.1: one parser, one oracle). Robust where a raw `getTypeAtLocation` on a type-only name
// would not surface the declared type (§3.3).

import ts from 'typescript';

export function typeAtNode(checker: ts.TypeChecker, node: ts.Node): ts.Type | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol !== undefined) {
    const typeLike =
      ts.SymbolFlags.Interface |
      ts.SymbolFlags.TypeAlias |
      ts.SymbolFlags.Class |
      ts.SymbolFlags.Enum;
    if ((symbol.flags & typeLike) !== 0) return checker.getDeclaredTypeOfSymbol(symbol);
    return checker.getTypeOfSymbolAtLocation(symbol, node);
  }
  return checker.getTypeAtLocation(node);
}
