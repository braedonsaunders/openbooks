import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { businessToday } from "./business-date.ts";
import { PayrollError } from "./payroll-error.ts";
import { add, cmp, neg, sum } from "./money.ts";
import {
  PAYROLL_PAYMENT_METHODS,
  payrollPaymentMethodSettings,
  resolvePayrollPaymentMethod,
  stubPaymentMethods,
  type PayrollPaymentMethod,
  type ResolvedPaymentMethod,
} from "./payroll-payment-method.ts";
import { hasUsablePayRateSql } from "./payroll-rate.ts";
import { payrollSettings } from "./payroll-run.ts";
import {
  jurisdictionKey,
  labourJurisdictionProblem,
  packRemittanceVendorSettingsKeys,
  packSlotState,
  PayrollPackError,
  payrollJurisdictionDeclared,
} from "./payroll/packs.ts";
import { payrollBankProfiles } from "./payroll-bank-file.ts";
import { undeclaredJurisdictionHolidayConflict } from "./payroll-holidays.ts";
import { effectiveFilingAccountSql } from "./payroll-filing.ts";
import {
  resolveStatutoryRates,
  unconfiguredStatutoryRates,
  type StatutoryRatePoint,
  type UnconfiguredStatutoryRate,
} from "./payroll/statutory-rates.ts";
import { payrollTaxYearForDate, payrollTaxYearProblem } from "./payroll/tax-years.ts";

/**
 * Pre-flight for a pay run: what must be fixed before it can calculate, what
 * the operator should look at before committing, what the payday actually
 * costs to fund, and what changed for each employee since their last pay.
 *
 * Blocker vs warning is a hard line. A blocker means the run cannot produce a
 * correct stub or a balanced posting (missing wage, unmapped statutory
 * account, closed period). Everything else is advisory — payroll teams
 * legitimately pay someone with zero hours, or run a period twice, and the
 * product's job is to make them see it, not to refuse.
 */

export type ReadinessSeverity = "blocker" | "warning";

export interface ReadinessItem {
  severity: ReadinessSeverity;
  /** Stable code; the UI localizes it and links to the fix. */
  code: string;
  /** Employees the item concerns (empty = a run/org-level item). */
  employees: { partyId: string; name: string }[];
  /** Substitution for the message (slot key, period name, …). */
  detail?: string;
  /** Where the operator resolves it, when there is one obvious place. */
  href?: string;
}

export interface PayRunReadiness {
  items: ReadinessItem[];
  blockers: number;
  warnings: number;
  /** Employees in scope after exclusions — the run's actual population. */
  included: number;
}
/** The columns the statutory-rate scope check reads off a payroll population. */
type RateScopeRow = Pick<
  ScopeRow,
  "employee_party_id" | "name" | "country" | "province" | "filing_account_id"
>;

type ScopeRow = {
  employee_party_id: string;
  name: string;
  pay_basis: string;
  country: string;
  province: string | null;
  /** The employment attribute that overrides the region derivation; null =
   *  derive the labour jurisdiction from the work region. */
  labour_jurisdiction: string | null;
  has_wage: boolean;
  approved_hours: string;
  hired_on: string | null;
  terminated_on: string | null;
  paid_in_period: boolean;
  has_bank: boolean;
  has_sin: boolean;
  profile_payment_method: string | null;
  party_payment_method: string | null;
  /**
   * The filing identity the employee is paid under, resolved with the SAME
   * fragment the run and the year-end returns use — never re-derived here.
   * Statutory rates that are assigned per account (an experience-rated SUI
   * rate) resolve against it.
   */
  filing_account_id: string | null;
};
type RunRow = {
  pay_schedule_id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  tax_year: number;
  run_type: string;
  run_status: string;
  subsidiary_id: string | null;
};

async function runContext(orgId: string, documentId: string): Promise<RunRow | null> {
  const runs = (await db.execute<RunRow>(sql`
    select r.pay_schedule_id, r.period_start::text as period_start, r.period_end::text as period_end,
           r.pay_date::text as pay_date, r.tax_year, r.run_type, r.run_status, s.subsidiary_id
      from pay_runs r
      join pay_schedules s on s.id = r.pay_schedule_id and s.org_id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${documentId}
  `));
  return runs.rows[0] ?? null;
}

/**
 * Everyone the run will pay, with the facts each check needs.
 *
 * The population predicates are the RUN's, not readiness's own: a
 * subsidiary-scoped pay schedule pays only that entity's employees, and an
 * employee terminated before the period started is not paid at all
 * (calculatePayRun applies both). Describing a different population from the
 * one that will be paid makes every per-employee count on this screen wrong.
 */
async function scope(orgId: string, documentId: string, run: RunRow): Promise<ScopeRow[]> {
  const rows = (await db.execute<ScopeRow>(sql`
    select p.id as employee_party_id, p.display_name as name, prof.pay_basis, prof.country,
           prof.province, prof.labour_jurisdiction,
           ${effectiveFilingAccountSql("prof")} as filing_account_id,
           coalesce(te.hours, 0)::text as approved_hours,
           er.hired_on::text as hired_on,
           er.terminated_on::text as terminated_on,
           prof.sin_encrypted is not null as has_sin,
           prof.payment_method as profile_payment_method,
           p.payment_method as party_payment_method,
           exists (
             select 1 from party_bank_accounts b
              where b.org_id = prof.org_id and b.party_id = p.id
                and b.is_active and b.approval_status = 'approved') as has_bank,
           coalesce(${hasUsablePayRateSql({
             org: sql`prof.org_id`,
             employee: sql`prof.employee_party_id`,
             onDate: run.period_end,
             payBasis: sql`prof.pay_basis`,
           })}, false) as has_wage,
           exists (
             select 1 from pay_stubs s2
               join pay_runs r2 on r2.document_id = s2.pay_run_document_id and r2.org_id = s2.org_id
              where s2.org_id = prof.org_id and s2.employee_party_id = prof.employee_party_id
                and s2.pay_run_document_id <> ${documentId}
                and r2.run_status = 'committed'
                and r2.period_start <= ${run.period_end}
                and r2.period_end >= ${run.period_start}) as paid_in_period
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
      left join employee_roles er on er.party_id = p.id and er.org_id = prof.org_id
      left join lateral (
        select sum(t.hours) as hours from time_entries t
         where t.org_id = prof.org_id and t.employee_party_id = prof.employee_party_id
           and t.status = 'approved'
           and t.worked_on between ${run.period_start} and ${run.period_end}) te on true
     where prof.org_id = ${orgId} and prof.pay_schedule_id = ${run.pay_schedule_id} and prof.is_active
       -- calculatePayRun's own two population predicates, verbatim.
       and (er.terminated_on is null or er.terminated_on >= ${run.period_start})
       and (${run.subsidiary_id}::uuid is null or p.subsidiary_id = ${run.subsidiary_id}::uuid)
       and not exists (
         select 1 from pay_run_adjustments a
          where a.org_id = ${orgId} and a.pay_run_document_id = ${documentId}
            and a.adjustment_type = 'exclude' and a.employee_party_id = p.id)
     order by p.display_name
  `));
  return rows.rows;
}

