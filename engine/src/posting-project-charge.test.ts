import assert from "node:assert/strict";
import { test } from "node:test";
import { sum } from "./money.ts";
import { PostingError, projectChargeKernelLines } from "./posting.ts";

const COST = "11111111-1111-4111-8111-111111111111";
const RECOVERY = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const EQUIPMENT = "44444444-4444-4444-8444-444444444444";

const doc = {
  departmentId: null,
  projectId: PROJECT,
  locationId: null,
  classId: null,
  extraDims: {},
} as any;

test("project charge balances, costs the job, and preserves equipment attribution", () => {
  const lines = projectChargeKernelLines(doc, [{
    accountId: COST,
    recoveryAccountId: RECOVERY,
    amount: "125.3750",
    description: "Excavator usage",
    projectId: PROJECT,
    equipmentUnitId: EQUIPMENT,
    extraDims: {},
  } as unknown as { amount: string; id: string; orgId: string; documentId: string; lineNumber: number; itemId: string | null; accountId: string | null; description: string | null; quantity: string; unit: string | null; unitPrice: string; taxCodeId: string | null; taxGroupId: string | null; taxInputAmount: string | null; taxAmount: string; taxOverridden: boolean; partyId: string | null; departmentId: string | null; projectId: string | null; locationId: string | null; classId: string | null; subsidiaryId: string | null; extraDims: unknown; employeeId: string | null; timeEntryId: string | null; timeTypeId: string | null; costMultiplier: string | null; markupPercent: string | null; isBillable: boolean; billedByLineId: string | null; fieldTicketId: string | null; equipmentUnitId: string | null; rateVersionId: string | null; ratePresentation: "summary" | "rate_components" | null; custom: unknown; baseQuantity: string | null; baseUnit: string | null; costRate: string | null; billRate: string | null; costAmount: string | null; billAmount: string | null; recoveryAccountId: string | null; quantityFulfilled: string; quantityBilled: string; stockLocationId: string | null; createdAt: Date; createdBy: string | null; updatedAt: Date; updatedBy: string | null; }]);

  assert.equal(lines.length, 2);
  assert.equal(sum(lines.map((line) => line.amount)), "0.0000");
  assert.deepEqual(
    lines.map((line) => ({ account: line.accountId, amount: line.amount, project: line.projectId, equipment: line.equipmentUnitId })),
    [
      { account: COST, amount: "125.3750", project: PROJECT, equipment: EQUIPMENT },
      { account: RECOVERY, amount: "-125.3750", project: null, equipment: EQUIPMENT },
    ],
  );
});

test("project charge refuses missing or same-account recovery", () => {
  const base = { accountId: COST, amount: "1.0000", description: null, projectId: PROJECT } as any;
  assert.throws(() => projectChargeKernelLines(doc, [base]), PostingError);
  assert.throws(() => projectChargeKernelLines(doc, [{ ...base, recoveryAccountId: COST }]), /must be different/);
});
