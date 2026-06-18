// Fully-dynamic honesty cases — the plugin must flag these `dynamic`, never guess the key
// (§3.3: a computed key is not silently bridged).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

// queryKey is a bare identifier (a variable), not an array literal → the key is `dynamic`,
// its value unknown. We report the site, not a fabricated key.
export function useDynamic(key: readonly unknown[]) {
  return useQuery<number>({
    queryKey: key,
    queryFn: () => Promise.resolve(1),
  });
}

// A mutation invalidating a key with an interpolated template segment — `user.${id}` is a
// TemplateExpression, so that segment is `dynamic` and the invalidated key is `partial`.
export function useUpdateUser(id: string) {
  const queryClient = useQueryClient();
  return useMutation<void, string>({
    mutationFn: () => Promise.resolve(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['user', `${id}`] });
    },
  });
}
