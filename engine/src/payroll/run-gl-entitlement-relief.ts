/**
 * Entitlement-plan settlement bindings for a governed GL recode.
 *
 * Split from the rebuild module so each operation stays within the line bound.
 */

import { sql } from "drizzle-orm";

import { db } from "../platform/db.ts";

import { cmp, neg, sum } from "../money/money.ts";

import { PayrollError } from "./error.ts";

import { type EntitlementReliefLine } from "./run-commit.ts";

/** A reviewed binding of one entitlement plan to the liability its bank is carried in. */
export interface EntitlementReliefBinding {
  planId: string;
  liabilityAccountId: string;
}

/** How a governed correction tied a movement to the stub lines it settled. */
type ReliefLinkage =
  "linked_component_lines" | "unlinked_component_lines" | "linked_line" | "unlinked_unique_match";

interface SelectedRelief {
  stubLineId: string;
  planId: string;
  movementId: string;
  /** The movement's own recorded stub line link; null when it recorded none. */
  movementStubLineId: string | null;
  linkage: ReliefLinkage;
  hours: string | null;
}

/**
 * Bind each settlement movement on a bound plan to the exact stub lines it
 * settled. All lines of the settling component on the employee's stub answer
 * when they sum to the withdrawal; otherwise the movement's linked line alone
 * when it equals the withdrawal; otherwise, for a movement that recorded no
 * link, the single line equal to it. Anything else is ambiguous and refuses,
 * as does a line claimed twice. Lines already posting to a plan liability are
 * left as they are.
 */