/**
 * Which payroll country packs the org runs: the settings marker where it
 * exists, and for a tenant provisioned before the marker did, the packs whose
 * statutory components are actually seeded. NEVER a default of Canada — an
 * org that installed only the US pack must not be told to map CA slots, and a
 * third pack's org must not inherit anybody. Shared by the pay-run readiness
 * and the setup wizard so the two can never disagree about what is installed.
 */
export async function installedPayrollCountries(
  orgId: string,
  payrollBlob: Record<string, unknown>,
): Promise<string[]> {
  if (Array.isArray((payrollBlob as { countries?: unknown }).countries)) {
    return ((payrollBlob as { countries: unknown[] }).countries).map(String);
  }
  return ((await db.execute<{ country: string }>(sql`
    select distinct country from pay_components
     where org_id = ${orgId} and system_key is not null and country is not null
  `))).rows.map((row) => row.country);
}

/**
 * One org-level configuration check the payroll setup wizard walks. Codes
 * reuse the pay-run readiness vocabulary (`setup.wageExpense`, `setup.slot`,
 * …) where the same fact is checked there, so the wizard and the run
 * pre-flight localize and resolve identically.
 */
export interface PayrollSetupCheck {
  code: string;
  severity: ReadinessSeverity;
  ok: boolean;
  /** Substitution for the message (pack country, slot key, vendor key). */
  detail?: string;
  /** Where the operator resolves it. */
  href?: string;
}

export interface PayrollSetupState {
  installedCountries: string[];
  checks: PayrollSetupCheck[];
  /** Failing blocker-severity checks — a pay run cannot commit past these. */
  blockers: number;
  /** Failing advisory checks. */
  warnings: number;
}

/**
 * Org-level payroll configuration state — the SETUP subset of what
 * `payRunReadiness` verifies before a run, computed without a run in hand
 * (no population, no period, no per-employee facts). The setup wizard's step
 * list and the "Set up payroll" call-to-action derive from these checks, and
 * every source consulted here (payrollSettings, packSlotState,
 * installedPayrollCountries, the pack vendor declarations) is the same one
 * the run pre-flight reads, so the two surfaces cannot disagree.
 */
export async function payrollSetupState(orgId: string): Promise<PayrollSetupState> {
  const setupHref = "/admin/setup/payroll";
  const checks: PayrollSetupCheck[] = [];

  const blobRes = (await db.execute<{ p: Record<string, unknown> | null }>(sql`
    select settings->'payroll' as p from orgs where id = ${orgId}
  `));
  const blob = blobRes.rows[0]?.p ?? {};
  const installed = await installedPayrollCountries(orgId, blob);
  const settings = await payrollSettings(orgId);

  checks.push({
    severity: "blocker", code: "setup.pack",
    ok: installed.length > 0, href: `${setupHref}?tab=packs`,
  });
  checks.push({
    severity: "blocker", code: "setup.wageExpense",
    ok: Boolean(settings.wageExpenseAccountId), href: `${setupHref}?tab=accounts`,
  });
  checks.push({
    severity: "blocker", code: "setup.netPay",
    ok: Boolean(settings.netPayAccountId), href: `${setupHref}?tab=accounts`,
  });
  if (settings.wagesTo === "labor_clearing") {
    const clearing = (await db.execute<{ id: string | null }>(sql`
      select settings#>>'{laborCosting,clearingAccountId}' as id from orgs where id = ${orgId}
    `));
    checks.push({
      severity: "blocker", code: "setup.laborClearing",
      ok: Boolean(clearing.rows[0]?.id), href: setupHref,
    });
  }

  // Every statutory slot of every installed pack must resolve to a liability
  // account — the same packSlotState walk the run pre-flight performs, minus
  // its runs-population filter (setup has no run to scope by).
  for (const pack of await packSlotState(orgId, installed, blob)) {
    const missing = pack.slots.filter((slot) => !slot.accountId);
    if (missing.length === 0) {
      checks.push({ severity: "blocker", code: "setup.slot", ok: true, detail: pack.country });
    }
    for (const slot of missing) {
      checks.push({
        severity: "blocker", code: "setup.slot", ok: false,
        detail: `${pack.country} · ${slot.key}`,
        href: `${setupHref}?tab=${pack.country.toLowerCase()}`,
      });
    }
  }

  // A run needs a pay calendar to exist at all.
  const schedules = (await db.execute<{ ok: boolean }>(sql`
    select exists (
      select 1 from pay_schedules where org_id = ${orgId} and is_active) as ok
  `));
  checks.push({
    severity: "blocker", code: "setup.schedule",
    ok: Boolean(schedules.rows[0]?.ok), href: `${setupHref}?tab=schedules`,
  });

  // Statutory remittance vendors — exactly the settings keys the installed
  // packs declare (pack-level plus regional overrides), never a literal list.
  // Advisory: a run calculates without them; the remittance summary surfaces
  // unassigned withholdings until they are set.
  for (const country of installed) {
    for (const key of packRemittanceVendorSettingsKeys(country)) {
      const value = (blob as Record<string, unknown>)[key];
      checks.push({
        severity: "warning", code: "setup.remittanceVendor",
        ok: typeof value === "string" && value.length > 0,
        detail: `${country} · ${key}`, href: `${setupHref}?tab=accounts`,
      });
    }
  }

  // Are this year's statutory tables loaded for every installed pack? Asked
  // against TODAY's date through each pack's own tax-year definition, so the
  // answer is right for a jurisdiction whose year does not open in January. A
  // blocker: no run in the current year can calculate until the edition lands,
  // and January is exactly when nobody wants to discover that mid-payroll.
  const today = await businessToday(orgId);
  for (const country of installed) {
    const { taxYear, problem } = payrollTaxYearForDate(country, today);
    checks.push({
      severity: "blocker", code: "setup.taxYear", ok: problem === null,
      detail: problem ? problem.message : `${country} · ${taxYear}`,
      href: `${setupHref}?tab=packs`,
    });
  }

  // Statutory rates the employer must supply, at the scope the pack declares
  // each one varies by — checked against the regions and filing accounts the
  // org's ACTIVE payroll population actually occupies, so an employer with no
  // Ontario payroll is never nagged about Ontario's health tax. Advisory for
  // the same reason as in the run pre-flight.
  const population = await activePayrollPopulation(orgId);
  for (const country of installed) {
    const missing = await unconfiguredRatesForRun(
      orgId, country, await currentTaxYear(orgId, country), population,
    );
    if (missing.length === 0) {
      checks.push({
        severity: "warning", code: "setup.statutoryRate", ok: true, detail: country,
      });
      continue;
    }
    for (const item of missing) {
      checks.push({
        severity: "warning", code: "setup.statutoryRate", ok: false,
        detail: item.message, href: `${setupHref}?tab=rates`,
      });
    }
  }

  // A way to pay people: a configured payroll-capable EFT originator profile,
  // or the cheque fallback left on (paper is a legitimate rail, so this is
  // advisory, not a blocker).
  const [paymentMethods, bankProfiles] = await Promise.all([
    payrollPaymentMethodSettings(orgId),
    payrollBankProfiles(orgId),
  ]);
  checks.push({
    severity: "warning", code: "setup.paymentRail",
    ok: paymentMethods.eftFallbackToCheque || bankProfiles.some((profile) => profile.configured),
    href: `${setupHref}?tab=payday`,
  });

  return {
    installedCountries: installed,
    checks,
    blockers: checks.filter((c) => !c.ok && c.severity === "blocker").length,
    warnings: checks.filter((c) => !c.ok && c.severity === "warning").length,
  };
}

