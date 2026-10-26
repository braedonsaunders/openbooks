import { getTableColumns, sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { canonicalPeriodLabelSql } from "../periods/period-policy.ts";
import { PayrollError } from "./error.ts";
import {
  payrollPaymentMethodSettings,
  resolvePayrollPaymentMethod,
  type ResolvedPaymentMethod,
} from "./payment-method.ts";
import { leavePayrollInputProblems } from "./leave-payroll-inputs.ts";
import { allowancePayrollInputProblem } from "./allowance-payroll-inputs.ts";
import { PERIODIC_RUN_TYPES } from "./run-contracts.ts";
import { payrollSettings } from "./run-setup.ts";
import { type PayrollSubsidiaryScope } from "./scope.ts";
import {
  employerLevyProgramKeys,
  jurisdictionKey,
  labourJurisdictionProblem,
  packSlotState,
  packWarnsOnMissingIdentifier,
  payrollJurisdictionDeclared,
  PAYROLL_COUNTRY_PACKS,
} from "./packs.ts";
import { undeclaredJurisdictionHolidayConflict } from "./holidays.ts";
import { UNDECIDED_WORKER_COMP_DETAIL } from "./employee-worker-comp.ts";
import { payrollTaxYearProblem } from "./packs.ts";
import { employeeFactsFor, missingEmployeeFacts, packPayableProblem } from "./employee-facts.ts";
import { employeePayrollProfiles } from "@openbooks/schema";
import { laborCostingSettings } from "../projects/labor-costing.ts";
import {
  CONTROL_ACCOUNTS_HREF,
  regionsByCountry,
  runContext,
  scope,
  installedPayrollCountries,
  type ReadinessSeverity,
  type ReadinessItem,
  type PayRunReadiness,
  type ScopeRow,
} from "./readiness-context.ts";
import {
  unconfiguredRatesForRun,
  flagRetiredCertificateAnswers,
  flagMissingOpeningBalances,
  flagMissingEntitlementOpenings,
} from "./readiness-statutory-gaps.ts";

/** Pay-run readiness: blockers and warnings that must be seen before a run calculates. */

export async function payRunReadiness(
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<PayRunReadiness> {
  const items: ReadinessItem[] = [];
  const flag = (
    severity: ReadinessSeverity,
    code: string,
    employees: ScopeRow[] = [],
    extra: { detail?: string; href?: string; action?: string } = {},
  ) => {
    items.push({
      severity,
      code,
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

  const run = await runContext(orgId, documentId, allowedSubsidiaryIds);
  // A missing run is a named not-found, never an empty bill of health:
  // tally(0) reports zero blockers for a run that does not exist.
  if (!run) throw new PayrollError("pay run not found");
  const people = await scope(orgId, documentId, run, allowedSubsidiaryIds);
  if (PERIODIC_RUN_TYPES.has(run.run_type)) {
    const problem = await leavePayrollInputProblems(db, {
      orgId,
      runDocumentId: documentId,
      periodStart: run.period_start,
      periodEnd: run.period_end,
      employeePartyIds: people.map((person) => person.employee_party_id),
    });
    if (problem) {
      flag("blocker", `payroll.${problem.code.toLowerCase()}`, people, {
        detail: problem.message,
        href: "/admin/setup/leave-types?setupTab=leave-payroll-entitlement-mappings",
      });
    }
    const allowanceProblem = await allowancePayrollInputProblem(db, {
      orgId,
      runDocumentId: documentId,
      periodStart: run.period_start,
      periodEnd: run.period_end,
      employeePartyIds: people.map((person) => person.employee_party_id),
    });
    if (allowanceProblem) {
      flag("blocker", `payroll.${allowanceProblem.code.toLowerCase()}`, people, {
        detail: allowanceProblem.message,
        href: "/hrm/compliance",
      });
    }
  }

  // --- Org configuration: a commit cannot balance without these ------------
  const setupHref = "/admin/setup/payroll";
  let settings: Awaited<ReturnType<typeof payrollSettings>> | null = null;
  let payrollPolicy: Record<string, unknown> = {};
  let installed: string[] = [];
  try {
    settings = await payrollSettings(orgId, allowedSubsidiaryIds);
    if (!settings.wageExpenseAccountId)
      flag("blocker", "setup.wageExpense", [], { href: setupHref });
    if (!settings.netPayAccountId) flag("blocker", "setup.netPay", [], { href: setupHref });
    if (settings.wagesTo === "labor_clearing") {
      const clearing = await db.execute<{ id: string | null }>(
        sql`
        select settings->'controlAccounts'->>'laborClearing' as id from orgs where id = ${orgId}
      `,
        "objects",
      );
      if (!clearing[0]?.id)
        flag("blocker", "setup.laborClearing", [], { href: CONTROL_ACCOUNTS_HREF });
    } else if ((await laborCostingSettings(orgId)).mode === "post") {
      flag("warning", "setup.laborWashMode", [], { href: `${setupHref}?tab=accounts` });
    }

    // Every statutory slot of every pack the run's people belong to must resolve
    // to a liability account, or the commit has nowhere to credit withholdings.
    const blob = await db.execute<{ p: Record<string, unknown> | null }>(
      sql`
      select settings->'payroll' as p from orgs where id = ${orgId}
    `,
      "objects",
    );
    payrollPolicy = blob[0]?.p ?? {};
    installed = await installedPayrollCountries(orgId, payrollPolicy, allowedSubsidiaryIds);
    const countriesInRun = new Set(people.map((p) => p.country));
    // Slots that do not apply where this run's people work are absent, not
    // demanded — an Ontario-only run is never blocked on Québec accounts.
    const runRegions = regionsByCountry(people);
    for (const pack of await packSlotState(orgId, installed, runRegions)) {
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

    // --- Statutory tables: is this year even loaded? -----------------------
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
      // Dedup on the DISPLAYED string: entries rendering identical operator
      // text are one blocker to the operator even when the developer strings
      // differ (the undeclared message names no year, so two years of it
      // would otherwise collapse callers that do pass a year along).
      if (!problem || taxYearFailures.has(problem.operatorMessage)) continue;
      taxYearFailures.add(problem.operatorMessage);
      flag(
        "blocker",
        "statutory.taxYear",
        people.filter((p) => p.country === country && (region === null || p.province === region)),
        // Operator text: the packs tab shows each pack's published coverage
        // but offers no action that loads an unpublished year, so the detail
        // must not prescribe the developer's scaffold script. The developer
        // remedy stays on `problem.message` for engine throws and logs.
        { detail: problem.operatorMessage, href: `${setupHref}?tab=packs` },
      );
    }

    // --- Pack payable: required employee facts with no producer ------------
    // A pack that cannot pay ANY employee says so here, before calculation,
    // rather than refusing every employee at test-calculation time: the PL
    // birth year, the ES grupo/situación/año trio, the JP hyōjun/kaigo pair
    // and the BR dependent count are declared on each pack's employeeFacts
    // with no producer yet. Countries with no registered pack are skipped —
    // the statutory.taxYear "undeclared" blocker above already carries them.
    for (const country of countriesInRun.size > 0 ? [...countriesInRun] : installed) {
      const pack = PAYROLL_COUNTRY_PACKS[country];
      if (!pack) continue;
      const payableProblem = packPayableProblem(pack);
      if (!payableProblem) continue;
      flag(
        "blocker",
        "pack.notPayable",
        people.filter((p) => p.country === country),
        { detail: payableProblem, href: `${setupHref}?tab=packs` },
      );
    }

    // --- Per-employee facts: a blank birth year blocks its employee ------
    // `pack.notPayable` fires only while a pack has NO producer for a
    // required fact. Once the channel exists, the gap moves per employee:
    // a PL profile with no birth year refuses at calculation, so it must
    // refuse here instead — naming the fact's operator-facing label and
    // pointing at the employee's Payroll tab. Read generically off the
    // packs' own declarations: the columns are whatever required facts
    // map to profile columns, so the next pack's fact is enumerated with
    // no edit here. Unregistered countries enumerate nothing — their reads
    // refuse at authoring time, never silently.
    if (people.length > 0) {
      const storedColumns = new Set(
        Object.values(getTableColumns(employeePayrollProfiles)).map((column) => column.name),
      );
      const wanted = new Set<string>();
      for (const person of people) {
        for (const fact of employeeFactsFor(person.country)) {
          if (
            fact.required &&
            fact.producer.kind === "profile_column" &&
            storedColumns.has(fact.producer.column)
          ) {
            wanted.add(fact.producer.column);
          }
        }
      }
      if (wanted.size > 0) {
        const columns = [...wanted].sort().map((column) => sql.identifier(column));
        const partyIds = [...new Set(people.map((p) => p.employee_party_id))];
        const factRows = await db.execute<Record<string, string | null>>(
          sql`
          select prof.employee_party_id, ${sql.join(columns, sql`, `)}
            from employee_payroll_profiles prof
           where prof.org_id = ${orgId}
             and prof.employee_party_id in (${sql.join(
               partyIds.map((id) => sql`${id}`),
               sql`, `,
             )})
        `,
          "objects",
        );
        const factsByEmployee = new Map<string, Record<string, string | null>>(
          factRows.map((row) => [String(row.employee_party_id), row]),
        );
        const missingByFact = new Map<
          string,
          { fact: string; label: string; people: ScopeRow[] }
        >();
        for (const person of people) {
          const emp = factsByEmployee.get(person.employee_party_id) ?? {};
          for (const fact of missingEmployeeFacts(person.country, emp)) {
            const entry = missingByFact.get(fact.key) ?? {
              fact: fact.key,
              label: fact.label,
              people: [],
            };
            entry.people.push(person);
            missingByFact.set(fact.key, entry);
          }
        }
        for (const { label, people: missing } of [...missingByFact.values()]) {
          flag("blocker", "employee.missingFact", missing, {
            detail: `${label} is not set — enter it on the employee's Payroll tab before calculating`,
            href: "/entities/employees",
          });
        }
      }
    }

    // --- Statutory rates the employer has to supply -------------------------
    for (const country of countriesInRun.size > 0 ? [...countriesInRun] : installed) {
      for (const missing of await unconfiguredRatesForRun(
        orgId,
        country,
        run.tax_year,
        people,
        run.pay_date,
      )) {
        flag(
          "warning",
          "statutory.rateUnconfigured",
          people.filter((p) => missing.employees.some((e) => e.partyId === p.employee_party_id)),
          { detail: missing.message, href: `${setupHref}?tab=rates` },
        );
      }
    }
  } catch (error) {
    // A child-only caller may read its run and people while the org-level
    // payroll configuration is rooted outside its scope. Omit those aggregate
    // checks rather than leaking settings or refusing authorized run data.
    if (
      allowedSubsidiaryIds == null ||
      !(error instanceof PayrollError) ||
      error.message !== "payroll settings not found"
    )
      throw error;
  }

  // --- Period control: posting into a closed period fails at post ---------
  // The lock read follows the same period the posting would resolve to
  // (default calendar, regular): with several calendars the covering row
  // would otherwise be whichever the database returns first.
  const lock = await db.execute<{ label: string; state: string }>(
    sql`
    select ${canonicalPeriodLabelSql("p")} as label, coalesce(l.state, 'open') as state
      from accounting_periods p
      join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
        and fc.is_default and fc.is_active
      join accounting_books b on b.org_id = p.org_id and b.is_primary and b.is_active
      left join period_locks l
        on l.org_id = p.org_id and l.period_id = p.id and l.book_id = b.id and l.module = 'gl'
       and (l.subsidiary_id is not distinct from ${run.subsidiary_id} or l.subsidiary_id is null)
     where p.org_id = ${orgId} and p.starts_on <= ${run.pay_date} and p.ends_on >= ${run.pay_date}
       and p.is_adjustment = false
     order by (l.subsidiary_id is not null) desc, p.starts_on, p.ends_on, p.id
     limit 1
  `,
    "objects",
  );
  // Both period blockers resolve on the periods setup screen (generate the
  // missing period, or reopen the closed one) — the readiness panel promises
  // every item links to where it is fixed.
  if (!lock[0])
    flag("blocker", "period.missing", [], {
      detail: run.pay_date,
      href: "/admin/setup/period-close",
    });
  else if (lock[0].state !== "open") {
    flag("blocker", "period.closed", [], {
      detail: lock[0].label,
      href: "/admin/setup/period-close",
    });
  }

  // --- Population ---------------------------------------------------------
  if (people.length === 0) flag("blocker", "scope.empty", []);

  const employeesHref = "/entities/employees";
  const noEmployment = people.filter((p) => !p.has_employment_link);
  if (noEmployment.length)
    flag("blocker", "employee.noEmployment", noEmployment, {
      href: employeesHref,
      action: "payroll.resolve-employment-links",
    });
  const noWage = people.filter((p) => !p.has_wage);
  if (noWage.length) flag("blocker", "employee.noWage", noWage, { href: employeesHref });

  // Workers-compensation coverage is pack-declared, never a country list: an
  // employee is flagged only when their own pack prices a workers-comp levy
  // (the CA pack's `wcb` program) — a pack with no such premium refuses
  // nothing. A missing rate class with no recorded exemption silently
  // accrued no premium, so the run cannot calculate until each named
  // employee is assigned a class or recorded exempt; calculateStub refuses
  // the same predicate, so the wizard names it first.
  const noWorkerComp = people.filter(
    (p) =>
      employerLevyProgramKeys(p.country).includes("wcb") &&
      !p.worker_comp_group_id &&
      !p.wcb_exempt,
  );
  if (noWorkerComp.length) {
    flag("blocker", "employee.noWorkerComp", noWorkerComp, {
      detail: UNDECIDED_WORKER_COMP_DETAIL,
      href: employeesHref,
    });
  }

  const zeroHours = people.filter(
    (p) => p.pay_basis === "hourly" && Number(p.approved_hours) === 0,
  );
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

  // Pack-declared, never a country list: the warning fires for an employee
  // without a sealed identifier only when their pack requires one AND names
  // a filing that needs it. A pack with no filing to feed, or with a
  // voluntary identifier, warns about nothing.
  const noSin = people.filter((p) => !p.has_sin && packWarnsOnMissingIdentifier(p.country));
  if (noSin.length) flag("warning", "employee.noSin", noSin, { href: employeesHref });

  // --- Statutory holiday pay ------------------------------------------------
  // Only when the org has turned the feature on. An employee whose
  // jurisdiction NO pack has transcribed (CA-MB, US-MA) is a blocker exactly
  // when a statutory holiday actually lands in the period — probed against the
  // country's declared employment calendars — and calculateStub refuses with
  // the SAME message, so the wizard names the problem before the run does.
  // With no holiday in the period, an undeclared jurisdiction calculates
  // exactly as it always has and nothing is flagged.
  if ((payrollPolicy as { statutoryHolidayPay?: unknown }).statutoryHolidayPay === true) {
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
        country,
        jurisdiction,
        from: run.period_start,
        to: run.period_end,
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
  // accumulated before OpenBooks (see engine/src/payroll/opening-balances.ts).
  // Without it the engine restarts every ceiling at zero, so an employer
  // adopting mid-year re-withholds up to a second full annual contribution maximum
  // and every T4/W-2 box understates the year.
  //
  // WARNING, never a blocker: a genuinely new employer's first payroll has no
  // prior year-to-date and is completely correct with no rows at all. The
  // product's job is to make the operator see the question once, on the one
  // run where it is still cheap to answer.
  await flagMissingOpeningBalances({ orgId, documentId, run, people, flag });
  await flagRetiredCertificateAnswers({ orgId, run, people, flag });
  await flagMissingEntitlementOpenings({ orgId, documentId, run, people, flag });

  // A retro run carries its own control set (source period voided or moved,
  // cross-year, retired component, another open retro run on the same cell).
  // The commit enforces the blockers; the pre-flight shows them here so the
  // operator sees the refusal before pressing Commit. Dynamic import keeps
  // the readiness ↔ retro-store ↔ pay-run cycle out of the engine load order.
  if (run.run_type === "retro") {
    const { retroRunFindings } = await import("./retro-store.ts");
    for (const finding of await retroRunFindings(orgId, documentId, db, allowedSubsidiaryIds)) {
      items.push({
        severity: finding.severity,
        code: finding.code,
        employees: finding.employees,
        detail: finding.detail,
        href: "/payroll/retro",
      });
    }
  }

  return tally(people.length);
}
