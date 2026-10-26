import assert from "node:assert/strict";
import test from "node:test";
import { rankPartyAccountUsage, rankPartyTaxUsage } from "./document-defaults.ts";

const usage = (
  accountId: string,
  documentCount: number,
  lastDocumentDate: string,
  lastCreatedAt = "2026-01-01T00:00:00.000000",
) => ({ accountId, documentCount, lastDocumentDate, lastCreatedAt });

test("party history proposes the account used on the most documents", () => {
  assert.equal(rankPartyAccountUsage([]), null);
  const top = rankPartyAccountUsage([
    usage("b", 1, "2026-09-30"),
    usage("a", 3, "2026-01-15"),
    usage("c", 2, "2026-09-29"),
  ]);
  assert.equal(top?.accountId, "a");
  assert.equal(top?.documentCount, 3);
});

test("equally used accounts rank by latest document date, then latest entry, then account id", () => {
  assert.equal(
    rankPartyAccountUsage([usage("a", 2, "2026-08-01"), usage("b", 2, "2026-09-01")])?.accountId,
    "b",
  );
  assert.equal(
    rankPartyAccountUsage([
      usage("a", 2, "2026-09-01", "2026-09-01T10:00:00.000000"),
      usage("b", 2, "2026-09-01", "2026-09-01T09:59:59.999999"),
    ])?.accountId,
    "a",
  );
  // A full tie is decided by the account id, so the proposal never depends on row order.
  const tied = [usage("b", 2, "2026-09-01"), usage("a", 2, "2026-09-01")];
  assert.equal(rankPartyAccountUsage(tied)?.accountId, "a");
  assert.equal(rankPartyAccountUsage([...tied].reverse())?.accountId, "a");
});

const taxUsage = (key: string | null, documentCount: number, lastDocumentDate = "2026-09-01") => ({
  taxCodeId: key?.startsWith("code:") ? key.slice(5) : null,
  taxGroupId: key?.startsWith("group:") ? key.slice(6) : null,
  documentCount,
  lastDocumentDate,
  lastCreatedAt: "2026-09-01T00:00:00.000000",
});

test("party tax history competes untaxed lines against codes and groups", () => {
  assert.equal(rankPartyTaxUsage([]), null);
  assert.deepEqual(
    rankPartyTaxUsage([taxUsage("code:hst", 9), taxUsage(null, 2), taxUsage("group:qc", 4)]),
    taxUsage("code:hst", 9),
  );
  assert.deepEqual(
    rankPartyTaxUsage([taxUsage("group:qc", 5), taxUsage("code:gst", 1)]),
    taxUsage("group:qc", 5),
  );
  // A party mostly billed without tax proposes no tax, never its minority code.
  const untaxed = rankPartyTaxUsage([taxUsage("code:hst", 2), taxUsage(null, 6)]);
  assert.equal(untaxed?.taxCodeId, null);
  assert.equal(untaxed?.taxGroupId, null);
  // A full tie with untaxed lines resolves to no tax rather than a guess.
  const tied = [taxUsage("code:hst", 3), taxUsage(null, 3)];
  assert.equal(rankPartyTaxUsage(tied)?.taxCodeId, null);
  assert.equal(rankPartyTaxUsage([...tied].reverse())?.taxCodeId, null);
});