export async function payRunReadiness(orgId: string, documentId: string): Promise<PayRunReadiness> {
  const items: ReadinessItem[] = [];
  const flag = (
    severity: ReadinessSeverity,
    code: string,
    employees: ScopeRow[] = [],
    extra: { detail?: string; href?: string } = {},
  ) => {
    items.push({
      severity, code,
      employees: employees.map((e) => ({ partyId: e.employee_party_id, name: e.name })),
      ...extra,
    });
  };
  const tally = (included: number): PayRunReadiness => ({
    items,
    blockers: items.filter((i) => i.severity === "blocker").length,
    warnings: items.filter((i) => i.severity === "warning").length,
    included,
  });

  const run = await runContext(orgId, documentId);
  if (!run) return tally(0);
  const people = await scope(orgId, documentId, run);

  // --- Org configuration: a commit cannot balance without these ------------
  const setupHref = "/admin/setup/payroll";
  const settings = await payrollSettings(orgId);
  if (!settings.wageExpenseAccountId) flag("blocker", "setup.wageExpense", [], { href: setupHref });
  if (!settings.netPayAccountId) flag("blocker", "setup.netPay", [], { href: setupHref });
  if (settings.wagesTo === "labor_clearing") {
    const clearing = (await db.execute<{ id: string | null }>(sql`
      select settings#>>'{laborCosting,clearingAccountId}' as id from orgs where id = ${orgId}
    `));
    if (!clearing.rows[0]?.id) flag("blocker", "setup.laborClearing", [], { href: setupHref });
  }

  // Every statutory slot of every pack the run's people belong to must resolve
  // to a liability account, or the commit has nowhere to credit withholdings.
  const blob = (await db.execute<{ p: Record<string, unknown> | null }>(sql`
    select settings->'payroll' as p from orgs where id = ${orgId}
  `));
  const legacy = blob.rows[0]?.p ?? {};
  const installed = await installedPayrollCountries(orgId, legacy);
  const countriesInRun = new Set(people.map((p) => p.country));
  for (const pack of await packSlotState(orgId, installed, legacy)) {
    if (people.length > 0 && !countriesInRun.has(pack.country)) continue;
    for (const slot of pack.slots) {
      if (!slot.accountId) {
        flag("blocker", "setup.slot", [], {
          detail: `${pack.country} · ${slot.key}`,
          href: `${setupHref}?tab=${pack.country.toLowerCase()}`,
        });
      }
    }
  }

  // --- Statutory tables: is this year even loaded? -------------------------
  // Every statutory engine refuses a pay date outside the years it has
  // transcribed, which is right — and used to surface as an exception thrown
  // from inside calculateStub, per employee, mid-payroll. The pack now DECLARES
  // its editions, so the missing year is named here, before Calculate, as the
  // blocker it is (engine/src/payroll/tax-years.ts).
  //
  // Asked per (country, region) pair actually being paid, because a region can
  // publish its own tables and lag the country's: 2027 can be loaded federally
  // for Canada and not loaded for Quebec.
  const jurisdictionsInRun = new Map<string, { country: string; region: string | null }>();
  for (const person of people) {
    const key = `${person.country}:${person.province ?? ""}`;
    if (!jurisdictionsInRun.has(key)) {
      jurisdictionsInRun.set(key, { country: person.country, region: person.province ?? null });
    }
  }
  if (people.length === 0) {
    for (const country of installed) {
      jurisdictionsInRun.set(`${country}:`, { country, region: null });
    }
  }
  const taxYearFailures = new Set<string>();
  for (const { country, region } of jurisdictionsInRun.values()) {
    const problem = payrollTaxYearProblem(country, run.tax_year, region);
    if (!problem || taxYearFailures.has(problem.message)) continue;
    taxYearFailures.add(problem.message);
    flag(
      "blocker", "statutory.taxYear",
      people.filter((p) => p.country === country && (region === null || p.province === region)),
      { detail: problem.message, href: `${setupHref}?tab=packs` },
    );
  }

  // --- Statutory rates the employer has to supply --------------------------
  // The pack declares which of its statutory rates cannot be published (an
  // experience-rated SUI rate) or are published per region per year (the FUTA
  // credit reduction, the provincial employer health levies), and at what scope
  // each varies. Anything the run touches with nothing configured is reported
  // here rather than accruing zero silently.
  //
  // ADVISORY, deliberately: an employer with no SUI registration in a state owes
  // no SUI there, and refusing the whole payroll over a levy that may not apply
  // would be wrong. What the operator is owed is the sentence, before payday.
  for (const country of countriesInRun.size > 0 ? [...countriesInRun] : installed) {
    for (const missing of await unconfiguredRatesForRun(orgId, country, run.tax_year, people)) {
      flag(
        "warning", "statutory.rateUnconfigured",
        people.filter((p) => missing.employees.some((e) => e.partyId === p.employee_party_id)),
        { detail: missing.message, href: `${setupHref}?tab=rates` },
      );
    }
  }

  // --- Period control: posting into a closed period fails at post ---------
  const lock = (await db.execute<{ name: string; state: string }>(sql`
    select p.name, coalesce(l.state, 'open') as state
      from accounting_periods p
      join accounting_books b on b.org_id = p.org_id and b.is_primary and b.is_active
      left join period_locks l
        on l.org_id = p.org_id and l.period_id = p.id and l.book_id = b.id and l.module = 'gl'
       and (l.subsidiary_id is not distinct from ${run.subsidiary_id} or l.subsidiary_id is null)
     where p.org_id = ${orgId} and p.starts_on <= ${run.pay_date} and p.ends_on >= ${run.pay_date}
       and p.is_adjustment = false
     order by (l.subsidiary_id is not null) desc
     limit 1
  `));
  if (!lock.rows[0]) flag("blocker", "period.missing", [], { detail: run.pay_date });
  else if (lock.rows[0].state !== "open") {
    flag("blocker", "period.closed", [], { detail: lock.rows[0].name, href: "/admin/close" });
  }

  // --- Population ---------------------------------------------------------
  if (people.length === 0) flag("blocker", "scope.empty", []);

  const employeesHref = "/entities/employees";
  const noWage = people.filter((p) => !p.has_wage);
  if (noWage.length) flag("blocker", "employee.noWage", noWage, { href: employeesHref });

  const zeroHours = people.filter((p) => p.pay_basis === "hourly" && Number(p.approved_hours) === 0);
  if (zeroHours.length) flag("warning", "employee.zeroHours", zeroHours, { href: "/timesheets" });

  const paidTwice = people.filter((p) => p.paid_in_period);
  if (paidTwice.length) flag("warning", "employee.paidInPeriod", paidTwice);

  // A final pay belongs on a termination run: flag terminated people elsewhere.
  const terminated = people.filter((p) => p.terminated_on && p.terminated_on <= run.period_end);
  if (run.run_type !== "termination" && terminated.length) {
    flag("warning", "employee.terminated", terminated);
  }

  // --- Payment rail ---------------------------------------------------------
  // Missing bank details is NOT an exception to wave through: an employee with
  // none is paid by cheque, which is a normal payroll, not a warning. Only two
  // things are worth saying here — somebody the employer means to pay by EFT
  // whose money is going out as paper instead (advisory), and somebody who has
  // no route at all because the employer turned that safety net off (blocker).
  const fallbackToCheque = (await payrollPaymentMethodSettings(orgId)).eftFallbackToCheque;
  const rail = new Map<string, ResolvedPaymentMethod>(
    people.map((p) => [
      p.employee_party_id,
      resolvePayrollPaymentMethod({
        profileMethod: p.profile_payment_method,
        partyMethod: p.party_payment_method,
        hasApprovedBankDetails: p.has_bank,
        fallbackToCheque,
      }),
    ]),
  );
  const unpayable = people.filter((p) => rail.get(p.employee_party_id)?.unpayable);
  if (unpayable.length) {
    flag("blocker", "employee.eftNoBankDetails", unpayable, { href: employeesHref });
  }
  const eftOnPaper = people.filter((p) => {
    const resolved = rail.get(p.employee_party_id);
    return resolved?.missingBankDetails && !resolved.unpayable;
  });
  if (eftOnPaper.length) {
    flag("warning", "employee.noBankDetails", eftOnPaper, { href: employeesHref });
  }

  const noSin = people.filter((p) => !p.has_sin);
  if (noSin.length) flag("warning", "employee.noSin", noSin, { href: employeesHref });

  // --- Statutory holiday pay ------------------------------------------------
  // Only when the org has turned the feature on. An employee whose
  // jurisdiction NO pack has transcribed (CA-MB, US-MA) is a blocker exactly
  // when a statutory holiday actually lands in the period — probed against the
  // country's declared employment calendars — and calculateStub refuses with
  // the SAME message, so the wizard names the problem before the run does.
  // With no holiday in the period, an undeclared jurisdiction calculates
  // exactly as it always has and nothing is flagged.
  if ((legacy as { statutoryHolidayPay?: unknown }).statutoryHolidayPay === true) {
    // An EXPLICIT labour jurisdiction no pack declares is its own blocker,
    // whether or not a holiday lands in the period: the value means nothing, so
    // the employment would silently be governed by the work region's calendar —
    // the substitution the attribute exists to prevent. calculateStub throws on
    // the same predicate, so the wizard names it first.
    const byLabourProblem = new Map<string, ScopeRow[]>();
    for (const person of people) {
      const problem = labourJurisdictionProblem(person.country, person.labour_jurisdiction);
      if (!problem) continue;
      byLabourProblem.set(problem, [...(byLabourProblem.get(problem) ?? []), person]);
    }
    for (const [detail, employees] of byLabourProblem) {
      flag("blocker", "holiday.labourJurisdictionUndeclared", employees, {
        detail,
        href: employeesHref,
      });
    }

    const byJurisdiction = new Map<string, ScopeRow[]>();
    for (const person of people) {
      if (labourJurisdictionProblem(person.country, person.labour_jurisdiction)) continue;
      const key = jurisdictionKey(person.country, person.province, person.labour_jurisdiction);
      if (payrollJurisdictionDeclared(key)) continue;
      byJurisdiction.set(key, [...(byJurisdiction.get(key) ?? []), person]);
    }
    for (const [jurisdiction, employees] of byJurisdiction) {
      const country = employees[0]!.country;
      const conflict = undeclaredJurisdictionHolidayConflict({
        country, jurisdiction, from: run.period_start, to: run.period_end,
      });
      if (conflict) {
        flag("blocker", "holiday.undeclaredJurisdiction", employees, {
          detail: conflict.message,
          href: "/admin/setup/payroll?tab=holidayCalendar",
        });
      }
    }
  }

  // --- Mid-year adoption ---------------------------------------------------
  // payroll_opening_balances is the ONLY carrier of statutory year-to-date
  // accumulated before OpenBooks (see engine/src/payroll-opening-balances.ts).
  // Without it the engine restarts every ceiling at zero, so an employer
  // adopting mid-year re-withholds up to a second full annual CPP/EI maximum
  // and every T4/W-2 box understates the year.
  //
  // WARNING, never a blocker: a genuinely new employer's first payroll has no
  // prior year-to-date and is completely correct with no rows at all. The
  // product's job is to make the operator see the question once, on the one
  // run where it is still cheap to answer.
  await flagMissingOpeningBalances({ orgId, documentId, run, people, flag });
  await flagMissingEntitlementOpenings({ orgId, documentId, run, people, flag });

  return tally(people.length);
}

