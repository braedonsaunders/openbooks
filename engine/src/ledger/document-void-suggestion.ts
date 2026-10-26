import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import { arePeriodModulesOpen, canonicalPeriodLabel } from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { effectivePostingDate } from "../journal/posting-contracts.ts";
import { resolveVoidCalendarSubsidiaryId, voidCloseModule } from "./document-void-shared.ts";

/**
 * Where a void reversal belongs when the operator names no date. The entry's
 * own date keeps both sides of the reversal in the entry's fiscal year; only
 * a closed entry period moves the default forward, to the first open period
 * after it. Advisory only — completion re-asserts openness authoritatively,
 * so a period that closes between suggestion and approval still refuses with
 * its remedy instead of posting into a lock.
 */
export interface VoidReversalSuggestion {
  originalDate: string;
  suggestedDate: string;
  fallbackToOpenPeriod: boolean;
  originalFiscalYear: number | null;
  /** Canonical fiscal label (`P08 FY2026`) of the period the document posts in. */
  originalPeriodName: string | null;
  suggestedFiscalYear: number | null;
  /** Canonical fiscal label of the period the reversal is suggested into. */
  suggestedPeriodName: string | null;
  suggestedOpen: boolean;
}

export async function suggestVoidReversalDate(
  runner: SqlExecutor,
  orgId: string,
  doc: {
    id: string;
    kind: string;
    documentDate: string;
    postingDate?: string | null;
    subsidiaryId: string | null;
  },
): Promise<VoidReversalSuggestion> {
  const originalDate = effectivePostingDate({
    postingDate: doc.postingDate,
    documentDate: doc.documentDate,
  });
  const uncovered: VoidReversalSuggestion = {
    originalDate,
    suggestedDate: originalDate,
    fallbackToOpenPeriod: false,
    originalFiscalYear: null,
    originalPeriodName: null,
    suggestedFiscalYear: null,
    suggestedPeriodName: null,
    suggestedOpen: false,
  };
  const calendarSubsidiaryId = await resolveVoidCalendarSubsidiaryId(
    runner,
    orgId,
    doc.id,
    doc.subsidiaryId,
  );
  if (!calendarSubsidiaryId) return uncovered;
  const covering = await resolveCoveringPeriod(runner, orgId, originalDate, calendarSubsidiaryId);
  if (!covering) return uncovered;
  // The covering and later candidates are regular periods.
  const coveringLabel = canonicalPeriodLabel({
    fiscalYear: covering.fiscal_year,
    periodNumber: covering.period_number,
    adjustment: false,
  });
  const modules = [voidCloseModule(doc.kind)];
  const books = await runner.execute<{ bookId: string }>(
    sql`
    select distinct e.book_id as "bookId" from journal_entries e
     -- Live entries only: a reversed entry cannot be reversed again
     where e.org_id = ${orgId} and e.source_document_id = ${doc.id} and e.status = 'posted'`,
    "objects",
  );
  const lines = await runner.execute<{ subsidiaryId: string | null }>(
    sql`
    select distinct l.subsidiary_id as "subsidiaryId" from journal_lines l
     join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     -- Live entries only: a reversed entry cannot be reversed again
     where e.org_id = ${orgId} and e.source_document_id = ${doc.id} and e.status = 'posted'`,
    "objects",
  );
  const postedBookIds = [...new Set(books.map((row) => row.bookId))];
  const primaryBookId =
    postedBookIds.length > 0 ? null : await activePostingPrimaryBookId(orgId, runner);
  const bookIds = postedBookIds.length > 0 ? postedBookIds : primaryBookId ? [primaryBookId] : [];
  const subsidiaryIds = [
    ...new Set(
      (lines.length > 0 ? lines.map((row) => row.subsidiaryId) : [doc.subsidiaryId]).filter(
        (value): value is string => value != null,
      ),
    ),
  ];
  if (subsidiaryIds.length === 0) subsidiaryIds.push(calendarSubsidiaryId);
  const openIn = async (periodId: string): Promise<boolean> => {
    for (const bookId of bookIds) {
      if (
        !(await arePeriodModulesOpen(runner, { orgId, periodId, bookId, subsidiaryIds, modules }))
      )
        return false;
    }
    return true;
  };
  if (await openIn(covering.id)) {
    return {
      originalDate,
      suggestedDate: originalDate,
      fallbackToOpenPeriod: false,
      originalFiscalYear: covering.fiscal_year,
      originalPeriodName: coveringLabel,
      suggestedFiscalYear: covering.fiscal_year,
      suggestedPeriodName: coveringLabel,
      suggestedOpen: true,
    };
  }
  const later = await runner.execute<{
    id: string;
    fiscal_year: number;
    period_number: number;
    starts_on: string;
  }>(
    sql`
    select p.id, p.fiscal_year, p.period_number, p.starts_on::text as starts_on
      from accounting_periods p
      join fiscal_calendars fc
        on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
       and fc.is_active
       and fc.id = public.subsidiary_posting_calendar(${orgId}::uuid, ${calendarSubsidiaryId}::uuid, p.starts_on)
     where p.org_id = ${orgId} and not p.is_adjustment
       and p.starts_on > ${covering.ends_on}
     order by p.starts_on, p.ends_on, p.id
     limit 25`,
    "objects",
  );
  for (const candidate of later) {
    if (await openIn(candidate.id)) {
      return {
        originalDate,
        suggestedDate: candidate.starts_on,
        fallbackToOpenPeriod: true,
        originalFiscalYear: covering.fiscal_year,
        originalPeriodName: coveringLabel,
        suggestedFiscalYear: candidate.fiscal_year,
        suggestedPeriodName: canonicalPeriodLabel({
          fiscalYear: candidate.fiscal_year,
          periodNumber: candidate.period_number,
          adjustment: false,
        }),
        suggestedOpen: true,
      };
    }
  }
  return {
    originalDate,
    suggestedDate: originalDate,
    fallbackToOpenPeriod: false,
    originalFiscalYear: covering.fiscal_year,
    originalPeriodName: coveringLabel,
    suggestedFiscalYear: covering.fiscal_year,
    suggestedPeriodName: coveringLabel,
    suggestedOpen: false,
  };
}
