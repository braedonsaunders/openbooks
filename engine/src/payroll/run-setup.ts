/**
 * Pay-run setup: organization payroll settings, component seeding, and the vacation entitlement-plan bootstrap.
 *
 * Extracted verbatim from engine/src/payroll/run.ts; bodies preserve exact
 * math, transaction/lock sequencing, and refusal identity.
 */
import { payrollSubsidiaryInScope, type PayrollSubsidiaryScope } from "./scope.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { cmp, roundMoney } from "../money/money.ts";
import { assertContributoryBasesDeclared, ensurePackSlotRoleAccounts, packStatutoryComponents } from "./packs.ts";
import { type EntitlementPlan } from "./entitlements.ts";
export interface PayrollSettings {
  /** DR for wages when a component has no expense account of its own. */
  wageExpenseAccountId: string | null;
  /** DR for employer statutory burden (CPP/EI employer share, vacation). */
  burdenExpenseAccountId: string | null;
  /** CR net pay owed to employees (relieved by the payment). */
  netPayAccountId: string | null;
  /** CR statutory withholdings pending remittance to the CRA. */
  cppPayableAccountId: string | null;
  eiPayableAccountId: string | null;
  taxPayableAccountId: string | null;
  vacationPayableAccountId: string | null;
  /**
   * Where time-driven wages debit. 'labor_clearing' washes the standard cost
   * already posted at time approval (labor costing mode 'post') so the
   * existing clearing true-up converges; 'expense' debits wage expense with
   * project splits straight from the time entries.
   */
  wagesTo: "expense" | "labor_clearing";
  /** Vendor party used when raising CRA remittance bills. */
  craRemittancePartyId: string | null;
  /**
   * Vendor party for Revenu Québec remittances (TPZ-1015.R): a QC stub's
   * QPP/QPP2/QPIP route here per the CA pack's regional remittance
   * declaration (engine/src/payroll/packs.ts), never to the CRA vendor.
   */
  rqRemittancePartyId: string | null;
}

