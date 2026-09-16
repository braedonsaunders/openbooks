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
  .describe("Stable UUID, copied verbatim from the id a find_ or list_ tool returned; never invent one");

/** Named fiscal-aware period, resolved server-side by the same resolver the
 *  report filter bar uses — the org's fiscal start month is applied here, so
 *  the model never computes fiscal boundaries itself. */
export const periodPresetInput = z
  .enum(PERIOD_PRESET_IDS as [string, ...string[]])
  .describe(
    "Named period resolved against the org's fiscal calendar (e.g. this_fiscal_year_to_date, last_fiscal_quarter, this_calendar_year_to_date). Always prefer this over hand-computed dates for relative period language.",
  );

/** Shared schema fields for every range-taking tool: a preset OR an explicit
 *  custom date pair. */
export const rangeInputFields = {
  period: periodPresetInput.optional(),
  fromDate: dateInput.optional().describe("Custom range start; only when no `period` preset fits"),
  toDate: dateInput.optional().describe("Custom range end; only when no `period` preset fits"),
  priorYears: z.number().int().min(0).max(10).optional().describe(
    "Shift the resolved window back this many fiscal years for a comparative (e.g. period=last_fiscal_quarter + priorYears=1 = the same quarter one year earlier). Use this instead of hand-computing prior-year dates.",
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
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export const MAX_LIST_ROWS = 200;

/** Cap a list so a single tool result can't blow the model context. */
export function capList<T>(items: T[], max = MAX_LIST_ROWS): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, max), truncated: items.length > max };
}

