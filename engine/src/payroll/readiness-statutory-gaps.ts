import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { assignmentOverlapsPeriod } from "./assignment-windows.ts";
import { type PayrollSubsidiaryScope } from "./scope.ts";
import {
  jurisdictionKey,
  labourJurisdictionProblem,
  PayrollPackError,
  payrollPack,
  PAYROLL_COUNTRY_PACKS,
} from "./packs.ts";
import {
  resolveStatutoryRates,
  unconfiguredStatutoryRates,
  type StatutoryRatePoint,
  type UnconfiguredStatutoryRate,
} from "./statutory-rates.ts";
import { packRates } from "./packs.ts";
import {
  declaredPayrollCertificates,
  resolveCertificate,
  retiredCertificateAnswerProblem,
  type PayrollCertificate,
  type StoredCertificate,
} from "./certificates.ts";
import {
  activePayrollPopulation,
  type ReadinessSeverity,
  type RateScopeRow,
  type ScopeRow,
  type RunRow,
} from "./readiness-context.ts";

/** Statutory-rate, certificate, and opening-balance gaps surfaced by readiness. */

/**
 * Pack-declared statutory rates the org's payroll population needs and has not
 * configured for a tax year — the rates surface's "gaps" list, and the same
 * computation the setup state and the run pre-flight report.
 */
export async function payrollStatutoryRateGaps(
  orgId: string,
  country: string,
  taxYear: number,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
  asOf?: string,
): Promise<UnconfiguredStatutoryRate[]> {
  return unconfiguredRatesForRun(
    orgId,
    country,
    taxYear,
    await activePayrollPopulation(orgId, allowedSubsidiaryIds),
    asOf ?? (await businessToday(orgId)),
  );
}

/**
 * Pack-declared statutory rates with nothing configured at the scope points a
 * population actually occupies. Shared by the run pre-flight and the setup
 * state, so the two surfaces cannot disagree about what is missing.
 *
 * A pack that declares no tenant-entered rates at all has nothing to check and
 * is not an error — that is a legitimate declaration (every statutory number
 * published), so its refusal is caught rather than surfaced.
 */
export async function unconfiguredRatesForRun(
  orgId: string,
  country: string,
  taxYear: number,
  people: readonly RateScopeRow[],
  asOf: string,
): Promise<UnconfiguredStatutoryRate[]> {
  let resolution;
  try {
    resolution = await resolveStatutoryRates(orgId, packRates(country), taxYear);
  } catch (error) {
    if (error instanceof PayrollPackError) return [];
    throw error;
  }
  const points = new Map<
    string,
    StatutoryRatePoint & {
      subsidiaryId: string | null;
      employees: { partyId: string; name: string }[];
    }
  >();
  for (const person of people) {
    if (person.country !== country) continue;
    const key = `${person.subsidiary_id ?? ""}:${person.province ?? ""}:${person.filing_account_id ?? ""}`;
    const entry = points.get(key) ?? {
      region: person.province ?? null,
      filingAccountId: person.filing_account_id ?? null,
      subsidiaryId: person.subsidiary_id,
      employees: [],
    };
    entry.employees.push({ partyId: person.employee_party_id, name: person.name });
    points.set(key, entry);
  }
  if (points.size === 0) return [];
  // A pack-recorded waiver stands its slots down from the requirement — the
  // SAME hook the run's rate gate calls, asked per scope point, so readiness
  // and the run cannot disagree about what is missing. Nothing recorded
  // waives nothing: every other point keeps today's warning byte-for-byte.
  // (packRates above already resolved this country's declaration off the
  // same registry, so payrollPack cannot throw for it here.)
  const waive = payrollPack(country).waivedRateSlots;
  if (!waive) return unconfiguredStatutoryRates(resolution, [...points.values()]);
  const found: UnconfiguredStatutoryRate[] = [];
  for (const point of points.values()) {
    const waived = new Set(
      await waive(db, {
        orgId,
        region: point.region,
        filingAccountId: point.filingAccountId,
        payDate: asOf,
        subsidiaryId: point.subsidiaryId,
      }),
    );
    found.push(
      ...unconfiguredStatutoryRates(
        waived.size === 0
          ? resolution
          : { ...resolution, slots: resolution.slots.filter((slot) => !waived.has(slot.key)) },
        [point],
      ),
    );
  }
  return found;
}