/** The tax year the org's business day falls in FOR THE PACK — never UTC `getFullYear()`. */
const currentTaxYear = async (orgId: string, country: string): Promise<number> =>
  payrollTaxYearForDate(country, await businessToday(orgId)).taxYear;

/**
 * The org's active payroll population, reduced to the facts a scope point is
 * made of: country, region, and the filing identity the employee is paid under.
 * Used where there is no run to scope by (the setup state, the rates surface).
 */
/**
 * The regions and filing accounts the org's active payroll actually occupies.
 *
 * This selects only the columns the statutory-rate check reads. It used to
 * claim `ScopeRow[]`, which also declares `pay_basis`, `labour_jurisdiction`
 * and the per-run readiness flags — none of which this query selects, so those
 * fields were `undefined` behind a type that promised otherwise.
 */
async function activePayrollPopulation(orgId: string): Promise<RateScopeRow[]> {
  const rows = (await db.execute<RateScopeRow>(sql`
    select p.id as employee_party_id, p.display_name as name, prof.country, prof.province,
           ${effectiveFilingAccountSql("prof")} as filing_account_id
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
     where prof.org_id = ${orgId} and prof.is_active
  `));
  return rows.rows;
}

/**
 * Pack-declared statutory rates the org's payroll population needs and has not
 * configured for a tax year — the rates surface's "gaps" list, and the same
 * computation the setup state and the run pre-flight report.
 */
