// @tanstack/react-query v5 stub — a REAL module (paths-mapped in tsconfig), NOT an ambient
// `declare module`: the by-identity scan resolves the import specifier to a file via the
// compiler's module resolution, which is blind to ambient declarations. Minimal surface, no
// `npm install`. `export declare` keeps it type-only (noEmit). Covers the v5 object-form hooks
// the react-query plugin detects + the QueryClient invalidation methods.

export type QueryKey = readonly unknown[];

export interface UseQueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  error: unknown;
}
export interface UseMutationResult<TData, TVars> {
  mutate: (vars: TVars) => void;
  mutateAsync: (vars: TVars) => Promise<TData>;
  isPending: boolean;
}

export interface QueryFilters {
  queryKey?: QueryKey;
  exact?: boolean;
  type?: 'active' | 'inactive' | 'all';
  predicate?: (query: unknown) => boolean;
}

export declare class QueryClient {
  invalidateQueries(filters?: QueryFilters): Promise<void>;
  refetchQueries(filters?: QueryFilters): Promise<void>;
  removeQueries(filters?: QueryFilters): void;
}

export declare function useQueryClient(): QueryClient;

export interface UseQueryOptions<T> {
  queryKey: QueryKey;
  queryFn: () => T | Promise<T>;
  enabled?: boolean;
}
export declare function useQuery<T>(options: UseQueryOptions<T>): UseQueryResult<T>;

export interface UseInfiniteQueryOptions<T> {
  queryKey: QueryKey;
  queryFn: (ctx: { pageParam: unknown }) => T | Promise<T>;
  initialPageParam: unknown;
  getNextPageParam: (last: T) => unknown;
}
export declare function useInfiniteQuery<T>(options: UseInfiniteQueryOptions<T>): UseQueryResult<T>;

export interface UseMutationOptions<TData, TVars> {
  mutationFn: (vars: TVars) => Promise<TData>;
  mutationKey?: QueryKey;
  onSuccess?: (data: TData, vars: TVars) => void | Promise<void>;
  onError?: (err: unknown, vars: TVars) => void | Promise<void>;
  onSettled?: (data: TData | undefined, err: unknown, vars: TVars) => void | Promise<void>;
}
export declare function useMutation<TData, TVars>(
  options: UseMutationOptions<TData, TVars>,
): UseMutationResult<TData, TVars>;
