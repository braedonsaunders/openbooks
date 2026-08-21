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

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const dateInput = z.string().regex(ISO_DATE, "YYYY-MM-DD");
export const uuidInput = z.string().regex(UUID_RE, "uuid");

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

export function today(): string {
  return new Date().toISOString().slice(0, 10);
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
