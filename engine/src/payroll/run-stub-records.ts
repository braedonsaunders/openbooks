/**
 * Stub construction records: the Line shape, persistence, expense-account resolution, and earnings snapshots.
 *
 * Extracted verbatim from engine/src/payroll/run.ts; bodies preserve exact
 * math, transaction/lock sequencing, and refusal identity.
 */
import { payrollSubsidiaryInScope, type PayrollSubsidiaryScope } from "./scope.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { add, sum } from "../money/money.ts";
import { jurisdictionKey, labourJurisdictionProblem, PayrollJurisdictionError, payrollJurisdictionDeclared, payrollPack, type PayrollAssessedOn } from "./packs.ts";
import { resolveStatutoryHolidayPay, undeclaredJurisdictionHolidayConflict, type StatutoryHolidayEligibilityFacts, type StatutoryHolidayEarningLine } from "./holidays.ts";
import { planMovementsForStub, recordEntitlementMovements } from "./entitlements.ts";
import { type EarningsAssessedLine } from "./limits.ts";
import { divideMoney } from "./run-allocation.ts";
/**
 * One line of a stub under construction — earnings, deductions, and employer
 * contributions alike, in the order phases append them. Hoisted to module
 * level so the jurisdiction and persistence helpers below can name it; it
 * carries no behavior, only shape.
 */
/** Which rung of the expense-account resolution answered for a stub line. */
export type ExpenseAccountSource = "item" | "component" | "org_default";

/**
 * Per-program applicability stamped from a component row's
 * `program_exclusions` (0342, C-13): the earning type feeds every declared
 * program EXCEPT the excluded keys. Empty or absent exclusions stamp
 * nothing, so the accumulation's default-true includes the line. Keys no
 * pack declares are inert — no declared program ever looks them up, exactly
 * like an undeclared tax treatment. Pure, so the exclusion semantics are
 * verifiable without a database.
 */
