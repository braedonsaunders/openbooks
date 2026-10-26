import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMoney } from "../money/brands.ts";
import { roundMoney } from "../money/money.ts";
import type { EntitlementMovement } from "./entitlements-movement-kernel.ts";
import type { EntitlementPlan } from "./entitlements-types.ts";
import { applyBankDrawdown } from "./run-bank-drawdown.ts";
import type { Line } from "./run-stub-records.ts";

for (const unit of ["money", "hours"] as const) {
  test(`bank drawdown leaves a cap auto-payout alone for ${unit} plans`, async () => {
    const plan: EntitlementPlan = {
      id: "plan-1",
      code: "AUTO-CAP",
      systemKey: null,
      name: "Capped bank",
      unit,
      direction: "accrue",
      accrualMethod: "fixed_per_period",
      accrualValue: unit === "money" ? "100.0000" : "2.0000",
      accrualComponentId: "accrual-component",
      payoutComponentId: "payout-component",
      depositComponentId: null,
      allowNegativeBalance: false,
      liabilityAccountId: "liability-account",
      capBehavior: "auto_payout",
    };
    const movement: EntitlementMovement = {
      planId: plan.id,
      employeePartyId: "employee-1",
      movementDate: "2026-07-21",
      amount: unit === "money" ? "-50.0000" : "-1.0000",
      hours: unit === "money" ? null : "1.00",
      kind: "payout",
      componentId: plan.payoutComponentId,
      note: "Balance capped",
    };
    const line: Line = {
      componentId: plan.payoutComponentId,
      kind: "earning",
      description: "Capped bank payout",
      amount: parseMoney(roundMoney(unit === "money" ? "50" : "30", 2)),
      hours: unit === "hours" ? "1.00" : undefined,
      sequence: 46,
      entitlementSettlementPlanId: plan.id,
      entitlementMovementKey: `${plan.id}:payout`,
    };

    await applyBankDrawdown(
      {
        execute: async () => {
          throw new Error("generated payout must not query or redraw the bank");
        },
      } as never,
      {
        orgId: "org-1",
        documentId: "run-1",
        payDate: "2026-07-21",
        employeePartyId: "employee-1",
        employeeName: "Bank Employee",
        terminationRun: false,
        plans: [plan],
        lines: [line],
        entitlementMovements: [movement],
      },
    );

    assert.deepEqual(
      [line.entitlementSettlementPlanId, line.entitlementMovementKey],
      [plan.id, `${plan.id}:payout`],
    );
    assert.deepEqual(
      [movement.amount, movement.hours],
      [unit === "money" ? "-50.0000" : "-1.0000", unit === "money" ? null : "1.00"],
    );
  });
}
