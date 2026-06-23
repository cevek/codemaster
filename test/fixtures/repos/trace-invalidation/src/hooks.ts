// The react-query layer: a query hook keyed `['todos']`, and a mutation whose onSuccess fires both
// a STATIC invalidate (`['todos']` → certain) and a BROAD `invalidateQueries()` (no key → dynamic).
// The trace must flag the broad edge dynamic and the static edge certain — never bridge them alike.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface Todo {
  id: number;
  title: string;
}

export function useTodos() {
  return useQuery<Todo[]>({
    queryKey: ['todos'],
    queryFn: () => Promise.resolve([]),
  });
}

export function useCreateTodo() {
  const queryClient = useQueryClient();
  return useMutation<Todo, string>({
    mutationFn: (title: string) => Promise.resolve({ id: 1, title }),
    onSuccess: () => {
      // Static key — affects useTodos by prefix, confidence certain.
      void queryClient.invalidateQueries({ queryKey: ['todos'] });
      // Broad — no key, affects every query; the trace must flag this hop dynamic.
      void queryClient.invalidateQueries();
    },
  });
}