export function programApplicabilityFromExclusions(
  exclusions: unknown,
): Record<string, boolean> | undefined {
  if (!Array.isArray(exclusions)) return undefined;
  const out: Record<string, boolean> = {};
  for (const key of exclusions) {
    if (typeof key === "string" && key !== "") out[key] = false;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface Line {
  componentId: string | null;
  kind: "earning" | "deduction" | "employer_contribution" | "credit";
  description: string; hours?: string; rate?: string; amount: string;
  projectId?: string | null; departmentId?: string | null; timeTypeId?: string | null;
  /** Service item the hours were worked on; only time-driven earning lines
   * carry one. Absent everywhere else — never inferred, never defaulted. */
  itemId?: string | null;
  /**
   * Expense account stamped at calculate (migration 0180). GL routing only:
   * setting these never changes what anyone is paid. Lines without an
   * item-driven stamp leave all three absent and post through the unchanged
   * component-then-default fallback.
   */
  expenseAccountId?: string | null;
  expenseAccountSource?: ExpenseAccountSource | null;
  expenseAccountEvidence?: { reason: string; reference: string } | null;
  sequence: number;
  taxable?: boolean; pensionable?: boolean; insurable?: boolean;
  /**
   * Per-program applicability for contribution programs the pack declares
   * (see `PayrollContributionProgram`): the earning type contributes to the
   * program's own base when its key is present and true. Absent key means
   * included, matching the sibling flags' default-true; an absent map means
   * every declared program includes the line. Never derived from another
   * program's base. Stamped from the component's `program_exclusions`
   * (beside `taxable`/`pensionable`/`insurable` in run-earning-lines.ts);
   * lines built without a component row in hand (holiday pay is wages)
   * carry no map and default-include, exactly like the sibling flags.
   */
  programApplicability?: Record<string, boolean>;
  vacationable?: boolean; nonPeriodic?: boolean; taxTreatment?: string;
  accrualOnly?: boolean;
  /**
   * Set on every pack-emitted statutory line: what the country pack declares
   * the amount is assessed on. `taxable_income` lines are dropped and
   * re-derived on each protection pass; `earnings` lines are computed once
   * and asserted unchanged (see the statutory pass below).
   */
  assessedOn?: PayrollAssessedOn;
  /** Time-type classification behind an hours line: the hours cap exempts
   *  overtime/double time charged to a job. */
  classification?: string;
  /** pay_components protection columns, carried so phase 10 needs no re-read. */
  protectionBase?: string;
  protectionMaxPercent?: string | null;
  protectionPriority?: number;
  includeInDisposableEarnings?: boolean;
}

/**
 * The run's resolved country pack, refused when it is declared but not
 * installable — statutory compute for such a country is refused, never
 * silently skipped.
 */
export function installablePackOrThrow(country: string) {
  const pack = payrollPack(country);
  if (!pack.installable) {
    throw new PayrollJurisdictionError(
      `the ${country} payroll pack is declared but not installable — statutory compute is refused`,
    );
  }
  return pack;
}

/**
 * Phase 2 — statutory holiday pay lines for one employee, gated entirely on
 * JURISDICTION facts. A day's pay derived from a LOOKBACK over prior
 * earnings, plus the premium for hours actually worked on the day, where —
 * and only where — the jurisdiction declares one. The formula is a statutory
 * fact declared per jurisdiction in the country pack
 * (engine/src/payroll/packs.ts), never hardcoded here: Ontario divides four
 * weeks of regular wages plus vacation pay by 20, British Columbia divides
 * thirty days of wages by the days actually worked, Saskatchewan takes five
 * per cent.
 *
 * The caller gates on the org's settings.payroll.statutoryHolidayPay (OFF for
 * existing tenants: the phase changes gross, so it is opted into, never
 * inherited by upgrade) and on the run not being an off-cycle one-off.
 *
 * A jurisdiction NO pack has transcribed (CA-MB, US-MA) is neither guessed at
 * nor blindly refused: with no statutory holiday in the period it calculates
 * exactly as it always has, and when one lands in the period — probed against
 * the country's declared employment calendars — the run stops with the same
 * message readiness raises, naming the jurisdiction and the holiday. A silent
 * zero on a paid holiday is indistinguishable from a correct calculation,
 * which is why the refusal exists.
 *
 * Returns the earning lines to append to the stub (empty when the period has
 * no paid holiday or the jurisdiction mandates none). Throws before any line
 * is produced when the employee's labour jurisdiction cannot be honoured or
 * an undeclared jurisdiction's holiday lands in the period.
 */
export async function statutoryHolidayLinesForStub(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    documentId: string;
    employeePartyId: string;
    employeeName: string;
    /** The profile record — its labour_jurisdiction overrides the region. */
    emp: Record<string, string | null>;
    country: string;
    province: string | null;
    periodStart: string;
    periodEnd: string;
    /** The resolved labor cost rate; a salaried rate is divided to hourly here. */
    payRate: { basis: "hour" | "year"; rate: string; annualHours: string } | null;
    need: (systemKey: string, kind: string) => Record<string, unknown>;
    /** Caller role scope; null/undefined is unrestricted. */
    allowedSubsidiaryIds?: PayrollSubsidiaryScope;
    /** Authoritative statutory entitlement facts keyed by employee party id. */
    holidayEligibility?: Readonly<Record<string, StatutoryHolidayEligibilityFacts>>;
  },
): Promise<StatutoryHolidayEarningLine[]> {
  const {
    orgId, documentId, employeePartyId, employeeName,
    emp, country, province, periodStart, periodEnd, payRate, need,
    allowedSubsidiaryIds,
    holidayEligibility,
  } = args;
  if (allowedSubsidiaryIds != null) {
    const employee = (await tx.execute<{ subsidiary_id: string | null }>(sql`
      select subsidiary_id from parties
       where org_id = ${orgId} and id = ${employeePartyId}
    `)).rows[0];
    if (!employee || !payrollSubsidiaryInScope(allowedSubsidiaryIds, employee.subsidiary_id)) {
      throw new PayrollError("employee not found");
    }
  }
  // The employment attribute wins over the region derivation where the
  // profile carries one: an employer regulated by a different labour
  // jurisdiction than the one the employee works in has a different holiday
  // calendar AND a different holiday-pay formula.
  //
  // An EXPLICIT value the packs do not declare is refused outright, not put
  // through the untranscribed-province gate below. The two are different
  // failures: an untranscribed province is a gap in the packs, and calculates
  // as it always has until a holiday actually lands in the period, whereas an
  // undeclared explicit key is a value somebody entered that means nothing —
  // it would silently fall back on the work region's calendar, which is the
  // exact substitution the attribute exists to prevent. The API validates it
  // with the same function (labourJurisdictionProblem), so reaching this is a
  // direct database write.
  const labourProblem = labourJurisdictionProblem(country, emp.labour_jurisdiction!);
  if (labourProblem) {
    throw new PayrollError(
      `${employeeName} has a labour jurisdiction this payroll cannot `
      + `honour — ${labourProblem}`,
    );
  }
  const employeeJurisdiction = jurisdictionKey(country, province, emp.labour_jurisdiction);
  if (!payrollJurisdictionDeclared(employeeJurisdiction)) {
    const conflict = undeclaredJurisdictionHolidayConflict({
      country, jurisdiction: employeeJurisdiction,
      from: periodStart, to: periodEnd,
    });
    if (conflict) throw new PayrollError(conflict.message);
    return [];
  }
  const holidayRate = payRate
    ? (payRate.basis === "hour"
        ? payRate.rate
        : divideMoney(payRate.rate, payRate.annualHours, 4))
    : "0";
  return resolveStatutoryHolidayPay(tx, {
    orgId,
    employeePartyId,
    employeeName,
    jurisdiction: employeeJurisdiction,
    periodStart,
    periodEnd,
    holidayComponentId: need("stat_holiday", "earning").id as string,
    premiumComponentId: need("stat_holiday_premium", "earning").id as string,
    excludeDocumentId: documentId,
    hourlyRate: holidayRate,
    paidOnCommission: holidayEligibility?.[employeePartyId]?.paidOnCommission,
    absentWithoutConsent: holidayEligibility?.[employeePartyId]?.absentWithoutConsent,
  });
}

/** Insert the pay_stubs header row; returns the new stub's id. */
export async function insertPayStubRow(
  tx: Pick<typeof db, "execute">,
  stub: {
    orgId: string; actorId: string; documentId: string; employeePartyId: string;
    country: string; filingAccountId: string | null; province: string; periodsPerYear: number; payDate: string; taxYear: number;
    federalClaim: string; provincialClaim: string; currency: string | null;
    gross: string; pensionable: string; insurable: string; net: string;
    employerCost: string; vacationAccrued: string;
    factors: Record<string, string>; paymentMethod: string;
  },
): Promise<string> {
  const inserted = (await tx.execute<{ id: string }>(sql`
    insert into pay_stubs (org_id, pay_run_document_id, employee_party_id, country, country_source, filing_account_id, filing_account_source, province,
                           periods_per_year, pay_date, tax_year, federal_claim, provincial_claim,
                           currency_code, gross, pensionable_earnings, insurable_earnings,
                           net_pay, employer_cost, vacation_accrued, factors, payment_method,
                           created_by, updated_by)
    values (${stub.orgId}, ${stub.documentId}, ${stub.employeePartyId}, ${stub.country}, 'calculation', ${stub.filingAccountId}, 'calculation', ${stub.province}, ${stub.periodsPerYear},
            ${stub.payDate}, ${stub.taxYear}, ${stub.federalClaim}, ${stub.provincialClaim},
            ${stub.currency}, ${stub.gross}, ${stub.pensionable}, ${stub.insurable},
            ${stub.net}, ${stub.employerCost}, ${stub.vacationAccrued}, ${JSON.stringify(stub.factors)}::jsonb,
            ${stub.paymentMethod},
            ${stub.actorId}, ${stub.actorId})
    returning id
  `));
  return inserted.rows[0]!.id;
}

/** Insert one row per stub line, in the order the phases appended them. */
export async function insertPayStubLineRows(
  tx: Pick<typeof db, "execute">,
  args: { orgId: string; stubId: string; actorId: string },
  lines: readonly Line[],
): Promise<void> {
  for (const line of lines) {
    // The expense stamp rides with the line it was resolved for: re-deriving
    // a draft deletes and reinserts these rows, so the expense immutability
    // guard (migration 0180) only ever fires on a committed run's history.
    // Lines without a stamp keep source 'unknown' with null account/evidence
    // and post through the unchanged component-then-default fallback.
    await tx.execute(sql`
      insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, hours, rate,
                                  amount, project_id, department_id, time_type_id, item_id, sequence,
                                  expense_account_id, expense_account_source, expense_account_evidence,
                                  created_by, updated_by)
      values (${args.orgId}, ${args.stubId}, ${line.componentId}, ${line.kind}, ${line.description},
              ${line.hours ?? null}, ${line.rate ?? null}, ${line.amount},
              ${line.projectId ?? null}, ${line.departmentId ?? null}, ${line.timeTypeId ?? null},
              ${line.itemId ?? null}, ${line.sequence},
              ${line.expenseAccountId ?? null}, ${line.expenseAccountSource ?? "unknown"},
              ${line.expenseAccountEvidence ? JSON.stringify(line.expenseAccountEvidence) : null}::jsonb,
              ${args.actorId}, ${args.actorId})
    `);
  }
}

/**
 * Ledger movements land only once the stub rows exist. The call replaces
 * THIS EMPLOYEE'S prior movements on this run and nobody else's — it is made
 * once per employee, so a run-scoped replacement here would erase every
 * previously calculated employee's bank. It runs unconditionally: an
 * employee whose recompute produced no movements must still have their stale
 * rows cleared.
 *
 * Skipped entirely for a SIMULATION: the movements of a committed run are
 * append-only (entitlement_ledger_append_only), and a rolled-back
 * re-derivation has no business rewriting the bank behind a payroll that has
 * already gone out.
 */
export async function persistEntitlementMovements(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; actorId: string; documentId: string;
    employeePartyIds: [string]; simulate: boolean;
    movements: Awaited<ReturnType<typeof planMovementsForStub>>["movements"];
  },
): Promise<void> {
  if (args.simulate) return;
  await recordEntitlementMovements(tx, {
    orgId: args.orgId, actorId: args.actorId, payRunDocumentId: args.documentId,
    employeePartyIds: args.employeePartyIds,
    movements: args.movements,
  });
}