export async function selectEntitlementRelief(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    documentId: string;
    number: string;
    bindings: readonly EntitlementReliefBinding[];
    carried: ReadonlyMap<string, EntitlementReliefLine>;
  },
): Promise<{ relief: Map<string, EntitlementReliefLine>; selected: SelectedRelief[] }> {
  const { orgId, documentId, number, bindings, carried } = args;
  const plans = new Map<
    string,
    {
      code: string;
      unit: string;
      liabilityAccountId: string;
      payoutComponentId: string | null;
      depositComponentId: string | null;
    }
  >();
  for (const binding of bindings) {
    const plan = (
      await tx.execute<{
        code: string;
        unit: string;
        liability_account_id: string | null;
        payout_component_id: string | null;
        deposit_component_id: string | null;
      }>(
        sql`
      select code, unit, liability_account_id::text as liability_account_id,
             payout_component_id::text as payout_component_id, deposit_component_id::text as deposit_component_id
        from entitlement_plans where org_id = ${orgId} and id = ${binding.planId}
       for share
    `,
        "objects",
      )
    )[0];
    if (!plan)
      throw new PayrollError(
        "an entitlement relief binding names a plan that does not exist in this organization",
      );
    if (plan.liability_account_id !== binding.liabilityAccountId) {
      throw new PayrollError(
        `the binding for entitlement plan ${plan.code} names a different liability account than the plan carries — review the plan's liability account and resubmit the binding`,
      );
    }
    const account = (
      await tx.execute<{ type: string; is_summary: boolean; is_active: boolean }>(
        sql`
      select type, is_summary, is_active from accounts where org_id = ${orgId} and id = ${binding.liabilityAccountId}
       for share
    `,
        "objects",
      )
    )[0];
    if (
      !account ||
      !account.type.startsWith("liability") ||
      account.is_summary ||
      !account.is_active
    ) {
      throw new PayrollError(
        `entitlement plan ${plan.code}'s bound account is not an active, postable liability account — correct the plan's liability account before relieving its bank`,
      );
    }
    plans.set(binding.planId, {
      code: plan.code,
      unit: plan.unit,
      liabilityAccountId: binding.liabilityAccountId,
      payoutComponentId: plan.payout_component_id,
      depositComponentId: plan.deposit_component_id,
    });
  }
  const movements = await tx.execute<{
    id: string;
    plan_id: string;
    employee_party_id: string;
    kind: string;
    amount: string;
    stub_line_id: string | null;
  }>(
    sql`
    select id::text as id, plan_id::text as plan_id, employee_party_id::text as employee_party_id, kind,
           amount::text as amount, stub_line_id::text as stub_line_id
      from entitlement_ledger
     where org_id = ${orgId} and pay_run_document_id = ${documentId} and kind in ('payout', 'bank_in')
       and plan_id in (${sql.join(
         [...plans.keys()].map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     order by id
  `,
    "objects",
  );
  const stubLines = await tx.execute<{
    employee_party_id: string;
    stub_id: string;
    line_id: string;
    component_id: string | null;
    kind: string;
    amount: string;
    hours: string | null;
    expense_account_source: string;
  }>(
    sql`
    select s.employee_party_id::text as employee_party_id, s.id::text as stub_id, l.id::text as line_id,
           l.component_id::text as component_id, l.kind, l.amount::text as amount, l.hours::text as hours,
           l.expense_account_source
      from pay_stubs s
      join pay_stub_lines l on l.org_id = s.org_id and l.stub_id = s.id
     where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
  `,
    "objects",
  );
  const byEmployee = new Map<string, typeof stubLines>();
  for (const line of stubLines)
    byEmployee.set(line.employee_party_id, [
      ...(byEmployee.get(line.employee_party_id) ?? []),
      line,
    ]);
  const relief = new Map<string, EntitlementReliefLine>();
  const selected: SelectedRelief[] = [];
  for (const movement of movements) {
    const plan = plans.get(movement.plan_id)!;
    const employeeLines = byEmployee.get(movement.employee_party_id) ?? [];
    if (new Set(employeeLines.map((line) => line.stub_id)).size !== 1) {
      throw new PayrollError(
        `pay run ${number}'s ${plan.code} movement cannot be tied to exactly one stub for its employee — the relief is ambiguous`,
      );
    }
    const linked = movement.stub_line_id
      ? employeeLines.find((line) => line.line_id === movement.stub_line_id)
      : undefined;
    if (movement.stub_line_id && !linked) {
      throw new PayrollError(
        `pay run ${number}'s ${plan.code} movement links a line outside its employee's stub — the relief is ambiguous`,
      );
    }
    const componentId = linked
      ? linked.component_id
      : movement.kind === "payout"
        ? plan.payoutComponentId
        : (plan.depositComponentId ?? plan.payoutComponentId);
    if (
      !componentId ||
      (componentId !== plan.payoutComponentId && componentId !== plan.depositComponentId)
    ) {
      throw new PayrollError(
        `pay run ${number}'s ${plan.code} movement does not settle through one of the plan's payout or deposit components — the relief is ambiguous`,
      );
    }
    const componentLines = employeeLines.filter(
      (line) => line.kind === "earning" && line.component_id === componentId,
    );
    // Already posting to a plan liability: stamped at calculation or relieved
    // by an earlier correction. Nothing to correct for this movement.
    if (
      componentLines.some(
        (line) => line.expense_account_source === "entitlement_plan" || carried.has(line.line_id),
      )
    )
      continue;
    const valueOf = (line: (typeof stubLines)[number]) =>
      plan.unit === "hours" ? line.hours : line.amount;
    const withdrawn = neg(movement.amount);
    const equals = (lines: typeof stubLines) =>
      lines.every((line) => valueOf(line) !== null) &&
      cmp(sum(lines.map((line) => valueOf(line)!)), withdrawn) === 0;
    let chosen: typeof stubLines;
    let linkage: ReliefLinkage;
    if (componentLines.length > 0 && equals(componentLines)) {
      chosen = componentLines;
      linkage = linked ? "linked_component_lines" : "unlinked_component_lines";
    } else if (linked && equals([linked])) {
      chosen = [linked];
      linkage = "linked_line";
    } else if (!linked) {
      const matches = componentLines.filter((line) => equals([line]));
      if (matches.length !== 1) {
        throw new PayrollError(
          `pay run ${number}'s ${plan.code} movement recorded no stub line and ${matches.length === 0 ? "no line" : "more than one line"} equals its withdrawal — the relief is ambiguous`,
        );
      }
      chosen = matches;
      linkage = "unlinked_unique_match";
    } else {
      throw new PayrollError(
        `pay run ${number}'s ${plan.code} movement does not equal its linked line or its component's lines — the relief is ambiguous`,
      );
    }
    for (const line of chosen) {
      if (relief.has(line.line_id))
        throw new PayrollError(
          `pay run ${number} has a stub line claimed by two settlement movements — the relief is ambiguous`,
        );
      relief.set(line.line_id, {
        accountId: plan.liabilityAccountId,
        planId: movement.plan_id,
        movementId: movement.id,
      });
      selected.push({
        stubLineId: line.line_id,
        planId: movement.plan_id,
        movementId: movement.id,
        movementStubLineId: movement.stub_line_id,
        linkage,
        hours: line.hours,
      });
    }
  }
  return { relief, selected };
}