export async function payrollSettings(
  orgId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<PayrollSettings> {
  if (allowedSubsidiaryIds != null) {
    const root = (await db.execute<{ id: string }>(sql`
      select id from subsidiaries
       where org_id = ${orgId} and parent_id is null and is_active
       order by created_at limit 1
    `)).rows[0]?.id ?? null;
    if (!payrollSubsidiaryInScope(allowedSubsidiaryIds, root)) {
      throw new PayrollError("payroll settings not found");
    }
  }
  const r = (await db.execute<{ p: Record<string, unknown> | null; c: Record<string, unknown> | null }>(
    sql`select settings->'payroll' as p, settings->'controlAccounts' as c from orgs where id = ${orgId}`,
  ));
  const p = (r.rows[0]?.p ?? {}) as Record<string, string | null>;
  return {
    wageExpenseAccountId: p.wageExpenseAccountId ?? null,
    burdenExpenseAccountId: p.burdenExpenseAccountId ?? null,
    netPayAccountId: p.netPayAccountId ?? null,
    cppPayableAccountId: p.cppPayableAccountId ?? null,
    eiPayableAccountId: p.eiPayableAccountId ?? null,
    taxPayableAccountId: p.taxPayableAccountId ?? null,
    vacationPayableAccountId: p.vacationPayableAccountId ?? null,
    wagesTo: p.wagesTo === "labor_clearing" ? "labor_clearing" : "expense",
    craRemittancePartyId: p.craRemittancePartyId ?? null,
    rqRemittancePartyId: p.rqRemittancePartyId ?? null,
  };
}


interface SeedComponent {
  code: string; name: string; kind: string; systemKey: string | null;
  basis?: string; taxable?: boolean; pensionable?: boolean; insurable?: boolean;
  vacationable?: boolean; nonPeriodic?: boolean; sequence: number;
  /** Country pack the row belongs to; omitted = shared across packs. */
  country?: string;
}

/**
 * Statutory holiday pay and its worked-the-day premium: ordinary EARNINGS with
 * ordinary treatment — taxable, pensionable, insurable and vacationable in
 * every jurisdiction that has them, because statutory holiday pay is wages.
 * The premium line carries only the UPLIFT over the regular wage (the hours
 * themselves are already paid at 1.0× by the timesheet).
 *
 * Declared separately so `ensureStatutoryHolidayComponents` can provision
 * exactly this pair for orgs that predate it.
 */
const STAT_HOLIDAY_COMPONENTS: SeedComponent[] = [
  { code: "STAT", name: "Statutory holiday pay", kind: "earning", systemKey: "stat_holiday", sequence: 25 },
  { code: "STATPREM", name: "Statutory holiday premium", kind: "earning", systemKey: "stat_holiday_premium", sequence: 26 },
];

/** Jurisdiction-free earning baseline shared by every country pack. */
const BASELINE_COMPONENTS: SeedComponent[] = [
  { code: "BASE", name: "Base pay", kind: "earning", systemKey: "base_pay", basis: "per_hour", sequence: 10 },
  { code: "OT", name: "Overtime", kind: "earning", systemKey: "overtime", basis: "per_hour", sequence: 20 },
  ...STAT_HOLIDAY_COMPONENTS,
  { code: "BONUS", name: "Bonus", kind: "earning", systemKey: "bonus", nonPeriodic: true, vacationable: false, sequence: 30 },
  { code: "VACPAY", name: "Vacation pay", kind: "earning", systemKey: "vacation_payout", vacationable: false, sequence: 40 },
];

/**
 * The statutory rows ARE the country pack's declaration
 * (engine/src/payroll/packs.ts): one place declares a jurisdiction's statutory
 * component set, its system keys, and what each one is assessed on, and this
 * provisions exactly that. Adding a levy to a pack therefore seeds it and
 * classifies it in the same edit — it cannot be seeded unclassified.
 *
 * The earning flags accumulate whatever contributory bases the pack DECLARES
 * (`contributoryBases` in packs.ts): CPP/EI for the CRA, FICA/FUTA wages for
 * the IRS. Seeding asserts the declaration exists, so a pack cannot inherit
 * another jurisdiction's meaning for `pensionable` by silence.
 */
const statutoryComponents = (country: string): SeedComponent[] =>
  packStatutoryComponents(country).map((component) => ({
    code: component.code, name: component.name, kind: component.kind,
    systemKey: component.systemKey, sequence: component.sequence, country,
  }));

/** One idempotent component insert — the single seeding path. */
async function ensureComponents(
  executor: Pick<typeof db, "execute">,
  orgId: string, actorId: string | null, rows: readonly SeedComponent[],
): Promise<void> {
  for (const c of rows) {
    // Conflict target is the component IDENTITY (org, country, system_key,
    // kind), not the code. A conflict here is expected and benign: every pack
    // install re-seeds the shared baseline (same NULL-country identity rows)
    // and reinstalling a pack re-seeds its own set, so the second write must
    // be absorbed, never fail. The old `on conflict (org_id, code)` target
    // was idempotent on CODE while the constraint that fires is the SYSTEM
    // KEY one — installing Japan after Canada 500d on
    // pay_components_org_system (CA TAX vs JP GENSEN, both income_tax)
    // instead of being absorbed. The WHERE predicate matches the partial
    // index (0189, WHERE system_key IS NOT NULL): every seeded row carries a
    // system key by type, so the arbiter covers exactly what this seeder can
    // write. A caller that ever seeds a NULL-key row will fail LOUD here
    // (no matching arbiter) rather than silently skipping — that is
    // deliberate, per the on-conflict justification rule: silent skips are
    // how one country's component absorbed another's.
    await executor.execute(sql`
      insert into pay_components (org_id, code, name, kind, system_key, country, basis, taxable,
                                  pensionable, insurable, vacationable, non_periodic, sequence,
                                  created_by, updated_by)
      values (${orgId}, ${c.code}, ${c.name}, ${c.kind}, ${c.systemKey}, ${c.country ?? null},
              ${c.basis ?? "fixed_amount"},
              ${c.taxable ?? true}, ${c.pensionable ?? true}, ${c.insurable ?? true},
              ${c.vacationable ?? true}, ${c.nonPeriodic ?? false}, ${c.sequence}, ${actorId}, ${actorId})
      on conflict (org_id, country, system_key, kind) where system_key is not null do nothing
    `);
  }
}

/**
 * Statutory + baseline components for a country pack; idempotent.
 *
 * `country` has NO default. The old `= "CA"` default was Canada as the
 * module's identity: a caller that forgot the argument provisioned CPP and EI
 * for an org that may never employ a Canadian, and a third pack reached
 * through the settings route's cast would have seeded the CANADIAN set. The
 * pack registry is the only validator — an unknown country throws out of
 * `packStatutoryComponents` before anything is written.
 */
export async function seedPayrollComponents(
  orgId: string, actorId: string | null, country: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<void> {
  if (allowedSubsidiaryIds != null) {
    const root = (await db.execute<{ id: string }>(sql`
      select id from subsidiaries
       where org_id = ${orgId} and parent_id is null and is_active
       order by created_at limit 1
    `)).rows[0]?.id ?? null;
    if (!payrollSubsidiaryInScope(allowedSubsidiaryIds, root)) {
      throw new PayrollError("payroll settings not found");
    }
  }
  // A pack whose contributory-bases declaration is missing (authored through
  // a cast) must fail before its flags accumulate an unnamed base.
  assertContributoryBasesDeclared(country);
  await ensureComponents(db, orgId, actorId, [...BASELINE_COMPONENTS, ...statutoryComponents(country)]);
  // Role-declared slots land on the chart account their role resolves to
  // (the payroll-deductions account, never a vendor payable) wherever the
  // operator has not mapped the slot yet. An explicit mapping always wins.
  await ensurePackSlotRoleAccounts(db, orgId, actorId, country);
  await seedVacationEntitlementPlan(orgId, actorId, country);
}

/**
 * The statutory-holiday earning pair, ensured idempotently for orgs
 * provisioned before the components existed. Called by the pay run whenever
 * the feature is ON, so `ctx.need("stat_holiday", …)` is never the discovery
 * mechanism for a missing component on a long-lived tenant.
 */
export async function ensureStatutoryHolidayComponents(
  executor: Pick<typeof db, "execute">, orgId: string, actorId: string | null,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<void> {
  if (allowedSubsidiaryIds != null) {
    const root = (await executor.execute<{ id: string }>(sql`
      select id from subsidiaries
       where org_id = ${orgId} and parent_id is null and is_active
       order by created_at limit 1
    `)).rows[0]?.id ?? null;
    if (!payrollSubsidiaryInScope(allowedSubsidiaryIds, root)) {
      throw new PayrollError("payroll settings not found");
    }
  }
  await ensureComponents(executor, orgId, actorId, STAT_HOLIDAY_COMPONENTS);
}

/**
 * Whether statutory holiday pay is calculated at all
 * (orgs.settings.payroll.statutoryHolidayPay).
 *
 * Default OFF: the phase changes gross pay, so a tenant that has been running
 * payroll without it must opt in deliberately rather than find every stub
 * changed by an upgrade. The pack-install path turns it on for a NEW install
 * only (web/app/api/payroll/settings/route.ts).
 */
export async function statutoryHolidayPayEnabled(
  orgId: string,
  executorOrScope: Pick<typeof db, "execute"> | PayrollSubsidiaryScope = db,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<boolean> {
  const isExecutor = executorOrScope != null
    && typeof executorOrScope === "object" && "execute" in executorOrScope;
  const executor = isExecutor
    ? executorOrScope as Pick<typeof db, "execute">
    : db;
  const scope = allowedSubsidiaryIds !== undefined
    ? allowedSubsidiaryIds
    : (isExecutor ? undefined : executorOrScope as PayrollSubsidiaryScope);
  if (scope != null) {
    const root = (await executor.execute<{ id: string }>(sql`
      select id from subsidiaries
       where org_id = ${orgId} and parent_id is null and is_active
       order by created_at limit 1
    `)).rows[0]?.id ?? null;
    if (!payrollSubsidiaryInScope(scope, root)) {
      throw new PayrollError("payroll settings not found");
    }
  }
  const r = (await executor.execute<{ enabled: string | null }>(sql`
    select settings#>>'{payroll,statutoryHolidayPay}' as enabled from orgs where id = ${orgId}
  `));
  return r.rows[0]?.enabled === "true";
}

/**
 * The Vacation entitlement plan, provisioned beside the components it drives.
 *
 * Vacation accrual is an ENTITLEMENT PLAN, not a component: the plan engine
 * owns the accrual, the bank, the caps and the payout
 * (engine/src/payroll/entitlements.ts). The pack seeds the vacation_accrual /
 * vacation_payout components, so without this the components existed and the
 * plan did not, and a fresh org silently accrued nothing at all until somebody
 * ran scripts/migrate-vacation-to-entitlements.ts. Provisioning belongs beside
 * the components, not in a one-off script.
 *
 * Seeded only where the country pack actually declares a vacation accrual —
 * the US pack has no such levy, so a US-only org gets no plan and, if one of
 * its employees is nonetheless configured to accrue, the pay run says so out
 * loud (see `assertVacationPlanResolved`).
 *
 * Idempotent, and safe on a tenant that already migrated: an existing plan
 * carrying the binding is left completely alone, and a legacy "VAC" plan is
 * adopted by having the binding stamped onto it rather than being duplicated.
 */
async function seedVacationEntitlementPlan(
  orgId: string, actorId: string | null, country: string,
): Promise<void> {
  const declaresVacation = packStatutoryComponents(country)
    .some((component) => component.systemKey === "vacation_accrual");
  if (!declaresVacation) return;

  // The plan's BASE rate. Per-employee rates keep their one home on the
  // payroll profile (employee_payroll_profiles.vacation_percent) and service
  // tiers raise them; this is only what an employee with neither falls back
  // to. Same derivation the migration script uses, so a migrated tenant and a
  // freshly seeded one land on the same number.
  const modal = (await db.execute<{ percent: string }>(sql`
    select vacation_percent::text as percent
      from employee_payroll_profiles
     where org_id = ${orgId} and vacation_percent is not null and vacation_percent > 0
     group by vacation_percent
     order by count(*) desc, vacation_percent asc
     limit 1
  `));
  const accrualValue = roundMoney(modal.rows[0]?.percent ?? "4", 4);

  await db.execute(sql`
    insert into entitlement_plans (org_id, code, system_key, name, unit, direction, accrual_method,
                                   accrual_value, accrual_component_id, payout_component_id,
                                   liability_account_id, cap_behavior, is_active,
                                   created_by, updated_by)
    select ${orgId}, 'VAC', 'vacation', 'Vacation', 'money', 'accrue', 'percent_of_earnings',
           ${accrualValue},
           (select id from pay_components
             where org_id = ${orgId} and system_key = 'vacation_accrual' limit 1),
           (select id from pay_components
             where org_id = ${orgId} and system_key = 'vacation_payout' limit 1),
           (select (settings#>>'{payroll,vacationPayableAccountId}')::uuid
              from orgs where id = ${orgId}),
           'warn', true, ${actorId}, ${actorId}
     where not exists (
       select 1 from entitlement_plans where org_id = ${orgId} and system_key = 'vacation'
     )
    on conflict (org_id, code) do update
       set system_key = 'vacation',
           accrual_component_id = coalesce(entitlement_plans.accrual_component_id,
                                           excluded.accrual_component_id),
           payout_component_id = coalesce(entitlement_plans.payout_component_id,
                                          excluded.payout_component_id),
           liability_account_id = coalesce(entitlement_plans.liability_account_id,
                                           excluded.liability_account_id),
           updated_by = ${actorId}, updated_at = now()
     where entitlement_plans.org_id = ${orgId}
  `);
}

/**
 * An employee configured to BANK vacation must have a bank to put it in.
 *
 * The failure this exists to make impossible: a tenant whose Vacation plan is
 * missing (never migrated) or renamed accrued nothing at all, silently — 4% of
 * every employee's gross, every period, with the liability understated and no
 * error anywhere in the run, the readiness check, or the stub. A missing
 * accrual is money the employee is owed; it is never a no-op.
 *
 * Only the accrue case throws: `pay_each_period` and a final pay settle the
 * vacation in cash and need no plan at all.
 */
export function assertVacationPlanResolved(
  emp: Record<string, string | null>,
  vacationPlan: EntitlementPlan | null,
  terminationRun: boolean,
): void {
  if (vacationPlan) return;
  const percent = emp.vacation_percent;
  if (!percent || cmp(percent, "0") <= 0) return;
  if (terminationRun || emp.vacation_method === "pay_each_period") return;
  throw new PayrollError(
    `${emp.display_name ?? emp.party_id} accrues ${percent}% vacation, but this organization `
    + "has no vacation entitlement plan to accrue it into — create one in Payroll setup → "
    + "Entitlement plans (or set the employee's vacation method to pay each period)",
  );
}
