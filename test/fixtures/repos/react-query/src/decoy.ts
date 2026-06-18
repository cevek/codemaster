// Same-named `useQuery` / `useMutation` from a DIFFERENT module — the import-anchored
// detection must NOT report these as react-query (the same-named false-positive guard).

import { useMutation, useQuery } from 'other-lib';

export function notAQuery() {
  return useQuery('todos');
}

export function notAMutation() {
  return useMutation('createTodo');
}