/**
 * A tax certificate filed under a field the pack has since retired — the
 * row holds the old answer and none for its replacement — refuses at
 * calculation by name (`retiredCertificateAnswerProblem`). Readiness raises
 * the same message as a blocker so the operator re-declares it before
 * pressing Calculate. Pack-declared: only certificates that list retired
 * fields are read.
 */
export async function flagRetiredCertificateAnswers(args: {
  orgId: string;
  run: RunRow;
  people: ScopeRow[];
  flag: (
    severity: ReadinessSeverity,
    code: string,
    employees?: ScopeRow[],
    extra?: { detail?: string; href?: string },
  ) => void;
}): Promise<void> {
  const { orgId, run, people, flag } = args;
  const declared = new Map<string, PayrollCertificate[]>();
  for (const country of new Set(people.map((person) => person.country))) {
    // A country with no certificate declaration has no retired fields; the
    // calculation and the tax-year blocker name a missing pack themselves.
    const withRetired = (
      declaredPayrollCertificates().find((entry) => entry.country === country)?.certificates ?? []
    ).filter((certificate) => (certificate.retiredFields ?? []).length > 0);
    if (withRetired.length > 0) declared.set(country, withRetired);
  }
  const subjects = people.filter((person) => declared.has(person.country));
  if (subjects.length === 0) return;
  const keys = [...new Set([...declared.values()].flat().map((certificate) => certificate.key))];
  const rows = await db.execute<{
    employee_party_id: string;
    country: string;
    certificate_key: string;
    answers: Record<string, string> | null;
    effective_from: string | null;
    superseded_on: string | null;
  }>(
    sql`
    select employee_party_id, country, certificate_key, answers,
           effective_from::text as effective_from, superseded_on::text as superseded_on
      from employee_tax_certificates
     where org_id = ${orgId}
       and employee_party_id in (${sql.join(
         subjects.map((person) => sql`${person.employee_party_id}`),
         sql`, `,
       )})
       and certificate_key in (${sql.join(
         keys.map((key) => sql`${key}`),
         sql`, `,
       )})
  `,
    "objects",
  );
  for (const person of subjects) {
    const stored: StoredCertificate[] = rows
      .filter(
        (row) =>
          row.employee_party_id === person.employee_party_id && row.country === person.country,
      )
      .map((row) => ({
        certificateKey: row.certificate_key,
        answers: row.answers ?? {},
        effectiveFrom: row.effective_from,
        supersededOn: row.superseded_on,
      }));
    for (const certificate of declared.get(person.country) ?? []) {
      const problem = retiredCertificateAnswerProblem(
        resolveCertificate({ certificate, stored, asOf: run.pay_date }),
        person.name,
      );
      if (problem)
        flag("blocker", "employee.missingFact", [person], {
          detail: problem,
          href: "/entities/employees",
        });
    }
  }
}

/**
 * The one run where "did anyone carry a year-to-date in?" is worth asking:
 * the org's FIRST committed run of a tax year whose period does not start in
 * January. Every later run in the year has the answer already, and a January
 * start means the year began here.
 */
