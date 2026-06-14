// traps: M5 (namespace import `* as NS` + member calls) · M6 (default + named import) · M7
// (type-only import + inline `{ type X, val }`) · M9 (plain dynamic `import()`) · M12
// (`import('@/data/shapes').Bar` type-query in a signature) · T4 (local `handle` — collision
// source #3) · T5 (indirect call `const f = fn; f()` + callback passing `run(fn)`) · T7
// (`Foo` used ONLY in a type position). · i18n.
import * as NS from '@/core/ns.ts';
import { Registry } from '@/core/registry.ts';
import submit, { handle as formHandle, validate } from './handlers.ts';
import { type Status, describe } from '@/core/status.ts';
import type { Foo } from '@/data/shapes.ts';
import { t } from '@/core/i18n.ts';

// T3 — Registry instance (5th instantiating file); method called via the instance.
const formRegistry = new Registry<string>('form');
formRegistry.register('mounted', 'true');

// T4 source #3 — a LOCAL `handle`, distinct from core/handle.ts and forms/handlers.ts.
const handle = (label: string): string => label.trim();

// T5 callback target.
function run(fn: (s: string) => boolean): boolean {
  return fn('seed');
}

// M9 plain dynamic import() — separate from the lazy registry.
async function loadHandlers(): Promise<void> {
  const mod = await import('./handlers.ts');
  mod.validate('x');
}

// M12 — `Bar` referenced via the import() type operator in a signature; T7 — `Foo` is
// referenced only as a type, never as a value.
export function toFoo(bar: import('@/data/shapes').Bar): Foo {
  return { id: bar.foo.id, count: bar.foo.count };
}

export function Form(props: { status: Status }): JSX.Element {
  const f = validate; // T5 indirect call
  const okIndirect = f('value');
  const okCallback = run(validate); // T5 callback passing
  void NS.beta(NS.alpha().length); // M5 member calls
  void formHandle; // M6 named (renamed) import
  void submit; // M6 default import
  void loadHandlers; // M9
  return (
    <form data-ok={okIndirect && okCallback}>
      <label>{handle(t('widget.actions.save'))}</label>
      <output>{describe(props.status)}</output>
    </form>
  );
}
