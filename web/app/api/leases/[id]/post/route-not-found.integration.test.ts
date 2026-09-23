import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Posting schedules for a valid-but-unknown lease id answered 200 with
// posted: 0 — indistinguishable from a successful empty run for a lease
// that is gone or belongs to another tenant. Unknown ids are now a 404;
// known leases with nothing due still answer 200.
const root = pathToFileURL(process.cwd() + "/").href;
const state: { orgId: string; actorId: string } = { orgId: "", actorId: "" };
Object.assign(globalThis, { __leasePostNotFoundState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "@/lib/feature-gates") return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__leasePostNotFoundState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `);
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { createLeaseAgreement } = await import("@openbooks/engine/src/revenue/leases.ts");
const { POST } = await import("./route.ts");

function post(id: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return withOrgContext(state.orgId, async () => {
    const response: Response = await POST(
      new Request(`http://leases.test/api/leases/${id}/post`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
    return { status: response.status, json: (await response.json().catch(() => null)) as Record<string, unknown> };
  });
}

test("posting a valid-but-unknown lease id is a 404, not an empty success", async () => {
  const org = await createScratchOrg();
  state.orgId = org.orgId;
  state.actorId = randomUUID();
  try {
    const missing = await post(randomUUID(), { asOfDate: "2026-07-31" });
    assert.equal(missing.status, 404, JSON.stringify(missing.json));
    assert.match(String(missing.json.error), /lease not found/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("posting a known lease with nothing due still answers 200", async () => {
  const org = await createScratchOrg();
  state.orgId = org.orgId;
  state.actorId = randomUUID();
  try {
    const one = randomUUID();
    const { leaseId } = await createLeaseAgreement(org.orgId, null, {
      subsidiaryId: org.subsidiaryId,
      leaseNumber: "L-POST-404",
      commencementOn: "2026-07-01",
      termPeriods: 3,
      paymentFrequency: "monthly",
      paymentAmount: "1000",
      annualDiscountRatePercent: "6",
      classificationInputs: { transfersOwnership: true },
      accounts: {
        rouAsset: one,
        leaseLiability: one,
        interestExpense: one,
        amortizationExpense: one,
        leaseExpense: one,
        payment: one,
      },
    });
    // Draft lease, nothing commenced: nothing due, empty run.
    const result = await post(leaseId, { asOfDate: "2026-07-31" });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.equal(result.json.posted, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