/** Gross earning base: every earning line that is real pay. Accrual-only
 * employer lines carry no employee money and stay out of every basis. */
export const earningsBase = (lines: readonly Line[]): string =>
    sum(lines.filter((l) => l.kind === "earning" && !l.accrualOnly).map((l) => l.amount));

// Hours ACTUALLY WORKED — earning lines only, matching cappableHourLines and
// the hourLines the per-hour fringe allocates across.
//
// A per-hour fringe writes its own lines carrying the hours it was assessed
// on, so summing "any line with hours" made each fringe compound the ones
// before it: with a pension and a health-and-welfare fringe on a 40-hour week,
// pension computed on 40 hours and H&W then computed on 80. Two or more
// per-hour fringes is the ordinary case in union construction, and the error
// grew with every additional one.
export const totalHours = (lines: readonly Line[]): string =>
    sum(lines.filter((l) => l.kind === "earning" && l.hours).map((l) => l.hours!));

/**
 * The current earnings collapsed to one bucket per project/department — the
 * weights any job-costed employer burden allocates against. The untagged
 * bucket is deliberately included so an overhead share stays overhead
 * instead of being pushed onto whichever jobs happen to be on the stub.
 */
export const earningJobBuckets = (lines: readonly Line[]): {
  projectId: string | null; departmentId: string | null; weight: string;
}[] => {
    const byDimension = new Map<string, {
      projectId: string | null; departmentId: string | null; weight: string;
    }>();
    for (const line of lines) {
      if (line.kind !== "earning" || line.accrualOnly) continue;
      const key = `${line.projectId ?? ""}|${line.departmentId ?? ""}`;
      const existing = byDimension.get(key);
      if (existing) existing.weight = add(existing.weight, line.amount);
      else {
        byDimension.set(key, {
          projectId: line.projectId ?? null,
          departmentId: line.departmentId ?? null,
          weight: line.amount,
        });
      }
    }
    return [...byDimension.values()];
};

