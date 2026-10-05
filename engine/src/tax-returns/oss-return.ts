import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { calendarQuarterBounds, endOfMonth, startOfMonth } from "../platform/civil-date.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { CrossBorderTaxError } from "../tax/cross-border-place-of-supply.ts";

/**
 * One-Stop-Shop returns from posted cross-border supplies.
 *
 * A Union (or non-Union) OSS return covers one calendar quarter, IOSS one
 * calendar month, grouping posted B2C supplies by member state of consumption
 * and VAT rate. Supplies post with their place-of-supply verdict frozen on
 * the document; this return reads that record — it never re-judges history.
 * Credits and voids posted in a later period return as correction lines for
 * the original quarter; posted history itself is never rewritten.
 *
 * Amounts file in euro. Documents in another currency are refused by name:
 * translating them needs an explicit FX policy the filer owns, and reporting
 * foreign-currency figures as euro would be a silent lie.
 *
 * Export today is the generic EU OSS semicolon CSV layout. Member-state
 * portal formats (for example file uploads with national line schemas)
 * are not implemented; the CSV carries every filed figure for hand-keying.
 */

export type OssScheme = "union" | "non_union" | "ioss";

export interface OssReturnRequest {
  scheme: OssScheme;
  from: string;
  to: string;
  /** Pin the registration; otherwise the single covering registration applies. */
  registrationId?: string | null;
}

export interface OssReturnLine {
  consumptionCountry: string;
  ratePercent: string;
  baseAmount: string;
  taxAmount: string;
  kind: "supply" | "correction";
  /** Original quarter (2026-Q3) for corrections, null for current supplies. */
  correctionQuarter: string | null;
}

export interface OssReturn {
  scheme: OssScheme;
  identificationState: string;
  registrationNumber: string;
  from: string;
  to: string;
  currency: "EUR";
  lines: OssReturnLine[];
  totalBase: string;
  totalTax: string;
}

export function quarterLabel(isoDate: string): string {
  const year = isoDate.slice(0, 4);
  const month = Number(isoDate.slice(5, 7));
  return `${year}-Q${Math.ceil(month / 3)}`;
}

function demandPeriod(scheme: OssScheme, from: string, to: string): void {
  if (!isIsoCalendarDate(from) || !isIsoCalendarDate(to) || from > to) {
    throw new CrossBorderTaxError("provide the return period as YYYY-MM-DD dates with from on or before to");
  }
  if (scheme === "ioss") {
    if (from !== startOfMonth(from) || to !== endOfMonth(from)) {
      throw new CrossBorderTaxError(
        `IOSS returns cover one calendar month; use ${startOfMonth(from)} to ${endOfMonth(from)} for this period`,
      );
    }
    return;
  }
  const bounds = calendarQuarterBounds(from);
  if (from !== bounds.start || to !== bounds.end) {
    throw new CrossBorderTaxError(
      `Union OSS returns cover one calendar quarter; use ${bounds.start} to ${bounds.end} for this period`,
    );
  }
}

interface RegistrationRow {
  id: string;
  identificationState: string;
  registrationNumber: string;
}

interface AttributedLine {
  country: string;
  ratePercent: string;
  baseAmount: string;
  taxAmount: string;
  documentDate: string;
  /** Corrected document's date, else the line's own date. */
  originalDate: string;
}

