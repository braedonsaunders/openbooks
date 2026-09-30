"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiJson } from "../../lib/api-error";
import type { EntryDistributionCandidate } from "./distribution-groups";

/** One cache for header and line queries, scoped to every effective-rule input. */
export function useEntryCandidates(context: string, enabled: boolean) {
  const scope = useMemo(() => ({ context, enabled }), [context, enabled]);
  const active = useRef<{ scope: typeof scope; inflight: Map<string, Promise<EntryDistributionCandidate[]>> } | null>(null);
  const [cache, setCache] = useState<ReadonlyMap<string, EntryDistributionCandidate[]>>(new Map());
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const key = useCallback((coordinates: Record<string, string> = {}) => {
    const query = new URLSearchParams(context);
    for (const [name, value] of Object.entries(coordinates).sort(([a], [b]) => a.localeCompare(b))) query.set(name, value);
    return query.toString();
  }, [context]);
  const isCurrent = useCallback(() => active.current?.scope === scope, [scope]);
  const load = useCallback((query: string): Promise<EntryDistributionCandidate[]> => {
    const lifetime = active.current;
    if (!enabled || lifetime?.scope !== scope) return Promise.resolve([]);
    const existing = lifetime.inflight.get(query);
    if (existing) return existing;
    const request = apiJson<{ rules: EntryDistributionCandidate[] }>(`/api/allocations/entry-candidates?${query}`)
      .then((body) => {
        if (!Array.isArray(body.rules)) throw new Error("Invalid allocation candidate response");
        if (active.current === lifetime) {
          setCache((prev) => new Map(prev).set(query, body.rules));
          setFailed((prev) => { const next = new Set(prev); next.delete(query); return next; });
        }
        return body.rules;
      }).catch((error: unknown) => {
        if (active.current === lifetime) setFailed((prev) => new Set(prev).add(query));
        throw error;
      }).finally(() => { lifetime.inflight.delete(query); });
    lifetime.inflight.set(query, request);
    return request;
  }, [enabled, scope]);
  useEffect(() => {
    const lifetime = { scope, inflight: new Map<string, Promise<EntryDistributionCandidate[]>>() };
    active.current = lifetime;
    if (enabled) void load(key()).catch(() => {});
    return () => { if (active.current === lifetime) active.current = null; };
  }, [enabled, scope, key, load]);
  const header = enabled ? cache.get(key()) : undefined;
  const automatic = useMemo(() => header?.filter((rule) => rule.applyPolicy === "automatic") ?? [], [header]);
  return { key, load, cache, failed, on: header !== undefined, automatic, isCurrent };
}
