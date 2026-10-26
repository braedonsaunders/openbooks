import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  DEFAULT_PERIOD_PRESET,
  isPeriodPreset,
  resolvePreset,
  type DateRange,
  type FiscalPeriodRef,
} from "@openbooks/reports";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { canonicalPeriodLabel } from "@openbooks/engine/periods/period-policy";
import { defaultFiscalCalendarPeriods, fiscalStartMonth } from "./fiscal";
import { resolveOrgId } from "./org-scope";
import { assertCustomPeriodBounds } from "./report-filters";

/**
 * Server-side period resolution. Turns a preset id (from `PERIOD_PRESETS`) plus
 * the org's fiscal start month into a concrete `{ from, to }` window. Pure
 * date-math presets are resolved by `resolvePreset`; the accounting-period
 * family ("This / Last / Period Before Last") is refined against real
 * `accounting_periods` rows when they exist so a non-calendar close (13-period,
 * short periods) is honoured — otherwise it falls back to fiscal-month math.
 */

export type ResolvedPeriod = {
  presetId: string;
  from: string;
  to: string;
  /**
   * Locale-free descriptive label (e.g. "FY 2026", "2026-07", "P05 FY2026").
   * Presenters label windows through `reportPeriodLabel`, which renders an
   * accounting-period window in the viewer's locale.
   */
  label: string;
  /**
   * The accounting period the window covers, when it is one period, so
   * presenters label it from its fiscal position and dates in the viewer's
   * locale (`P05 FY2026 · May 2026`).
   */
  fiscalPeriod?: FiscalPeriodRef;
  /**
   * Structured form of `label` for presets that qualify a window ("2026-07
   * to date"): the bare window name plus whether it runs to the business
   * day, so readers render the qualifier through the catalog instead of
   * parsing English. Absent for presets with a plain label.
   */
  windowName?: string;
  toDate?: boolean;
};

/**
 * No configured accounting period covers the business day: today precedes
 * the first period, so no period-to-date window exists. Carries the date
 * and the first period so presenters refuse through the catalog, labelling
 * the period in the viewer's locale, instead of matching the message text.
 */
export class MissingAccountingPeriodError extends Error {
  readonly code = "missing-accounting-period";
  readonly businessDate: string;
  readonly firstPeriod: FiscalPeriodRef;
  /** Locale-free label of the first period (`P01 FY2026`). */
  readonly firstPeriodLabel: string;
  constructor(businessDate: string, firstPeriod: FiscalPeriodRef) {
    const firstPeriodLabel = canonicalPeriodLabel({ ...firstPeriod, adjustment: false });
    super(
      `business date '${businessDate}' precedes the first configured accounting period '${firstPeriodLabel}' — configure an accounting period covering this date in Close Setup`,
    );
    this.name = "MissingAccountingPeriodError";
    this.businessDate = businessDate;
    this.firstPeriod = firstPeriod;
    this.firstPeriodLabel = firstPeriodLabel;
  }
}

const PERIOD_FAMILY: Record<string, number> = {
  this_period: 0,
  last_period: -1,
  period_before_last: -2,
};

/** Real accounting-period window shifted `offset` periods from the one holding
 *  `today` (non-adjustment periods only). Null when no periods are configured. */
async function accountingPeriodWindow(
  offset: number,
  today: string,
  orgId: string,
): Promise<DateRange | null> {
  const r = await db.execute<{
    fiscal_year: number;
    period_number: number;
    starts_on: string;
    ends_on: string;
  }>(
    sql`
    select fiscal_year, period_number, starts_on::text as starts_on, ends_on::text as ends_on
      from accounting_periods
     where org_id = ${orgId} and is_adjustment = false
     order by starts_on
  `,
    "objects",
  );
  const rows = r;
  if (!rows.length) return null;
  // Index of the period containing today, else the latest one that has started.
  let idx = rows.findIndex((p) => p.starts_on <= today && today <= p.ends_on);
  if (idx < 0) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.starts_on <= today) {
        idx = i;
        break;
      }
    }
  }
  const ref = (p: (typeof rows)[number]): FiscalPeriodRef => ({
    fiscalYear: Number(p.fiscal_year),
    periodNumber: Number(p.period_number),
    from: p.starts_on,
    to: p.ends_on,
  });
  if (idx < 0) {
    throw new MissingAccountingPeriodError(today, ref(rows[0]!));
  }
  const target = idx + offset;
  if (target < 0 || target >= rows.length) return null;
  const period = ref(rows[target]!);
  return {
    from: period.from,
    to: period.to,
    label: canonicalPeriodLabel({ ...period, adjustment: false }),
    fiscalPeriod: period,
  };
}