function sumLines(lines: AttributedLine[], from: string): OssReturnLine[] {
  const buckets = new Map<string, { base: bigint; tax: bigint }>();
  const meta = new Map<string, { country: string; rate: string; kind: "supply" | "correction"; quarter: string | null }>();
  for (const line of lines) {
    const corrected = line.originalDate < from;
    const key = corrected
      ? `C|${quarterLabel(line.originalDate)}|${line.country}|${line.ratePercent}`
      : `S|${line.country}|${line.ratePercent}`;
    const bucket = buckets.get(key) ?? { base: 0n, tax: 0n };
    bucket.base += toUnits(line.baseAmount);
    bucket.tax += toUnits(line.taxAmount);
    buckets.set(key, bucket);
    if (!meta.has(key)) {
      meta.set(key, {
        country: line.country,
        rate: line.ratePercent,
        kind: corrected ? "correction" : "supply",
        quarter: corrected ? quarterLabel(line.originalDate) : null,
      });
    }
  }
  return [...buckets.entries()]
    .filter(([, amounts]) => amounts.base !== 0n || amounts.tax !== 0n)
    .map(([key, amounts]) => {
      const info = meta.get(key)!;
      return {
        consumptionCountry: info.country,
        ratePercent: info.rate,
        baseAmount: fromUnits(amounts.base),
        taxAmount: fromUnits(amounts.tax),
        kind: info.kind,
        correctionQuarter: info.quarter,
      };
    })
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        (a.correctionQuarter ?? "").localeCompare(b.correctionQuarter ?? "") ||
        a.consumptionCountry.localeCompare(b.consumptionCountry) ||
        a.ratePercent.localeCompare(b.ratePercent),
    );
}

/**
 * Compute the OSS return for one registration and period. Reads posted
 * documents only (status posted with a frozen customer-country verdict and
 * standard components); reverse-charge, domestic and manual supplies are out
 * of the OSS scope by construction. Names its book implicitly: finality is
 * the posted document, the same record the ledger posted from.
 */
export async function computeOssReturn(
  runner: SqlExecutor,
  orgId: string,
  request: OssReturnRequest,
): Promise<OssReturn> {
  demandPeriod(request.scheme, request.from, request.to);
  const registrations = (
    await runner.execute<RegistrationRow>(sql`
      select id, identification_state as "identificationState", registration_number as "registrationNumber"
        from tax_oss_registrations
       where org_id = ${orgId}
         and scheme = ${request.scheme}
         and is_active
         and effective_from <= ${request.to}::date
         and (effective_to is null or effective_to >= ${request.from}::date)
         ${request.registrationId ? sql`and id = ${request.registrationId}` : sql``}`)
  ).rows;
  if (registrations.length !== 1) {
    throw new CrossBorderTaxError(
      `register exactly one ${request.scheme === "ioss" ? "IOSS" : "Union OSS"} registration covering ${request.from} to ${request.to} in Tax setup before preparing this return`,
    );
  }
  const registration = registrations[0]!;

  // Current-period supplies: posted invoices and credits whose frozen verdict
  // prices them in the customer's state. A credit naming an older corrected
  // document attributes to that document's quarter below; every other credit
  // nets in its own period as a negative supply.
  const current = (
    await runner.execute<
      AttributedLine & { currency: string }
    >(sql`
      select (d.custom -> 'crossBorderSupply' ->> 'country') as country,
             component.rate_percent::text as "ratePercent",
             -- Invoices add to the return; credit memos post positive and
             -- reduce it, so the return signs them here, never in storage.
             (case when d.kind = 'customer_credit' then -component.taxable_amount else component.taxable_amount end)::text as "baseAmount",
             (case when d.kind = 'customer_credit' then -component.tax_amount else component.tax_amount end)::text as "taxAmount",
             d.document_date::text as "documentDate",
             coalesce(corrected.document_date::text, d.document_date::text) as "originalDate",
             d.currency as currency
        from documents d
        join document_lines line
          on line.org_id = d.org_id and line.document_id = d.id
        join document_line_tax_components component
          on component.org_id = d.org_id and component.document_line_id = line.id
        left join documents corrected
          on corrected.org_id = d.org_id
         and corrected.id = case
           when d.custom -> 'crossBorder' ->> 'correctsDocument' ~ '^[0-9a-fA-F-]{36}$'
           then (d.custom -> 'crossBorder' ->> 'correctsDocument')::uuid
         end
       where d.org_id = ${orgId}
         and d.kind in ('customer_invoice', 'customer_credit')
         and d.status = 'posted'
         and d.document_date between ${request.from}::date and ${request.to}::date
         and d.custom -> 'crossBorderSupply' ->> 'outcome' = 'customer_country'
         and component.calculation_type = 'standard'`)
  ).rows;
  const currencies = [...new Set(current.map((row) => row.currency))];
  if (currencies.length > 1 || (currencies.length === 1 && currencies[0] !== "EUR")) {
    throw new CrossBorderTaxError(
      `OSS returns file in euro but this period holds ${currencies.join(", ") || "no supplies"}; translate the documents to euro or file the foreign-currency supplies nationally`,
    );
  }

  // Voids posted away in this period: the voided supply leaves the filed
  // quarter through a correction, mirroring the credit treatment.
  const voided = (
    await runner.execute<AttributedLine>(sql`
      select (d.custom -> 'crossBorderSupply' ->> 'country') as country,
             component.rate_percent::text as "ratePercent",
             -- A void unwinds the document's economic effect: a voided
             -- invoice corrects negative, a voided credit corrects positive.
             (case when d.kind = 'customer_credit' then component.taxable_amount else -component.taxable_amount end)::text as "baseAmount",
             (case when d.kind = 'customer_credit' then component.tax_amount else -component.tax_amount end)::text as "taxAmount",
             d.document_date::text as "documentDate",
             d.document_date::text as "originalDate"
        from documents d
        join document_lines line
          on line.org_id = d.org_id and line.document_id = d.id
        join document_line_tax_components component
          on component.org_id = d.org_id and component.document_line_id = line.id
       where d.org_id = ${orgId}
         and d.kind in ('customer_invoice', 'customer_credit')
         and d.status = 'voided'
         and d.voided_at::date between ${request.from}::date and ${request.to}::date
         and d.document_date < ${request.from}::date
         and d.currency = 'EUR'
         and d.custom -> 'crossBorderSupply' ->> 'outcome' = 'customer_country'
         and component.calculation_type = 'standard'`)
  ).rows;

  const lines = sumLines(
    [...current, ...voided].map((row) => ({
      country: row.country,
      ratePercent: row.ratePercent,
      baseAmount: row.baseAmount,
      taxAmount: row.taxAmount,
      documentDate: row.documentDate,
      originalDate: row.originalDate,
    })),
    request.from,
  );
  let totalBase = 0n;
  let totalTax = 0n;
  for (const line of lines) {
    totalBase += toUnits(line.baseAmount);
    totalTax += toUnits(line.taxAmount);
  }
  return {
    scheme: request.scheme,
    identificationState: registration.identificationState,
    registrationNumber: registration.registrationNumber,
    from: request.from,
    to: request.to,
    currency: "EUR",
    lines,
    totalBase: fromUnits(totalBase),
    totalTax: fromUnits(totalTax),
  };
}