// Hours behind a capped basis. "Overtime or double time charged to a job is
// exempt from the 40-hour cap" is a property of the hour, not of the
// component, so the predicate lives here and the engine stays pure.
export const cappableHourLines = (lines: readonly Line[]) =>
    lines
      .filter((l) => l.kind === "earning" && l.hours && !l.accrualOnly)
      .map((l) => ({
        hours: l.hours!,
        amount: l.amount,
        exemptFromHoursCap:
          (l.classification === "overtime" || l.classification === "double_time")
          && l.projectId != null,
      }));

/** Every earnings-assessed line as the invariant check compares them. */
export const earningsAssessedSnapshot = (lines: readonly Line[]): EarningsAssessedLine[] =>
    lines
      .filter((l) => l.assessedOn === "earnings")
      .map((l) => ({
        component: l.description,
        amount: l.amount,
        projectId: l.projectId ?? null,
        departmentId: l.departmentId ?? null,
      }));

/**
 * Periodic earnings for one stub: salary divided by the period count, or the
 * period's approved time grouped by time type × project × department and
 * priced at the effective wage. An off-cycle one-off run appends nothing —
 * its adjustments or settled retro differences carry the whole cheque.
 */
/**
 * Expense-account resolution for a time-driven earning line (migration 0180).
 * Most specific first: the service item (what work this was) answers before
 * the pay component (what kind of money it is) before the org wage default.
 * GL routing only — the returned account never changes any amount.
 *
 * Structured as (itemAccount, componentAccount, default) so employer burden
 * can reuse it later without rework; burden is deliberately NOT wired to it
 * yet (burden lines keep the component-then-default fallback at posting).
 * Returns null when no rung names an account, and the line stays unstamped —
 * posting then refuses with the same setup-incomplete error as today.
 */
