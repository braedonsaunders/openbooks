import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { dataDependentFeatureDefault } from "../organization/feature-defaults.ts";
import type { FeatureState } from "../organization/feature-registry.ts";
import { lockAssetTaxLifecycle } from "../organization/asset-tax-fence.ts";
import { isShortTaxYear } from "./macrs-short-year.ts";
import {
  assertMacrsWindowsCover,
  nextCalendarDay,
  TAX_DEPRECIATION_REGIMES,
  type MacrsYearWindow,
} from "./depreciation-pool.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class MacrsCalendarError extends Error {
  readonly name = "MacrsCalendarError";
}

export interface TaxYearWindow {
  id: string;
  subsidiaryId: string;
  regime: string;
  yearStart: string;
  yearEnd: string;
  filingYear: number;
  reason: string;
}

export interface TaxYearWindowWrite {
  id?: string;
  subsidiaryId?: string | null;
  regime?: string | null;
  yearStart?: string | null;
  yearEnd?: string | null;
  filingYear?: number | null;
  reason?: string | null;
}

/** Exact registered facts consumed by a calculation, never an overlap guess. */
export type TaxYearWindowEvidence = {
  id: string;
  subsidiaryId: string;
  regime: string;
  yearStart: string;
  yearEnd: string;
  filingYear: number;
};

export type RegisteredMacrsYearWindow = MacrsYearWindow & {
  id: string;
  subsidiaryId: string;
  regime: string;
};

export function taxYearWindowEvidence(window: MacrsYearWindow | TaxYearWindow): TaxYearWindowEvidence {
  if (!window.id || !window.subsidiaryId || !window.regime) {
    throw new MacrsCalendarError("tax-year evidence requires a registered id, legal entity and regime; load the declared years before calculating");
  }
  return {
    id: window.id, subsidiaryId: window.subsidiaryId, regime: window.regime,
    yearStart: window.yearStart, yearEnd: window.yearEnd,
    filingYear: "filingYear" in window ? window.filingYear : window.taxYear,
  };
}

/** One canonical set across multiple vintages that consumed the same year. */
export function normalizeTaxYearWindowEvidence(evidence: readonly TaxYearWindowEvidence[]): TaxYearWindowEvidence[] {
  const distinct = new Map<string, TaxYearWindowEvidence>();
  for (const row of evidence) {
    if (!row || !UUID_RE.test(row.id) || !UUID_RE.test(row.subsidiaryId)
      || typeof row.regime !== "string" || !row.regime.trim()
      || !isIsoCalendarDate(row.yearStart) || !isIsoCalendarDate(row.yearEnd) || row.yearStart > row.yearEnd
      || !Number.isInteger(row.filingYear) || row.filingYear < 1900 || row.filingYear > 9999) {
      throw new MacrsCalendarError("tax-year evidence must contain the exact registered identity, legal entity, regime, dates and filing label; reload the declared years");
    }
    const frozen = {
      id: row.id, subsidiaryId: row.subsidiaryId, regime: row.regime,
      yearStart: row.yearStart, yearEnd: row.yearEnd, filingYear: row.filingYear,
    };
    const prior = distinct.get(row.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(frozen)) {
      throw new MacrsCalendarError(`tax-year evidence for ${row.id} contains conflicting facts; reload the declared year before proposing the workpaper`);
    }
    distinct.set(row.id, frozen);
  }
  return [...distinct.values()].sort((left, right) =>
    left.yearStart.localeCompare(right.yearStart)
    || left.yearEnd.localeCompare(right.yearEnd)
    || left.id.localeCompare(right.id));
}

// Stable caller name; one validator defines canonical evidence everywhere.
export const freezeTaxYearWindowEvidence = normalizeTaxYearWindowEvidence;

/** Persist the explicit approved read set in the applying transaction.
 * Consumers must acquire ALL lineage legal-entity fences in sorted order
 * before locking asset rows. Reacquiring that same set here is intentional. */
