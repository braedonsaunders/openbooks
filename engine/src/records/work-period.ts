import { isIsoCalendarDate } from "../platform/iso-date.ts";

/**
 * The work period an invoice line bills and the date the invoiced work was
 * completed. A generated invoice line spans the earliest to the latest work
 * date of the sources it bills; the document's work-completed date is the
 * latest of its lines. Lines that bill no dated work (rate-card charges,
 * ceiling adjustments, draws) carry no period.
 */
export interface WorkPeriod {
  workFrom: string | null;
  workTo: string | null;
}

/** Span of the given work dates; nulls and blanks are ignored. */
export function workPeriodOf(dates: readonly (string | null | undefined)[]): WorkPeriod {
  let workFrom: string | null = null;
  let workTo: string | null = null;
  for (const date of dates) {
    if (!date) continue;
    if (workFrom === null || date < workFrom) workFrom = date;
    if (workTo === null || date > workTo) workTo = date;
  }
  return { workFrom, workTo };
}

/**
 * Work periods of presented invoice lines, from the detail lines behind them.
 * `presentedIndexOf[i]` names the presented line detail line `i` rolled into
 * (absent means it presents as itself).
 */
export function presentedWorkPeriods(
  detailDates: readonly (string | null | undefined)[],
  presentedIndexOf: readonly (number | undefined)[],
  presentedCount: number,
): WorkPeriod[] {
  const dates: (string | null | undefined)[][] = Array.from({ length: presentedCount }, () => []);
  detailDates.forEach((date, index) => {
    const target = presentedIndexOf[index] ?? index;
    dates[target]?.push(date);
  });
  return dates.map(workPeriodOf);
}

/** The document's work-completed date: the latest line work date. */
export function workCompletedOn(periods: readonly WorkPeriod[]): string | null {
  return workPeriodOf(periods.map((period) => period.workTo)).workTo;
}

/**
 * Validate an entered work period. Returns a refusal message, or null when
 * the pair is acceptable. Either bound may be absent; both present must be
 * ordered.
 */
export function workPeriodRefusal(workFrom: unknown, workTo: unknown): string | null {
  for (const [label, value] of [["work from", workFrom], ["work to", workTo]] as const) {
    if (value !== undefined && value !== null && (typeof value !== "string" || !isIsoCalendarDate(value))) {
      return `invalid ${label} date — expected YYYY-MM-DD`;
    }
  }
  if (typeof workFrom === "string" && typeof workTo === "string" && workTo < workFrom) {
    return "work to must be on or after work from";
  }
  return null;
}

/** Document kinds whose header and lines carry a work period. */
export const WORK_PERIOD_DOCUMENT_KINDS: ReadonlySet<string> = new Set(["customer_invoice", "customer_credit", "sales_order"]);

/**
 * Refusal for a submitted header work-completed date and line work periods,
 * or null when acceptable: real dates, ordered per line, and only on kinds
 * that bill work.
 */
export function documentWorkDatesRefusal(
  kind: string,
  workCompletedOn: unknown,
  lines: readonly { workFrom?: unknown; workTo?: unknown }[] | undefined,
): string | null {
  if (workCompletedOn !== undefined && workCompletedOn !== null && (typeof workCompletedOn !== "string" || !isIsoCalendarDate(workCompletedOn))) {
    return "invalid workCompletedOn — expected YYYY-MM-DD";
  }
  const lineList = lines ?? [];
  for (let index = 0; index < lineList.length; index++) {
    const refusal = workPeriodRefusal(lineList[index]!.workFrom, lineList[index]!.workTo);
    if (refusal) return `Line ${index + 1}: ${refusal}`;
  }
  const carries = (workCompletedOn ?? null) !== null
    || lineList.some((line) => (line.workFrom ?? null) !== null || (line.workTo ?? null) !== null);
  if (carries && !WORK_PERIOD_DOCUMENT_KINDS.has(kind)) {
    return "work dates apply only to customer invoices, customer credits and sales orders";
  }
  return null;
}
