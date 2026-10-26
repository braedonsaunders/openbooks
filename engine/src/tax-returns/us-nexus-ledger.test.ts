import assert from "node:assert/strict";
import test from "node:test";
import { db } from "../platform/db.ts";
import { computeUsNexusStatus } from "./us-nexus-ledger.ts";

type LedgerRow = {
  subsidiary_id: string;
  state: string;
  currency: string;
  fx_rate: string;
  base_currency: string;
  amount: string;
  marketplace_amount: string;
  is_invoice: number;
  marketplace_invoice: number;
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
  marketplace_amount: "0",
  is_invoice: 1,
  marketplace_invoice: 0,
  as_of: "2026-07-10",
};

const hiddenSale: LedgerRow = {
  ...visibleSale,
  subsidiary_id: "00000000-0000-0000-0000-000000000002",
  amount: "250000.0000",
  as_of: "2026-07-11",
};

/** No seeded marketplace-facilitator rules: every state defaults to included. */
const NO_MARKETPLACE_RULES = "marketplace_nexus_state_rules";

test("restricted nexus aggregation excludes documents from other subsidiaries", async (t) => {
  const visibleSubsidiaryId = "00000000-0000-0000-0000-000000000001";
  let documentQuery = "";
  t.mock.method(db, "execute", async (query: unknown, mode?: string) => {
    const inMode = <T extends { rows: unknown }>(result: T) =>
      mode === "objects" ? result.rows : result;
    const text = sqlText(query);
    if (text.includes(NO_MARKETPLACE_RULES)) return inMode({ rows: [] });
    documentQuery = text;
    // Model the database applying the generated predicate. Without it this
    // mock returns both legal entities, making the regression fail.
    return inMode({
      rows: documentQuery.includes("d.subsidiary_id in")
        ? [visibleSale]
        : [visibleSale, hiddenSale],
    });
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
  t.mock.method(db, "execute", async (query: unknown, mode?: string) =>
    Promise.resolve({
      rows: sqlText(query).includes(NO_MARKETPLACE_RULES) ? [] : [visibleSale, hiddenSale],
    }).then(<T extends { rows: unknown }>(result: T) =>
      mode === "objects" ? result.rows : result,
    ),
  );

  const result = await computeUsNexusStatus("org-1", "2026-07-01", "2026-07-31");

  assert.equal(result.states[0]?.salesUsd, "260000.0000");
  assert.equal(result.states[0]?.txnCount, 2);
});

test("marketplace-excluded rules omit fully facilitated invoices from the transaction threshold", async (t) => {
  const marketplaceInvoices = Array.from({ length: 200 }, (_, index) => ({
    ...visibleSale,
    state: "FL",
    amount: "1000.0000",
    marketplace_amount: "1000.0000",
    is_invoice: 1,
    marketplace_invoice: 1,
    as_of: `2026-07-${String((index % 28) + 1).padStart(2, "0")}`,
  }));
  t.mock.method(db, "execute", async (query: unknown, mode?: string) => {
    const inMode = <T extends { rows: unknown }>(result: T) =>
      mode === "objects" ? result.rows : result;
    const text = sqlText(query);
    if (text.includes(NO_MARKETPLACE_RULES)) {
      return inMode({
        rows: [{ state: "FL", includeInThreshold: false, needsReview: false, source: "verified" }],
      });
    }
    return inMode({ rows: marketplaceInvoices });
  });

  const result = await computeUsNexusStatus("org-1", "2026-07-01", "2026-07-31");
  const florida = result.states.find((state) => state.state === "FL");
  assert.ok(florida);
  assert.equal(florida.salesUsd, "0.0000");
  assert.equal(florida.txnCount, 0);
  assert.equal(florida.status, "none");
});
