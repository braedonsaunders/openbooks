import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { ApiField, ResolvedApiType } from "./registry-data.ts";

// Clearing a required physical column through PATCH must fail closed with a
// typed field error — never a generic constraint blow-up, and never a silent
// NULL when the column happens to be nullable. Mirrors the repo's writer
// integration-test conventions (hand-built resolved type + fields).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { updateRecord } = await import("./writers.ts");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

const resolved: ResolvedApiType = {
  key: "items",
  table: "items",
  searchColumn: "name",
  readPermission: "items.read",
  writePermission: "items.manage",
  operations: ["list", "get", "create", "update", "delete"],
  writer: { kind: "entity", table: "items" },
  dynamic: false,
  documentKinds: null,
};

const fields: ApiField[] = [
  { name: "kind", type: "string", required: true, writable: true, description: null, custom: false },
  { name: "name", type: "string", required: true, writable: true, description: null, custom: false },
];

test(
  "an entity PATCH that clears a required field fails with a typed field error",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId;
    const user = {
      id: actorId,
      email: "writers-required-clear@scratch.test",
      name: "Writers Required Clear Test",
      roles: [{ key: "admin", name: "Admin" }],
      orgId: org.orgId,
      envKind: "production" as const,
      productionOrgId: org.orgId,
      isSuperAdmin: false,
      homeUserId: actorId,
      homeOrgId: org.orgId,
    };
    const itemId = randomUUID();
    try {
      await withBypass(() => db.execute(sql`
        insert into items (id, org_id, kind, name, created_by, updated_by)
        values (${itemId}, ${org.orgId}, 'service', 'Required clear item', ${actorId}, ${actorId})
      `));

      const result = await withOrgContext(org.orgId, () =>
        updateRecord(user, resolved, fields, itemId, { name: null }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(result.status, 422);
      const body = result.body as { fieldErrors?: { field: string }[] };
      assert.ok(
        (body.fieldErrors ?? []).some((e) => e.field === "name"),
        `expected a typed error naming "name", got ${JSON.stringify(result.body)}`,
      );

      const stored = await withBypass(() =>
        db.execute<{ name: string }>(sql`select name from items where id = ${itemId}`),
      );
      assert.equal(stored.rows[0]?.name, "Required clear item", "stored value untouched");

      // Partial PATCH omitting required fields still succeeds.
      const partial = await withOrgContext(org.orgId, () =>
        updateRecord(user, resolved, fields, itemId, { kind: "service" }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(partial.status, 200);
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
