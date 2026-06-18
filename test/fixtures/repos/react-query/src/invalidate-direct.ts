// Direct QueryClient invalidation OUTSIDE a mutation — refetch/remove on a `useQueryClient()`
// binding. These have an enclosing decl (useRefreshers) but no enclosing useMutation, so they
// are reported as direct cache ops, not as a mutation→key relation.

import { useQueryClient } from '@tanstack/react-query';

export function useRefreshers() {
  const qc = useQueryClient();
  return {
    refreshTodos: () => qc.refetchQueries({ queryKey: ['todos'] }),
    dropTodo: (id: number) => qc.removeQueries({ queryKey: ['todo', id] }),
  };
}