export async function flagMissingOpeningBalances(args: {
  orgId: string;
  documentId: string;
  run: RunRow;
  people: ScopeRow[];
  flag: (
    severity: ReadinessSeverity,
    code: string,
    employees?: ScopeRow[],
    extra?: { detail?: string; href?: string },
  ) => void;
}): Promise<void> {
  const { orgId, documentId, run, people, flag } = args;
  if (people.length === 0) return;
  // Month of the period start, not the pay date: a period that begins in
  // January is the start of the year regardless of when it is paid.
  if (run.period_start.slice(5, 7) === "01") return;

  const prior = await db.execute(
    sql`
    select 1 from pay_runs other
     where other.org_id = ${orgId} and other.tax_year = ${run.tax_year}
       and other.run_status = 'committed' and other.document_id <> ${documentId}
     limit 1
  `,
    "objects",
  );
  if (prior.length > 0) return; // not the first committed run of the year

  const entered = await db.execute<{ employee_party_id: string }>(
    sql`
    select employee_party_id from payroll_opening_balances
     where org_id = ${orgId} and tax_year = ${run.tax_year}
  `,
    "objects",
  );
  const have = new Set(entered.map((r) => r.employee_party_id));

  // Someone hired on or after this period started cannot have been paid by
  // this employer earlier in the year, so they have nothing to carry in.
  // Statutory room is per-employer, so earnings at a PREVIOUS employer are
  // deliberately not relevant here.
  const missing = people.filter(
    (p) => !have.has(p.employee_party_id) && !(p.hired_on && p.hired_on >= run.period_start),
  );
  if (missing.length > 0) {
    flag("warning", "employee.noOpeningBalance", missing, {
      detail: String(run.tax_year),
      href: `/payroll/opening-balances?year=${run.tax_year}`,
    });
  }

  // The COMPONENT dimension of the same carry-in. A statutory row alone does
  // not answer it: `pay_components.basis_cap_amount_per_year` is an annual
  // ceiling (the CRA money-purchase limit, the US 402(g) elective-deferral
  // limit) and it restarts at zero on the adoption date unless the component's
  // year-to-date is carried in too. Left unanswered, the employee is allowed a
  // SECOND full annual limit and the excess is the employer's to unwind — which
  // is why it is worth a separate line rather than being folded into the row
  // warning that has already gone quiet.
  const capped = await db.execute<{ code: string; employee_party_id: string }>(
    sql`
    select distinct c.code, epc.employee_party_id
      from employee_pay_components epc
      join pay_components c on c.id = epc.component_id and c.org_id = epc.org_id
     where epc.org_id = ${orgId} and epc.is_active and c.is_active
       and c.basis_cap_amount_per_year is not null
       and ${assignmentOverlapsPeriod(sql`epc.effective_from`, sql`epc.effective_to`, run.period_start, run.period_end)}
       and not exists (
         select 1 from payroll_opening_balance_components oc
           join payroll_opening_balances b on b.id = oc.opening_balance_id and b.org_id = oc.org_id
          where oc.org_id = epc.org_id and oc.component_id = epc.component_id
            and b.employee_party_id = epc.employee_party_id and b.tax_year = ${run.tax_year})
     order by c.code
  `,
    "objects",
  );
  if (capped.length > 0) {
    const byPerson = new Map(people.map((p) => [p.employee_party_id, p]));
    const byComponent = new Map<string, ScopeRow[]>();
    for (const row of capped) {
      const person = byPerson.get(row.employee_party_id);
      // Same exemption as above: somebody this employer first hired inside the
      // period cannot have consumed any of the limit here earlier in the year.
      if (!person || (person.hired_on && person.hired_on >= run.period_start)) continue;
      byComponent.set(row.code, [...(byComponent.get(row.code) ?? []), person]);
    }
    for (const [code, employees] of byComponent) {
      flag("warning", "employee.noOpeningComponentYtd", employees, {
        detail: code,
        href: `/payroll/opening-balances?year=${run.tax_year}`,
      });
    }
  }
}

/**
 * Whether the alternate-day carry-in question applies to this employee. The
 * bank is seeded org-wide wherever the country pack declares the
 * work-triggered grant, but it accrues only under the declaration's
 * jurisdictions — an employee governed elsewhere can never hold a balance,
 * so asking for one is noise. Scoped from the pack declaration
 * (`alternateDayGrant.jurisdictions` against the resolved labour
 * jurisdiction, override included), never a province literal: a second
 * jurisdiction's grant extends the declaration and flows here with no
 * branch.
 *
 * Keeps the current behavior on every input the declaration does not pin:
 * a pack declaring no grant (or no scope) warns as before, and an
 * unresolvable labour jurisdiction is left out — the run refuses it by name.
 */