export async function citeTaxYearWindows(
  tx: SqlExecutor,
  orgId: string,
  workpaperId: string,
  evidence: readonly TaxYearWindowEvidence[],
): Promise<void> {
  if (!UUID_RE.test(workpaperId)) throw new MacrsCalendarError("calendar citations require the applying tax workpaper id");
  const declared = normalizeTaxYearWindowEvidence(evidence);
  await lockAssetTaxLifecycle(tx, orgId, declared.map((row) => row.subsidiaryId));
  const paper = (await tx.execute<{
    regime: string; computed: Record<string, unknown>; created_by: string;
  }>(sql`
    select regime, computed, created_by from tax_asset_basis_workpapers
     where org_id=${orgId} and id=${workpaperId} for update`)).rows[0];
  if (!paper) throw new MacrsCalendarError("the applying tax workpaper could not be loaded; no calendar evidence was recorded");
  if (!Array.isArray(paper.computed.taxYearWindows)) {
    throw new MacrsCalendarError("the approved tax workpaper has no frozen calendar evidence; re-propose it with the registered years used by its calculation");
  }
  const approved = normalizeTaxYearWindowEvidence(paper.computed.taxYearWindows as TaxYearWindowEvidence[]);
  if (JSON.stringify(declared) !== JSON.stringify(approved)) {
    throw new MacrsCalendarError("the consumed tax-year windows do not match the independently approved workpaper; obtain a new approval");
  }
  for (const row of declared) {
    if (row.regime !== paper.regime) throw new MacrsCalendarError(`tax year ${row.id} belongs to ${row.regime}, not this workpaper's ${paper.regime}`);
    const current = (await tx.execute<{
      id: string; subsidiary_id: string; regime: string; year_start: string; year_end: string; filing_year: number;
    }>(sql`
      select id, subsidiary_id, regime, year_start::text, year_end::text, filing_year
        from tax_year_windows where org_id=${orgId} and id=${row.id} for share`)).rows[0];
    if (!current || JSON.stringify(row) !== JSON.stringify({
      id: current.id, subsidiaryId: current.subsidiary_id, regime: current.regime,
      yearStart: current.year_start, yearEnd: current.year_end, filingYear: current.filing_year,
    })) {
      throw new MacrsCalendarError(`tax year ${row.yearStart}–${row.yearEnd} changed after workpaper approval; reload the years and obtain a new approval`);
    }
  }
  const persisted = (await tx.execute<TaxYearWindowEvidence>(sql`
    select tax_year_window_id as id, subsidiary_id as "subsidiaryId", regime,
           year_start::text as "yearStart", year_end::text as "yearEnd", filing_year as "filingYear"
      from tax_basis_window_citations where org_id=${orgId} and workpaper_id=${workpaperId}`)).rows;
  if (persisted.length > 0) {
    if (JSON.stringify(normalizeTaxYearWindowEvidence(persisted)) !== JSON.stringify(declared)) {
      throw new MacrsCalendarError("persisted calendar citations differ from the approved workpaper; no existing evidence may be overwritten");
    }
    return; // Exact replay; every required citation is already observable.
  }
  for (const row of declared) {
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into tax_basis_window_citations
        (org_id, workpaper_id, tax_year_window_id, subsidiary_id, regime, year_start, year_end, filing_year, created_by)
      values (${orgId}, ${workpaperId}, ${row.id}, ${row.subsidiaryId}, ${row.regime},
              ${row.yearStart}, ${row.yearEnd}, ${row.filingYear}, ${paper.created_by})
      returning id`);
    if (inserted.rows.length !== 1) throw new MacrsCalendarError(`tax-year citation ${row.id} was not recorded; the workpaper cannot be applied`);
  }
}

/** Take the existing lifecycle fence BEFORE setup takes the window row lock.
 * Call within the same transaction as the mutation; preflight alone is not a fence. */
export async function lockTaxYearWindowWrite(
  tx: SqlExecutor,
  orgId: string,
  input: { id?: string; subsidiaryId?: string | null },
): Promise<void> {
  const existing = input.id && UUID_RE.test(input.id)
    ? (await tx.execute<{ subsidiary_id: string }>(sql`
        select subsidiary_id from tax_year_windows where org_id=${orgId} and id=${input.id}`)).rows[0]
    : undefined;
  const subsidiaries = [existing?.subsidiary_id, input.subsidiaryId]
    .filter((value): value is string => typeof value === "string" && UUID_RE.test(value));
  await lockAssetTaxLifecycle(tx, orgId, subsidiaries);
}

/** Authoritative MACRS/pool tax-year windows from the declared registry.
 * Book fiscal calendars, provision runs, and pool-period results are not
 * this calendar. */
export async function loadTaxYearWindows(
  tx: SqlExecutor,
  orgId: string,
  args: { subsidiaryId: string; regime: string; fromOn: string; throughOn: string },
): Promise<RegisteredMacrsYearWindow[]> {
  if (!isIsoCalendarDate(args.fromOn) || !isIsoCalendarDate(args.throughOn)) {
    throw new MacrsCalendarError(
      `tax year load ${args.fromOn}–${args.throughOn} requires calendar days; do not invent book period bounds`,
    );
  }
  if (args.fromOn > args.throughOn) {
    throw new MacrsCalendarError(
      `tax year load ${args.fromOn}–${args.throughOn} ends before it starts`,
    );
  }
  const rows = (
    await tx.execute<{
      id: string;
      filing_year: number;
      year_start: string;
      year_end: string;
    }>(sql`
      select id, filing_year, year_start::text, year_end::text
        from tax_year_windows
       where org_id=${orgId}
         and subsidiary_id=${args.subsidiaryId}
         and regime=${args.regime}
         and year_end>=${args.fromOn}
         and year_start<=${args.throughOn}
       order by year_start, year_end`)
  ).rows;
  try {
    const mapped = rows.map((row): RegisteredMacrsYearWindow => ({
      id: row.id, subsidiaryId: args.subsidiaryId, regime: args.regime,
      taxYear: row.filing_year, yearStart: row.year_start, yearEnd: row.year_end,
    }));
    assertMacrsWindowsCover(mapped, args.fromOn, args.throughOn);
    // The next contiguous year can determine a short year's convention date.
    // Return it as context; callers still stop deductions at the requested year.
    const last = mapped.at(-1)!;
    const nextStart = nextCalendarDay(last.yearEnd);
    if (!isShortTaxYear(last.yearStart, last.yearEnd) || nextStart.slice(0, 7) !== last.yearEnd.slice(0, 7)) return mapped;
    const successor = (await tx.execute<{
      id: string; filing_year: number; year_start: string; year_end: string;
    }>(sql`
      select id, filing_year, year_start::text, year_end::text from tax_year_windows
       where org_id=${orgId} and subsidiary_id=${args.subsidiaryId} and regime=${args.regime}
         and year_start=${nextStart} limit 1`)).rows[0];
    if (successor) mapped.push({
      id: successor.id, subsidiaryId: args.subsidiaryId, regime: args.regime,
      taxYear: successor.filing_year, yearStart: successor.year_start, yearEnd: successor.year_end,
    });
    return mapped;
  } catch (error) {
    throw error instanceof Error ? new MacrsCalendarError(error.message) : error;
  }
}

export async function listTaxYearWindows(
  tx: SqlExecutor,
  orgId: string,
  args: { subsidiaryId: string; regime: string },
): Promise<TaxYearWindow[]> {
  const rows = (
    await tx.execute<{
      id: string;
      subsidiary_id: string;
      regime: string;
      year_start: string;
      year_end: string;
      filing_year: number;
      reason: string;
    }>(sql`
      select id, subsidiary_id, regime, year_start::text, year_end::text,
             filing_year, reason
        from tax_year_windows
       where org_id=${orgId}
         and subsidiary_id=${args.subsidiaryId}
         and regime=${args.regime}
       order by year_start, year_end`)
  ).rows;
  return rows.map((row) => ({
    id: row.id,
    subsidiaryId: row.subsidiary_id,
    regime: row.regime,
    yearStart: row.year_start,
    yearEnd: row.year_end,
    filingYear: row.filing_year,
    reason: row.reason,
  }));
}

export async function resolveTaxYearWindow(
  tx: SqlExecutor,
  orgId: string,
  args: {
    subsidiaryId: string;
    regime: string;
    windowId?: string | null;
    yearStart?: string | null;
    yearEnd?: string | null;
  },
): Promise<TaxYearWindow> {
  if (args.windowId) {
    if (!UUID_RE.test(args.windowId)) {
      throw new MacrsCalendarError(
        "taxYearWindowId must be a declared tax year window; do not invent a free-form year",
      );
    }
    const row = (
      await tx.execute<{
        id: string;
        subsidiary_id: string;
        regime: string;
        year_start: string;
        year_end: string;
        filing_year: number;
        reason: string;
      }>(sql`
        select id, subsidiary_id, regime, year_start::text, year_end::text,
               filing_year, reason
          from tax_year_windows
         where org_id=${orgId} and id=${args.windowId}
           and subsidiary_id=${args.subsidiaryId} and regime=${args.regime}
         limit 1`)
    ).rows[0];
    if (!row) {
      throw new MacrsCalendarError(
        `tax year window ${args.windowId} is not declared for this legal entity and regime; select a configured year — do not pass a free-form range`,
      );
    }
    if (args.yearStart && args.yearStart !== row.year_start) {
      throw new MacrsCalendarError(
        `year start ${args.yearStart} does not match declared window ${row.year_start}–${row.year_end}; select the configured year — do not rewrite its dates`,
      );
    }
    if (args.yearEnd && args.yearEnd !== row.year_end) {
      throw new MacrsCalendarError(
        `year end ${args.yearEnd} does not match declared window ${row.year_start}–${row.year_end}; select the configured year — do not rewrite its dates`,
      );
    }
    return {
      id: row.id,
      subsidiaryId: row.subsidiary_id,
      regime: row.regime,
      yearStart: row.year_start,
      yearEnd: row.year_end,
      filingYear: row.filing_year,
      reason: row.reason,
    };
  }
  if (!args.yearStart || !args.yearEnd) {
    throw new MacrsCalendarError(
      "a tax pool run must identify a declared tax year by window id or exact yearStart/yearEnd; do not default January–December",
    );
  }
  const row = (
    await tx.execute<{
      id: string;
      subsidiary_id: string;
      regime: string;
      year_start: string;
      year_end: string;
      filing_year: number;
      reason: string;
    }>(sql`
      select id, subsidiary_id, regime, year_start::text, year_end::text,
             filing_year, reason
        from tax_year_windows
       where org_id=${orgId}
         and subsidiary_id=${args.subsidiaryId}
         and regime=${args.regime}
         and year_start=${args.yearStart}
         and year_end=${args.yearEnd}
       limit 1`)
  ).rows[0];
  if (!row) {
    throw new MacrsCalendarError(
      `run window ${args.yearStart}–${args.yearEnd} is not a declared tax year for this entity and regime; select a configured year on Fixed Assets tax-year setup — do not pass a free-form range`,
    );
  }
  return {
    id: row.id,
    subsidiaryId: row.subsidiary_id,
    regime: row.regime,
    yearStart: row.year_start,
    yearEnd: row.year_end,
    filingYear: row.filing_year,
    reason: row.reason,
  };
}

/** Setup-write problem string, pay-schedules shape. Null is accepted. */
export async function taxYearWindowWriteProblem(
  runner: SqlExecutor,
  orgId: string,
  input: TaxYearWindowWrite,
): Promise<string | null> {
  try {
    await assertTaxYearWindowWrite(runner, orgId, input);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "tax year window is not valid";
  }
}

export async function assertTaxYearWindowWrite(
  runner: SqlExecutor,
  orgId: string,
  input: TaxYearWindowWrite,
): Promise<TaxYearWindowWrite & {
  subsidiaryId: string;
  regime: string;
  yearStart: string;
  yearEnd: string;
  filingYear: number;
  reason: string;
}> {
  await lockTaxYearWindowWrite(runner, orgId, input);
  const existing = input.id
    ? (
        await runner.execute<{
          id: string;
          subsidiary_id: string;
          regime: string;
          year_start: string;
          year_end: string;
          filing_year: number;
          reason: string;
        }>(sql`
          select id, subsidiary_id, regime, year_start::text, year_end::text,
                 filing_year, reason
            from tax_year_windows
           where org_id=${orgId} and id=${input.id}
           limit 1`)
      ).rows[0]
    : null;
  if (input.id && !existing) {
    throw new MacrsCalendarError(
      "that tax year window could not be loaded; refresh and edit the declared year — do not invent an id",
    );
  }

  const subsidiaryId = input.subsidiaryId !== undefined
    ? (input.subsidiaryId ? String(input.subsidiaryId) : "")
    : existing?.subsidiary_id ?? "";
  const regime = input.regime !== undefined
    ? String(input.regime ?? "").trim()
    : existing?.regime ?? "";
  const yearStart = input.yearStart !== undefined
    ? String(input.yearStart ?? "")
    : existing?.year_start ?? "";
  const yearEnd = input.yearEnd !== undefined
    ? String(input.yearEnd ?? "")
    : existing?.year_end ?? "";
  const filingYear = input.filingYear !== undefined
    ? input.filingYear
    : existing?.filing_year ?? null;
  const reason = input.reason !== undefined
    ? String(input.reason ?? "").trim()
    : existing?.reason ?? "";

  const subsidiaryProblem = await taxYearWindowSubsidiaryProblem(runner, orgId, subsidiaryId);
  if (subsidiaryProblem) throw new MacrsCalendarError(subsidiaryProblem);

  if (!regime) {
    throw new MacrsCalendarError(
      "a tax year window must name the depreciation regime it belongs to; choose the regime — do not leave it empty",
    );
  }
  const known = TAX_DEPRECIATION_REGIMES[regime]
    ?? (
      await runner.execute<{ code: string }>(sql`
        select code from tax_regimes
         where org_id=${orgId} and code=${regime} and is_active
         limit 1`)
    ).rows[0];
  if (!known) {
    throw new MacrsCalendarError(
      `regime ${regime} is not an installed tax depreciation regime; install it on Fixed Assets setup — do not invent a calendar for an unknown code`,
    );
  }
  if (!isIsoCalendarDate(yearStart) || !isIsoCalendarDate(yearEnd)) {
    throw new MacrsCalendarError(
      "tax year start and end must be real calendar days (YYYY-MM-DD); do not invent book period bounds",
    );
  }
  if (yearStart > yearEnd) {
    throw new MacrsCalendarError("tax year start must not follow year end");
  }
  if (
    typeof filingYear !== "number"
    || !Number.isInteger(filingYear)
    || filingYear < 1900
    || filingYear > 9999
  ) {
    throw new MacrsCalendarError(
      "filingYear is a label for the declared window and must be a whole year from 1900 to 9999; it may repeat when two short years end in the same calendar year",
    );
  }
  if (reason.length < 8 || reason.length > 4000) {
    throw new MacrsCalendarError(
      "reason is required evidence for the declared tax year (first year, year-end change, final year); write at least 8 characters — do not leave the year unexplained",
    );
  }

  if (existing) {
    const cited = await taxYearWindowCitationCount(runner, orgId, existing.id);
    if (subsidiaryId !== existing.subsidiary_id || regime !== existing.regime || yearStart !== existing.year_start) {
      throw new MacrsCalendarError(
        cited > 0
          ? `tax year window ${existing.year_start}–${existing.year_end} already has a computed pool result or applied tax workpaper; its legal entity, regime, and year start cannot be rewritten. Re-run that same year from Fixed Assets tax pools if it is the latest computed year for the regime — there is no reversal of a computed tax year`
          : "a tax year window's legal entity, regime, and year start are its identity and cannot be rewritten; delete this unused window on Fixed Assets tax-year setup and declare the correct year",
      );
    }
    if ((yearEnd !== existing.year_end || filingYear !== existing.filing_year) && cited > 0) {
      throw new MacrsCalendarError(
        `tax year window ${existing.year_start}–${existing.year_end} already has a computed pool result or applied tax workpaper; its dates are frozen, as is its filing label. Re-run that same year from Fixed Assets tax pools if it is the latest computed year for the regime — there is no reversal of a computed tax year`,
      );
    }
  }

  const overlap = (
    await runner.execute<{ id: string; year_start: string; year_end: string }>(sql`
      select id, year_start::text, year_end::text
        from tax_year_windows
       where org_id=${orgId}
         and subsidiary_id=${subsidiaryId}
         and regime=${regime}
         and (${existing?.id ?? null}::uuid is null or id<>${existing?.id ?? null})
         and daterange(year_start, year_end, '[]') && daterange(${yearStart}::date, ${yearEnd}::date, '[]')
       order by year_start
       limit 1`)
  ).rows[0];
  if (overlap) {
    throw new MacrsCalendarError(
      `tax year windows overlap ${overlap.year_start}–${overlap.year_end} and ${yearStart}–${yearEnd}; correct the declared years — do not min/max them together`,
    );
  }

  return {
    ...input,
    subsidiaryId,
    regime,
    yearStart,
    yearEnd,
    filingYear,
    reason,
  };
}

export async function ensureTaxYearWindow(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  input: TaxYearWindowWrite,
): Promise<TaxYearWindow> {
  if (input.subsidiaryId && input.regime && input.yearStart && input.yearEnd) {
    try {
      return await resolveTaxYearWindow(runner, orgId, {
        subsidiaryId: String(input.subsidiaryId),
        regime: String(input.regime),
        yearStart: String(input.yearStart),
        yearEnd: String(input.yearEnd),
      });
    } catch (error) {
      if (!(error instanceof MacrsCalendarError)) throw error;
    }
  }
  try {
    return await insertTaxYearWindow(runner, orgId, actorId, input);
  } catch {
    return resolveTaxYearWindow(runner, orgId, {
      subsidiaryId: String(input.subsidiaryId ?? ""),
      regime: String(input.regime ?? ""),
      yearStart: String(input.yearStart ?? ""),
      yearEnd: String(input.yearEnd ?? ""),
    });
  }
}

export async function insertTaxYearWindow(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  input: TaxYearWindowWrite,
): Promise<TaxYearWindow> {
  const valid = await assertTaxYearWindowWrite(runner, orgId, input);
  const row = (
    await runner.execute<{
      id: string;
      subsidiary_id: string;
      regime: string;
      year_start: string;
      year_end: string;
      filing_year: number;
      reason: string;
    }>(sql`
      insert into tax_year_windows (
        org_id, subsidiary_id, regime, year_start, year_end, filing_year, reason,
        created_by, updated_by
      ) values (
        ${orgId}, ${valid.subsidiaryId}, ${valid.regime}, ${valid.yearStart},
        ${valid.yearEnd}, ${valid.filingYear}, ${valid.reason}, ${actorId}, ${actorId}
      )
      returning id, subsidiary_id, regime, year_start::text, year_end::text,
                filing_year, reason`)
  ).rows[0];
  if (!row) {
    throw new MacrsCalendarError(
      "the tax year window write matched no row; refresh and declare the year again — do not report success for an unreadable save",
    );
  }
  return {
    id: row.id,
    subsidiaryId: row.subsidiary_id,
    regime: row.regime,
    yearStart: row.year_start,
    yearEnd: row.year_end,
    filingYear: row.filing_year,
    reason: row.reason,
  };
}

/**
 * Named delete refusal. A cited window is blocked by FK, but a 23503 is not
 * a remedy. Unused windows may be deleted from Fixed Assets tax-year setup;
 * a computed year cannot be reversed or uncomputed.
 */
export async function taxYearWindowDeleteProblem(
  runner: SqlExecutor,
  orgId: string,
  windowId: string,
): Promise<string | null> {
  if (!UUID_RE.test(windowId)) return "that tax year window could not be loaded";
  await lockTaxYearWindowWrite(runner, orgId, { id: windowId });
  const existing = (
    await runner.execute<{ year_start: string; year_end: string }>(sql`
      select year_start::text, year_end::text
        from tax_year_windows
       where org_id=${orgId} and id=${windowId}
       limit 1`)
  ).rows[0];
  if (!existing) return "that tax year window could not be loaded";
  const cited = await taxYearWindowCitationCount(runner, orgId, windowId);
  if (cited > 0) {
    return `tax year window ${existing.year_start}–${existing.year_end} already has a computed pool result or applied tax workpaper and cannot be deleted. Re-run that same year from Fixed Assets tax pools if it is the latest computed year for the regime — there is no reversal of a computed tax year`;
  }
  return null;
}

async function taxYearWindowCitationCount(
  runner: SqlExecutor,
  orgId: string,
  windowId: string,
): Promise<number> {
  return (
    await runner.execute<{ n: number }>(sql`
      select (
        (select count(*) from tax_pool_periods where org_id=${orgId} and tax_year_window_id=${windowId})
        + (select count(*) from tax_basis_window_citations where org_id=${orgId} and tax_year_window_id=${windowId})
      )::int as n`)
  ).rows[0]?.n ?? 0;
}

/**
 * Legal-entity ownership for a tax year window. Always required.
 * multiSubsidiary off: only the company's sole/root active legal entity.
 * Always same org, active, non-elimination. Not a second feature toggle.
 */
export async function taxYearWindowSubsidiaryProblem(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string | null | undefined,
): Promise<string | null> {
  if (!subsidiaryId) {
    return "a tax year window must name the legal entity it belongs to; choose the company — do not leave subsidiaryId empty";
  }
  if (!UUID_RE.test(subsidiaryId)) {
    return "choose an active legal entity from this organization";
  }
  const row = (
    await runner.execute<{
      id: string;
      is_active: boolean;
      is_elimination: boolean;
    }>(sql`
      select id, is_active, is_elimination
        from subsidiaries
       where org_id=${orgId} and id=${subsidiaryId}
       limit 1`)
  ).rows[0];
  if (!row) return "choose an active legal entity from this organization";
  if (!row.is_active) return "choose an active legal entity from this organization";
  if (row.is_elimination) {
    return "tax year windows cannot be owned by an elimination subsidiary; choose an operating legal entity";
  }
  if (await multiSubsidiaryEnabled(runner, orgId)) return null;
  const company = await companyLegalEntity(runner, orgId);
  if (company.status === "missing") {
    return "this organization has no active legal entity to own tax year windows; create the company first";
  }
  if (company.status === "ambiguous") {
    return "tax year windows belong to this company's root legal entity; this organization has more than one active entity and the company root is not unique — do not guess";
  }
  if (subsidiaryId !== company.id) {
    return `tax year windows belong to this company's legal entity ${company.id}; another entity is not valid while only one company is configured — do not invent a second tax calendar`;
  }
  return null;
}

async function multiSubsidiaryEnabled(runner: SqlExecutor, orgId: string): Promise<boolean> {
  const row = (
    await runner.execute<{ features: FeatureState | null }>(sql`
      select settings->'features' as features from orgs where id=${orgId}`)
  ).rows[0];
  if (!row) return false;
  return dataDependentFeatureDefault(runner, orgId, "multiSubsidiary", row.features);
}

async function companyLegalEntity(
  runner: SqlExecutor,
  orgId: string,
): Promise<
  | { status: "ready"; id: string }
  | { status: "missing" }
  | { status: "ambiguous" }
> {
  const rows = (
    await runner.execute<{ id: string; parent_id: string | null }>(sql`
      select id, parent_id
        from subsidiaries
       where org_id=${orgId} and is_active and not is_elimination
       order by parent_id nulls first, created_at, id`)
  ).rows;
  if (rows.length === 0) return { status: "missing" };
  if (rows.length === 1) return { status: "ready", id: rows[0]!.id };
  const roots = rows.filter((row) => row.parent_id == null);
  if (roots.length === 1) return { status: "ready", id: roots[0]!.id };
  return { status: "ambiguous" };
}
