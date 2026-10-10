"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, SearchSelect } from "@openbooks/ui";
import { readApiErrorMessage } from "@/lib/api-error";
export type RemoteRecordOption = { value: string; label: string; parentId?: string | null };
/** Search results and retries stay inside the house reference-picker shell. */
export function RemoteRecordChoice({
  id,
  value,
  options,
  endpoint,
  resultKey,
  disabled=false,
  clearable=false,
  onChange,
  labels,
  emptyHint,
}: {
  id: string;
  value: string;
  options: RemoteRecordOption[];
  endpoint: string;
  resultKey?: "lots" | "serials";
  disabled?: boolean;
  clearable?: boolean;
  onChange: (value: string) => void;
  labels: { choose: string; searchPlaceholder: string; loadFailed: string; retry: string };
  /**
   * Why an empty collection is empty, shown only when the whole collection
   * (no search filter) comes back with nothing to pick. A filtered search
   * that matches nothing keeps the picker's own no-matches note, so the
   * hint never blames the query for an empty catalog.
   */
  emptyHint?: ReactNode;
}) {
  const [query, setQuery] = useState(""),
    [rows, setRows] = useState(options),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [attempt, setAttempt] = useState(0);
  const chosen = useRef<RemoteRecordOption | undefined>(
    options.find((o) => o.value === value),
  );
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      const url = new URL(endpoint, window.location.origin);
      url.searchParams.set("q", query);
      if (value) url.searchParams.set("selected", value);
      fetch(url.pathname + url.search, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok)
            throw new Error(
              await readApiErrorMessage(response, labels.loadFailed),
            );
          const data = await response.json();
          return (resultKey ? data[resultKey] : data) as RemoteRecordOption[];
        })
        .then((result) => {
          if (!controller.signal.aborted) {
            setRows(result);
            const selected = result.find((o) => o.value === value);
            chosen.current = selected;
          }
        })
        .catch((cause) => {
          if (!controller.signal.aborted) {
            setRows([]);
            setError(cause instanceof Error ? cause.message : labels.loadFailed);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [endpoint, query, value, resultKey, labels.loadFailed, attempt]);
  const selected =
    rows.find((o) => o.value === value) ??
    (chosen.current?.value === value ? chosen.current : undefined);
  const choices =
    selected && !rows.some((o) => o.value === value)
      ? [selected, ...rows]
      : rows;
  const showEmptyHint =
    emptyHint !== undefined &&
    !loading &&
    error === null &&
    rows.length === 0 &&
    query.trim() === "";
  return (
    <div className="space-y-1">
      <SearchSelect
        id={id}
        ariaLabel={labels.choose}
        value={value}
        options={choices}
        onChange={(next) => {
          chosen.current = choices.find((o) => o.value === next);
          onChange(next);
        }}
        placeholder={labels.choose}
        searchPlaceholder={labels.searchPlaceholder}
        disabled={disabled}
        clearable={clearable}
        emptyLabel={labels.choose}
        remote
        searchable
        loading={loading}
        onSearchChange={(q) => setQuery(q.slice(0, 200))}
        statusMessage={error ?? undefined}
        statusTone={error ? "error" : "muted"}
      />
      {showEmptyHint ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">{emptyHint}</p>
      ) : null}
      {error ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => setAttempt((a) => a + 1)}
        >
          {labels.retry}
        </Button>
      ) : null}
    </div>
  );
}
