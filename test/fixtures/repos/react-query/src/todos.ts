// The mainline honesty cases: static and dynamic-segment queryKeys, and a mutation whose
// onSuccess invalidates a static key (the mutation→key relation the plugin reports).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface Todo {
  id: number;
  title: string;
}

// Static inline queryKey — every segment a literal → confidence `certain`.
export function useTodos() {
  return useQuery<Todo[]>({
    queryKey: ['todos'],
    queryFn: () => Promise.resolve([]),
  });
}

// Mixed key — a literal first segment plus a parameter segment. The `id` segment is
// `dynamic` (an identifier, not a literal) → the whole key demotes to `partial`.
export function useTodo(id: number) {
  return useQuery<Todo>({
    queryKey: ['todo', id],
    queryFn: () => Promise.resolve({ id, title: '' }),
  });
}

// A mutation that invalidates the `['todos']` list on success — the relation
// useCreateTodo → invalidates → ['todos'] (which matches useTodos by key prefix).
export function useCreateTodo() {
  const queryClient = useQueryClient();
  return useMutation<Todo, string>({
    mutationFn: (title: string) => Promise.resolve({ id: 1, title }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['todos'] });
    },
  });
}

// Invalidates the `['todo']` prefix — matches useTodo, whose key `['todo', id]` carries a DYNAMIC
// segment. The relation is certain (static prefix), but the affected query's key is `partial`.
export function useTouchTodo() {
  const queryClient = useQueryClient();
  return useMutation<void, number>({
    mutationFn: () => Promise.resolve(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['todo'] });
    },
  });
}

// `exact: true` — matches ONLY the same-length key, so the `['todo']` filter must NOT claim
// useTodo (`['todo', id]`, longer). Over-reporting it would be a confident lie (§3).
export function useExactTouch() {
  const queryClient = useQueryClient();
  return useMutation<void, number>({
    mutationFn: () => Promise.resolve(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['todo'], exact: true });
    },
  });
}

// A `predicate` filter narrows the set in a way we cannot evaluate statically — the prefix match
// is an upper bound, so even the static `['todos']` match against useTodos demotes to `partial`.
export function usePredicateInvalidate() {
  const queryClient = useQueryClient();
  return useMutation<void, void>({
    mutationFn: () => Promise.resolve(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['todos'], predicate: () => true });
    },
  });
}