export async function payrollStatutoryRateGaps(
  orgId: string,
  country: string,
  taxYear: number,
): Promise<UnconfiguredStatutoryRate[]> {
  return unconfiguredRatesForRun(orgId, country, taxYear, await activePayrollPopulation(orgId));
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
async function unconfiguredRatesForRun(
  orgId: string,
  country: string,
  taxYear: number,
  people: readonly RateScopeRow[],
): Promise<UnconfiguredStatutoryRate[]> {
  let resolution;
  try {
    resolution = await resolveStatutoryRates(orgId, country, taxYear);
  } catch (error) {
    if (error instanceof PayrollPackError) return [];
    throw error;
  }
  const points = new Map<string, StatutoryRatePoint & { employees: { partyId: string; name: string }[] }>();
  for (const person of people) {
    if (person.country !== country) continue;
    const key = `${person.province ?? ""}:${person.filing_account_id ?? ""}`;
    const entry = points.get(key) ?? {
      region: person.province ?? null,
      filingAccountId: person.filing_account_id ?? null,
      employees: [],
    };
    entry.employees.push({ partyId: person.employee_party_id, name: person.name });
    points.set(key, entry);
  }
  if (points.size === 0) return [];
  return unconfiguredStatutoryRates(resolution, [...points.values()]);
}

/**
 * The one run where "did anyone carry a year-to-date in?" is worth asking:
 * the org's FIRST committed run of a tax year whose period does not start in
 * January. Every later run in the year has the answer already, and a January
 * start means the year began here.
 */
async function flagMissingOpeningBalances(args: {
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

  const prior = (await db.execute(sql`
    select 1 from pay_runs other
     where other.org_id = ${orgId} and other.tax_year = ${run.tax_year}
       and other.run_status = 'committed' and other.document_id <> ${documentId}
     limit 1
  `));
  if (prior.rows.length > 0) return; // not the first committed run of the year

  const entered = (await db.execute<{ employee_party_id: string }>(sql`
    select employee_party_id from payroll_opening_balances
     where org_id = ${orgId} and tax_year = ${run.tax_year}
  `));
  const have = new Set(entered.rows.map((r) => r.employee_party_id));

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
  const capped = (await db.execute<{ code: string; employee_party_id: string }>(sql`
    select distinct c.code, epc.employee_party_id
      from employee_pay_components epc
      join pay_components c on c.id = epc.component_id and c.org_id = epc.org_id
     where epc.org_id = ${orgId} and epc.is_active and c.is_active
       and c.basis_cap_amount_per_year is not null
       and epc.effective_from <= ${run.period_end}
       and (epc.effective_to is null or epc.effective_to >= ${run.period_start})
       and not exists (
         select 1 from payroll_opening_balance_components oc
           join payroll_opening_balances b on b.id = oc.opening_balance_id and b.org_id = oc.org_id
          where oc.org_id = epc.org_id and oc.component_id = epc.component_id
            and b.employee_party_id = epc.employee_party_id and b.tax_year = ${run.tax_year})
     order by c.code
  `));
  if (capped.rows.length > 0) {
    const byPerson = new Map(people.map((p) => [p.employee_party_id, p]));
    const byComponent = new Map<string, ScopeRow[]>();
    for (const row of capped.rows) {
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
async function flagMissingEntitlementOpenings(args: {
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
  const carried = (await db.execute<{ employee_party_id: string }>(sql`
    select b.employee_party_id from payroll_opening_balances b
     where b.org_id = ${orgId} and b.tax_year = ${run.tax_year}
    union
    select l.employee_party_id from entitlement_ledger l
     where l.org_id = ${orgId} and l.kind = 'opening'
  `));
  const adopted = new Set(carried.rows.map((r) => r.employee_party_id));
  if (adopted.size === 0) return;

  // Plans no committed run has ever moved: this run is the plan's first.
  const virgin = (await db.execute<{ id: string; code: string; name: string }>(sql`
    select pl.id, pl.code, pl.name from entitlement_plans pl
     where pl.org_id = ${orgId} and pl.is_active
       and not exists (
         select 1 from entitlement_ledger l
           join pay_runs r on r.document_id = l.pay_run_document_id and r.org_id = l.org_id
          where l.org_id = pl.org_id and l.plan_id = pl.id
            and r.run_status = 'committed' and l.pay_run_document_id <> ${documentId})
     order by pl.code
  `));
  if (virgin.rows.length === 0) return;

  const openings = (await db.execute<{ plan_id: string; employee_party_id: string }>(sql`
    select plan_id, employee_party_id from entitlement_ledger
     where org_id = ${orgId} and kind = 'opening'
  `));
  const have = new Set(openings.rows.map((r) => `${r.plan_id}:${r.employee_party_id}`));

  for (const plan of virgin.rows) {
    const missing = people.filter(
      (p) => adopted.has(p.employee_party_id) && !have.has(`${plan.id}:${p.employee_party_id}`),
    );
    if (missing.length === 0) continue;
    flag("warning", "employee.noOpeningEntitlement", missing, {
      detail: plan.name,
      href: "/payroll/opening-balances?section=entitlements",
    });
  }
}

export interface PayRunStaleness {
  /** True when an input changed after the run was last calculated. */
  stale: boolean;
  /** Stable codes for what changed — see STALENESS_INPUT_CLASSES. */
  reasons: string[];
  calculatedAt: string | null;
}

/**
 * Every class of input a calculated stub is a function of. The wizard blocks
 * the commit while any of them changed after `calculated_at`, so anything
 * MISSING from this list is a silent commit of figures the operator edited
 * past — which is the one failure this control exists to prevent.
 *
 * `missing` is the run row itself: a run that cannot be read is not a fresh
 * run, and reporting it fresh green-lights a commit against nothing.
 */
export const STALENESS_INPUT_CLASSES = [
  "missing",
  "adjustments",
  "time",
  "wages",
  "roster",
  "components",
  "componentDefinitions",
  "derivedRules",
  "entitlements",
  "workerComp",
  "timeTypes",
  "settings",
  "ytd",
] as const;

/**
 * Whether the calculated stubs still reflect the run's inputs. Payroll's worst
 * failure mode is committing figures the operator edited past — so the wizard
 * reads this on every render and blocks the commit while it is stale, rather
 * than trusting anyone to remember to recalculate.
 *
 */
export async function payRunStaleness(
  orgId: string,
  documentId: string,
): Promise<PayRunStaleness> {
  const rows = (await db.execute<{
      calculated_at: Date | string | null; never_calculated: boolean;
      adjustments_changed: boolean; time_changed: boolean;
      wages_changed: boolean; roster_changed: boolean; employment_changed: boolean;
      components_changed: boolean; component_definitions_changed: boolean;
      derived_rules_changed: boolean; entitlements_changed: boolean;
      worker_comp_changed: boolean; time_types_changed: boolean;
      settings_changed: boolean; ytd_changed: boolean;
    }>(sql`
    select r.calculated_at,
           r.calculated_at is null as never_calculated,
           exists (
             select 1 from pay_run_adjustments a
              where a.org_id = r.org_id and a.pay_run_document_id = r.document_id
                and a.updated_at > r.calculated_at) as adjustments_changed,
           exists (
             select 1 from time_entries t
              where t.org_id = r.org_id and t.status = 'approved'
                and t.worked_on between r.period_start and r.period_end
                and t.updated_at > r.calculated_at) as time_changed,
           exists (
             select 1 from labor_cost_rates w
              where w.org_id = r.org_id and w.updated_at > r.calculated_at) as wages_changed,
           -- Roster: the payroll profile (TD1/W-4, exemptions, schedule) and
           -- the employment record the run reads for termination, job title,
           -- trade and WCB class.
           exists (
             select 1 from employee_payroll_profiles prof
              where prof.org_id = r.org_id and prof.pay_schedule_id = r.pay_schedule_id
                and prof.updated_at > r.calculated_at) as roster_changed,
           exists (
             select 1 from employee_roles er
              join employee_payroll_profiles prof
                on prof.org_id = er.org_id and prof.employee_party_id = er.party_id
              where er.org_id = r.org_id and prof.pay_schedule_id = r.pay_schedule_id
                and er.updated_at > r.calculated_at) as employment_changed,
           -- Per-employee assigned components: garnishments, benefits, RRSP,
           -- union dues overrides. Editing one of these changes net pay.
           exists (
             select 1 from employee_pay_components epc
              join employee_payroll_profiles prof
                on prof.org_id = epc.org_id and prof.employee_party_id = epc.employee_party_id
              where epc.org_id = r.org_id and prof.pay_schedule_id = r.pay_schedule_id
                and epc.updated_at > r.calculated_at) as components_changed,
           -- The component DEFINITIONS themselves (rate, taxability,
           -- pensionable/insurable flags, liability account).
           exists (
             select 1 from pay_components c
              where c.org_id = r.org_id and c.updated_at > r.calculated_at)
             as component_definitions_changed,
           exists (
             select 1 from pay_derived_rules dr
              where dr.org_id = r.org_id and dr.updated_at > r.calculated_at)
             as derived_rules_changed,
           -- Entitlement plans, their limits and their service tiers: all
           -- three move accrual and payout amounts on the stub.
           (exists (select 1 from entitlement_plans ep
                     where ep.org_id = r.org_id and ep.updated_at > r.calculated_at)
            or exists (select 1 from entitlement_plan_limits el
                        where el.org_id = r.org_id and el.updated_at > r.calculated_at)
            or exists (select 1 from entitlement_service_tiers et
                        where et.org_id = r.org_id and et.updated_at > r.calculated_at))
             as entitlements_changed,
           -- WCB/WSIB class rates and assessable maximums. calculatePayRun
           -- multiplies assessable earnings by worker_comp_groups.rate_percent
           -- to produce the employer premium, so a rate edited after Calculate
           -- commits a stale premium. The audit_log arm is belt AND braces on
           -- purpose: updated_at is now authoritative (the registry entry is
           -- flagged actorCols), but a writer that bypassed the generic setup
           -- route would still leave the audit row.
           (exists (select 1 from worker_comp_groups wcg
                     where wcg.org_id = r.org_id and wcg.updated_at > r.calculated_at)
            or exists (select 1 from audit_log al
                        where al.org_id = r.org_id and al.table_name = 'worker_comp_groups'
                          and al.at > r.calculated_at))
             as worker_comp_changed,
           -- Time-type definitions. calculatePayRun reads cost_multiplier as
           -- the wage multiplier and exclude_from_wages as the switch that
           -- keeps an event entry out of gross, so moving overtime from 1.5 to
           -- 2.0 after Calculate restates every overtime hour on the run.
           (exists (select 1 from time_types tt
                     where tt.org_id = r.org_id and tt.updated_at > r.calculated_at)
            or exists (select 1 from audit_log al
                        where al.org_id = r.org_id and al.table_name = 'time_types'
                          and al.at > r.calculated_at))
             as time_types_changed,
           -- Org payroll settings: EHT/SUI rates, exemptions, posting accounts,
           -- and the filing accounts a remittance is grouped under.
           --
           -- orgs.updated_at is watched but is NOT sufficient on its own: the
           -- settings writers update orgs.settings without stamping
           -- updated_at, and there is no trigger. The audit_log row
           -- those writers DO insert ('orgs' / the org id) is the reliable
           -- signal today. See .local/handoff-controls.md for the touch
           -- trigger that would make the column authoritative.
           (exists (select 1 from orgs o
                     where o.id = r.org_id and o.updated_at > r.calculated_at)
            or exists (select 1 from audit_log al
                        where al.org_id = r.org_id and al.table_name = 'orgs'
                          and al.at > r.calculated_at)
            or exists (select 1 from payroll_filing_accounts fa
                        where fa.org_id = r.org_id and fa.updated_at > r.calculated_at))
             as settings_changed,
           -- Another run consumed this employee's statutory room. A run
           -- calculated before an off-cycle run commits carries the YTD the
           -- off-cycle run has already used, and over-deducts the employee past
           -- the CPP/EI maximum (or under-deducts if that run was voided).
           exists (
             select 1 from pay_runs other
              where other.org_id = r.org_id and other.document_id <> r.document_id
                and other.tax_year = r.tax_year
                and other.run_status in ('committed', 'voided')
                and other.updated_at > r.calculated_at
                and exists (
                  select 1 from pay_stubs os
                    join pay_stubs mine
                      on mine.employee_party_id = os.employee_party_id
                     and mine.org_id = os.org_id
                     and mine.pay_run_document_id = r.document_id
                   where os.org_id = r.org_id
                     and os.pay_run_document_id = other.document_id)) as ytd_changed
      from pay_runs r
     where r.org_id = ${orgId} and r.document_id = ${documentId}
  `));
  const row = rows.rows[0];
  // A missing run is not a fresh run. Fail closed and say why.
  if (!row) return { stale: true, reasons: ["missing"], calculatedAt: null };
  if (row.never_calculated) return { stale: false, reasons: [], calculatedAt: null };
  const reasons = [
    row.adjustments_changed ? "adjustments" : null,
    row.time_changed ? "time" : null,
    row.wages_changed ? "wages" : null,
    row.roster_changed || row.employment_changed ? "roster" : null,
    row.components_changed ? "components" : null,
    row.component_definitions_changed ? "componentDefinitions" : null,
    row.derived_rules_changed ? "derivedRules" : null,
    row.entitlements_changed ? "entitlements" : null,
    row.worker_comp_changed ? "workerComp" : null,
    row.time_types_changed ? "timeTypes" : null,
    row.settings_changed ? "settings" : null,
    row.ytd_changed ? "ytd" : null,
  ].filter((r): r is string => r !== null);
  return {
    stale: reasons.length > 0,
    reasons,
    calculatedAt: row.calculated_at instanceof Date
      ? row.calculated_at.toISOString()
      : (row.calculated_at ?? null),
  };
}

/**
 * The commit-side half of the staleness control.
 *
 * `payRunStaleness` is what the wizard RENDERS — a banner and a disabled
 * button, both client-side, both of which a scripted call to the runs API or
 * a tab left open across an edit simply walks past. This is the boundary
 * that ENFORCES it: called immediately before `commitPayRun`, it turns the
 * same answer into a refusal, so the figures the GL projection materializes
 * are always ones a calculation produced against the inputs as they stand
 * now — never ones the operator edited past after Calculate ran.
 *
 * A missing run and a never-calculated run are NOT this gate's question to
 * answer: both fall through to `commitPayRun`'s own state guards ("pay run
 * not found", "calculate the pay run before committing"), which name those
 * states precisely. This gate owns exactly one question — is the stored
 * calculation still current — and answers it by refusing when it is not.
 */
export async function assertPayRunNotStale(
  orgId: string,
  documentId: string,
): Promise<void> {
  const { stale, reasons, calculatedAt } = await payRunStaleness(orgId, documentId);
  if (!stale || calculatedAt === null) return;
  throw new PayrollError(
    `the run's inputs changed after it was last calculated (${reasons.join(", ")})`
      + " — recalculate before committing",
  );
}

/** Net pay owed on one rail, and how many people are on it. */
export interface FundingRail {
  method: PayrollPaymentMethod;
  netPay: string;
  employees: number;
}

export interface PayRunFunding {
  /** Net pay owed to employees — the money that must leave the bank. */
  netPay: string;
  /**
   * The same net pay split by how it leaves: a controller funds a direct-
   * deposit file and a cheque run differently — the file is drawn on the
   * payday, the cheques clear whenever they are presented — so a single
   * "cash required" number is not the question actually being asked.
   */
  rails: FundingRail[];
  /** Statutory + benefit liabilities the run records (remitted later). */
  liabilities: string;
  /** Total employer cost of the payday. */
  totalCost: string;
  payDate: string;
  /** Business days from today to the pay date (negative = already past). */
  businessDaysToPayDate: number;
  /** Bank accounts with book balance, for the funding picker. */
  accounts: { id: string; label: string; balance: string; sufficient: boolean }[];
}

function businessDaysBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  const forward = to >= from;
  const cursor = new Date(forward ? from : to);
  const end = forward ? to : from;
  let days = 0;
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) days++;
  }
  return forward ? days : -days;
}

/** What this payday costs, and whether the chosen bank can carry it. */
export async function payRunFunding(orgId: string, documentId: string): Promise<PayRunFunding> {
  const run = await runContext(orgId, documentId);
  const today = await businessToday(orgId);
  const payDate = run?.pay_date ?? today;

  const totals = (await db.execute<{ net: string; gross: string; employer: string }>(sql`
    select coalesce(sum(net_pay), 0)::text as net,
           coalesce(sum(gross), 0)::text as gross,
           coalesce(sum(employer_cost), 0)::text as employer
      from pay_stubs where org_id = ${orgId} and pay_run_document_id = ${documentId}
  `));
  const t = totals.rows[0] ?? { net: "0", gross: "0", employer: "0" };
  // Liabilities = what the run owes but does not pay today: employee
  // withholdings (gross − net) plus the employer-side accruals.
  const liabilities = add(add(t.gross, neg(t.net)), t.employer);

  // Both rails are always reported, including at zero: the operator has to be
  // able to see that nobody is on cheques, not infer it from an absent row.
  const stubs = await stubPaymentMethods(orgId, documentId);
  const rails: FundingRail[] = PAYROLL_PAYMENT_METHODS.map((method) => {
    const mine = stubs.filter((s) => s.method === method);
    return { method, netPay: sum(mine.map((s) => s.netPay)), employees: mine.length };
  });

  const accounts = (await db.execute<{ id: string; label: string; balance: string }>(sql`
    select a.id, coalesce(a.number || ' · ', '') || a.name as label,
           coalesce(bal.amount, 0)::text as balance
      from accounts a
      left join lateral (
        select sum(jl.amount) as amount
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
         where jl.org_id = a.org_id and jl.account_id = a.id) bal on true
     where a.org_id = ${orgId} and a.is_active and not a.is_summary and a.type = 'asset_bank'
     order by a.number nulls last, a.name
  `));

  return {
    netPay: t.net,
    rails,
    liabilities,
    totalCost: add(t.net, liabilities),
    payDate,
    businessDaysToPayDate: businessDaysBetween(today, payDate),
    accounts: accounts.rows.map((a) => ({ ...a, sufficient: cmp(a.balance, t.net) >= 0 })),
  };
}

export interface StubChange {
  employeePartyId: string;
  employeeName: string;
  /** Pay date of the previous committed stub, when there is one. */
  previousPayDate: string | null;
  netDelta: string;
  grossDelta: string;
  hoursDelta: string;
  /** Component-level differences: added, removed, or changed amount. */
  changes: {
    kind: "added" | "removed" | "changed";
    component: string;
    from: string | null;
    to: string | null;
  }[];
}

/**
 * What changed for each employee since their previous committed stub.
 * Payroll review is a diff exercise — reconstructing it by eye is exactly
 * where errors survive — so compare the component sets, not just net pay.
 */
export async function payRunChanges(orgId: string, documentId: string): Promise<StubChange[]> {
  const rows = (await db.execute<{
      employee_party_id: string; name: string; gross: string; net_pay: string;
      prev_gross: string | null; prev_net: string | null; prev_pay_date: string | null;
      current_lines: { d: string; a: string; h: string | null }[] | null;
      previous_lines: { d: string; a: string; h: string | null }[] | null;
    }>(sql`
    with current_stub as (
      select s.id, s.employee_party_id, p.display_name as name, s.gross, s.net_pay
        from pay_stubs s
        join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
       where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
    ),
    previous_stub as (
      select distinct on (s.employee_party_id)
             s.employee_party_id, s.id, s.gross, s.net_pay, s.pay_date::text as pay_date
        from pay_stubs s
        join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
       where s.org_id = ${orgId} and s.pay_run_document_id <> ${documentId}
       order by s.employee_party_id, s.pay_date desc, s.id desc
    )
    select c.employee_party_id, c.name, c.gross, c.net_pay,
           pv.gross as prev_gross, pv.net_pay as prev_net, pv.pay_date as prev_pay_date,
           coalesce((select json_agg(json_build_object('d', l.description, 'a', l.amount, 'h', l.hours))
                       from pay_stub_lines l where l.org_id = ${orgId} and l.stub_id = c.id), '[]'::json) as current_lines,
           coalesce((select json_agg(json_build_object('d', l.description, 'a', l.amount, 'h', l.hours))
                       from pay_stub_lines l where l.org_id = ${orgId} and l.stub_id = pv.id), '[]'::json) as previous_lines
      from current_stub c
      left join previous_stub pv on pv.employee_party_id = c.employee_party_id
     order by c.name
  `));

  const fold = (lines: { d: string; a: string; h: string | null }[] | null) => {
    const map = new Map<string, { amount: string; hours: string }>();
    for (const line of lines ?? []) {
      const seen = map.get(line.d) ?? { amount: "0", hours: "0" };
      map.set(line.d, {
        amount: add(seen.amount, line.a),
        hours: add(seen.hours, line.h ?? "0"),
      });
    }
    return map;
  };

  return rows.rows.map((row) => {
    const now = fold(row.current_lines);
    const before = fold(row.previous_lines);
    const changes: StubChange["changes"] = [];
    for (const [component, value] of now) {
      const prior = before.get(component);
      if (!prior) changes.push({ kind: "added", component, from: null, to: value.amount });
      else if (cmp(prior.amount, value.amount) !== 0) {
        changes.push({ kind: "changed", component, from: prior.amount, to: value.amount });
      }
    }
    for (const [component, value] of before) {
      if (!now.has(component)) {
        changes.push({ kind: "removed", component, from: value.amount, to: null });
      }
    }
    return {
      employeePartyId: row.employee_party_id,
      employeeName: row.name,
      previousPayDate: row.prev_pay_date,
      netDelta: add(row.net_pay, neg(row.prev_net ?? "0")),
      grossDelta: add(row.gross, neg(row.prev_gross ?? "0")),
      hoursDelta: add(
        sum([...now.values()].map((v) => v.hours)),
        neg(sum([...before.values()].map((v) => v.hours))),
      ),
      changes,
    };
  });
}
