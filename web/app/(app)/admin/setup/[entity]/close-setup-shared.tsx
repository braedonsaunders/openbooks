"use client";

import Link from "next/link";
import { ApiResponseError, apiJson } from "@/lib/api-error";
import { useTranslations } from "next-intl";
import { Button, Card, Input, Label, SearchSelect, cn } from "@openbooks/ui";
import { Plus, Trash2, X } from "lucide-react";
import { PERIOD_PRESETS } from "@openbooks/reports";
import { SearchInput } from "../../../../../components/search-input";
import { Pagination } from "../../../../../components/pagination";
import { mergeHref } from "../../../../../lib/list-params";
import type { ConfigListKey, ConfigListMeta, Props, ReportAttachment } from "./close-setup-types";

export const BASE = "/admin/setup/period-close";
export const TABS = [
  "calendars",
  "periods",
  "blueprints",
  "policies",
  "automation",
  "packages",
] as const;
export type Tab = (typeof TABS)[number];
export const MODULES = ["ar", "ap", "banking", "assets", "tax", "gl"] as const;

export async function post(
  body: Record<string, unknown>,
  fallback: string,
  timeoutMessage?: string,
) {
  // Close writes run sequential module transitions behind one advisory
  // fence: on a loaded host the answer can take a while, but a request that
  // never answers must not wedge the drawer with a busy button and no
  // feedback. The timeout turns a hang into a visible error that releases
  // the form; the message tells the operator to review the locks before
  // retrying, since a timed-out write may still have committed.
  try {
    return await apiJson<Record<string, unknown>>(
      "/api/admin/close",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      },
      fallback,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new ApiResponseError(timeoutMessage ?? fallback, 0);
    throw error;
  }
}

export function dataText(t: ReturnType<typeof useTranslations>, value: string | null | undefined) {
  if (!value) return "";
  return value.startsWith("close.") ? t(value.slice(6)) : value;
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  // Descriptive hints live in the label's `?` popover (FieldLabel); inline
  // text under a control is reserved for validation/state messages.
  return (
    <div className="space-y-1.5">
      <Label help={hint}>{label}</Label>
      {children}
    </div>
  );
}

export function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {children}
    </label>
  );
}

export function SectionHeading({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-teal-50 p-2 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
          {icon}
        </div>
        <div>
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
          <p className="max-w-3xl text-sm text-slate-500 dark:text-slate-400">{description}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

export type Option = { value: string; label: string; group?: string };

/** Checkbox chips for a fixed, short list of values (statuses, workstreams…). */
export function Chips({
  options,
  value,
  onChange,
}: {
  options: Option[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const on = value.includes(option.value);
        return (
          <label
            key={option.value}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
              on
                ? "border-teal-500 bg-teal-50 text-teal-800 dark:border-teal-500 dark:bg-teal-950/40 dark:text-teal-200"
                : "border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300",
            )}
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={on}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...value, option.value]
                    : value.filter((item) => item !== option.value),
                )
              }
            />
            {option.label}
          </label>
        );
      })}
    </div>
  );
}

/** Searchable add-and-remove token list backed by a large/grouped option set
 * (people, roles, reports). Selected values render as removable chips. */