export function resolveEarningExpenseAccount(args: {
  item: {
    id: string; name: string;
    accountId: string | null; accountNumber: string | null; accountName: string | null;
  } | null;
  component: { id: string; name: string; expenseAccountId: string | null };
  wageDefaultAccountId: string | null;
}): {
  accountId: string; source: ExpenseAccountSource; evidence: { reason: string; reference: string };
} | null {
  if (args.item?.accountId) {
    const label = [args.item.accountNumber, args.item.accountName].filter(Boolean).join(" · ")
      || args.item.accountId;
    return {
      accountId: args.item.accountId,
      source: "item",
      evidence: {
        reason: `hours on item "${args.item.name}" are costed to ${label}`,
        reference: `items:${args.item.id}`,
      },
    };
  }
  if (args.component.expenseAccountId) {
    return {
      accountId: args.component.expenseAccountId,
      source: "component",
      evidence: {
        reason: args.item
          ? `item "${args.item.name}" names no payroll expense account; component "${args.component.name}" expense account answers`
          : `no item on this line; component "${args.component.name}" expense account answers`,
        reference: `pay_components:${args.component.id}`,
      },
    };
  }
  if (args.wageDefaultAccountId) {
    return {
      accountId: args.wageDefaultAccountId,
      source: "org_default",
      evidence: {
        reason: "neither the item nor the component names an expense account; org wage expense default answers",
        reference: "orgs.settings.payroll.wageExpenseAccountId",
      },
    };
  }
  return null;
}
