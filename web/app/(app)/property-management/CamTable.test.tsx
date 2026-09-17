import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("an invoiced CAM pool exposes replacement billing only for released nonzero allocations", () => {
  for (const [amount, invoice, expected] of [
    ["100.0000", null, true], ["-100.0000", null, true],
    ["0.0000", null, false], ["100.0000", "existing-invoice", false],
  ] as const) {
    const data = structuredClone(workspace);
    data.camPools[0]!.status = "invoiced";
    data.camAllocations[0]!.reconciliationAmount = amount;
    data.camAllocations[0]!.invoiceDocumentId = invoice;
    const html = renderToStaticMarkup(createElement(CamTable, {
      data, money: value => String(value), busy: false,
      permissions: { manage: false, account: false, bill: true }, act: async () => null,
    }));
    assert.equal(html.includes("Create true-ups"), expected);
    assert.equal(html.includes("Reopen for correction"), false);
  }
});

// F-t07-007: a refused CAM Finalize (422 naming the blocking open period)
// surfaced nowhere on the record — the shared act() toasted and returned
// null, so the pool card sat unchanged. The finalize call must hand the
// server's reason back to the pool card, which pins it as an alert until
// the next finalize attempt.
const camSource = readFileSync(new URL("./CamTable.tsx", import.meta.url), "utf8");
const workspaceSource = readFileSync(
  new URL("./PropertyManagementWorkspace.tsx", import.meta.url),
  "utf8",
);
const typesSource = readFileSync(new URL("./types.ts", import.meta.url), "utf8");

test("a refused CAM finalize pins its reason on the pool card", () => {
  assert.match(typesSource, /onError\?: \(message: string\) => void/);
  assert.match(workspaceSource, /onError\?\.?\(message\)/);
  assert.match(camSource, /const \[poolError, setPoolError\]/);
  assert.match(camSource, /finalizeCam[\s\S]{0,300}\(message\) => setPoolError\(\{ poolId: pool\.id, message \}\)/);
  assert.match(camSource, /<p role="alert"[\s\S]*?\{poolError/);
  assert.match(camSource, /setPoolError\(null\)/);
});
