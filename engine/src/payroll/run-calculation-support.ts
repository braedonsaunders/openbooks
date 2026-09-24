/**
 * Calculation support queries: headcount, stored tax certificates, and the FX/pay-rate source.
 *
 * Extracted verbatim from engine/src/payroll/run.ts; bodies preserve exact
 * math, transaction/lock sequencing, and refusal identity.
 */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { type StoredCertificate } from "./certificates.ts";
import { effectivePayRateSql } from "./rate.ts";
import { convertLaborWage } from "../projects/labor-costing.ts";
import { type EntitlementWarning } from "./entitlements.ts";
export interface StubComputation {
  employeePartyId: string;
  province: string;
  gross: string;
  net: string;
  employerCost: string;
  errors: string[];
  /** Non-fatal entitlement notices (a bank at or over its scoped limit). */
  warnings: EntitlementWarning[];
  /**
   * Named, non-blocking advisories the statutory pass reported (a reciprocity
   * form to collect). Surfaced as run warnings — the commit gate binds to
   * refusals only, so a correct stub with advice still commits.
   */
  advisories: string[];
}

/**
 * Count the employer's employee population for jurisdiction rules that key off
 * headcount (Nebraska's special withholding procedure is one). This is not
 * the number paid on this run: an employer may have employees on another
 * schedule, and Nebraska's threshold applies to the employer as a whole.
 * The paying subsidiary is the legal-employer boundary, so employees of a
 * sibling entity can never activate this threshold accidentally.
 */
export async function employerEmployeeCount(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  subsidiaryId: string,
): Promise<number> {
  const result = await tx.execute<{ employee_count: string | number }>(sql`
    select count(distinct prof.employee_party_id)::int as employee_count
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
     where prof.org_id = ${orgId}
       and prof.is_active
       and p.is_active
       and p.subsidiary_id = ${subsidiaryId}
  `);
  const count = Number(result.rows[0]?.employee_count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new PayrollError(
      `the paying employer's employee headcount is invalid (${String(result.rows[0]?.employee_count)})`,
    );
  }
  return count;
}

/**
 * Every tax certificate this employee has on file, as `resolveCertificate`
 * reads them.
 *
 * Generic: `employee_tax_certificates` is a pack-agnostic table (the pack's own
 * certificate key, the pack's own region vocabulary), so this query names no
 * country and no form. Superseded rows are LEFT IN — `resolveCertificate` picks
 * the one in force on the pay date, which is what lets a prior period re-run
 * against the certificate that was actually signed then rather than the one
 * that replaced it.
 */
export async function storedTaxCertificates(
  tx: Pick<typeof db, "execute">, orgId: string, employeePartyId: string, country: string,
): Promise<StoredCertificate[]> {
  const r = (await tx.execute<{
      certificate_key: string; region: string | null; sub_region: string | null;
      answers: Record<string, string> | null;
      effective_from: string | null; superseded_on: string | null;
    }>(sql`
    select certificate_key, region, sub_region, answers, effective_from::text as effective_from,
           superseded_on::text as superseded_on
      from employee_tax_certificates
     where org_id = ${orgId} and employee_party_id = ${employeePartyId} and country = ${country}
  `));
  return r.rows.map((row) => ({
    certificateKey: row.certificate_key,
    region: row.region,
    subRegion: row.sub_region,
    answers: row.answers ?? {},
    effectiveFrom: row.effective_from,
    supersededOn: row.superseded_on,
  }));
}

/**
 * Employee-scope pay rate straight from labor_cost_rates (one-table doctrine),
 * CONVERTED to the currency the run pays in.
 *
 * labor_cost_rates carries its own `currency`; the pay run is denominated in
 * its subsidiary's functional currency. Returning the raw rate and ignoring
 * the difference is not a rounding problem, it is a wrong cheque: a CAD 60.00
 * wage row paid by a USD entity paid USD 60.00 an hour — 37% over — and
 * nothing detected it, because both GL legs used the same inflated number and
 * the projection balanced perfectly.
 *
 * A missing spot rate THROWS, exactly as `recomputeCostRates` does for the
 * costing side of the same wage. Paying an unconverted wage silently is the
 * failure mode; refusing to calculate until somebody enters the rate is the
 * correct one.
 *
 * ROW SELECTION IS NOT DUPLICATED HERE. `engine/src/payroll/rate.ts` owns the
 * single definition of "which labor_cost_rates row pays this employee on this
 * date, and is it usable", because two implementations of that one rule IS the
 * defect that made readiness pass green and the run then throw. Readiness
 * builds its predicate from `effectivePayRateSql`; so does this, and the
 * salaried-needs-an-annual-row half is `payRateIsUsable` at the call site.
 * They agree because they are the same expression, not because someone kept
 * two copies in step.
 */
