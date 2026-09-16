import "server-only";
import { z } from "zod";
import { PERIOD_PRESET_IDS, type DateRange } from "@openbooks/reports";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { fiscalStartMonth } from "../fiscal";
import { resolveRangeArgs, type RangeArgs } from "./period-range";

/**
 * Shared input atoms and result-shaping helpers for the domain tool files
 * (tools-analytics, tools-reports, tools-banking, tools-payroll, tools-files,
 * tools-setup). Same contracts as the originals in tools.ts: capped lists,
 * 2-dp money, ISO dates.
 */

/**
 * Canonical tool-input UUID pattern. Written WITHOUT a case-insensitive flag
 * on purpose: JSON Schema patterns carry no flags, so a flag-dependent regex
 * would validate one set of values in zod and a narrower set provider-side.
 * The explicit A-F class keeps both sides identical (see
 * tool-schema-lint.test.ts, which pins the emitted pattern).
 */
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const dateInput = z.string().regex(ISO_DATE, "YYYY-MM-DD")
  .describe("Calendar date (YYYY-MM-DD)");
export const uuidInput = z.string().regex(UUID_RE, "uuid")
  .describe("UUID copied from a find_, list_, or get_ tool; never invent one");

/** Named fiscal-aware period, resolved server-side by the same resolver the
 *  report filter bar uses — the org's fiscal start month is applied here, so
 *  the model never computes fiscal boundaries itself. */
export const periodPresetInput = z
  .enum(PERIOD_PRESET_IDS as [string, ...string[]])
  .describe(
    "Fiscal-calendar preset (e.g. this_fiscal_year_to_date, last_fiscal_quarter); prefer over hand-computed dates.",
  );

/** Shared schema fields for every range-taking tool: a preset OR an explicit
 *  custom date pair. */
export const rangeInputFields = {
  period: periodPresetInput.optional(),
  fromDate: dateInput.optional().describe("Custom range start; only when no `period` preset fits"),
  toDate: dateInput.optional().describe("Custom range end; only when no `period` preset fits"),
  priorYears: z.number().int().min(0).max(10).optional().describe(
    "Repeat the window N fiscal years earlier for a comparative; never hand-compute prior-year dates.",
  ),
};

export type { RangeArgs };

/** Resolve a tool's period/fromDate/toDate inputs to exact inclusive dates
 *  using the org's configured fiscal start month. */
export async function resolveToolRange(
  orgId: string,
  a: RangeArgs,
): Promise<DateRange | { error: string }> {
  return resolveRangeArgs(a, await fiscalStartMonth(orgId), await businessToday(orgId));
}

export async function orgToday(orgId: string): Promise<string> {
  return businessToday(orgId);
}

export function num(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const rounded = Math.round(n * 100) / 100;
  // Normalize -0 (e.g. Math.round of a tiny negative) to 0: they compare
  // equal everywhere except Object.is, but the wire (JSON "0") cannot tell
  // them apart, so tool output should not either.
  return rounded === 0 ? 0 : rounded;
}

export const MAX_LIST_ROWS = 200;

/** Cap a list so a single tool result can't blow the model context. */
export function capList<T>(items: T[], max = MAX_LIST_ROWS): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, max), truncated: items.length > max };
}

/** Default per-string ceiling inside compacted rows (see compactRows). */
export const MAX_ROW_STRING = 500;

/** Recursively cap string leaves so one wide field can't blow the model
 *  context. Plain data passes through; class instances (Date, …) are left
 *  untouched so their wire shape never changes here. */
function truncateLeaves(value: unknown, max: number): unknown {
  if (typeof value === "string") {
    return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
  }
  if (Array.isArray(value)) return value.map((entry) => truncateLeaves(entry, max));
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, truncateLeaves(entry, max)]),
    );
  }
  return value;
}

/**
 * Cap a row list AND trim wide string fields in one step: the `{ items,
 * total, returned, truncated }` shape list tools return, with every string
 * leaf capped at `maxString` (marked with `[truncated]`). Prefer this over
 * hand-rolled `capList(rows.map(...))` in new tools so result budgets stay
 * uniform across the catalog.
 */
export function compactRows<T>(
  rows: readonly T[],
  opts?: { limit?: number; maxString?: number },
): { items: T[]; total: number; returned: number; truncated: boolean } {
  const limit = opts?.limit ?? MAX_LIST_ROWS;
  const maxString = opts?.maxString ?? MAX_ROW_STRING;
  const items = rows.slice(0, limit).map((row) => truncateLeaves(row, maxString) as T);
  return { items, total: rows.length, returned: items.length, truncated: rows.length > limit };
}
