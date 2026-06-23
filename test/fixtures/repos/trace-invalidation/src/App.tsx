// The PARENTS that place <TodoList/>: a direct mount and a conditional mount (both are static
// `<TodoList/>` token sites — certain LOCATIONS). App does NOT re-render from the invalidation;
// it is only where TodoList is mounted. `Aliased = TodoList` then `<Aliased/>` is an OPAQUE
// reference of TodoList (a value read, not a `<TodoList/>` token) — the trace must flag that mount
// hop dynamic, never silently treat it as a clean mount.

import { TodoList } from './TodoList.tsx';

export function App({ show }: { show: boolean }) {
  return (
    <main>
      <TodoList />
      {show && <TodoList />}
    </main>
  );
}

const Aliased = TodoList;

export function Wrapper() {
  return <Aliased />;
}
