import { withOpeningReportingSnapshot } from './opening-reporting-snapshot.ts';
import { takeOpeningSourceYearFence } from '../organization/payroll-source-fence.ts';
import { lockPayrollEmploymentRoster } from "./employment-roster.ts";
import { requireCompensationPackageConfiguration } from './compensation-package-payroll.ts';
import { lockEmployerAssignmentProfiles } from './employer-assignment-history.ts';
import { lockPayrollServiceConfiguration } from './service-credit.ts';
import { assertRecurringBenefitsRunFresh } from './benefit-plan-inputs.ts';
import { payrollSettingsForPayRun } from "./run-setup.ts";
/**
 * Refusal acknowledgement, commit (GL projection write), and pre-commit preview.
 *
 * Extracted verbatim from engine/src/payroll/run.ts; bodies preserve exact
 * math, transaction/lock sequencing, and refusal identity.
 */
import { lockAndCheckPayrollRunPopulation, payrollSubsidiaryInScope, payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import { employeeTaxYearFenceKey, employerLevyFenceKey, takeEmployeeTaxYearFences, takeEmployerLevyFences } from "./fences.ts";
import { sql } from "drizzle-orm";
import { db, withTransactionSavepoint } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { add, cmp, neg, sum } from "../money/money.ts";
import { legacyStatutoryLiabilityAccount, PAYROLL_COUNTRY_PACKS } from "./packs.ts";
import { laborCostingSettingsInTx } from "../projects/labor-costing.ts";
import { canonicalJson, payRunCalculationSourceDigest, parsePayRunCalculationSource, payRunCalculationSource, payRunCalculationSourceChanges, type PayRunCalculationError, type PayRunRefusalAcknowledgement, payRunCalculationRefusals, payRunRefusalDigest, parsePayRunCalculationErrors, parsePayRunRefusalAcknowledgement } from "./run-calculation-evidence.ts";
import { lockStatutoryRatesForPayRun } from "./statutory-rates.ts";
import { PERIODIC_RUN_TYPES } from "./run-contracts.ts";
import { assertPeriodSequence, periodRunIdentity } from "./period-priors.ts";
import { lockPayrollAnomalyReview, payrollAnomalyFinalizeCheck } from "./anomaly-finalize-gate.ts";
/**
 * The commit refusal: names every refused in-scope employee WITH the pack's
 * own words for why, so the operator sees at POST exactly what the exception
 * list showed at calculate — and how a posted partial run is completed.
 */
function refusedCommitMessage(refusals: PayRunCalculationError[]): string {
  const shown = refusals.slice(0, 10).map((entry) => `${entry.employee}: ${entry.message}`);
  const more = refusals.length > shown.length
    ? `, and ${refusals.length - shown.length} more`
    : "";
  const count = `${refusals.length} in-scope ${refusals.length === 1 ? "employee was" : "employees were"}`;
  return `pay run cannot be committed — ${count} refused at calculation `
    + `(${shown.join("; ")}${more}) — acknowledge the refused employees on the run `
    + `or fix the input and recalculate. A posted partial run can only be completed `
    + `with an off-cycle run once the missing input is supplied.`;
}

/** What a projected leg represents; persisted on the document line. */
export type PayRunGlLegKind =
  | "expense" | "non_cash_offset" | "liability" | "net_pay" | "labor_clearing" | "entitlement_relief";

/**
 * How an entitlement-relief leg reached the plan's liability: the stub line's
 * own calculation stamp, or a governed correction of a committed run whose
 * stub lines were stamped to an expense account.
 */
export type EntitlementReliefBasis = "calculation_stamp" | "governed_correction";

/** A governed correction's binding of one committed stub line to the bank it settled. */
export interface EntitlementReliefLine {
  /** The plan liability account the reviewed binding supplied. */
  accountId: string;
  planId: string;
  /** The entitlement ledger movement the line settles. */
  movementId: string;
}

export interface PayRunGlLeg {
  payrollExpense?: boolean;
  payComponentId?: string | null;
  accountId: string;
  amount: string;
  partyId: string | null;
  projectId: string | null;
  departmentId: string | null;
  description: string;
  legKind: PayRunGlLegKind;
  /** The employee whose stub line produced an expense or non-cash leg. */
  employeePartyId: string | null;
  /** The stub line's time type and service item, retained for classification. */
  timeTypeId: string | null;
  itemId: string | null;
  /** Entitlement-relief legs only: the settled plan, how the leg was based and its stub lines. */
  entitlementPlanId?: string | null;
  entitlementMovementId?: string | null;
  entitlementReliefBasis?: EntitlementReliefBasis;
  stubLineIds?: string[];
}

/**
 * The accounting basis of a run's committed projection, read from its own
 * committed records instead of today's setup. Rebuilding a never-posted
 * projection with this basis can refine line identity but never restate an
 * account: liabilities come from the stub lines' commit stamps, expenses from
 * their calculation stamps or the account the committed projection used for
 * the same coding, and net pay from the account the committed projection
 * credited.
 */
export interface FrozenPayRunGlBasis {
  /** Null when the committed projection credited no net pay (employer-only runs). */
  netPayAccountId: string | null;
  /** Committed expense account per `${componentId}|${departmentId}|${projectId}`. */
  expenseAccountByCoding: ReadonlyMap<string, string>;
  /**
   * Stub lines a governed correction moved from expense to an entitlement
   * plan's liability, keyed by stub line id. Earlier corrections recorded on
   * the committed projection are carried here so a rebuild preserves them.
   */
  entitlementReliefByStubLine?: ReadonlyMap<string, EntitlementReliefLine>;
}

/** One stub line a governed correction moved from its expense account to a plan liability. */
export interface PayRunGlRelief {
  stubLineId: string;
  planId: string;
  movementId: string;
  /** The account the line's calculation stamp or committed coding resolved; null when neither recorded one. */
  fromAccountId: string | null;
  toAccountId: string;
  amount: string;
}

/** The document-line metadata a projected leg carries. */
export function payRunGlLegCustom(leg: PayRunGlLeg): Record<string, unknown> {
  const custom: Record<string, unknown> = {
    payrollExpense: leg.payrollExpense === true,
    payComponentId: leg.payComponentId ?? null,
    legKind: leg.legKind,
    employeePartyId: leg.employeePartyId,
    timeTypeId: leg.timeTypeId,
    itemId: leg.itemId,
  };
  if (leg.legKind === "entitlement_relief") {
    custom.entitlementPlanId = leg.entitlementPlanId ?? null;
    custom.entitlementMovementId = leg.entitlementMovementId ?? null;
    custom.entitlementReliefBasis = leg.entitlementReliefBasis ?? null;
    custom.stubLineIds = [...(leg.stubLineIds ?? [])].sort();
  }
  return custom;
}

export function payRunGlCodingKey(componentId: string | null, departmentId: string | null, projectId: string | null): string {
  return `${componentId ?? ""}|${departmentId ?? ""}|${projectId ?? ""}`;
}

/**
 * Build the balanced GL projection for a calculated run — shared by commit
 * (which writes it into document_lines) and the wizard's pre-commit preview.
 * Throws PayrollError on missing accounts or an unbalanced projection, so the
 * preview surfaces setup problems before anything is written. With a frozen
 * basis it resolves every account from the run's committed records only and
 * refuses when one cannot be resolved that way.
 */
export async function payRunGlLegs(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
  frozen?: FrozenPayRunGlBasis,
): Promise<{
  legs: PayRunGlLeg[];
  debitTotal: string;
  lineLiabilities: { lineId: string; accountId: string }[];
  /** Commit-time remittance destination per accrual line: the component's
   * vendor AS OF THIS COMMIT. Remittances route by this snapshot, so a
   * vendor edited afterwards can never re-point committed payroll. */
  lineDestinations: { lineId: string; partyId: string | null }[];
  /** Stub lines the frozen basis moved to an entitlement plan liability. */
  reliefs: PayRunGlRelief[];
}> {
  {
    // Live setup is read only for an ordinary commit or preview. A frozen
    // rebuild never consults today's settings, component accounts or costing
    // mode, so it cannot restate what the committed projection recorded.
    let wageExpense: string | null = null;
    let netPayable: string | null;
    let burdenExpense: string | null = null;
    let laborClearing: string | null = null;
    let wagesToClearing = false;
    let statutoryLiability = (_systemKey: string | null, _country: string | null): string | null => null;
    if (frozen) {
      netPayable = frozen.netPayAccountId;
    } else {
      const settings = await payrollSettingsForPayRun(orgId, documentId, allowedSubsidiaryIds, tx);
      const costing = await laborCostingSettingsInTx(tx, orgId);
      const control = (await tx.execute<{ c: Record<string, string | null> | null; p: Record<string, unknown> | null }>(sql`
        select settings->'controlAccounts' as c, settings->'payroll' as p from orgs where id = ${orgId}
      `));
      laborClearing = control.rows[0]?.c?.laborClearing ?? null;
      const rawPayrollSettings = control.rows[0]?.p ?? {};

      const requireAccount = (value: string | null, label: string): string => {
        if (!value) throw new PayrollError(`payroll setup incomplete: ${label} account is not configured`);
        return value;
      };
      wageExpense = requireAccount(settings.wageExpenseAccountId, "wage expense");
      netPayable = requireAccount(settings.netPayAccountId, "net pay payable");
      burdenExpense = settings.burdenExpenseAccountId ?? wageExpense;
      // Statutory liabilities are pack-declared: each seeded component carries
      // its slot's account (Payroll setup → Accounts & posting). For pre-pack
      // tenants, the SLOT's own legacySettingsKey names the old org-level
      // settings key to fall back to — the pack declares which liabilities
      // share an account (CPP2 rides the CPP payable, QPIP the EI payable);
      // this projection no longer knows any jurisdiction's mapping itself, and
      // a third pack's slot with no legacy key simply resolves to the
      // component account or a named refusal.
      statutoryLiability = (systemKey: string | null, country: string | null): string | null =>
        systemKey ? legacyStatutoryLiabilityAccount(systemKey, rawPayrollSettings, country) : null;
      wagesToClearing = settings.wagesTo === "labor_clearing" && costing.mode === "post";
      if (settings.wagesTo === "labor_clearing" && !laborClearing) {
        throw new PayrollError("payroll setup incomplete: labor clearing account is not configured");
      }
    }

    const stubLines = (await tx.execute<Record<string, string | null>>(sql`
      select l.id as line_id, l.component_id, s.employee_party_id, l.kind, l.description, l.amount, l.project_id, l.department_id,
             l.time_type_id, l.item_id, l.expense_account_source,
             l.expense_account_evidence->>'reference' as expense_account_reference,
             c.system_key, c.country, l.expense_account_id as line_expense_account_id,
             c.expense_account_id as component_expense_account_id,
             c.liability_account_id, c.remittance_party_id, s.net_pay,
             l.liability_account_id as committed_liability_account_id,
             l.payment_kind, l.non_cash_account_id, expense_account.type as expense_account_type
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
        left join pay_components c on c.id = l.component_id and c.org_id = l.org_id
        left join accounts expense_account on expense_account.org_id = l.org_id
          and expense_account.id = coalesce(l.expense_account_id, c.expense_account_id,
            case when l.kind = 'employer_contribution' then ${burdenExpense}::uuid else ${wageExpense}::uuid end)
        left join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
       where l.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
         ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
       order by s.employee_party_id, l.sequence
    `));
    // Frozen resolution: the stub line's own stamp, else the account the
    // committed projection used for the same component, department and
    // project. Account types come from the resolved account itself.
    const frozenExpenseAccount = (line: Record<string, string | null>): string => {
      const stamped = line.line_expense_account_id;
      const committed = stamped ?? frozen!.expenseAccountByCoding.get(
        payRunGlCodingKey(line.component_id ?? null, line.department_id ?? null, line.project_id ?? null));
      if (!committed) {
        throw new PayrollError(`the committed projection has no unique expense account for "${line.description ?? "payroll line"}" — its accounting basis cannot be rebuilt from committed records`);
      }
      return committed;
    };
    const reliefFor = (line: Record<string, string | null>): EntitlementReliefLine | undefined =>
      frozen?.entitlementReliefByStubLine?.get(line.line_id!);
    const frozenAccountTypes = new Map<string, string>();
    if (frozen) {
      // A line a governed correction relieved posts to its bound liability;
      // its original expense resolution is reported, never required.
      const ids = [...new Set(stubLines.rows
        .filter((line) => (line.kind === "earning" || line.kind === "employer_contribution") && !reliefFor(line))
        .map(frozenExpenseAccount))];
      if (ids.length) {
        const types = (await tx.execute<{ id: string; type: string }>(sql`
          select id::text as id, type from accounts
           where org_id = ${orgId} and id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
        `)).rows;
        for (const row of types) frozenAccountTypes.set(row.id, row.type);
        if (frozenAccountTypes.size !== ids.length) throw new PayrollError("a committed payroll expense account no longer exists — the projection cannot be rebuilt");
      }
    }
    const frozenLiability = (line: Record<string, string | null>): string => {
      if (!line.committed_liability_account_id) {
        throw new PayrollError(`"${line.description ?? "payroll line"}" has no committed liability stamp — the projection cannot be rebuilt from committed records`);
      }
      return line.committed_liability_account_id;
    };
    const stubs=(await tx.execute<{has_value:boolean;has_lines:boolean}>(sql`select
      (s.gross<>0 or s.net_pay<>0 or s.employer_cost<>0 or s.pensionable_earnings<>0 or s.insurable_earnings<>0 or s.vacation_accrued<>0) as has_value,
      exists(select 1 from pay_stub_lines line where line.org_id=s.org_id and line.stub_id=s.id) as has_lines
      from pay_stubs s left join parties p on p.org_id=s.org_id and p.id=s.employee_party_id
      where s.org_id=${orgId} and s.pay_run_document_id=${documentId}
        ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`,allowedSubsidiaryIds)}`)).rows;
    if (!stubs.length) throw new PayrollError('Pay run has no calculated stubs — calculate its selected employees before committing');
    if (stubs.some(stub=>stub.has_value && !stub.has_lines)) throw new PayrollError('A calculated pay stub has financial totals but no native lines — recalculate the pay run before committing');
    if (stubLines.rows.length === 0) {
      // Unpaid coverage retains native bank movements and allocations without
      // inventing financial entries for an entirely zero-money projection.
      return {legs:[],debitTotal:'0.0000',lineLiabilities:[],lineDestinations:[],reliefs:[]};
    }

    // Keep the account, coding, party, payroll component, employee, time type
    // and service item in the grouping identity so posting allocations and
    // later classification can select the original expense source. Employer
    // burden descriptions remain separate to identify each share.
    const legs = new Map<string, PayRunGlLeg>();
    const accumulate = (
      accountId: string, amount: string, description: string, legKind: PayRunGlLegKind,
      opts: {
        partyId?: string | null; projectId?: string | null; departmentId?: string | null; split?: string;
        payrollExpense?: boolean; payComponentId?: string | null;
        employeePartyId?: string | null; timeTypeId?: string | null; itemId?: string | null;
        relief?: { planId: string | null; movementId: string | null; basis: EntitlementReliefBasis; stubLineId: string };
      } = {},
    ) => {
      if (cmp(amount, "0") === 0) return;
      const key = [accountId, opts.partyId ?? "", opts.projectId ?? "", opts.departmentId ?? "", opts.split ?? "",
        opts.payrollExpense ? "expense" : "", opts.payComponentId ?? "", legKind,
        opts.employeePartyId ?? "", opts.timeTypeId ?? "", opts.itemId ?? "",
        opts.relief?.planId ?? "", opts.relief?.movementId ?? "", opts.relief?.basis ?? ""].join("|");
      const existing = legs.get(key);
      if (existing) {
        existing.amount = add(existing.amount, amount);
        if (opts.relief) existing.stubLineIds = [...(existing.stubLineIds ?? []), opts.relief.stubLineId];
      } else legs.set(key, {
        accountId, amount, description, legKind,
        partyId: opts.partyId ?? null, projectId: opts.projectId ?? null,
        departmentId: opts.departmentId ?? null,
        payrollExpense: opts.payrollExpense,
        payComponentId: opts.payComponentId,
        employeePartyId: opts.employeePartyId ?? null,
        timeTypeId: opts.timeTypeId ?? null,
        itemId: opts.itemId ?? null,
        ...(opts.relief ? {
          entitlementPlanId: opts.relief.planId,
          entitlementMovementId: opts.relief.movementId,
          entitlementReliefBasis: opts.relief.basis,
          stubLineIds: [opts.relief.stubLineId],
        } : {}),
      });
    };
    const reliefs: PayRunGlRelief[] = [];

    const netByEmployee = new Map<string, string>();
    // The account each liability line accrues to, resolved ONCE here and
    // stamped on the stub line at commit so a later remittance debits the
    // account that was credited, not the component's setup of the day.
    const lineLiabilities: { lineId: string; accountId: string }[] = [];
    // The vendor each accrual line remits to, frozen the same way: the
    // component's remittance_party_id AS OF THIS COMMIT. A union agreement's
    // destination is already folded in — union.ts copies the agreement's
    // vendor onto its auto-provisioned component — so this one stamp covers
    // agreement-sourced destinations too.
    const lineDestinations: { lineId: string; partyId: string | null }[] = [];
    const liabilityFor = (line: Record<string, string | null>, label: string): string => {
      if (frozen) return frozenLiability(line);
      const liability = line.liability_account_id ?? statutoryLiability(line.system_key ?? null, line.country ?? null);
      if (!liability) {
        throw new PayrollError(
          `${label} "${line.description}" has no liability account — set it in Payroll setup → Accounts & posting`,
        );
      }
      return liability;
    };
    for (const line of stubLines.rows) {
      netByEmployee.set(line.employee_party_id!, line.net_pay!);
      const amount = line.amount!;
      const identity = {
        employeePartyId: line.employee_party_id, timeTypeId: line.time_type_id, itemId: line.item_id,
      };
      const expenseAccountType = (accountId: string): string | null =>
        frozen ? frozenAccountTypes.get(accountId) ?? null : line.expense_account_type ?? null;
      if (line.kind === "earning") {
        if (line.payment_kind === "non_cash") {
          if (!line.non_cash_account_id) throw new PayrollError(`non-cash earning "${line.description}" has no calculated clearing account — recalculate the editable run after configuring its non-cash account`);
          accumulate(line.non_cash_account_id, neg(amount), `Non-cash benefit: ${line.description}`, "non_cash_offset", {
            projectId: line.project_id, departmentId: line.department_id, ...identity,
          });
        }
        const isTimeDriven = line.system_key === "base_pay" || line.system_key === "overtime";
        const settlesBank = line.expense_account_source === "entitlement_plan" || reliefFor(line) !== undefined;
        if (isTimeDriven && wagesToClearing && !settlesBank) {
          // Standard cost already posted to the job at approval; wash clearing.
          accumulate(laborClearing!, amount, "Wages (labor clearing)", "labor_clearing");
        } else {
          // The line's own stamp (migration 0180) wins: it froze the
          // item > component > org-default resolution at calculate, so a
          // mapping edited after Calculate cannot restate this run — the
          // staleness digest refuses the commit instead. Unstamped history
          // keeps the exact fallback it always had.
          const relief = reliefFor(line);
          if (line.expense_account_source === "entitlement_plan") {
            // Stamped at calculation: the line settles a bank and posts to
            // the plan's liability, outside payroll cost allocation.
            if (relief) throw new PayrollError(`"${line.description ?? "payroll line"}" already posts to its entitlement plan's liability — it cannot be corrected again`);
            const reference = line.expense_account_reference ?? "";
            accumulate(line.line_expense_account_id!, amount, line.description ?? "Entitlement payout", "entitlement_relief", {
              projectId: line.project_id, departmentId: line.department_id,
              payrollExpense: false, payComponentId: line.component_id, ...identity,
              relief: {
                planId: reference.startsWith("entitlement_plans:") ? reference.slice("entitlement_plans:".length) : null,
                movementId: null, basis: "calculation_stamp", stubLineId: line.line_id!,
              },
            });
          } else if (relief) {
            const fromAccountId = line.line_expense_account_id ?? frozen!.expenseAccountByCoding.get(
              payRunGlCodingKey(line.component_id ?? null, line.department_id ?? null, line.project_id ?? null)) ?? null;
            accumulate(relief.accountId, amount, line.description ?? "Entitlement payout", "entitlement_relief", {
              projectId: line.project_id, departmentId: line.department_id,
              payrollExpense: false, payComponentId: line.component_id, ...identity,
              relief: { planId: relief.planId, movementId: relief.movementId, basis: "governed_correction", stubLineId: line.line_id! },
            });
            reliefs.push({
              stubLineId: line.line_id!, planId: relief.planId, movementId: relief.movementId,
              fromAccountId, toAccountId: relief.accountId, amount,
            });
          } else {
            const accountId = frozen
              ? frozenExpenseAccount(line)
              : line.line_expense_account_id ?? line.component_expense_account_id ?? wageExpense!;
            // Bank drawdowns debit a liability rather than a new payroll expense.
            // Keep those debits outside cost allocation, just like payable credits.
            const payrollExpense = ["expense", "expense_other", "cogs"].includes(expenseAccountType(accountId) ?? "");
            accumulate(accountId, amount, line.description ?? "Wages", "expense", {
              projectId: line.project_id, departmentId: line.department_id,
              payrollExpense, payComponentId: line.component_id, ...identity,
            });
          }
        }
      } else if (line.kind === "deduction") {
        const liability = liabilityFor(line, "deduction");
        accumulate(liability, neg(amount), line.description ?? "Deduction", "liability");
        lineLiabilities.push({ lineId: line.line_id!, accountId: liability });
        lineDestinations.push({ lineId: line.line_id!, partyId: line.remittance_party_id ?? null });
      } else if (line.kind === "credit") {
        // A refundable credit is reclaimed from the tax authority by paying
        // it less (F24 compensation for IT): debit the same liability the
        // withholdings credited, so the projection balances and the frozen
        // account below is the one the reclaim lands on. No burden expense —
        // the P&L cost is nil (see the net math above).
        const liability = liabilityFor(line, "credit");
        accumulate(liability, amount, line.description ?? "Credit", "liability");
        lineLiabilities.push({ lineId: line.line_id!, accountId: liability });
        lineDestinations.push({ lineId: line.line_id!, partyId: line.remittance_party_id ?? null });
      } else {
        const liability = liabilityFor(line, "employer contribution");
        // Job-costed burdens (union fringes) carry the line's project split.
        // Each component keeps its own debit: the shares ride one expense
        // account, so without the split the whole aggregate wears the first
        // share's name.
        // Honor the account resolved during calculation before falling back
        // to the component or company burden account.
        const accountId = frozen
          ? frozenExpenseAccount(line)
          : line.line_expense_account_id ?? line.component_expense_account_id ?? burdenExpense!;
        const payrollExpense = ["expense", "expense_other", "cogs"].includes(expenseAccountType(accountId) ?? "");
        accumulate(accountId, amount, line.description ?? "Employer burden", "expense", {
          projectId: line.project_id, departmentId: line.department_id,
          payrollExpense, payComponentId: line.component_id,
          split: line.description ?? "Employer burden", ...identity,
        });
        accumulate(liability, neg(amount), line.description ?? "Employer burden", "liability");
        lineLiabilities.push({ lineId: line.line_id!, accountId: liability });
        lineDestinations.push({ lineId: line.line_id!, partyId: line.remittance_party_id ?? null });
      }
    }
    for (const [employeePartyId, net] of netByEmployee) {
      if (cmp(net, "0") === 0) continue;
      if (!netPayable) {
        throw new PayrollError("the committed projection credited no net pay account, but a stub carries net pay — its accounting basis cannot be rebuilt from committed records");
      }
      accumulate(netPayable, neg(net), "Net pay", "net_pay", { partyId: employeePartyId });
    }

    const total = sum([...legs.values()].map((l) => l.amount));
    if (cmp(total, "0") !== 0) throw new PayrollError(`pay run GL projection is unbalanced (${total})`);
    const debitTotal = sum([...legs.values()].filter((l) => cmp(l.amount, "0") > 0).map((l) => l.amount));
    return { legs: [...legs.values()], debitTotal, lineLiabilities, lineDestinations, reliefs };
  }
}

