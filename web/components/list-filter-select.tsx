"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@openbooks/ui";
import { mergeHref, pickString } from "../lib/list-params";

/**
 * Shared enum filter for list toolbars: a small labelled select, blank = no
 * filter. Bound to one query param, changing it navigates and resets
 * pagination, matching the ShowInactivesToggle contract. A filter over
 * rows the page already holds (a computed scenario, say) passes `value` and
 * `onValueChange` instead, and changes nothing in the URL.
 */
export function ListFilterSelect({
  basePath,
  currentParams,
  paramKey,
  label,
  allLabel,
  options,
  pageParamKey = "page",
  value,
  onValueChange,
}: {
  basePath: string;
  currentParams: Record<string, string | string[] | undefined>;
  paramKey: string;
  label: string;
  /** The blank choice; omit it for a filter that always has a value. */
  allLabel?: string;
  options: { value: string; label: string }[];
  /** The page parameter a change resets; null for a loaded list that pages on the client. */
  pageParamKey?: string | null;
  value?: string;
  onValueChange?: (value: string) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const current = value ?? pickString(currentParams[paramKey]) ?? "";

  return (
    <label className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
      <span className="whitespace-nowrap">{label}</span>
      <Select
        value={current}
        disabled={pending}
        className="h-8 w-auto min-w-32"
        onChange={(event) => {
          const next = event.target.value;
          if (onValueChange) {
            onValueChange(next);
            return;
          }
          const href = mergeHref(basePath, currentParams, {
            [paramKey]: next || undefined,
            ...(pageParamKey ? { [pageParamKey]: 1 } : {}),
          });
          startTransition(() => router.push(href as never));
        }}
      >
        {allLabel !== undefined ? <option value="">{allLabel}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </label>
  );
}