/** Exact half-up rounding from ledger scale to filing cents. */
export function toFilingCents(canonical: string): string {
  const units = toUnits(canonical);
  const sign = units < 0n ? -1n : 1n;
  const abs = units < 0n ? -units : units;
  const cents = (abs + 50n) / 100n;
  const signed = sign * cents;
  const absCents = signed < 0n ? -signed : signed;
  const euros = absCents / 100n;
  const remainder = (absCents % 100n).toString().padStart(2, "0");
  return `${signed < 0n ? "-" : ""}${euros}.${remainder}`;
}

/**
 * Generic EU OSS semicolon CSV: one row per consumption state and rate,
 * corrections flagged with their original quarter. Rates and amounts carry
 * two decimals as filed.
 */
export function ossReturnToCsv(oss: OssReturn): string {
  const header =
    "scheme;identification_state;registration_number;period_from;period_to;record;consumption_country;vat_rate;base_amount;vat_amount;correction_quarter";
  const rows = oss.lines.map((line) =>
    [
      oss.scheme,
      oss.identificationState,
      oss.registrationNumber,
      oss.from,
      oss.to,
      line.kind === "correction" ? "CORRECTION" : "CURRENT",
      line.consumptionCountry,
      toFilingCents(line.ratePercent),
      toFilingCents(line.baseAmount),
      toFilingCents(line.taxAmount),
      line.correctionQuarter ?? "",
    ].join(";"),
  );
  return [header, ...rows].join("\n");
}