/**
 * Record an explicit, auditable decision to commit a run that leaves in-scope
 * employees unpaid. The acknowledgement is taken against the run's CURRENT
 * stored refusal set — never a caller-supplied list — so it necessarily names
 * exactly who is being left out and carries the pack's own refusal text for
 * each of them. There are legitimate partial runs (a mid-period hire, unpaid
 * leave); silence is not one of them, so this is the only path past the
 * commit gate besides fixing the input and recalculating.
 *
 * Like commit, this enforces on its own transaction: the run must be
 * calculated and its document editable, and acknowledging a clean run (or one
 * that was never calculated) is refused rather than recorded vacuously.
 */
export async function acknowledgePayRunRefusals(input: {
  orgId: string;
  documentId: string;
  actorId: string;
  /** Caller role scope; null/undefined is unrestricted. */
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}): Promise<PayRunRefusalAcknowledgement> {
  const { orgId, documentId, actorId } = input;
  return await db.transaction(async (tx) => withTransactionSavepoint(tx, async () => {
    const sourceIdentity = (await tx.execute<{taxYear: number}>(sql`
      select r.tax_year as "taxYear" from pay_runs r join documents d on d.org_id=r.org_id and d.id=r.document_id
       where r.org_id=${orgId} and r.document_id=${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, input.allowedSubsidiaryIds)}
    `)).rows;
    if (sourceIdentity.length !== 1) throw new PayrollError("pay run not found");
    await takeOpeningSourceYearFence(tx, orgId, sourceIdentity[0]!.taxYear);
    if (!(await lockAndCheckOrgFeature(tx, orgId, "payroll"))) throw new PayrollError("Payroll feature is disabled");
    const runRows = (await tx.execute<Record<string, unknown>>(sql`
      select r.*, d.status as doc_status, d.subsidiary_id as subsidiary_id from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      where r.org_id = ${orgId} and r.document_id = ${documentId} for update
    `));
    const run = runRows.rows[0];
    if (!run) throw new PayrollError("pay run not found");
    if (Number(run.tax_year) !== sourceIdentity[0]!.taxYear) throw new PayrollError("The payroll source year changed — reload and calculate the run before committing");
    if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, run.subsidiary_id as string | null)) {
      throw new PayrollError("pay run not found");
    }
    if (run.run_status === "committed") throw new PayrollError("pay run is already committed");
    if (run.run_status !== "calculated") {
      throw new PayrollError("calculate the pay run before acknowledging its refusals");
    }
    if (run.doc_status !== "draft" && run.doc_status !== "approved") {
      throw new PayrollError("pay run document is not editable");
    }
    const storedErrors = parsePayRunCalculationErrors(run.calculation_errors);
    if (!storedErrors) {
      throw new PayrollError(
        "recalculate the pay run before acknowledging its refusals — its calculation predates refusal tracking",
      );
    }
    const refusals = payRunCalculationRefusals(storedErrors);
    if (refusals.length === 0) {
      throw new PayrollError("no refused employees to acknowledge on this pay run");
    }
    const acknowledgement: PayRunRefusalAcknowledgement = {
      version: 1,
      acknowledgedBy: actorId,
      acknowledgedAt: new Date().toISOString(),
      errorsDigest: payRunRefusalDigest(refusals),
      refusals,
    };
    await tx.execute(sql`
      update pay_runs set refusal_acknowledgement = ${JSON.stringify(acknowledgement)}::jsonb,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and document_id = ${documentId}
    `);
    const afterRun = (await tx.execute<Record<string, unknown>>(sql`
      select * from pay_runs where org_id = ${orgId} and document_id = ${documentId}
    `)).rows[0];
    if (!afterRun) throw new PayrollError("pay run not found");
    // Committing authorizes pay; acknowledging authorizes leaving people out.
    // Same evidence shape as the commit transition, so an auditor finds both
    // decisions in the same place, months later.
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'pay_runs', ${documentId}, 'update',
              ${JSON.stringify({ operation: "acknowledge-refusals", before: run, after: afterRun })}::jsonb, ${actorId})
    `);
    return acknowledgement;
  }));
}

/**
 * Commit: materialize the balanced GL projection into document_lines and claim
 * the period's time entries. The document then posts through the standard
 * submit/post action (RULES.pay_run maps lines 1:1, signed, like a journal).
 *
 * Freshness is enforced HERE, on this transaction's own read — not only by
 * the route's pre-flight and the wizard's disabled button. A run whose inputs
 * changed after Calculate is refused before anything is written, which is
 * what keeps newly approved time from being claimed by a stub that never
 * priced it.
 */
export async function commitPayRun(input: {
  orgId: string;
  documentId: string;
  actorId: string;
  /** Caller role scope; null/undefined is unrestricted. */
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}): Promise<{ lines: number }> {
  const { orgId, documentId, actorId } = input;
  // A caller may catch the late freshness refusal inside its own transaction.
  // Restore our projection, liability stamps, and time claims before returning it.
  return await db.transaction(async (tx) => withTransactionSavepoint(tx, async () => {
    const sourceIdentity = (await tx.execute<{taxYear: number}>(sql`
      select r.tax_year as "taxYear" from pay_runs r join documents d on d.org_id=r.org_id and d.id=r.document_id
       where r.org_id=${orgId} and r.document_id=${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, input.allowedSubsidiaryIds)}
    `)).rows;
    if (sourceIdentity.length !== 1) throw new PayrollError("pay run not found");
    await takeOpeningSourceYearFence(tx, orgId, sourceIdentity[0]!.taxYear);
    if (!(await lockAndCheckOrgFeature(tx, orgId, "payroll"))) throw new PayrollError("Payroll feature is disabled");
    const runRows = (await tx.execute<Record<string, string>>(sql`
      select r.*, d.status as doc_status, d.subsidiary_id as subsidiary_id, d.document_number from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      where r.org_id = ${orgId} and r.document_id = ${documentId} for update
    `));
    const run = runRows.rows[0];
    if (!run) throw new PayrollError("pay run not found");
    if (Number(run.tax_year) !== sourceIdentity[0]!.taxYear) throw new PayrollError("The payroll source year changed — reload and calculate the run before committing");
    if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, run.subsidiary_id)) {
      throw new PayrollError("pay run not found");
    }
    if (run.run_status !== "calculated") throw new PayrollError("calculate the pay run before committing");
    // Approval moves the document from draft to approved, so both are
    // committable; anything else (posted, voided) is not.
    if (run.doc_status !== "draft" && run.doc_status !== "approved") {
      throw new PayrollError("pay run document is not editable");
    }
    await lockPayrollEmploymentRoster(tx, orgId, documentId);
    await lockAndCheckPayrollRunPopulation(tx, orgId, documentId, input.allowedSubsidiaryIds);

    // Fence the commit on the EMPLOYEE-AND-TAX-YEAR identity every racing run
    // must hold (see `employeeTaxYearFenceKey`) — not on this run's own row,
    // which a concurrent same-year run never contends on. Taken BEFORE the
    // freshness gate below, so the gate's answer describes the world as of
    // THIS RUN'S TURN IN THE FENCE ORDER: if another run for one of these
    // employees committed while this transaction waited, the gate sees its
    // committed stubs ("ytd" staleness) and refuses, which is exactly what
    // makes exactly ONE of two racing runs able to commit. Sorted key order —
    // the order `calculatePayRun` already acquires in — so overlapping
    // rosters queue instead of deadlocking mid-set.
    const fencedEmployees = (await tx.execute<{ employee_party_id: string }>(sql`
      select distinct s.employee_party_id
        from pay_stubs s
       where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
    `));
    await takeEmployeeTaxYearFences(
      tx,
      fencedEmployees.rows.map((e) =>
        employeeTaxYearFenceKey(orgId, e.employee_party_id, run.tax_year),
      ),
    );
    await lockEmployerAssignmentProfiles(tx, orgId, fencedEmployees.rows.map(e => e.employee_party_id));
    await lockPayrollAnomalyReview(tx, orgId);
    const anomalyGate = await payrollAnomalyFinalizeCheck(tx, { orgId, documentId });
    if (anomalyGate.openBlockCount > 0) {
      throw new PayrollError(
        `pay run cannot be committed — ${anomalyGate.openBlockCount} blocking payroll check(s) are open `
        + `for this run — review Payroll → Anomalies and resolve or acknowledge each flag before committing`,
      );
    }
    // Employer-aggregate room is shared across rosters, so the employee
    // fence above cannot serialize it: two runs on disjoint rosters hold no
    // common employee key. Every commit takes each declared per-run levy's
    // employer key too — AFTER the employee keys, always in that order —
    // so the freshness gate below sees competing commits in fence order and
    // refuses the run whose room is gone. Declarations are read off every
    // pack (the key carries its country, so packs never contend); packs
    // that declare none add no keys and behave exactly as before. A pack
    // that refuses the year contributes no keys here, as in readiness —
    // otherwise one pack's untranscribed year would abort every other
    // pack's commit.
    const levyFenceKeys: string[] = [];
    for (const [packCountry, pack] of Object.entries(PAYROLL_COUNTRY_PACKS)) {
      let levies: readonly { key: string; timing: string }[];
      try {
        levies = pack.employerAggregateLevies?.(Number(run.tax_year)) ?? [];
      } catch {
        continue;
      }
      for (const levy of levies) {
        if (levy.timing === "per_run") {
          levyFenceKeys.push(employerLevyFenceKey(orgId, run.tax_year, packCountry, levy.key));
        }
      }
    }
    await takeEmployerLevyFences(tx, levyFenceKeys);
    // Historical component policy changes and deletes take the component
    // row's write lock. Hold the same rows through freshness and commit:
    // a later editor waits, then the database history guard sees the committed
    // run; an earlier editor finishes before this transaction checks freshness.
    await tx.execute(sql`
      select c.id from pay_components c
       where c.org_id = ${orgId} and exists (
         select 1 from pay_stub_lines l
         join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
          where l.org_id = c.org_id and l.component_id = c.id
            and s.pay_run_document_id = ${documentId}
       )
       order by c.id for share of c
    `);
    // The freshness gate, asked ON THIS TRANSACTION so an engine caller that
    // skips the route's pre-flight gets the same refusal, against the same
    // snapshot the claim below will run under. Dynamic import keeps the
    // payroll-run ↔ payroll-readiness cycle out of the engine's load order
    // (same idiom as the approval gate just below).
    await requireCompensationPackageConfiguration(tx, orgId);
    await lockPayrollServiceConfiguration(tx, orgId);
    const { assertPayRunNotStale, staleCalculationMessage } =
      await import("./readiness.ts");
    await assertPayRunNotStale(orgId, documentId, tx, input.allowedSubsidiaryIds);
    // A retro run's own control set (payroll-retro-store.ts): a voided or
    // re-settled source period, a cross-year settlement, a retired component,
    // or another open retro run already holding the same cell. The pre-flight
    // shows these; the commit ENFORCES them on this transaction so a caller
    // that skips the wizard cannot pay the same difference twice.
    if (run.run_type === "retro") {
      const { retroRunFindings } = await import("./retro-store.ts");
      const blockers = (await retroRunFindings(orgId, documentId, tx, input.allowedSubsidiaryIds))
        .filter((finding) => finding.severity === "blocker");
      if (blockers.length > 0) {
        throw new PayrollError(
          `retro run cannot be committed (${[...new Set(blockers.map((b) => b.code))].join(", ")})`
          + " — review the retro run's source periods before paying it",
        );
      }
    }
    // A calculated share is only committable while the period still sequences
    // around it: a run created or committed after the calculation can leave
    // its priors stale. Asked here as well as at calculate, on this
    // transaction, so the commit cannot land on a period that moved.
    if (PERIODIC_RUN_TYPES.has(run.run_type ?? "regular")) {
      await assertPeriodSequence(tx, orgId, periodRunIdentity(run, {
        documentId,
        documentNumber: run.document_number ?? documentId,
        runType: run.run_type ?? "regular",
      }), "commit");
    }
    // Money must not move before the run is approved. Asked ON THIS
    // TRANSACTION, under the run row lock taken above: the old call ran on
    // the default executor OUTSIDE the commit, so an approval withdrawn
    // between the pre-check and the terminal write committed without a live
    // approval. Dynamic import keeps the module cycle out of the engine's
    // load order (same idiom as flows/documents-adapter.ts →
    // document-void.ts).
    const { assertPayRunApprovalReleased } = await import("./approval.ts");
    await assertPayRunApprovalReleased(orgId, documentId, tx);

    // Recompute and lock the canonical source population before producing a
    // single GL line. Legacy calculated rows have no evidence and therefore
    // require recalculation; a corrupt snapshot/digest pair fails the same
    // closed way. Category-specific reasons preserve the wizard/API contract.
    const storedSource = parsePayRunCalculationSource(run.calculation_source_snapshot);
    const storedDigest = run.calculation_source_digest ?? null;
    if (!storedSource || !storedDigest
        || payRunCalculationSourceDigest(storedSource) !== storedDigest) {
      throw new PayrollError(staleCalculationMessage(["selection"], run.doc_status));
    }
    const currentSource = await payRunCalculationSource(
      orgId,
      documentId,
      tx,
      true,
      input.allowedSubsidiaryIds,
    );
    if (!currentSource) throw new PayrollError("pay run not found");
    const changes = payRunCalculationSourceChanges(storedSource, currentSource);
    if (changes.holidayObligations) throw new PayrollError("Approved holiday entitlements, their dated wages or payment claims changed since calculation; recalculate this editable pay run before committing.");
    if (changes.compensationPackages) throw new PayrollError('Approved compensation terms or their native component policy changed since calculation — recalculate this editable pay run before committing.');
    const sourceReasons = [
      changes.time ? "time" : null,
      changes.timeTypes ? "timeTypes" : null,
      changes.wages ? "wages" : null,
      changes.items ? "items" : null,
      changes.incomeTaxOverrides ? "adjustments" : null,
      changes.bankCashInputs ? "adjustments" : null,
      changes.employerLevyAdjustments ? "adjustments" : null,
      changes.declaredVacationAccruals ? "adjustments" : null,
      changes.roster ? "roster" : null,
      changes.openingBalances ? "openingBalances" : null,
    ].filter((reason): reason is string => reason !== null);
    if (payRunCalculationSourceDigest(currentSource) !== storedDigest) {
      throw new PayrollError(staleCalculationMessage(
        sourceReasons.length > 0 ? sourceReasons : ["selection"],
        run.doc_status,
      ));
    }

    await assertRecurringBenefitsRunFresh(tx, orgId, documentId, run.benefit_source_snapshot);

    // The refusal gate. A refusal does not shrink the payroll silently: while
    // an in-scope employee has no stub, commit is refused unless the operator
    // has explicitly acknowledged EXACTLY this refusal set. The
    // acknowledgement binds to the refusal digest, so acknowledging one set
    // and recalculating into another leaves a stale acknowledgement this gate
    // refuses. Runs calculated before refusal tracking (null, not empty)
    // recalculate first — absence of evidence is not evidence of absence.
    //
    // Placed after the source-digest check and before the first GL write, so
    // a refused commit writes nothing at all.
    const storedErrors = parsePayRunCalculationErrors(
      (run as Record<string, unknown>).calculation_errors,
    );
    if (!storedErrors) {
      throw new PayrollError(
        "recalculate the pay run before committing — its calculation predates refusal tracking",
      );
    }
    const refusals = payRunCalculationRefusals(storedErrors);
    if (refusals.length > 0) {
      const acknowledgement = parsePayRunRefusalAcknowledgement(
        (run as Record<string, unknown>).refusal_acknowledgement,
      );
      if (!acknowledgement
          || acknowledgement.errorsDigest !== payRunRefusalDigest(refusals)) {
        throw new PayrollError(refusedCommitMessage(refusals));
      }
    }

    const { legs, debitTotal, lineLiabilities, lineDestinations } = await payRunGlLegs(
      tx,
      orgId,
      documentId,
      input.allowedSubsidiaryIds,
    );
    // Freeze the credited liability account on every deduction/contribution
    // line (migration 0094): remittance reads the snapshot, so editing the
    // component's account afterwards can never restate a committed period.
    // The remittance destination freezes in the same write (migration 0296):
    // the vendor the line accrued to, so a vendor edited afterwards can
    // never re-point committed payroll at a new payee. The RETURNING count
    // is the write's own receipt — a stamp that matches zero rows is a
    // failure, not a success.
    if (lineLiabilities.length > 0) {
      const stamped = (await tx.execute<{ id: string }>(sql`
        update pay_stub_lines l
           set liability_account_id = stamp.account_id, liability_account_source = 'commit',
               remittance_party_id = nullif(stamp.party_text, '')::uuid,
               updated_by = ${actorId}, updated_at = now()
          from unnest(${`{${lineLiabilities.map((x) => x.lineId).join(",")}}`}::uuid[],
                      ${`{${lineLiabilities.map((x) => x.accountId).join(",")}}`}::uuid[],
                      ${`{${lineDestinations.map((x) => `"${x.partyId ?? ""}"`).join(",")}}`}::text[])
               as stamp(line_id, account_id, party_text)
         where l.org_id = ${orgId} and l.id = stamp.line_id
        returning l.id::text as id
      `));
      if (stamped.rows.length !== lineLiabilities.length) {
        throw new PayrollError("pay run commit could not stamp its liability history — recalculate and commit again");
      }
    }

    // An approved pay run commits after its release (migration 0145): the
    // document-line freeze permits this transaction's own line replacement
    // while openbooks.payroll_commit names the committing document. Set only
    // here, only for approved runs, transaction-local so it dies with the
    // commit — draft commits keep the ordinary path bit for bit.
    if (run.doc_status === "approved") {
      await tx.execute(sql`select set_config('openbooks.payroll_commit', ${String(documentId)}, true)`);
    }
    await tx.execute(sql`delete from document_lines where org_id = ${orgId} and document_id = ${documentId}`);
    let lineNumber = 1;
    for (const leg of legs) {
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    amount, party_id, project_id, department_id, custom, created_by, updated_by)
        values (${orgId}, ${documentId}, ${lineNumber++}, ${leg.accountId}, ${leg.description},
                ${leg.amount}, ${leg.partyId}, ${leg.projectId}, ${leg.departmentId},
                ${JSON.stringify(payRunGlLegCustom(leg))}::jsonb,
                ${actorId}, ${actorId})
      `);
    }

    // Claim the calculation's exact IDs — never a rediscovered employee/group
    // population. The compare above proves these locked rows are unchanged;
    // the update's own predicates and returned-ID equality are defense in
    // depth against corruption or a future caller weakening that lock.
    const claimed = (await tx.execute<{ id: string }>(sql`
      with selected as (
        select value::uuid as id
          from jsonb_array_elements_text(
            ${JSON.stringify(storedSource.claimEntryIds)}::jsonb
          ) entry(value)
      )
      update time_entries te
         set payroll_batch_ref = ${documentId}
        from selected
       where te.id = selected.id and te.org_id = ${orgId}
         and te.status = 'approved'
         and te.worked_on between ${run.period_start} and ${run.period_end}
         and te.payroll_batch_ref is null
      returning te.id::text as id
    `));
    const expectedClaimIds = [...storedSource.claimEntryIds].sort();
    const actualClaimIds = claimed.rows.map((row) => row.id).sort();
    if (canonicalJson(actualClaimIds) !== canonicalJson(expectedClaimIds)) {
      throw new PayrollError(staleCalculationMessage(["time"], run.doc_status));
    }
    // Rate writes use the same per-slot and per-point transaction advisory
    // locks. Take every slot used by this schedule (including slots with no
    // current row, so a new more-specific point cannot appear in the gap),
    // then lock its current points before the final READ COMMITTED freshness
    // snapshot. The fences stay held through the terminal commit below.
    const rateCountries = (await tx.execute<{ country: string }>(sql`
      select distinct country from employee_payroll_profiles
       where org_id = ${orgId} and pay_schedule_id = ${run.pay_schedule_id}
         and is_active and country is not null
       order by country
    `)).rows.map((row) => row.country);
    const ratePacks = rateCountries.flatMap((country) => {
      const pack = PAYROLL_COUNTRY_PACKS[country];
      return pack ? [pack.statutoryRates] : [];
    });
    await lockStatutoryRatesForPayRun(tx, orgId, Number(run.tax_year), ratePacks);

    // Belt AND braces, deliberately — the same doctrine as the gate that
    // opened this transaction, now asked again at the LAST moment. The two
    // gates are separate statements and READ COMMITTED gives each its own
    // snapshot, so the first gate's answer cannot see what commits after it:
    // a wage row, a rate, a plan, org settings, or ANOTHER RUN'S COMMIT could
    // land in the gap between check and terminal write and ride under a
    // freshness answer that was true when it was taken. The fences above
    // order two racing COMMITS against each other; this second read closes
    // the remaining gap for every OTHER writer — anything committed before
    // this statement executes is SEEN by it (fresh snapshot), and the run is
    // refused and recalculated instead of posting figures edited past. Only
    // writes committing after this statement stay outside it, exactly as the
    // time claim above leaves them unclaimed for the next calculation.
    await assertPayRunNotStale(orgId, documentId, tx, input.allowedSubsidiaryIds);
    // The approval gate again, at the LAST moment beside the staleness
    // recheck: withdrawing the approval between the pre-check above and the
    // terminal write must refuse by name, not ride under a release answer
    // that was true when it was taken.
    await assertPayRunApprovalReleased(orgId, documentId, tx);
    await tx.execute(sql`
      update pay_runs set run_status = 'committed', updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and document_id = ${documentId}
    `);
    await tx.execute(sql`
      update documents set subtotal = ${debitTotal}, total = ${debitTotal},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${documentId}
    `);
    // Committing authorizes pay: evidence who committed which run computed
    // from what. The `run` row above is the locked before-image (status +
    // pinned calculation digest); the stubs and lines it rewrote are
    // recalculable from that digest, so the run transition is the evidence.
    const afterRun = (await tx.execute<Record<string, unknown>>(sql`
      select * from pay_runs where org_id = ${orgId} and document_id = ${documentId}
    `)).rows[0];
    if (!afterRun) throw new PayrollError("pay run not found");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'pay_runs', ${documentId}, 'update',
              ${JSON.stringify({ operation: 'commit', before: run, after: afterRun })}::jsonb, ${actorId})
    `);
    return { lines: legs.length };
  }));
}

/**
 * Pre-commit GL preview: the exact legs commit would write, enriched with
 * account/party/project names for the wizard's review step. Read-only —
 * setup problems (missing accounts, imbalance) surface as PayrollError here
 * before anything is written.
 */
export async function previewPayRunGl(
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<{legs: (PayRunGlLeg & {accountLabel:string;partyName:string|null;projectName:string|null})[];debitTotal:string}> {
  const source=(await db.execute<{taxYear:number}>(sql`select r.tax_year as "taxYear" from pay_runs r
    join documents d on d.org_id=r.org_id and d.id=r.document_id
    where r.org_id=${orgId} and r.document_id=${documentId}
      ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`,allowedSubsidiaryIds)}`)).rows;
  if(source.length!==1) throw new PayrollError('pay run not found');
  return withOpeningReportingSnapshot(orgId,source[0]!.taxYear,async tx=>{
    await tx.execute(sql`select id from orgs where id=${orgId} for share`);
    const locked=(await tx.execute<{taxYear:number}>(sql`select r.tax_year as "taxYear" from pay_runs r
      join documents d on d.org_id=r.org_id and d.id=r.document_id
      where r.org_id=${orgId} and r.document_id=${documentId}
        ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`,allowedSubsidiaryIds)} for share of r,d`)).rows;
    if(locked.length!==1 || locked[0]!.taxYear!==source[0]!.taxYear) throw new PayrollError('The payroll source identity changed — reload the GL preview');
    await lockPayrollEmploymentRoster(tx,orgId,documentId);
    await lockAndCheckPayrollRunPopulation(tx,orgId,documentId,allowedSubsidiaryIds);
    return previewPayRunGlInSnapshot(tx,orgId,documentId,allowedSubsidiaryIds);
  });
}

async function previewPayRunGlInSnapshot(
  tx: Pick<typeof db,'execute'>,
  orgId:string,
  documentId:string,
  allowedSubsidiaryIds?:PayrollSubsidiaryScope,
): Promise<{legs: (PayRunGlLeg & {accountLabel:string;partyName:string|null;projectName:string|null})[];debitTotal:string}> {
  const runRows = (await tx.execute<{ run_status: string; subsidiary_id: string | null }>(sql`
    select r.run_status, d.subsidiary_id
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
  `));
  if (!runRows.rows[0]) throw new PayrollError("pay run not found");
  if (runRows.rows[0].run_status === "draft") {
    throw new PayrollError("calculate the pay run to preview its GL impact");
  }
  const { legs, debitTotal } = await payRunGlLegs(
    tx,
    orgId,
    documentId,
    allowedSubsidiaryIds,
  );
  const accountIds = [...new Set(legs.map((l) => l.accountId))];
  const partyIds = [...new Set(legs.map((l) => l.partyId).filter(Boolean))] as string[];
  const projectIds = [...new Set(legs.map((l) => l.projectId).filter(Boolean))] as string[];
  const [accounts, parties, projects] = (await Promise.all([
    tx.execute<{ id: string; number: string | null; name: string }>(sql`select id, number, name from accounts
                    where org_id = ${orgId} and id = any(${`{${accountIds.join(",")}}`}::uuid[])`),
    partyIds.length
      ? tx.execute<{ id: string; display_name: string }>(sql`select id, display_name from parties
                        where org_id = ${orgId} and id = any(${`{${partyIds.join(",")}}`}::uuid[])`)
      : { rows: [] },
    projectIds.length
      ? tx.execute<{ id: string; name: string }>(sql`select id, name from projects
                        where org_id = ${orgId} and id = any(${`{${projectIds.join(",")}}`}::uuid[])`)
      : { rows: [] },
  ]));
  const accountById = new Map(accounts.rows.map((a) => [a.id, a.number ? `${a.number} · ${a.name}` : a.name]));
  const partyById = new Map(parties.rows.map((p) => [p.id, p.display_name]));
  const projectById = new Map(projects.rows.map((p) => [p.id, p.name]));
  return {
    debitTotal,
    legs: legs.map((leg) => ({
      ...leg,
      accountLabel: accountById.get(leg.accountId) ?? leg.accountId,
      partyName: leg.partyId ? (partyById.get(leg.partyId) ?? null) : null,
      projectName: leg.projectId ? (projectById.get(leg.projectId) ?? null) : null,
    })),
  };
}
