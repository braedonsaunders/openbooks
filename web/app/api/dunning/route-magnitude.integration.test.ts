import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Dunning integers live in int4 columns and min_balance in numeric(19,4).
 * Number.isInteger admits any magnitude, so pasted 10-digit day counts and
 * 20-digit balances passed validation and died in Postgres as unhandled
 * storage errors (500). All must refuse as 400 with nothing written.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __dunningMagnitudeUser: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/dunning/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardPermission(){return {user:globalThis.__dunningMagnitudeUser.user,permissions:new Set(['documents.manage']),allowedSubsidiaryIds:null}}",
          ),
      };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    // Pin the engine to THIS checkout: the environment shares node_modules
    // with the main checkout, so an unmapped @openbooks/engine import would
    // silently exercise main's engine instead of the branch under test.
    if (specifier.startsWith("@openbooks/engine/")) return next(root + specifier.slice("@openbooks/".length), context);
    return next(specifier, context);
  },
});
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { POST: create } = await import("./route");
const { PATCH: patch } = await import("./[id]/route");

const json = (method: string, body?: unknown) =>
  new Request("http://audit.local/api/dunning", { method, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const stage = (override: Record<string, unknown> = {}) => ({
  sequence: 1,
  name: "Nudge",
  offsetDays: 7,
  subjectTemplate: "s",
  bodyTemplate: "b",
  ...override,
});

async function counts(orgId: string) {
  const policies = await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from dunning_policies where org_id = ${orgId}`),
  );
  const stages = await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from dunning_stages where org_id = ${orgId}`),
  );
  return { policies: policies.rows[0]!.n, stages: stages.rows[0]!.n };
}

test("dunning writes refuse magnitudes the integer and money columns cannot hold", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };

    const bad = [
      ["oversized grace days", { name: "Chase", gracePeriodDays: 9999999999, stages: [] }],
      ["oversized stage offset", { name: "Chase", stages: [stage({ offsetDays: 9999999999 })] }],
      ["oversized stage sequence", { name: "Chase", stages: [stage({ sequence: 9999999999 })] }],
      ["oversized min balance", { name: "Chase", minBalance: "99999999999999999999999", stages: [] }],
    ] as const;
    for (const [label, body] of bad) {
      const refused = await create(json("POST", body));
      assert.equal(refused.status, 400, `${label}: expected 400, got ${refused.status}: ${JSON.stringify(await refused.clone().json().catch(() => null))}`);
    }
    assert.deepEqual(await counts(org.orgId), { policies: 0, stages: 0 }, "refused policies must write nothing");

    // The column maximums still store.
    const ok = await create(json("POST", { name: "Max", gracePeriodDays: 2147483647, minBalance: "999999999999999.9999", stages: [stage({ sequence: 2147483647, offsetDays: -2147483648 })] }));
    assert.equal(ok.status, 201, `column maximums must store, got ${ok.status}: ${JSON.stringify(await ok.clone().json().catch(() => null))}`);
    const policyId = (await ok.json() as { id: string }).id;

    // PATCH enforces the same bounds on the way back in.
    const repatch = await patch(json("PATCH", { gracePeriodDays: 9999999999 }), params(policyId));
    assert.equal(repatch.status, 400, `PATCH oversized grace: expected 400, got ${repatch.status}`);
    const restage = await patch(json("PATCH", { stages: [stage({ offsetDays: 9999999999 })] }), params(policyId));
    assert.equal(restage.status, 400, `PATCH oversized offset: expected 400, got ${restage.status}`);
    const remin = await patch(json("PATCH", { minBalance: "99999999999999999999999" }), params(policyId));
    assert.equal(remin.status, 400, `PATCH oversized minBalance: expected 400, got ${remin.status}`);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
