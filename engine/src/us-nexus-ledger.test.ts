import assert from "node:assert/strict";
import test from "node:test";
import { db } from "./db.ts";
import { computeUsNexusStatus } from "./us-nexus-ledger.ts";

type LedgerRow = {
  subsidiary_id: string;
  state: string;
  currency: string;
  fx_rate: string;
  base_currency: string;
  amount: string;
  is_invoice: number;
  as_of: string;
};

/** Flatten a drizzle SQL chunk enough to inspect the generated predicates. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      return (chunk as { queryChunks?: unknown[] })?.queryChunks ? sqlText(chunk) : "";
    })
    .join("");
}

const visibleSale: LedgerRow = {
  subsidiary_id: "00000000-0000-0000-0000-000000000001",
  state: "CA",
  currency: "USD",
  fx_rate: "1.0000000000",
  base_currency: "USD",
  amount: "10000.0000",
  is_invoice: 1,
  as_of: "2026-07-10",
};

const hiddenSale: LedgerRow = {
  ...visibleSale,
  subsidiary_id: "00000000-0000-0000-0000-000000000002",
  amount: "250000.0000",
  as_of: "2026-07-11",
};

test("restricted nexus aggregation excludes documents from other subsidiaries", async (t) => {
  const visibleSubsidiaryId = "00000000-0000-0000-0000-000000000001";
  let documentQuery = "";
  t.mock.method(db, "execute", async (query: unknown) => {
    documentQuery = sqlText(query);
    // Model the database applying the generated predicate. Without it this
    // mock returns both legal entities, making the regression fail.
    return {
      rows: documentQuery.includes("d.subsidiary_id in") ? [visibleSale] : [visibleSale, hiddenSale],
    };
  });

  const result = await computeUsNexusStatus(
    "org-1",
    "2026-07-01",
    "2026-07-31",
    new Set([visibleSubsidiaryId]),
  );

  assert.match(documentQuery, /d\.subsidiary_id in/);
  assert.match(documentQuery, new RegExp(visibleSubsidiaryId));
  assert.equal(result.states[0]?.salesUsd, "10000.0000");
  assert.equal(result.states[0]?.txnCount, 1);
});

test("unrestricted nexus aggregation retains all organization sales", async (t) => {
  t.mock.method(db, "execute", async () => ({ rows: [visibleSale, hiddenSale] }));

  const result = await computeUsNexusStatus("org-1", "2026-07-01", "2026-07-31");

  assert.equal(result.states[0]?.salesUsd, "260000.0000");
  assert.equal(result.states[0]?.txnCount, 2);
});
