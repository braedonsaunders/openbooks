import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

/**
 * PSP reversal validates reversalDate calendar reality at the shared JSON
 * boundary (isoDate refuses impossible days with a named field issue), so a
 * September 31 fails closed as a 400 before the handler's period lookup —
 * never as a raw driver 500 — with the batch still posted and no reversal
 * journal written.
 */
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __pspReverseBoundState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function getAuthz() {
          const s = globalThis.__pspReverseBoundState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
        export function can() { return true }
        export function guardSubsidiaryScope() { return null }
        export function guardUnrestrictedScope() { return null }
      `);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { importSettlementBatch, postSettlementBatch } = await import("@openbooks/engine/src/payments/psp-settlement.ts");
const { POST } = await import("./route.ts");

async function fixture(): Promise<{ orgId: string; batchId: string; date: string }> {
  const org = await withBypassContext(() => createScratchOrg());
  const actor = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actor;
  await withBypassContext(() =>
    db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,banking}', 'true'::jsonb, true) where id = ${org.orgId}`),
  );
  const parsed = {
    provider: "stripe",
    externalRef: `payout-${org.orgId}`,
    settlementDate: org.date,
    currency: "CAD",
    memo: "PSP reversal bounds probe",
    raw: { source: "integration-test", immutable: true },
    lines: [
      { kind: "charge", amount: "200.0000", currency: "CAD", externalRef: "charge-1" },
      { kind: "fee", amount: "6.0000", currency: "CAD", externalRef: "fee-1" },
    ],
  } as const;
  const accounts = {
    bankAccountId: org.accounts.bank,
    feeAccountId: org.accounts.freight,
    disputeAccountId: org.accounts.adjustment,
    fxAccountId: org.accounts.fxGainLoss,
    clearingAccountId: org.accounts.clearing,
    subsidiaryId: org.subsidiaryId,
  };
  const { batchId } = await withBypassContext(() =>
    importSettlementBatch(org.orgId, actor, parsed as never, accounts),
  );
  await withBypassContext(() => postSettlementBatch(org.orgId, batchId, actor, null));
  return { orgId: org.orgId, batchId, date: org.date };
}

const post = (batchId: string, reversalDate: string) =>
  withOrgContext(state.orgId, () =>
    POST(
      new Request("http://psp.test/api/psp/settlements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "reverse",
          batchId,
          reversalDate,
          reason: "Provider confirmed payout cancellation",
        }),
      }),
    ),
  );

async function batchState(orgId: string, batchId: string): Promise<{ status: string; reversalEntryId: string | null }> {
  const rows = (await withBypassContext(() =>
    db.execute<{ status: string; reversalEntryId: string | null }>(
      sql`select status, reversal_entry_id as "reversalEntryId" from psp_settlement_batches where org_id = ${orgId} and id = ${batchId}`,
    ))).rows;
  return { status: rows[0]!.status, reversalEntryId: rows[0]!.reversalEntryId };
}

async function journalCount(orgId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: string }>(
      sql`select count(*) as n from journal_entries where org_id = ${orgId}`,
    ))).rows;
  return Number(rows[0]!.n);
}

test("psp reversal refuses a non-calendar reversal date without writing", async () => {
  const { orgId, batchId } = await fixture();
  try {
    const journalsBefore = await journalCount(orgId);
    const response = await post(batchId, "2026-09-31");
    const json = (await response.json().catch(() => null)) as { error?: string; issues?: Array<{ path?: string; message?: string }> } | null;
    assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /calendar date/, "the refusal names calendar reality");
    assert.equal(json?.issues?.[0]?.path, "reversalDate", "the refusal names the offending field, not a blanket body error");
    assert.doesNotMatch(json?.error ?? "", /invalid input syntax|Failed query/i);
    const after = await batchState(orgId, batchId);
    assert.equal(after.status, "posted", "the batch remains posted");
    assert.equal(after.reversalEntryId, null, "no reversal entry attaches");
    assert.equal(await journalCount(orgId), journalsBefore, "no reversal journal writes");
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("psp reversal still reverses on an ordinary date", async () => {
  const { orgId, batchId, date } = await fixture();
  try {
    const response = await post(batchId, date);
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.equal((await batchState(orgId, batchId)).status, "void");
  } finally {
    await dropScratchOrg(orgId);
  }
});
