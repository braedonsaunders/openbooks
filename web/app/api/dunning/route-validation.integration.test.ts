import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Dunning policy writes must validate what they store. POST required a
 * non-empty name but stored any gracePeriodDays — a non-numeric value only
 * failed later as an unhandled storage error (500), and a negative or
 * fractional value was stored. PATCH skipped even the name check, so an empty
 * name silently replaced the policy ladder's title.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __dunningValidationUser: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/dunning/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardPermission(){return {user:globalThis.__dunningValidationUser.user,permissions:new Set(['documents.manage']),allowedSubsidiaryIds:null}}",
          ),
      };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext } = await import("@openbooks/engine/src/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/test-fixtures.ts");
const { POST: create } = await import("./route");
const { PATCH: patch } = await import("./[id]/route");

const json = (method: string, body?: unknown) =>
  new Request("http://audit.local/api/dunning", { method, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function policyRow(orgId: string, id: string): Promise<{ name: string; grace: number } | undefined> {
  const r = await withBypassContext(() =>
    db.execute<{ name: string; grace: number }>(
      sql`select name, grace_period_days as grace from dunning_policies where id = ${id} and org_id = ${orgId}`,
    ),
  );
  return r.rows[0];
}

test("dunning writes reject an invalid grace period or an empty name", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };

    // gracePeriodDays is stored into an integer column: non-numeric input must
    // be a 4xx, never an unhandled storage error, and negative or fractional
    // values must not be stored.
    for (const gracePeriodDays of ["abc", true, 1.5, -5]) {
      const refused = await create(json("POST", { name: "Chase", gracePeriodDays, stages: [] }));
      assert.equal(refused.status, 400, `POST gracePeriodDays ${JSON.stringify(gracePeriodDays)}`);
    }
    const count = await withBypassContext(() =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from dunning_policies where org_id = ${org.orgId}`),
    );
    assert.equal(count.rows[0]!.n, 0, "a refused policy must not be created");

    const created = await create(json("POST", { name: "Collections", gracePeriodDays: 3, stages: [] }));
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    const { id } = (await created.json()) as { id: string };

    // PATCH enforces the same contracts: the name POST requires, and a
    // storable grace period.
    for (const gracePeriodDays of ["abc", 2.5, -1]) {
      const refused = await patch(json("PATCH", { gracePeriodDays }), params(id));
      assert.equal(refused.status, 400, `PATCH gracePeriodDays ${JSON.stringify(gracePeriodDays)}`);
    }
    for (const name of ["", "   ", 7]) {
      const refused = await patch(json("PATCH", { name }), params(id));
      assert.equal(refused.status, 400, `PATCH name ${JSON.stringify(name)}`);
    }
    assert.deepEqual(await policyRow(org.orgId, id), { name: "Collections", grace: 3 });

    // Controls: valid values still write on both paths.
    const renamed = await patch(json("PATCH", { name: "Collections (AR)", gracePeriodDays: 0 }), params(id));
    assert.equal(renamed.status, 200, JSON.stringify(await renamed.clone().json()));
    assert.deepEqual(await policyRow(org.orgId, id), { name: "Collections (AR)", grace: 0 });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
