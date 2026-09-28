import assert from "node:assert/strict";
import test from "node:test";
import {
  FINANCIAL_CHANGE_DOMAIN_LABELS,
  FINANCIAL_CHANGE_OPERATION_LABELS,
  financialChangeDomainLabel,
  financialChangeEventLabel,
  financialChangeInboxLabel,
  financialChangeStatusLabel,
} from "./financial-change-labels.ts";

test("inbox labels name the event and subject, not the raw domain.operation pair", () => {
  assert.equal(
    financialChangeInboxLabel({
      operation: "remeasurement",
      subjectLabel: "L-1042 — Warehouse 12",
      effectiveOn: "2026-10-01",
    }),
    `${FINANCIAL_CHANGE_OPERATION_LABELS.remeasurement} · L-1042 — Warehouse 12`,
  );
  assert.equal(
    financialChangeInboxLabel({
      operation: "contract_modification",
      effectiveOn: "2026-09-15",
    }),
    "Contract modification · 2026-09-15",
  );
});

test("the manufacturing domain and restatement operation read as product language", () => {
  assert.equal(financialChangeDomainLabel("manufacturing"), "Manufacturing");
  assert.equal(
    FINANCIAL_CHANGE_DOMAIN_LABELS.manufacturing,
    "Manufacturing",
  );
  assert.equal(
    financialChangeEventLabel("scrap_snapshot_restatement"),
    "Scrap snapshot restatement",
  );
  assert.equal(
    financialChangeInboxLabel({
      operation: "scrap_snapshot_restatement",
      effectiveOn: "2026-10-01",
    }),
    "Scrap snapshot restatement · 2026-10-01",
  );
});

test("unknown operations stay readable instead of vanishing", () => {
  assert.equal(financialChangeEventLabel("scope_reduction"), "scope reduction");
  assert.equal(financialChangeStatusLabel("pending"), "Awaiting approval");
});

test("every stored operation used by the register has a label", () => {
  for (const operation of [
    "modification",
    "remeasurement",
    "termination",
    "separate_lease",
    "contract_modification",
    "partial_disposal",
    "intercompany_transfer",
    "group_valuation",
    "loss_of_control",
    "reversal",
    "scrap_snapshot_restatement",
  ]) {
    assert.equal(typeof FINANCIAL_CHANGE_OPERATION_LABELS[operation], "string");
    assert.notEqual(
      FINANCIAL_CHANGE_OPERATION_LABELS[operation],
      operation.replaceAll("_", " "),
    );
  }
});