/**
 * Resolve a period selection into concrete dates. `today` defaults to the
 * organization's business day; callers can pin it for deterministic exports.
 */
export async function resolvePeriod(
  presetId: string | null | undefined,
  opts: {
    customFrom?: string | null;
    customTo?: string | null;
    today?: string;
    orgId?: string;
  } = {},
): Promise<ResolvedPeriod> {
  // A named preset that no longer exists (saved before it was removed from
  // the catalog) must refuse by name — never silently become This Fiscal
  // Year and widen or move the window. An absent preset is the ordinary
  // "no selection" path and still resolves the default. Fail fast, before
  // any database work: membership is pure catalog.
  if (typeof presetId === "string" && presetId !== "" && !isPeriodPreset(presetId)) {
    throw new Error(`preset '${presetId}' no longer exists — choose a current period preset`);
  }
  // A custom window without valid bounds refuses by name for the same reason:
  // it must never widen to the default fiscal year. Checked before any
  // database work, like the stale-preset refusal above.
  if (presetId === "custom") assertCustomPeriodBounds(opts.customFrom, opts.customTo);
  const orgId = await resolveOrgId(opts.orgId);
  const today = opts.today ?? (await businessToday(orgId));
  const id = isPeriodPreset(presetId) ? presetId! : DEFAULT_PERIOD_PRESET;
  const startMonth = await fiscalStartMonth(orgId);

  // Retail/custom calendars: resolve the period/month, quarter, half and
  // fiscal-year preset families against the default calendar's declared
  // periods so the filter-bar window agrees with fiscal-period statement
  // columns (a 5-week period is one window, labelled as that fiscal period).
  // A miss falls through to the legacy paths below. Monthly-cadence orgs —
  // or calendars without generated periods — skip this entirely and keep
  // the existing behavior byte-identical.
  const fiscal = await defaultFiscalCalendarPeriods(orgId);
  const declared =
    fiscal && fiscal.cadence !== "monthly" && fiscal.periods.length > 0
      ? fiscal.periods
      : undefined;
  if (declared) {
    const range = resolvePreset(id, {
      startMonth,
      today,
      customFrom: opts.customFrom,
      customTo: opts.customTo,
      periods: declared,
    });
    if (range) return { presetId: id, ...range };
  }

  // Accounting-period-aware presets: prefer real period rows.
  if (id in PERIOD_FAMILY) {
    const win = await accountingPeriodWindow(PERIOD_FAMILY[id]!, today, orgId);
    if (win) return { presetId: id, ...win };
  }
  if (id === "this_period_to_date") {
    const win = await accountingPeriodWindow(0, today, orgId);
    if (win) {
      return {
        presetId: id,
        ...win,
        to: today,
        label: `${win.label} to date`,
        windowName: win.label,
        toDate: true,
      };
    }
  }

  const range = resolvePreset(id, {
    startMonth,
    today,
    customFrom: opts.customFrom,
    customTo: opts.customTo,
  });
  if (range) return { presetId: id, ...range };

  // Only an absent preset reaches here without a window: it is the ordinary
  // "no selection" path and resolves the default.
  const fallback = resolvePreset(DEFAULT_PERIOD_PRESET, { startMonth, today })!;
  return { presetId: DEFAULT_PERIOD_PRESET, ...fallback };
}
