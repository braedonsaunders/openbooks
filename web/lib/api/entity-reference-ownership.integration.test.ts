import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { ApiField, ResolvedApiType } from "./registry-data.ts";

// A `reference`-type custom field is shape-checked (uuid syntax) but nothing
// proves the referenced row belongs to the caller's organization: the v1
// records entity writer persists a foreign-org (or dangling) uuid blind into
// the tenant jsonb bag. The master-data import path resolves the same fields
// through an org-scoped resolver and refuses unknown ids — the API writer
// must fail closed the same way, with a tenant-opaque 404.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { createRecord, updateRecord } = await import("./writers.ts");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
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
  { name: "cf_ref_party", type: "string", required: false, writable: true, description: null, custom: true },
];

function userFor(orgId: string, actorId: string) {
  return {
    id: actorId,
    email: "writers-reference-ownership@scratch.test",
    name: "Writers Reference Ownership Test",
    roles: [{ key: "admin", name: "Admin" }],
    orgId,
    envKind: "production" as const,
    productionOrgId: orgId,
    isSuperAdmin: false,
    homeUserId: actorId,
    homeOrgId: orgId,
  };
}

async function seedReferenceDef(orgId: string, actorId: string) {
  await withBypass(() => db.execute(sql`
    insert into custom_field_defs
      (id, org_id, target_table, target_kind, key, label, field_type, config, is_required, is_active, created_by, updated_by)
    values
      (${randomUUID()}, ${orgId}, 'items', null, 'ref_party', 'Reference party', 'reference', '{"referenceTable":"parties"}'::jsonb, false, true, ${actorId}, ${actorId})
  `));
}

test(
  "entity writes refuse reference custom values owned by another organization",
  { skip: !DB },
  async () => {
    const orgA = await withBypass(() => createScratchOrg());
    const orgB = await withBypass(() => createScratchOrg());
    const actorId = (await withBypass(() => seedFlowActors(orgA.orgId))).adminId;
    const user = userFor(orgA.orgId, actorId);
    try {
      await seedReferenceDef(orgA.orgId, actorId);
      const foreign = orgB.vendorId;
      const own = orgA.vendorId;

      // CREATE with a foreign-org reference must fail closed.
      const refusedCreate = await withOrgContext(orgA.orgId, () =>
        createRecord(user, resolved, fields, {
          kind: "service",
          name: "Foreign ref item",
          cf_ref_party: foreign,
        }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(
        refusedCreate.status,
        404,
        `expected tenant-opaque 404, got ${refusedCreate.status}: ${JSON.stringify(refusedCreate.body)}`,
      );
      const created = await withBypass(() =>
        db.execute<{ n: number }>(sql`select count(*)::int as n from items where org_id = ${orgA.orgId} and name = 'Foreign ref item'`),
      );
      assert.equal(created.rows[0]?.n ?? -1, 0, "refused create stores nothing");

      // CREATE with a dangling uuid must fail closed too.
      const dangling = await withOrgContext(orgA.orgId, () =>
        createRecord(user, resolved, fields, {
          kind: "service",
          name: "Dangling ref item",
          cf_ref_party: randomUUID(),
        }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(
        dangling.status,
        404,
        `expected tenant-opaque 404, got ${dangling.status}: ${JSON.stringify(dangling.body)}`,
      );

      // CREATE with an own-org reference still succeeds.
      const okCreate = await withOrgContext(orgA.orgId, () =>
        createRecord(user, resolved, fields, {
          kind: "service",
          name: "Owned ref item",
          cf_ref_party: own,
        }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(okCreate.status, 201, `expected 201, got ${okCreate.status}: ${JSON.stringify(okCreate.body)}`);
      const itemId = (okCreate.body as { id: string }).id;

      // UPDATE swapping in a foreign-org reference must fail closed.
      const refusedUpdate = await withOrgContext(orgA.orgId, () =>
        updateRecord(user, resolved, fields, itemId, { cf_ref_party: foreign }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(
        refusedUpdate.status,
        404,
        `expected tenant-opaque 404, got ${refusedUpdate.status}: ${JSON.stringify(refusedUpdate.body)}`,
      );
      const stored = await withBypass(() =>
        db.execute<{ custom: Record<string, unknown> }>(sql`select custom from items where id = ${itemId}`),
      );
      assert.equal(
        (stored.rows[0]?.custom as Record<string, unknown> | undefined)?.ref_party,
        own,
        "refused update leaves the stored reference untouched",
      );

      // UPDATE with an own-org reference still succeeds.
      const okUpdate = await withOrgContext(orgA.orgId, () =>
        updateRecord(user, resolved, fields, itemId, { cf_ref_party: orgA.customerId }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(okUpdate.status, 200, `expected 200, got ${okUpdate.status}: ${JSON.stringify(okUpdate.body)}`);
    } finally {
      await withBypass(() => dropScratchOrg(orgA.orgId));
      await withBypass(() => dropScratchOrg(orgB.orgId));
    }
  },
);
