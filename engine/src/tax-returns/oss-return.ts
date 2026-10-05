import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { calendarQuarterBounds, endOfMonth, startOfMonth } from "../platform/civil-date.ts";
import { fromUnits, mulRate, toUnits } from "../money/money.ts";
import { lookupSpotRateWithEvidence } from "../fx/spot-rate.ts";
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
 * Amounts file in euro. Documents in another currency translate at the ECB
 * spot rate on the last published day on or before the period's last day
 * (the OSS conversion rule); the rate, its date and its reproducibility
 * digest travel on the return and are stored as filing evidence. A currency
 * with no rate refuses by name — reporting foreign-currency figures as euro
 * would be a silent lie, and so would converting at a guessed rate.
 *
 * Export is the generic EU OSS semicolon CSV layout plus the member-state
 * transport layouts in oss-exports.ts. Every layout carries every filed
 * figure for portal hand-keying or upload.
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
  /** ECB translation evidence per translated source currency; empty for euro-only periods. */
  fx: OssFxEvidence[];
}

/** One stored translation behind a filed euro figure. */
export interface OssFxEvidence {
  currency: string;
  /** Euro per unit of the source currency on the rate date. */
  rate: string;
  /** Last published ECB day on or before the period end. */
  rateAsOf: string;
  rateSource: string;
  /** Reproducibility digest over the observation set. */
  digest: string;
}

/** Signed-amount translation: ledger signs live on the amount, never in the rate. */
function translateSigned(amount: string, rate: string): string {
  const negative = amount.trim().startsWith("-");
  const magnitude = negative ? amount.trim().slice(1) : amount;
  const converted = mulRate(magnitude, rate);
  return negative ? `-${converted}` : converted;
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

type RegistrationRow = {
  id: string;
  identificationState: string;
  registrationNumber: string;
}

type AttributedLine = {
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
           when d.custom -> 'crossBorder' ->> 'correctsDocument' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           then (d.custom -> 'crossBorder' ->> 'correctsDocument')::uuid
         end
       where d.org_id = ${orgId}
         and d.kind in ('customer_invoice', 'customer_credit')
         and d.status = 'posted'
         and d.document_date between ${request.from}::date and ${request.to}::date
         and d.custom -> 'crossBorderSupply' ->> 'outcome' = 'customer_country'
         and component.calculation_type = 'standard'`)
  ).rows;
  // Foreign-currency supplies translate at the ECB spot rate on the last
  // published day on or before the period end — one rate per currency, so
  // every line in that currency converts identically and deterministically.
  const currencies = [...new Set(current.map((row) => row.currency))].sort();
  const fx: OssFxEvidence[] = [];
  const rates = new Map<string, string>();
  for (const currency of currencies) {
    if (currency === "EUR") continue;
    const evidence = await lookupSpotRateWithEvidence(runner, orgId, currency, "EUR", request.to);
    if (evidence.rate === null) {
      throw new CrossBorderTaxError(
        `OSS returns file in euro but this period holds ${currency} supplies with no ECB rate on or before ${request.to}; sync ECB rates (or add a manual spot rate) in FX setup, then prepare the return again`,
      );
    }
    rates.set(currency, evidence.rate);
    fx.push({
      currency,
      rate: evidence.rate,
      rateAsOf: evidence.observations[0]?.asOf ?? request.to,
      rateSource: evidence.observations[0]?.source ?? "unknown",
      digest: evidence.digest,
    });
  }
  const toEuro = (amount: string, currency: string): string => {
    const rate = rates.get(currency);
    return rate ? translateSigned(amount, rate) : amount;
  };

  // Voids posted away in this period: the voided supply leaves the filed
  // quarter through a correction, mirroring the credit treatment.
  const voided = (
    await runner.execute<AttributedLine & { currency: string }>(sql`
      select (d.custom -> 'crossBorderSupply' ->> 'country') as country,
             component.rate_percent::text as "ratePercent",
             -- A void unwinds the document's economic effect: a voided
             -- invoice corrects negative, a voided credit corrects positive.
             (case when d.kind = 'customer_credit' then component.taxable_amount else -component.taxable_amount end)::text as "baseAmount",
             (case when d.kind = 'customer_credit' then component.tax_amount else -component.tax_amount end)::text as "taxAmount",
             d.document_date::text as "documentDate",
             d.document_date::text as "originalDate",
             d.currency as currency
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
         and d.custom -> 'crossBorderSupply' ->> 'outcome' = 'customer_country'
         and component.calculation_type = 'standard'`)
  ).rows;
  for (const row of voided) {
    if (row.currency !== "EUR" && !rates.has(row.currency)) {
      const evidence = await lookupSpotRateWithEvidence(runner, orgId, row.currency, "EUR", request.to);
      if (evidence.rate === null) {
        throw new CrossBorderTaxError(
          `OSS returns file in euro but a voided correction holds ${row.currency} with no ECB rate on or before ${request.to}; sync ECB rates (or add a manual spot rate) in FX setup, then prepare the return again`,
        );
      }
      rates.set(row.currency, evidence.rate);
      fx.push({
        currency: row.currency,
        rate: evidence.rate,
        rateAsOf: evidence.observations[0]?.asOf ?? request.to,
        rateSource: evidence.observations[0]?.source ?? "unknown",
        digest: evidence.digest,
      });
    }
  }

  const lines = sumLines(
    [...current, ...voided].map((row) => ({
      country: row.country,
      ratePercent: row.ratePercent,
      baseAmount: toEuro(row.baseAmount, row.currency),
      taxAmount: toEuro(row.taxAmount, row.currency),
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
  fx.sort((a, b) => a.currency.localeCompare(b.currency));
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
    fx,
  };
}

/**
 * Store the return's translation evidence as filing evidence: one row per
 * period and source currency with the rate, its date and the digest that
 * reproduces the filed figures after provider rows change. Re-preparing a
 * period converges on these rows (upsert), so the conflict is expected and
 * benign; corrections still travel as return correction lines.
 */
export async function recordOssFxEvidence(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  oss: OssReturn,
): Promise<{ stored: number }> {
  let stored = 0;
  for (const entry of oss.fx) {
    const rows = (
      await runner.execute<{ id: string }>(sql`
        insert into tax_oss_fx_evidence
          (id, org_id, scheme, period_from, period_to, currency, rate,
           rate_as_of, rate_source, evidence_digest, created_by, updated_by)
        values (${randomUUID()}, ${orgId}, ${oss.scheme}, ${oss.from}::date, ${oss.to}::date,
                ${entry.currency}, ${entry.rate}, ${entry.rateAsOf}::date,
                ${entry.rateSource}, ${entry.digest}, ${actorId}, ${actorId})
        on conflict (org_id, scheme, period_from, period_to, currency) do update
           set rate = excluded.rate,
               rate_as_of = excluded.rate_as_of,
               rate_source = excluded.rate_source,
               evidence_digest = excluded.evidence_digest,
               updated_by = excluded.updated_by,
               updated_at = now()
        returning id`)
    ).rows;
    // A write that matches zero rows is a failure: evidence no read can
    // observe was not stored, and the filed figures would lose their proof.
    if (rows.length !== 1) {
      throw new CrossBorderTaxError(
        `the ECB translation evidence for ${entry.currency} was not stored; prepare the return again before filing`,
      );
    }
    stored += 1;
  }
  return { stored };
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