export function TokenSelect({
  options,
  value,
  onChange,
  placeholder,
  empty,
}: {
  options: Option[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  empty?: string;
}) {
  const t = useTranslations("close.setup");
  const byValue = new Map(options.map((option) => [option.value, option]));
  const available = options.filter((option) => !value.includes(option.value));
  return (
    <div className="space-y-2">
      <SearchSelect
        value=""
        onChange={(next) => {
          if (next && !value.includes(next)) onChange([...value, next]);
        }}
        options={available}
        placeholder={placeholder}
        searchable
        emptyLabel={empty}
        ariaLabel={placeholder}
      />
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((item) => {
            const label = byValue.get(item)?.label ?? item;
            return (
              <span
                key={item}
                className="flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              >
                {label}
                <button
                  type="button"
                  aria-label={t("actions.removeValue", { value: label })}
                  onClick={() => onChange(value.filter((value) => value !== item))}
                  className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100"
                >
                  <X size={12} />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Friendly replacement for a raw-JSON object field: rows of key/value pairs.
 * Only used for policy/delivery shapes that have no dedicated engine schema. */
export function KeyValueRows({
  rows,
  onChange,
}: {
  rows: Array<{ key: string; value: string }>;
  onChange: (next: Array<{ key: string; value: string }>) => void;
}) {
  const t = useTranslations("close.setup");
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            className="flex-1"
            placeholder={t("kv.key")}
            aria-label={`${t("kv.key")} ${index + 1}`}
            value={row.key}
            onChange={(event) =>
              onChange(
                rows.map((item, i) => (i === index ? { ...item, key: event.target.value } : item)),
              )
            }
          />
          <Input
            className="flex-1"
            placeholder={t("kv.value")}
            aria-label={`${t("kv.value")} ${index + 1}`}
            value={row.value}
            onChange={(event) =>
              onChange(
                rows.map((item, i) =>
                  i === index ? { ...item, value: event.target.value } : item,
                ),
              )
            }
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("actions.removeValue", {
              value: row.key.trim() || String(index + 1),
            })}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        <Plus size={14} />
        {t("kv.add")}
      </Button>
    </div>
  );
}

/** Coerce a stored jsonb object into editable key/value rows, and back. */
export function objectToRows(value: unknown): Array<{ key: string; value: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([key, raw]) => ({
    key,
    value: typeof raw === "string" ? raw : JSON.stringify(raw),
  }));
}
export function rowsToObject(rows: Array<{ key: string; value: string }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, value } of rows) {
    const trimmed = key.trim();
    if (!trimmed) continue;
    let parsed: unknown = value;
    if (value === "true") parsed = true;
    else if (value === "false") parsed = false;
    else if (value !== "" && !Number.isNaN(Number(value))) parsed = Number(value);
    out[trimmed] = parsed;
  }
  return out;
}
export function numberOrUndefined(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string" && value
      ? [value]
      : [];
}
/** Drop empty strings, nullish, and empty arrays so engine `?? fallback`
 * defaults still apply (an empty title must not overwrite the rule name). */
export function pruneEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === "" || value == null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

export function normalizeAttachments(raw: unknown): ReportAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (item && typeof item === "object" ? { ...(item as ReportAttachment) } : null))
    .filter((item): item is ReportAttachment => Boolean(item && item.slug));
}

export const BREAKOUT_DIMENSIONS = [
  "none",
  "department",
  "location",
  "class",
  "project",
  "month",
  "quarter",
] as const;

/** Period presets (~50) plus a leading token that follows whatever period is
 * being closed, and a trailing custom range. */
export function periodOptions(
  closeLabel: string,
  customLabel: string,
  presetLabel: (id: string) => string,
  groupLabel: (group: string) => string,
): Option[] {
  return [
    { value: "$close", label: closeLabel },
    ...PERIOD_PRESETS.map((preset) => ({
      value: preset.id,
      label: presetLabel(preset.id),
      group: groupLabel(preset.group),
    })),
    { value: "custom", label: customLabel },
  ];
}

export const RUN_STATUSES = [
  "draft",
  "in_progress",
  "review",
  "approved",
  "closed",
  "published",
  "cancelled",
] as const;
export const TASK_STATUSES = [
  "blocked",
  "ready",
  "in_progress",
  "submitted",
  "changes_requested",
  "complete",
  "waived",
  "invalidated",
] as const;
export const SEVERITIES = ["info", "warning", "error", "critical"] as const;
export const ALL_WORKSTREAMS = [
  "readiness",
  "banking",
  "ar",
  "ap",
  "assets",
  "tax",
  "payroll",
  "intercompany",
  "gl",
  "review",
  "publish",
] as const;

export function ConfigListControls({
  listKey,
  list,
  currentParams,
  perPage,
}: {
  listKey: ConfigListKey;
  list: ConfigListMeta;
  currentParams: Props["currentParams"];
  perPage: number;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <SearchInput paramKey={`${listKey}Q`} pageParamKey={`${listKey}Page`} />
      <Pagination
        basePath={BASE}
        currentParams={currentParams}
        total={list.total}
        page={list.page}
        perPage={perPage}
        pageParamKey={`${listKey}Page`}
      />
    </div>
  );
}

export function EmptyList({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 px-5 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
      {children}
    </div>
  );
}

export function drawerHref(
  params: Props["currentParams"],
  tab: Tab,
  key: string,
  value: string | null,
) {
  return mergeHref(BASE, params, { tab, [key]: value });
}

export function RowLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
    >
      <Card interactive>{children}</Card>
    </Link>
  );
}
