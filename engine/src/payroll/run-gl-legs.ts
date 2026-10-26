import { payrollSettingsForPayRun } from "./run-setup.ts";
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { add, cmp, neg, sum } from "../money/money.ts";
import { laborCostingSettingsInTx } from "../projects/labor-costing.ts";

/** What a projected leg represents; persisted on the document line. */
export type PayRunGlLegKind =
  "expense" | "non_cash_offset" | "liability" | "net_pay" | "labor_clearing" | "entitlement_relief";

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

export function payRunGlCodingKey(
  componentId: string | null,
  departmentId: string | null,
  projectId: string | null,
): string {
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
    if (frozen) {
      netPayable = frozen.netPayAccountId;
    } else {
      const settings = await payrollSettingsForPayRun(orgId, documentId, allowedSubsidiaryIds, tx);
      const costing = await laborCostingSettingsInTx(tx, orgId);
      const control = await tx.execute<{ c: Record<string, string | null> | null }>(
        sql`
        select settings->'controlAccounts' as c from orgs where id = ${orgId}
      `,
        "objects",
      );
      laborClearing = control[0]?.c?.laborClearing ?? null;

      const requireAccount = (value: string | null, label: string): string => {
        if (!value)
          throw new PayrollError(`payroll setup incomplete: ${label} account is not configured`);
        return value;
      };
      wageExpense = requireAccount(settings.wageExpenseAccountId, "wage expense");
      netPayable = requireAccount(settings.netPayAccountId, "net pay payable");
      burdenExpense = settings.burdenExpenseAccountId ?? wageExpense;
      wagesToClearing = settings.wagesTo === "labor_clearing" && costing.mode === "post";
      if (settings.wagesTo === "labor_clearing" && !laborClearing) {
        throw new PayrollError(
          "payroll setup incomplete: labor clearing account is not configured",
        );
      }
    }

    const stubLines = await tx.execute<Record<string, string | null>>(
      sql`
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
    `,
      "objects",
    );
    // Frozen resolution: the stub line's own stamp, else the account the
    // committed projection used for the same component, department and
    // project. Account types come from the resolved account itself.
    const frozenExpenseAccount = (line: Record<string, string | null>): string => {
      const stamped = line.line_expense_account_id;
      const committed =
        stamped ??
        frozen!.expenseAccountByCoding.get(
          payRunGlCodingKey(
            line.component_id ?? null,
            line.department_id ?? null,
            line.project_id ?? null,
          ),
        );
      if (!committed) {
        throw new PayrollError(
          `the committed projection has no unique expense account for "${line.description ?? "payroll line"}" — its accounting basis cannot be rebuilt from committed records`,
        );
      }
      return committed;
    };
    const reliefFor = (line: Record<string, string | null>): EntitlementReliefLine | undefined =>
      frozen?.entitlementReliefByStubLine?.get(line.line_id!);
    const frozenAccountTypes = new Map<string, string>();
    if (frozen) {
      // A line a governed correction relieved posts to its bound liability;
      // its original expense resolution is reported, never required.
      const ids = [
        ...new Set(
          stubLines
            .filter(
              (line) =>
                (line.kind === "earning" || line.kind === "employer_contribution") &&
                !reliefFor(line),
            )
            .map(frozenExpenseAccount),
        ),
      ];
      if (ids.length) {
        const types = await tx.execute<{ id: string; type: string }>(
          sql`
          select id::text as id, type from accounts
           where org_id = ${orgId} and id in (${sql.join(
             ids.map((id) => sql`${id}::uuid`),
             sql`, `,
           )})
        `,
          "objects",
        );
        for (const row of types) frozenAccountTypes.set(row.id, row.type);
        if (frozenAccountTypes.size !== ids.length)
          throw new PayrollError(
            "a committed payroll expense account no longer exists — the projection cannot be rebuilt",
          );
      }
    }
    const frozenLiability = (line: Record<string, string | null>): string => {
      if (!line.committed_liability_account_id) {
        throw new PayrollError(
          `"${line.description ?? "payroll line"}" has no committed liability stamp — the projection cannot be rebuilt from committed records`,
        );
      }
      return line.committed_liability_account_id;
    };
    const stubs = await tx.execute<{ has_value: boolean; has_lines: boolean }>(
      sql`select
      (s.gross<>0 or s.net_pay<>0 or s.employer_cost<>0 or s.pensionable_earnings<>0 or s.insurable_earnings<>0 or s.vacation_accrued<>0) as has_value,
      exists(select 1 from pay_stub_lines line where line.org_id=s.org_id and line.stub_id=s.id) as has_lines
      from pay_stubs s left join parties p on p.org_id=s.org_id and p.id=s.employee_party_id
      where s.org_id=${orgId} and s.pay_run_document_id=${documentId}
        ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}`,
      "objects",
    );
    if (!stubs.length)
      throw new PayrollError(
        "Pay run has no calculated stubs — calculate its selected employees before committing",
      );
    if (stubs.some((stub) => stub.has_value && !stub.has_lines))
      throw new PayrollError(
        "A calculated pay stub has financial totals but no native lines — recalculate the pay run before committing",
      );
    if (stubLines.length === 0) {
      // Unpaid coverage retains native bank movements and allocations without
      // inventing financial entries for an entirely zero-money projection.
      return {
        legs: [],
        debitTotal: "0.0000",
        lineLiabilities: [],
        lineDestinations: [],
        reliefs: [],
      };
    }

    // Keep the account, coding, party, payroll component, employee, time type
    // and service item in the grouping identity so posting allocations and
    // later classification can select the original expense source. Employer
    // burden descriptions remain separate to identify each share.
    const legs = new Map<string, PayRunGlLeg>();
    const accumulate = (
      accountId: string,
      amount: string,
      description: string,
      legKind: PayRunGlLegKind,
      opts: {
        partyId?: string | null;
        projectId?: string | null;
        departmentId?: string | null;
        split?: string;
        payrollExpense?: boolean;
        payComponentId?: string | null;
        employeePartyId?: string | null;
        timeTypeId?: string | null;
        itemId?: string | null;
        relief?: {
          planId: string | null;
          movementId: string | null;
          basis: EntitlementReliefBasis;
          stubLineId: string;
        };
      } = {},
    ) => {
      if (cmp(amount, "0") === 0) return;
      const key = [
        accountId,
        opts.partyId ?? "",
        opts.projectId ?? "",
        opts.departmentId ?? "",
        opts.split ?? "",
        opts.payrollExpense ? "expense" : "",
        opts.payComponentId ?? "",
        legKind,
        opts.employeePartyId ?? "",
        opts.timeTypeId ?? "",
        opts.itemId ?? "",
        opts.relief?.planId ?? "",
        opts.relief?.movementId ?? "",
        opts.relief?.basis ?? "",
      ].join("|");
      const existing = legs.get(key);
      if (existing) {
        existing.amount = add(existing.amount, amount);
        if (opts.relief)
          existing.stubLineIds = [...(existing.stubLineIds ?? []), opts.relief.stubLineId];
      } else
        legs.set(key, {
          accountId,
          amount,
          description,
          legKind,
          partyId: opts.partyId ?? null,
          projectId: opts.projectId ?? null,
          departmentId: opts.departmentId ?? null,
          payrollExpense: opts.payrollExpense,
          payComponentId: opts.payComponentId,
          employeePartyId: opts.employeePartyId ?? null,
          timeTypeId: opts.timeTypeId ?? null,
          itemId: opts.itemId ?? null,
          ...(opts.relief
            ? {
                entitlementPlanId: opts.relief.planId,
                entitlementMovementId: opts.relief.movementId,
                entitlementReliefBasis: opts.relief.basis,
                stubLineIds: [opts.relief.stubLineId],
              }
            : {}),
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
      const liability = line.liability_account_id;
      if (!liability) {
        throw new PayrollError(
          `${label} "${line.description}" has no liability account — set it in Payroll setup → Accounts & posting`,
        );
      }
      return liability;
    };
    for (const line of stubLines) {
      netByEmployee.set(line.employee_party_id!, line.net_pay!);
      const amount = line.amount!;
      const identity = {
        employeePartyId: line.employee_party_id,
        timeTypeId: line.time_type_id,
        itemId: line.item_id,
      };
      const expenseAccountType = (accountId: string): string | null =>
        frozen ? (frozenAccountTypes.get(accountId) ?? null) : (line.expense_account_type ?? null);
      if (line.kind === "earning") {
        if (line.payment_kind === "non_cash") {
          if (!line.non_cash_account_id)
            throw new PayrollError(
              `non-cash earning "${line.description}" has no calculated clearing account — recalculate the editable run after configuring its non-cash account`,
            );
          accumulate(
            line.non_cash_account_id,
            neg(amount),
            `Non-cash benefit: ${line.description}`,
            "non_cash_offset",
            {
              projectId: line.project_id,
              departmentId: line.department_id,
              ...identity,
            },
          );
        }
        const isTimeDriven = line.system_key === "base_pay" || line.system_key === "overtime";
        const settlesBank =
          line.expense_account_source === "entitlement_plan" || reliefFor(line) !== undefined;
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
            if (relief)
              throw new PayrollError(
                `"${line.description ?? "payroll line"}" already posts to its entitlement plan's liability — it cannot be corrected again`,
              );
            const reference = line.expense_account_reference ?? "";
            accumulate(
              line.line_expense_account_id!,
              amount,
              line.description ?? "Entitlement payout",
              "entitlement_relief",
              {
                projectId: line.project_id,
                departmentId: line.department_id,
                payrollExpense: false,
                payComponentId: line.component_id,
                ...identity,
                relief: {
                  planId: reference.startsWith("entitlement_plans:")
                    ? reference.slice("entitlement_plans:".length)
                    : null,
                  movementId: null,
                  basis: "calculation_stamp",
                  stubLineId: line.line_id!,
                },
              },
            );
          } else if (relief) {
            const fromAccountId =
              line.line_expense_account_id ??
              frozen!.expenseAccountByCoding.get(
                payRunGlCodingKey(
                  line.component_id ?? null,
                  line.department_id ?? null,
                  line.project_id ?? null,
                ),
              ) ??
              null;
            accumulate(
              relief.accountId,
              amount,
              line.description ?? "Entitlement payout",
              "entitlement_relief",
              {
                projectId: line.project_id,
                departmentId: line.department_id,
                payrollExpense: false,
                payComponentId: line.component_id,
                ...identity,
                relief: {
                  planId: relief.planId,
                  movementId: relief.movementId,
                  basis: "governed_correction",
                  stubLineId: line.line_id!,
                },
              },
            );
            reliefs.push({
              stubLineId: line.line_id!,
              planId: relief.planId,
              movementId: relief.movementId,
              fromAccountId,
              toAccountId: relief.accountId,
              amount,
            });
          } else {
            const accountId = frozen
              ? frozenExpenseAccount(line)
              : (line.line_expense_account_id ?? line.component_expense_account_id ?? wageExpense!);
            // Bank drawdowns debit a liability rather than a new payroll expense.
            // Keep those debits outside cost allocation, just like payable credits.
            const payrollExpense = ["expense", "expense_other", "cogs"].includes(
              expenseAccountType(accountId) ?? "",
            );
            accumulate(accountId, amount, line.description ?? "Wages", "expense", {
              projectId: line.project_id,
              departmentId: line.department_id,
              payrollExpense,
              payComponentId: line.component_id,
              ...identity,
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
          : (line.line_expense_account_id ?? line.component_expense_account_id ?? burdenExpense!);
        const payrollExpense = ["expense", "expense_other", "cogs"].includes(
          expenseAccountType(accountId) ?? "",
        );
        accumulate(accountId, amount, line.description ?? "Employer burden", "expense", {
          projectId: line.project_id,
          departmentId: line.department_id,
          payrollExpense,
          payComponentId: line.component_id,
          split: line.description ?? "Employer burden",
          ...identity,
        });
        accumulate(liability, neg(amount), line.description ?? "Employer burden", "liability");
        lineLiabilities.push({ lineId: line.line_id!, accountId: liability });
        lineDestinations.push({ lineId: line.line_id!, partyId: line.remittance_party_id ?? null });
      }
    }
    for (const [employeePartyId, net] of netByEmployee) {
      if (cmp(net, "0") === 0) continue;
      if (!netPayable) {
        throw new PayrollError(
          "the committed projection credited no net pay account, but a stub carries net pay — its accounting basis cannot be rebuilt from committed records",
        );
      }
      accumulate(netPayable, neg(net), "Net pay", "net_pay", { partyId: employeePartyId });
    }

    const total = sum([...legs.values()].map((l) => l.amount));
    if (cmp(total, "0") !== 0)
      throw new PayrollError(`pay run GL projection is unbalanced (${total})`);
    const debitTotal = sum(
      [...legs.values()].filter((l) => cmp(l.amount, "0") > 0).map((l) => l.amount),
    );
    return { legs: [...legs.values()], debitTotal, lineLiabilities, lineDestinations, reliefs };
  }
}