export interface PayrollFxSource {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  asOf: string;
  rate: string;
  direction: "direct" | "inverse";
  resolvedRate: string;
}

/**
 * The exact FX observation used to translate a wage, on the calculating
 * transaction rather than a pooled side read. The ordering is the same rule
 * as laborFxRate; returning the source row lets the calculation fingerprint
 * the rate instead of remembering only its rounded monetary consequence.
 */
export async function resolvePayrollFxSource(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  from: string,
  to: string,
  onDate: string,
): Promise<PayrollFxSource | null> {
  if (from === to) return null;
  const result = (await tx.execute<{
      id: string; from_currency: string; to_currency: string; as_of: string;
      rate: string; direction: "direct" | "inverse"; resolved_rate: string;
    }>(sql`
    select fx.id, fx.from_currency, fx.to_currency, fx.as_of::text as as_of,
           fx.rate::text as rate,
           case when fx.from_currency = ${from} and fx.to_currency = ${to}
                then 'direct' else 'inverse' end as direction,
           case when fx.from_currency = ${from} and fx.to_currency = ${to}
                then fx.rate
                else (1 / fx.rate)::numeric(19,10) end::text as resolved_rate
      from fx_rates fx
     where fx.org_id = ${orgId} and fx.rate_type = 'spot' and fx.as_of <= ${onDate}
       and ((fx.from_currency = ${from} and fx.to_currency = ${to})
         or (fx.from_currency = ${to} and fx.to_currency = ${from}))
     order by fx.as_of desc,
              case when fx.from_currency = ${from} and fx.to_currency = ${to}
                   then 0 else 1 end
     limit 1
     for update
  `));
  const row = result.rows[0];
  return row ? {
    id: row.id,
    fromCurrency: row.from_currency,
    toCurrency: row.to_currency,
    asOf: row.as_of,
    rate: row.rate,
    direction: row.direction,
    resolvedRate: row.resolved_rate,
  } : null;
}

export async function resolvePayRate(
  tx: Pick<typeof db, "execute">, orgId: string, employeePartyId: string, onDate: string,
  /** Functional currency of the run (the run document's currency). */
  payCurrency: string | null,
): Promise<{ basis: "hour" | "year"; rate: string; annualHours: string; currency: string } | null> {
  const r = (await tx.execute<{
      id: string; basis: "hour" | "year"; rate: string;
      annual_hours: string; currency: string;
    }>(sql`
    select * from ${effectivePayRateSql({
      org: sql`${orgId}`,
      employee: sql`${employeePartyId}`,
      onDate: sql`${onDate}`,
      selectList: sql`w.id, w.basis, w.rate, w.annual_hours, w.currency`,
    })} as rate
  `));
  const selected = r.rows[0];
  if (!selected) return null;
  // Lock the exact version selected by the shared effective-rate rule. Under
  // the calculation's repeatable-read snapshot a concurrent edit either
  // waits behind this row or raises a serialization failure; it can never
  // produce a stub from one version and fingerprint another.
  const locked = (await tx.execute<{
      basis: "hour" | "year"; rate: string; annual_hours: string; currency: string;
    }>(sql`
    select basis, rate::text as rate, annual_hours::text as annual_hours, currency
      from labor_cost_rates
     where org_id = ${orgId} and id = ${selected.id}
     for update
  `));
  const row = locked.rows[0];
  if (!row) return null;
  const resolved = {
    basis: row.basis, rate: row.rate, annualHours: row.annual_hours, currency: row.currency,
  };
  if (!payCurrency || !row.currency || row.currency === payCurrency) return resolved;

  const fxSource = await resolvePayrollFxSource(tx, orgId, row.currency, payCurrency, onDate);
  if (!fxSource) {
    throw new PayrollError(
      `no spot rate for the wage ${row.currency}→${payCurrency} on or before ${onDate}`
      + " — enter one before this employee can be paid",
    );
  }
  return {
    ...resolved,
    rate: convertLaborWage(row.rate, fxSource.resolvedRate),
    currency: payCurrency,
  };
}
