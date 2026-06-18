// The slice of the ts plugin's `callArgShapes` contract this plugin consumes (§5-L2 / §4). We
// reach the seam's value types through the PUBLIC method signature (`ReturnType<…>`), never by
// importing the ts plugin's internal `call-scan-shared.ts` — the same idiom the i18n plugin uses
// for `literalCalls`. A field rename on the seam then breaks compilation here (the contract is
// enforced), and react-query stays a pure consumer that introduces no parser of its own.

import type { TsPluginApi } from '../ts/plugin.ts';

type CallArgShapesResult = ReturnType<TsPluginApi['callArgShapes']>;

/** One matched call: `{ fn, provenance, callId, callSpan, args, encloser, enclosingCallId? }`. */
export type ShapedCall = CallArgShapesResult['calls'][number];

/** A classified argument/property/element value (the discriminated union over syntactic shape). */
export type ValueShape = ShapedCall['args'][number];

/** The `object`-kind member of `ValueShape` — carries the `props` we pick `queryKey` from. */
type ObjectShape = Extract<ValueShape, { kind: 'object' }>;

export type ValueProp = ObjectShape['props'][number];
