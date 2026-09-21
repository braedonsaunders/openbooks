import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { dataDependentFeatureDefault } from "../organization/feature-defaults.ts";
import type { FeatureState } from "../organization/feature-registry.ts";
import {
  assertMacrsWindowsCover,
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

export type TaxYearWindowEvidence = {
  id: string;
  subsidiaryId: string;
  regime: string;
  yearStart: string;
  yearEnd: string;
  filingYear: number;
};

export function taxYearWindowEvidence(
  window: Pick<MacrsYearWindow, "id" | "subsidiaryId" | "regime" | "taxYear" | "yearStart" | "yearEnd">,
): TaxYearWindowEvidence {
  if (!window.id || !window.subsidiaryId || !window.regime) {
    throw new MacrsCalendarError(
      "a tax year window citation requires the registered id, legal entity and regime; do not invent evidence from a filing-year label",
    );
  }
  return {
    id: window.id,
    subsidiaryId: window.subsidiaryId,
    regime: window.regime,
    yearStart: window.yearStart,
    yearEnd: window.yearEnd,
    filingYear: window.taxYear,
  };
}

export function freezeTaxYearWindowEvidence(
  windows: readonly TaxYearWindowEvidence[],
): TaxYearWindowEvidence[] {
  const seen = new Set<string>();
  const out: TaxYearWindowEvidence[] = [];
  for (const row of [...windows].sort((left, right) =>
    left.yearStart.localeCompare(right.yearStart)
    || left.yearEnd.localeCompare(right.yearEnd)
    || left.id.localeCompare(right.id)
  )) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/** Authoritative MACRS/pool tax-year windows from the declared registry.
 * Book fiscal calendars, provision runs, and pool-period results are not
 * this calendar. */
export async function loadTaxYearWindows(
  tx: SqlExecutor,
  orgId: string,
  args: { subsidiaryId: string; regime: string; fromOn: string; throughOn: string },
): Promise<MacrsYearWindow[]> {
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
      subsidiary_id: string;
      regime: string;
      filing_year: number;
      year_start: string;
      year_end: string;
    }>(sql`
      with covering as (
        select id, subsidiary_id, regime, filing_year, year_start, year_end
          from tax_year_windows
         where org_id=${orgId}
           and subsidiary_id=${args.subsidiaryId}
           and regime=${args.regime}
           and year_end>=${args.fromOn}
           and year_start<=${args.throughOn}
      )
      select id, subsidiary_id, regime, filing_year, year_start::text, year_end::text
        from covering
      union all
      select tw.id, tw.subsidiary_id, tw.regime, tw.filing_year,
             tw.year_start::text, tw.year_end::text
        from tax_year_windows tw
        join covering last
          on last.year_end = (select max(year_end) from covering)
         and tw.org_id=${orgId}
         and tw.subsidiary_id=${args.subsidiaryId}
         and tw.regime=${args.regime}
         and tw.year_start = last.year_end + 1
       order by year_start, year_end`)
  ).rows;
  try {
    return assertMacrsWindowsCover(
      rows.map((row) => ({
        id: row.id,
        subsidiaryId: row.subsidiary_id,
        regime: row.regime,
        taxYear: row.filing_year,
        yearStart: row.year_start,
        yearEnd: row.year_end,
      })),
      args.fromOn,
      args.throughOn,
    );
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

export async function citeTaxYearWindows(
  tx: SqlExecutor,
  orgId: string,
  workpaperId: string,
  evidence: readonly TaxYearWindowEvidence[],
): Promise<void> {
  if (!UUID_RE.test(workpaperId)) {
    throw new MacrsCalendarError(
      "citeTaxYearWindows requires the applied workpaper id; do not invent a citation without a paper",
    );
  }
  const paper = (
    await tx.execute<{ computed: Record<string, unknown> | null }>(sql`
      select computed from tax_asset_basis_workpapers
       where org_id=${orgId} and id=${workpaperId}
       limit 1`)
  ).rows[0];
  if (!paper) {
    throw new MacrsCalendarError(
      "that tax basis workpaper could not be loaded; cite the applied paper in the same transaction — do not persist an orphan citation",
    );
  }
  const frozen = paper.computed?.taxYearWindows;
  if (!Array.isArray(frozen)) {
    throw new MacrsCalendarError(
      "the applied workpaper is missing computed.taxYearWindows; freeze the exact windows read at propose — do not cite a live calendar",
    );
  }
  const expected = freezeTaxYearWindowEvidence(
    frozen.map((row) => taxYearWindowEvidence({
      id: String((row as TaxYearWindowEvidence).id ?? ""),
      subsidiaryId: String((row as TaxYearWindowEvidence).subsidiaryId ?? ""),
      regime: String((row as TaxYearWindowEvidence).regime ?? ""),
      taxYear: Number((row as TaxYearWindowEvidence).filingYear),
      yearStart: String((row as TaxYearWindowEvidence).yearStart ?? ""),
      yearEnd: String((row as TaxYearWindowEvidence).yearEnd ?? ""),
    })),
  );
  const supplied = freezeTaxYearWindowEvidence(evidence);
  if (JSON.stringify(expected) !== JSON.stringify(supplied)) {
    throw new MacrsCalendarError(
      "tax year window citations must match the frozen computed.taxYearWindows set; do not add, drop or rewrite a cited year after approval",
    );
  }
  for (const row of supplied) {
    const live = (
      await tx.execute<{
        subsidiary_id: string;
        regime: string;
        year_start: string;
        year_end: string;
        filing_year: number;
      }>(sql`
        select subsidiary_id, regime, year_start::text, year_end::text, filing_year
          from tax_year_windows
         where org_id=${orgId} and id=${row.id}
         limit 1`)
    ).rows[0];
    if (
      !live
      || live.subsidiary_id !== row.subsidiaryId
      || live.regime !== row.regime
      || live.year_start !== row.yearStart
      || live.year_end !== row.yearEnd
      || live.filing_year !== row.filingYear
    ) {
      throw new MacrsCalendarError(
        `tax year window ${row.yearStart}–${row.yearEnd} is not the live same-org window ${row.id}; cite the registered facts — do not persist a rewritten calendar`,
      );
    }
    const inserted = (
      await tx.execute<{ id: string }>(sql`
        insert into tax_year_window_citations (
          org_id, workpaper_id, tax_year_window_id, subsidiary_id, regime,
          year_start, year_end, filing_year
        ) values (
          ${orgId}, ${workpaperId}, ${row.id}, ${row.subsidiaryId}, ${row.regime},
          ${row.yearStart}, ${row.yearEnd}, ${row.filingYear}
        ) returning id`)
    ).rows[0];
    if (!inserted) {
      throw new MacrsCalendarError(
        `tax year window citation ${row.id} for workpaper ${workpaperId} matched no row; do not report a cite that cannot be read`,
      );
    }
  }
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
          ? `tax year window ${existing.year_start}–${existing.year_end} already has a computed pool result; its legal entity, regime, and year start cannot be rewritten. Re-run that same year from Fixed Assets tax pools if it is the latest computed year for the regime — there is no reversal of a computed tax year`
          : "a tax year window's legal entity, regime, and year start are its identity and cannot be rewritten; delete this unused window on Fixed Assets tax-year setup and declare the correct year",
      );
    }
    if (yearEnd !== existing.year_end && cited > 0) {
      throw new MacrsCalendarError(
        `tax year window ${existing.year_start}–${existing.year_end} already has a computed pool result; its dates are frozen. Re-run that same year from Fixed Assets tax pools if it is the latest computed year for the regime — there is no reversal of a computed tax year`,
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
    return `tax year window ${existing.year_start}–${existing.year_end} already has a computed pool result and cannot be deleted. Re-run that same year from Fixed Assets tax pools if it is the latest computed year for the regime — there is no reversal of a computed tax year`;
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
      select count(*)::int as n from tax_pool_periods
       where org_id=${orgId} and tax_year_window_id=${windowId}`)
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
