/*
 * Copyright (c) 2016-present Invertase Limited & Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this library except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */
import { Unsubscribe as AuthUnsubscribe } from "firebase/auth";
import { Unsubscribe as DatabaseUnsubscribe } from "firebase/database";
import { Unsubscribe as FirestoreUnsubscribe } from "firebase/firestore";
import {
  hashQueryKey,
  QueryFunction,
  QueryKey,
  useQuery,
  useQueryClient,
  UseQueryOptions,
  UseQueryResult,
} from "react-query";
import { useEffect, useMemo } from "react";

type Unsubscribe = AuthUnsubscribe | FirestoreUnsubscribe | DatabaseUnsubscribe;

const firestoreUnsubscribes: Record<string, any> = {};
const queryCacheUnsubscribes: Record<string, () => void> = {};
const eventCount: Record<string, number> = {};

interface CancellablePromise<T = void> extends Promise<T> {
  cancel?: () => void;
}

type UseSubscriptionOptions<TData, TError, R> = UseQueryOptions<TData,
  TError,
  R> & {
  onlyOnce?: boolean;
  fetchFn?: () => Promise<TData | null>;
};

function firestoreUnsubscribe(subscriptionHash: string) {
  const firestoreUnsubscribe = firestoreUnsubscribes[subscriptionHash];
  if (firestoreUnsubscribe && typeof firestoreUnsubscribe === "function") {
    firestoreUnsubscribe();
  }
  delete firestoreUnsubscribes[subscriptionHash];
  delete eventCount[subscriptionHash];
}

function queryCacheUnsubscribe(subscriptionHash: string) {
  const queryCacheUnsubscribe = queryCacheUnsubscribes[subscriptionHash];
  if (queryCacheUnsubscribe) {
    queryCacheUnsubscribe();
    delete queryCacheUnsubscribes[subscriptionHash];
  }
}

/**
 * Utility hook to subscribe to events, given a function that returns an observer callback.
 * @param queryKey The react-query queryKey
 * @param subscriptionKey A hashable key to store the subscription
 * @param subscribeFn Returns an unsubscribe function to the event
 * @param options
 * @returns
 */
export function useSubscription<TData, TError, R = TData>(
  queryKey: QueryKey,
  subscriptionKey: QueryKey,
  subscribeFn: (cb: (data: TData | null) => Promise<void>) => Unsubscribe,
  options?: UseSubscriptionOptions<TData, TError, R>
): UseQueryResult<R, TError> {
  const hashFn = options?.queryKeyHashFn || hashQueryKey;
  const subscriptionHash = hashFn(subscriptionKey);
  const enabled = options?.enabled ?? true;
  const queryClient = useQueryClient();

  const { result, resolvePromise, rejectPromise } = useMemo(() => {
    let resolvePromise: (data: TData | null) => void = () => null;
    let rejectPromise: (err: any) => void = () => null;
    const result: CancellablePromise<TData | null> = new Promise<TData | null>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    result.cancel = () => {
      queryClient.invalidateQueries(queryKey);
    };

    return {
      result,
      resolvePromise,
      rejectPromise
    };
  }, [queryKey.toString()]);

  useEffect(() => {
    if (!options?.onlyOnce || !enabled) {
      return;
    }
    if (!options.fetchFn) {
      throw new Error("You must specify fetchFn if using onlyOnce mode.");
    }
    let cancelled = false;
    options
      .fetchFn()
      .then((data) => {
        if (cancelled) {
          return;
        }
        resolvePromise(data);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        rejectPromise(err);
      });
    return () => {
      cancelled = true;
    };
  }, [options?.onlyOnce, !options?.fetchFn, enabled, resolvePromise, rejectPromise]);

  useEffect(() => {
    if (options?.onlyOnce || !enabled) {
      return;
    }
    const subscribedToQueryCache = !!queryCacheUnsubscribes[subscriptionHash];
    if (subscribedToQueryCache) {
      return;
    }
    const queryCache = queryClient.getQueryCache();
    queryCacheUnsubscribes[subscriptionHash] = queryCache.subscribe((event) => {
      if (!event || event.query.queryHash !== hashFn(queryKey)) {
        return;
      }
      const { query, type } = event;
      const observersCount = query.getObserversCount();
      const isSubscribedToFirestore = !!firestoreUnsubscribes[subscriptionHash];
      switch (type) {
        case "queryRemoved":
          queryCacheUnsubscribe(subscriptionHash);
          firestoreUnsubscribe(subscriptionHash);
          break;
        case "observerRemoved":
          if (observersCount !== 0) {
            return;
          }
          firestoreUnsubscribe(subscriptionHash);
          break;
        case "observerAdded":
          if (isSubscribedToFirestore) {
            const cachedData = queryClient.getQueryData<TData | null>(queryKey);
            const hasData = !!eventCount[subscriptionHash];

            if (hasData) {
              resolvePromise(cachedData ?? null);
            }
            return;
          }
          firestoreUnsubscribes[subscriptionHash] = subscribeFn(async (data) => {
            eventCount[subscriptionHash] ??= 0;
            eventCount[subscriptionHash]++;
            if (eventCount[subscriptionHash] === 1) {
              resolvePromise(data || null);
              return;
            }
            queryClient.setQueryData(queryKey, data);
          });
          break;
      }
    });
  }, [options?.onlyOnce, enabled, subscriptionHash, subscribeFn, queryKey.toString()]);

  const queryFn: QueryFunction<TData> = () => {
    return result as Promise<TData>;
  };

  return useQuery<TData, TError, R>({
    ...options,
    queryFn,
    queryKey,
    retry: false,
    staleTime: Infinity,
    refetchInterval: undefined,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
