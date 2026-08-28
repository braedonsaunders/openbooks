import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { CamTable, formatCamAmount } from "./CamTable";
import type { PropertyWorkspace } from "./types";

type MoneyCall = {
  value: string | number;
  options?: { currency?: string };
};

const workspace = {
  properties: [
    {
      id: "property-eur",
      name: "Euro Centre",
      currency: "EUR",
    },
  ],
  camPools: [
    {
      id: "pool-eur",
      propertyId: "property-eur",
      name: "Operating expenses",
      fiscalYear: 2026,
      periodStartsOn: "2026-01-01",
      periodEndsOn: "2026-12-31",
      allocationBasis: "equal",
      budgetAmount: "1000.0000000000",
      actualAmount: "1100.0000000000",
      status: "open",
    },
  ],
  camAllocations: [
    {
      id: "allocation-eur",
      poolId: "pool-eur",
      leaseId: "lease-eur",
      sharePercent: "100.0000",
      budgetAllocation: "1000.0000000000",
      actualAllocation: "1100.1234567890",
      billedEstimate: "1000.1234567890",
      reconciliationAmount: "100.0000000000",
      invoiceDocumentId: null,
    },
  ],
  leases: [{ id: "lease-eur", leaseNumber: "L-EUR" }],
} as unknown as PropertyWorkspace;

const permissions = { manage: false, account: false, bill: false };

test("CAM allocation rows format exact amounts in their property's currency", () => {
  const calls: MoneyCall[] = [];
  const money = (value: string | number, options?: { currency?: string }) => {
    calls.push({ value, options });
    return `${options?.currency ?? "ORG"}:${value}`;
  };

  renderToStaticMarkup(
    createElement(CamTable, {
      data: workspace,
      money,
      busy: false,
      permissions,
      act: async () => null,
    }),
  );

  assert.deepEqual(calls.slice(-3), [
    { value: "1100.1234567890", options: { currency: "EUR" } },
    { value: "1000.1234567890", options: { currency: "EUR" } },
    { value: "100.0000000000", options: { currency: "EUR" } },
  ]);
});

test("CAM amount helper keeps organization-base formatting when no property currency is supplied", () => {
  const calls: MoneyCall[] = [];
  const money = (value: string | number, options?: { currency?: string }) => {
    calls.push({ value, options });
    return `${options?.currency ?? "ORG"}:${value}`;
  };

  assert.equal(formatCamAmount("900.1234567890", money), "ORG:900.1234567890");
  assert.deepEqual(calls, [{ value: "900.1234567890", options: undefined }]);
});
