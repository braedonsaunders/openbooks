import { isIsoCalendarDate } from "../platform/business-date.ts";

/** Kinds whose lines may defer an expense through an amortization template. */
export const AMORTIZABLE_LINE_KINDS: ReadonlySet<string> = new Set([
  "vendor_bill",
  "journal",
  "expense_report",
]);

export interface AmortizationLineFields {
  amortizationTemplateId?: string | null;
  amortizationStartOn?: string | null;
  amortizationEndOn?: string | null;
}

/** Shared draft contract; effective policy and account routing are resolved at posting. */
export function amortizationLineRefusal(kind: string, line: AmortizationLineFields): string | null {
  const templateId = line.amortizationTemplateId ?? null;
  const start = line.amortizationStartOn ?? null;
  const end = line.amortizationEndOn ?? null;
  if (templateId === null) {
    return start !== null || end !== null
      ? "choose an amortization template for the service dates, or clear the dates"
      : null;
  }
  if (!AMORTIZABLE_LINE_KINDS.has(kind))
    return "only vendor bill, journal and expense report lines can amortize";
  if (start !== null && !isIsoCalendarDate(start))
    return "the service start date must be a valid YYYY-MM-DD date";
  if (end !== null && !isIsoCalendarDate(end))
    return "the service end date must be a valid YYYY-MM-DD date";
  if (start !== null && end !== null && end < start)
    return "the service end date is before the service start date";
  return null;
}
