import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * PSP reversal presence-checks reversalDate but never checks calendar
 * reality — so a September 31 sails through every named check into the
 * period lookup's ::date comparisons, dies in Postgres, and surfaces the
 * raw driver failure as the 500 body instead of failing closed with a
 * named error and nothing written.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __pspReverseBoundState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function getAuthz() {
          const s = globalThis.__pspReverseBoundState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
        export function can() { return true }
        export function guardSubsidiaryScope() { return null }
      `);
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { importSettlementBatch, postSettlementBatch } = await import("@openbooks/engine/src/payments/psp-settlement.ts");
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

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
  await withBypassContext(() => postSettlementBatch(org.orgId, batchId, actor));
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

async function batchStatus(orgId: string, batchId: string): Promise<string> {
  const rows = (await withBypassContext(() =>
    db.execute<{ status: string }>(
      sql`select status from psp_settlement_batches where org_id = ${orgId} and id = ${batchId}`,
    ))).rows;
  return rows[0]!.status;
}

test("psp reversal refuses a non-calendar reversal date without writing", { skip: !DB }, async () => {
  const { orgId, batchId } = await fixture();
  try {
    const response = await post(batchId, "2026-09-31");
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /invalid input syntax|Failed query/i);
    assert.equal(await batchStatus(orgId, batchId), "posted");
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("psp reversal still reverses on an ordinary date", { skip: !DB }, async () => {
  const { orgId, batchId, date } = await fixture();
  try {
    const response = await post(batchId, date);
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await batchStatus(orgId, batchId), "void");
  } finally {
    await dropScratchOrg(orgId);
  }
});