function alternateDayCarryInApplies(person: ScopeRow): boolean {
  const scope = PAYROLL_COUNTRY_PACKS[person.country]?.alternateDayGrant?.jurisdictions;
  if (!scope) return true;
  if (labourJurisdictionProblem(person.country, person.labour_jurisdiction)) return false;
  return scope.includes(
    jurisdictionKey(person.country, person.province, person.labour_jurisdiction),
  );
}

/**
 * The bank carry-ins: a plan whose FIRST run in this org's history is happening
 * now, for an employee who demonstrably predates it.
 *
 * Timing is the whole design. Vacation and banked time live on the entitlement
 * ledger, and a mid-year adopter's banks start at zero unless somebody loads
 * them — so a ten-year employee's accrued vacation is absent from the balance
 * sheet and absent from their final cheque, with nothing anywhere saying so. The
 * one moment that question is both answerable and still cheap is the run that
 * will first move the plan; after it commits, the accrual is already sitting on
 * top of a wrong opening.
 *
 * "Demonstrably predates it" is the precision that keeps this from being noise:
 * the employee must carry a carry-in SOMEWHERE ELSE — a statutory opening
 * balance for the tax year, or an opening movement on another plan. That is
 * evidence this employer was paying them before OpenBooks. A genuinely new
 * employer has no openings anywhere, so nothing fires, which is the same
 * doctrine `flagMissingOpeningBalances` follows: never a blocker, and never a
 * question whose answer is already known.
 */
export async function flagMissingEntitlementOpenings(args: {
  orgId: string;
  documentId: string;
  run: RunRow;
  people: ScopeRow[];
  flag: (
    severity: ReadinessSeverity,
    code: string,
    employees?: ScopeRow[],
    extra?: { detail?: string; href?: string },
  ) => void;
}): Promise<void> {
  const { orgId, documentId, run, people, flag } = args;
  if (people.length === 0) return;

  // Employees with a carry-in somewhere else: the adoption evidence.
  const carried = await db.execute<{ employee_party_id: string }>(
    sql`
    select b.employee_party_id from payroll_opening_balances b
     where b.org_id = ${orgId} and b.tax_year = ${run.tax_year}
    union
    select l.employee_party_id from entitlement_ledger l
     where l.org_id = ${orgId} and l.kind = 'opening'
  `,
    "objects",
  );
  const adopted = new Set(carried.map((r) => r.employee_party_id));
  if (adopted.size === 0) return;

  // Plans no committed run has ever moved: this run is the plan's first.
  const virgin = await db.execute<{
    id: string;
    code: string;
    name: string;
    system_key: string | null;
  }>(
    sql`
    select pl.id, pl.code, pl.name, pl.system_key from entitlement_plans pl
     where pl.org_id = ${orgId} and pl.is_active
       and not exists (
         select 1 from entitlement_ledger l
           join pay_runs r on r.document_id = l.pay_run_document_id and r.org_id = l.org_id
          where l.org_id = pl.org_id and l.plan_id = pl.id
            and r.run_status = 'committed' and l.pay_run_document_id <> ${documentId})
     order by pl.code
  `,
    "objects",
  );
  if (virgin.length === 0) return;

  const openings = await db.execute<{ plan_id: string; employee_party_id: string }>(
    sql`
    select plan_id, employee_party_id from entitlement_ledger
     where org_id = ${orgId} and kind = 'opening'
  `,
    "objects",
  );
  const have = new Set(openings.map((r) => `${r.plan_id}:${r.employee_party_id}`));

  for (const plan of virgin) {
    // The alternate-day bank accrues only under the declaring jurisdictions:
    // name it only for employees whose resolved labour jurisdiction the pack
    // declaration covers, so an Ontario-governed hire is never asked for a
    // balance no run could grant them.
    const applies =
      plan.system_key === "stat_holiday_alternate"
        ? (person: ScopeRow) => alternateDayCarryInApplies(person)
        : () => true;
    const missing = people.filter(
      (p) =>
        applies(p) &&
        adopted.has(p.employee_party_id) &&
        !have.has(`${plan.id}:${p.employee_party_id}`),
    );
    if (missing.length === 0) continue;
    flag("warning", "employee.noOpeningEntitlement", missing, {
      detail: plan.name,
      href: "/payroll/opening-balances?section=entitlements",
    });
  }
}
