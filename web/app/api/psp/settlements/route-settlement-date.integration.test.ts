import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * PAY-04 (route face): an impossible settlementDate on import must surface
 * the named PspSettlementError as HTTP 422 — never the raw Postgres cast
 * failure as a 500. The real provider parser and the real import boundary
 * run here; only authn/authz and feature flags are stubbed.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __pspSettlementDateRouteState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function getAuthz() {
          const s = globalThis.__pspSettlementDateRouteState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['banking.reconcile']), allowedSubsidiaryIds: null };
        }
        export function can() { return true }
        export function guardSubsidiaryScope() { return null }
        export function guardUnrestrictedScope() { return null }
      `);
    if (specifier.endsWith("/lib/features"))
      return virtual(`
        export async function isFeatureEnabled() { return true }
        export async function subsidiaryFeatureEnabled() { return false }
      `);
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actor = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actor;
  return { orgId: org.orgId, date: org.date };
}

const postImport = (externalRef: string, settlementDate: string) =>
  withOrgContext(state.orgId, () =>
    POST(
      new Request("http://psp.test/api/psp/settlements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "import",
          provider: "stripe",
          externalRef,
          settlementDate,
          transactions: [{ id: "ch_route_date", type: "charge", amount: 10000, currency: "CAD" }],
        }),
      }),
    ),
  );

async function batchCount(orgId: string, externalRef: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: string }>(
      sql`select count(*)::text as n from psp_settlement_batches where org_id = ${orgId} and external_ref = ${externalRef}`,
    ))).rows;
  return Number(rows[0]!.n);
}

test("psp import maps an impossible settlement date to 422 with nothing written", { skip: !DB }, async () => {
  const { orgId } = await fixture();
  try {
    const externalRef = `payout-route-bad-${orgId}`;
    const response = await postImport(externalRef, "2023-02-30");
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /settlement date must be a real calendar date \(YYYY-MM-DD\)/);
    assert.doesNotMatch(json?.error ?? "", /invalid input syntax|Failed query/i);
    assert.equal(await batchCount(orgId, externalRef), 0);
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("psp import still accepts a real calendar date", { skip: !DB }, async () => {
  const { orgId, date } = await fixture();
  try {
    const response = await postImport(`payout-route-good-${orgId}`, date);
    const json = (await response.json().catch(() => null)) as { batchId?: string } | null;
    assert.equal(response.status, 200, JSON.stringify(json));
    assert.ok(json?.batchId, "expected a draft batch id");
  } finally {
    await dropScratchOrg(orgId);
  }
});
