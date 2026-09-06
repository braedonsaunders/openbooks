import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Dunning policy routes: a malformed policy id must be a clean 404 (never a
 * Postgres uuid cast error surfacing as a 500), and `appliesToKind` may only
 * name a dunnable receivable kind — the runner selects documents by that kind
 * and mails the counterparty, so a payable kind would dun vendors.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __dunningRouteUser: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/dunning/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardPermission(){return {user:globalThis.__dunningRouteUser.user,permissions:new Set(['documents.manage']),allowedSubsidiaryIds:null}}",
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
const { PATCH: patch, DELETE: remove } = await import("./[id]/route");

const json = (method: string, body?: unknown) =>
  new Request("http://audit.local/api/dunning", { method, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function policyKind(orgId: string, id: string): Promise<string | undefined> {
  const r = await withBypassContext(() =>
    db.execute<{ kind: string }>(sql`select applies_to_kind as kind from dunning_policies where id = ${id} and org_id = ${orgId}`),
  );
  return r.rows[0]?.kind;
}

test("dunning [id] routes return 404 for a malformed policy id", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    for (const id of ["not-a-uuid", "new", "00000000-0000-0000-0000-00000000000"]) {
      const patched = await patch(json("PATCH", { name: "Renamed" }), params(id));
      assert.equal(patched.status, 404, `PATCH ${id}`);
      assert.deepEqual(await patched.json(), { error: "not found" });
      const deleted = await remove(json("DELETE"), params(id));
      assert.equal(deleted.status, 404, `DELETE ${id}`);
      assert.deepEqual(await deleted.json(), { error: "not found" });
    }
    // A well-formed id that names nothing keeps the sibling's not-found shape.
    const missing = await patch(json("PATCH", { name: "Renamed" }), params(randomUUID()));
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not found" });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("dunning policies only apply to dunnable receivable kinds", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    for (const appliesToKind of ["vendor_bill", "customer_credit", "journal_entry", "", 7, null]) {
      const refused = await create(json("POST", { name: "Chase", appliesToKind, stages: [] }));
      assert.equal(refused.status, 422, `POST appliesToKind ${JSON.stringify(appliesToKind)}`);
    }
    const count = await withBypassContext(() =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from dunning_policies where org_id = ${org.orgId}`),
    );
    assert.equal(count.rows[0]!.n, 0, "a refused policy must not be created");

    // Omitted defaults to the receivable kind; explicit receivable kinds pass.
    const created = await create(json("POST", { name: "Collections", stages: [] }));
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    const { id } = (await created.json()) as { id: string };
    assert.equal(await policyKind(org.orgId, id), "customer_invoice");

    for (const appliesToKind of ["vendor_bill", "customer_credit", 7, null]) {
      const refused = await patch(json("PATCH", { appliesToKind }), params(id));
      assert.equal(refused.status, 422, `PATCH appliesToKind ${JSON.stringify(appliesToKind)}`);
    }
    assert.equal(await policyKind(org.orgId, id), "customer_invoice", "a refused patch must not change the policy");
    const accepted = await patch(json("PATCH", { appliesToKind: "customer_invoice", name: "Collections (AR)" }), params(id));
    assert.equal(accepted.status, 200);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
