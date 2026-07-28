// Which `codemaster <x>` names are NOT ops (t-141874). A CLI ROUTING fact: `batch` and `status`
// exist and are documented — they are simply dispatched on their own rather than through `op`, so
// answering "unknown op 'batch'" with the op catalogue is true about this route and FALSE about the
// tool, which is the §3.6 shape the project polices everywhere else.
//
// The message answers "why did this not work here" by naming the form that does. It does not
// recommend a surface: an agent whose MCP connection is healthy has no reason to be told about the
// CLI, and one already on the CLI only needs the spelling.

/** The non-op surfaces an agent reaches for as `codemaster op <x>` (t-141874). `batch` and `status`
 *  are not unknown — they exist, they are just not dispatched through `op`, and answering "unknown
 *  op 'batch'" is true about this route and FALSE about the tool (§3.6). Names the form that works
 *  here; it does not recommend a surface. */
const NON_OP_SURFACES: Readonly<Record<string, string>> = {
  batch:
    "'batch' is not an op — it is a composition surface, dispatched on its own. Here: " +
    "codemaster batch '<json-requests>' [--sql '<SELECT>']; a single op composes with " +
    "codemaster op <name> '<json-args>' --sql '<SELECT>'.",
  status:
    "'status' is not an op — it is the per-repo manifest. Here: codemaster status [--op <name>].",
};

/** `Object.hasOwn`, not a bare index: a plain object literal carries `Object.prototype`, so
 *  `NON_OP_SURFACES['constructor']` returns a FUNCTION that passes an `!== undefined` guard —
 *  `codemaster op constructor` would answer `function Object() { [native code] }` instead of the
 *  honest `unknown_op` + catalogue. That inverts the very §3.6 fix this map exists for: a name that
 *  genuinely is not an op must reach the dispatcher's own rejection. */
export function nonOpSurfaceMessage(name: string): string | undefined {
  return Object.hasOwn(NON_OP_SURFACES, name) ? NON_OP_SURFACES[name] : undefined;
}
