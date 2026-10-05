import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { lookupSpotRateWithEvidence } from "../fx/spot-rate.ts";
import { add, cmp, mulRate } from "../money/money.ts";
import { CrossBorderTaxError } from "./cross-border-place-of-supply.ts";

/**
 * Pre-posting supply-evidence monitor: the same disagreement that refuses a
 * cross-border post (two location signals naming different countries) is
 * surfaced here while the document is still a draft, so the operator fixes
 * the evidence before posting instead of learning about it from a refusal.
 * The posting path stays authoritative; this queue only reads.
 */

export interface SupplyEvidenceConflict {
  documentId: string;
  documentNumber: string;
  kind: string;
  documentDate: string;
  /** Distinct countries the collected signals assert, sorted. */
  countries: string[];
  /** The disagreeing signals, for the in-context fix on the document. */
  evidence: { kind: string; country: string }[];
}

/**
 * Unposted documents (draft or approved) electing cross-border treatment
 * whose collected location signals name more than one country. Posted,
 * voided and refused documents are out: posted history already carries its
 * frozen verdict, and voided documents leave through corrections.
 */
export async function findSupplyEvidenceConflicts(
  runner: SqlExecutor,
  orgId: string,
): Promise<SupplyEvidenceConflict[]> {
  const rows = (
    await runner.execute<{
      documentId: string;
      documentNumber: string;
      kind: string;
      documentDate: string;
      countries: string[];
      signals: { kind: string; country: string }[];
    }>(sql`
      with conflicted as (
        select e.document_id
          from document_supply_evidence e
          join documents d on d.org_id = e.org_id and d.id = e.document_id
         where e.org_id = ${orgId}
           and d.kind in ('customer_invoice', 'customer_credit')
           and d.status in ('draft', 'approved')
           and d.custom -> 'crossBorder' ->> 'supplyKind' is not null
         group by e.document_id
        having count(distinct e.country_code) > 1
      )
      select d.id as "documentId", d.document_number as "documentNumber",
             d.kind, d.document_date::text as "documentDate",
             (select coalesce(array_agg(distinct e2.country_code order by e2.country_code), '{}')
                from document_supply_evidence e2
               where e2.org_id = ${orgId} and e2.document_id = d.id) as countries,
             (select coalesce(json_agg(json_build_object('kind', e3.kind, 'country', e3.country_code)
                                       order by e3.kind, e3.country_code), '[]')
                from document_supply_evidence e3
               where e3.org_id = ${orgId} and e3.document_id = d.id) as signals
        from documents d
        join conflicted c on c.document_id = d.id
       where d.org_id = ${orgId}
       order by d.document_date, d.document_number`)
  ).rows;
  return rows.map((row) => ({
    documentId: row.documentId,
    documentNumber: row.documentNumber,
    kind: row.kind,
    documentDate: row.documentDate,
    countries: [...row.countries],
    evidence: (row.signals as { kind: string; country: string }[]).map((signal) => ({
      kind: signal.kind,
      country: signal.country,
    })),
  }));
}

export interface DistanceTurnoverTranslation {
  currency: string;
  baseAmount: string;
  rate: string;
  rateAsOf: string;
  rateSource: string;
}

export interface DistanceTurnover {
  year: number;
  /** Covered turnover in euro (posted B2C base, credits netted). */
  totalEur: string;
  threshold: "10000.0000";
  crossed: boolean;
  /** Per-currency translation evidence behind the euro total. */
  translated: DistanceTurnoverTranslation[];
  /**
   * Currencies with posted turnover but no ECB rate on or before the window
   * end: the total excludes them, so the monitor names what is missing and
   * how to complete it instead of reporting a silently partial figure.
   */
  uncoveredCurrencies: string[];
}

/**
 * Year-to-date distance-sales turnover for the EUR 10,000 threshold: posted
 * B2C invoices and credits with a frozen customer-country verdict, goods and
 * digital services combined, taxable base excluding VAT. Non-euro documents
 * translate at the ECB spot rate on the last published day on or before the
 * window end (the OSS conversion doctrine); a currency with no rate is
 * reported uncovered, never converted at a guessed rate or silently dropped.
 */
export async function computeDistanceTurnover(
  runner: SqlExecutor,
  orgId: string,
  year: number,
  today = new Date().toISOString().slice(0, 10),
): Promise<DistanceTurnover> {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new CrossBorderTaxError("assess the distance-sales threshold for a four-digit calendar year");
  }
  const windowEnd = today < `${year}-12-31` && today >= `${year}-01-01` ? today : `${year}-12-31`;
  const rows = (
    await runner.execute<{ currency: string; base: string }>(sql`
      select d.currency as currency,
             sum(case when d.kind = 'customer_credit' then -component.taxable_amount
                      else component.taxable_amount end)::text as base
        from documents d
        join document_lines line
          on line.org_id = d.org_id and line.document_id = d.id
        join document_line_tax_components component
          on component.org_id = d.org_id and component.document_line_id = line.id
       where d.org_id = ${orgId}
         and d.kind in ('customer_invoice', 'customer_credit')
         and d.status = 'posted'
         and d.document_date between ${`${year}-01-01`}::date and ${windowEnd}::date
         and d.custom -> 'crossBorderSupply' ->> 'outcome' = 'customer_country'
         and component.calculation_type = 'standard'
       group by d.currency`)
  ).rows;
  const translated: DistanceTurnoverTranslation[] = [];
  const uncovered: string[] = [];
  let total = "0.0000";
  for (const row of rows.sort((a, b) => a.currency.localeCompare(b.currency))) {
    if (row.currency === "EUR") {
      total = add(total, row.base);
      continue;
    }
    const evidence = await lookupSpotRateWithEvidence(runner, orgId, row.currency, "EUR", windowEnd);
    if (evidence.rate === null) {
      uncovered.push(row.currency);
      continue;
    }
    total = add(total, mulRate(row.base, evidence.rate));
    translated.push({
      currency: row.currency,
      baseAmount: row.base,
      rate: evidence.rate,
      rateAsOf: evidence.observations[0]?.asOf ?? windowEnd,
      rateSource: evidence.observations[0]?.source ?? "unknown",
    });
  }
  return {
    year,
    totalEur: total,
    threshold: "10000.0000",
    crossed: cmp(total, "10000.0000") >= 0,
    translated,
    uncoveredCurrencies: uncovered,
  };
}
