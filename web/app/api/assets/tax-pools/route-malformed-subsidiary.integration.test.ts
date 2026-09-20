import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Tax-pool POST resolves an explicit subsidiaryId with a bare
// `where id = ${requestedSubsidiaryId}` and no UUID gate: an unrestricted
// caller passing a malformed id trips a raw Postgres 22P02 that escapes as
// HTTP 500 instead of the tenant-opaque 404 the unknown-id control below
// already returns. Same malformed-id class as the setup/[entity] and close
// fixes. Only the gates are stubbed; handler and storage are real.

const state = {
  gate: {
    user: { orgId: "", id: "" },
    permissions: new Set<string>(["*"]),
    allowedSubsidiaryIds: null as null,
  },
};
Object.assign(globalThis, { __taxPoolFlagsGate: state });
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (
      (specifier.endsWith("/lib/feature-gates") || specifier.endsWith("/lib/authz")) &&
      context.parentURL?.includes("/api/assets/tax-pools/")
    ) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardFeaturePermission(){return globalThis.__taxPoolFlagsGate.gate} " +
              "export function guardSubsidiaryScope(gate,id){ " +
              "if(gate.allowedSubsidiaryIds===null)return null; " +
              "if(id&&gate.allowedSubsidiaryIds.has(id))return null; " +
              "return new Response(JSON.stringify({error:'not found'}),{status:404}) }",
          ),
      };
    }
    if (specifier.startsWith("@/")) return next(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    return next(specifier, context);
  },
});
const { POST } = await import("./route");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
hooks.deregister();

const request = (body: unknown) =>
  new Request("http://taxpool.local/api/assets/tax-pools", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("tax-pool POST maps a malformed subsidiaryId to 404 before SQL", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    state.gate.user = { orgId: org.orgId, id: (await seedFlowActors(org.orgId)).adminId };
    const malformed = await POST(request({ regime: "ca_cca", taxYear: 2026, subsidiaryId: "not-a-uuid" }));
    assert.equal(malformed.status, 404, `expected 404, got ${malformed.status}: ${await malformed.text()}`);

    // Control: a well-formed but unknown id keeps its existing 404 contract.
    const unknown = await POST(
      request({ regime: "ca_cca", taxYear: 2026, subsidiaryId: "11111111-2222-4333-8444-555555555555" }),
    );
    assert.equal(unknown.status, 404, `expected 404, got ${unknown.status}: ${await unknown.text()}`);
  } finally {
    state.gate.user = { orgId: "", id: "" };
    await dropScratchOrg(org.orgId);
  }
});
