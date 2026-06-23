// The SUBSCRIBER: a component that consumes the query through the custom hook. An invalidation of
// ['todos'] re-renders THIS component (not its parent) — so the trace's reRenderComponents must
// count TodoList, reached via useTodos (a used-by hop), never the App that places <TodoList/>.

import { useTodos } from './hooks.ts';

export function TodoList() {
  const { data } = useTodos();
  return (
    <ul>
      {data?.map((t) => (
        <li key={t.id}>{t.title}</li>
      ))}
    </ul>
  );
}
