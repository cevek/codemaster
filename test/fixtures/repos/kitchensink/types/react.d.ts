// Ambient React stub — minimal surface, no `npm install` (spec §5). Covers the classic
// runtime (createElement / Component), the automatic runtime (`react/jsx-runtime`, which
// `jsx: "react-jsx"` emits to), the hooks/utilities the fixture uses, and a global JSX
// namespace so `.tsx` files typecheck. NOT the real react types — just enough shape.

declare module 'react' {
  export type Key = string | number;
  export type ReactNode =
    | ReactElement
    | string
    | number
    | boolean
    | null
    | undefined
    | ReactNode[];
  export interface ReactElement {
    type: unknown;
    props: unknown;
    key: Key | null;
  }
  export type ComponentType<P = Record<string, unknown>> = (props: P) => ReactElement | null;
  export type FC<P = Record<string, unknown>> = (props: P) => ReactElement | null;
  export type PropsWithChildren<P = unknown> = P & { children?: ReactNode };

  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): ReactElement;
  export function useState<S>(initial: S): [S, (next: S) => void];
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  export function useCallback<T>(fn: T, deps: readonly unknown[]): T;
  export function useEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useRef<T>(initial: T): { current: T };
  export function lazy<T extends ComponentType<never>>(loader: () => Promise<{ default: T }>): T;
  export const Fragment: unique symbol;
  export const Suspense: ComponentType<PropsWithChildren>;

  export class Component<P = Record<string, unknown>, S = Record<string, unknown>> {
    constructor(props: P);
    props: P;
    state: S;
    setState(next: Partial<S>): void;
    render(): ReactElement | null;
  }

  const React: {
    createElement: typeof createElement;
    Fragment: typeof Fragment;
    lazy: typeof lazy;
    Suspense: typeof Suspense;
    Component: typeof Component;
  };
  export default React;
}

declare module 'react/jsx-runtime' {
  import type { ReactElement } from 'react';
  export function jsx(type: unknown, props: unknown, key?: unknown): ReactElement;
  export function jsxs(type: unknown, props: unknown, key?: unknown): ReactElement;
  export const Fragment: unique symbol;
}

// This .d.ts is an ambient script (no top-level import/export), so JSX lives at global
// scope directly — `declare global` is only valid inside a module.
declare namespace JSX {
  type Element = import('react').ReactElement;
  interface ElementClass {
    render(): import('react').ReactElement | null;
  }
  interface IntrinsicElements {
    [tag: string]: Record<string, unknown>;
  }
  interface ElementChildrenAttribute {
    children: object;
  }
}
