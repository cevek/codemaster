// traps T1 (classes: methods / static / getter / setter / fields / generic) + T3 (high
// fan-in class — `Registry` is instantiated in ≥5 feature files; its `register` method is
// called via instance, via destructure, and via `this`). Serves: expand_type, rename, move.
import type { Box, Id } from './kinds.ts';

/** Generic, high-fan-in class (T1 + T3). */
export class Registry<T> {
  /** instance field */
  private readonly items = new Map<string, T>();
  /** public field */
  readonly name: string;
  /** static field */
  static instances = 0;

  constructor(name: string) {
    this.name = name;
    Registry.instances += 1;
  }

  /** instance method — the high-fan-in call target (instance + this + destructure). */
  register(key: string, value: T): void {
    this.items.set(key, value);
    this.touch();
  }

  /** called via `this` inside register (T3 "via this"). */
  private touch(): void {
    void this.items.size;
  }

  get size(): number {
    return this.items.size;
  }

  set seed(pairs: readonly [string, T][]) {
    for (const [k, v] of pairs) this.items.set(k, v);
  }

  /** static method. */
  static create<U>(name: string): Registry<U> {
    return new Registry<U>(name);
  }
}

/** A boxed-id registry alias used to exercise the generic at a concrete type. */
export function boxRegistry(): Registry<Box<Id>> {
  return Registry.create<Box<Id>>('boxes');
}
