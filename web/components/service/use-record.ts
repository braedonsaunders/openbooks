"use client";

import { useCallback, useEffect, useState } from "react";
import { serviceRequest } from "./api";

/**
 * One service record read by URL. `reload` re-reads after a command, keeping
 * the current data on screen until the fresh copy arrives.
 */
export function useServiceRecord<T>(url: string | null, fallback: string) {
  const [state, setState] = useState<{ url: string | null; data: T | null; error: string | null }>({
    url,
    data: null,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);
  if (state.url !== url) setState({ url, data: null, error: null });
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    serviceRequest<T>(url, { signal: controller.signal }, fallback)
      .then((data) => {
        if (!controller.signal.aborted) setState({ url, data, error: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState((current) => ({
            url,
            data: current.url === url ? current.data : null,
            error: error instanceof Error ? error.message : fallback,
          }));
      });
    return () => controller.abort();
  }, [url, attempt, fallback]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const current = state.url === url ? state : { data: null, error: null };
  return {
    data: current.data,
    error: current.error,
    pending: !current.data && !current.error,
    reload,
  };
}
