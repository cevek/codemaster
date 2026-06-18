// A decoy module (paths-mapped) exporting SAME-NAMED `useQuery` / `useMutation` that are NOT
// react-query. Its imports resolve to THIS file, not the tanstack target, so the import-anchored
// by-identity scan never mistakes them for the real hooks (the same-named false-positive guard).

export declare function useQuery(name: string): { value: unknown };
export declare function useMutation(name: string): { run: () => void };
