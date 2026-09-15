import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { ApiField, ResolvedApiType } from "./registry-data.ts";

// Native uuid columns on v1 entity writes ride the same uncast path the
// document line refs once did: a malformed id dies at storage as 22P02 and a
// foreign-org id dies at the tenant-coherent composite FK as 23503 — both
// surfacing as an untyped 422 leaking SQL text. Worse, single-column FKs
// (items.recognition_rule_id) are tenant-INCOHERENT: a foreign-org id passes
// the constraint and persists as a silent cross-tenant link with a 200.
// Every supplied native reference must be shape-checked (typed 422) and
// ownership-checked (tenant-opaque 404) before storage, mirroring the
// document header/line-ref fences.
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

// Mirrors the live registry output for these columns (pgTypeToOpenApi:
// uuid → "string (uuid)").
const fields: ApiField[] = [
  { name: "kind", type: "string", required: true, writable: true, description: null, custom: false },
  { name: "name", type: "string", required: true, writable: true, description: null, custom: false },
  { name: "income_account_id", type: "string (uuid)", required: false, writable: true, description: null, custom: false },
  { name: "recognition_rule_id", type: "string (uuid)", required: false, writable: true, description: null, custom: false },
];

function userFor(orgId: string, actorId: string) {
  return {
    id: actorId,
    email: "writers-native-refs@scratch.test",
    name: "Writers Native Refs Test",
    roles: [{ key: "admin", name: "Admin" }],
    orgId,
    envKind: "production" as const,
    productionOrgId: orgId,
    isSuperAdmin: false,
    homeUserId: actorId,
    homeOrgId: orgId,
  };
}

test(
  "entity writes refuse malformed and foreign native reference ids with typed errors",
  { skip: !DB },
  async () => {
    const orgA = await withBypass(() => createScratchOrg());
    const orgB = await withBypass(() => createScratchOrg());
    const actorId = (await withBypass(() => seedFlowActors(orgA.orgId))).adminId;
    const user = userFor(orgA.orgId, actorId);
    try {
      const itemId = randomUUID();
      await withBypass(() => db.execute(sql`
        insert into items (id, org_id, kind, name, created_by, updated_by)
        values (${itemId}, ${orgA.orgId}, 'service', 'Native ref item', ${actorId}, ${actorId})
      `));
      interface StoredRefs { income: string | null; rule: string | null }
      const stored = async (): Promise<StoredRefs | undefined> =>
        (await withBypass(() => db.execute(
          sql`select income_account_id as income, recognition_rule_id as rule from items where id = ${itemId}`,
        )) as unknown as { rows: StoredRefs[] }).rows[0];

      // Malformed uuid fails closed with a typed field error, never SQL text.
      const malformed = await withOrgContext(orgA.orgId, () =>
        updateRecord(user, resolved, fields, itemId, { income_account_id: "not-a-uuid" }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(malformed.status, 422, `expected 422, got ${malformed.status}: ${JSON.stringify(malformed.body)}`);
      const malformedBody = malformed.body as { fieldErrors?: { field: string }[] };
      assert.ok(
        (malformedBody.fieldErrors ?? []).some((e) => e.field === "income_account_id"),
        `expected a typed error naming income_account_id, got ${JSON.stringify(malformed.body)}`,
      );

      // Foreign-org id behind a composite FK: tenant-opaque 404, nothing stored.
      const foreignComposite = await withOrgContext(orgA.orgId, () =>
        updateRecord(user, resolved, fields, itemId, { income_account_id: orgB.accounts.revenue }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(
        foreignComposite.status,
        404,
        `expected tenant-opaque 404, got ${foreignComposite.status}: ${JSON.stringify(foreignComposite.body)}`,
      );
      assert.equal((await stored())?.income, null, "refused composite reference stores nothing");

      // Foreign-org id behind a tenant-incoherent single-column FK: 404, nothing stored.
      const foreignSingle = await withOrgContext(orgA.orgId, () =>
        updateRecord(user, resolved, fields, itemId, { recognition_rule_id: orgB.recognitionRuleId }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(
        foreignSingle.status,
        404,
        `expected tenant-opaque 404, got ${foreignSingle.status}: ${JSON.stringify(foreignSingle.body)}`,
      );
      assert.equal((await stored())?.rule, null, "refused single-column reference stores nothing");

      // CREATE with a foreign single-column reference fails the same way.
      const refusedCreate = await withOrgContext(orgA.orgId, () =>
        createRecord(user, resolved, fields, {
          kind: "service",
          name: "Foreign native ref item",
          recognition_rule_id: orgB.recognitionRuleId,
        }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(
        refusedCreate.status,
        404,
        `expected tenant-opaque 404, got ${refusedCreate.status}: ${JSON.stringify(refusedCreate.body)}`,
      );

      // Own-org references still save on both paths.
      const okUpdate = await withOrgContext(orgA.orgId, () =>
        updateRecord(user, resolved, fields, itemId, {
          income_account_id: orgA.accounts.revenue,
          recognition_rule_id: orgA.recognitionRuleId,
        }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(okUpdate.status, 200, `expected 200, got ${okUpdate.status}: ${JSON.stringify(okUpdate.body)}`);
      const after = await stored();
      assert.equal(after?.income, orgA.accounts.revenue);
      assert.equal(after?.rule, orgA.recognitionRuleId);
    } finally {
      await withBypass(() => dropScratchOrg(orgA.orgId));
      await withBypass(() => dropScratchOrg(orgB.orgId));
    }
  },
);
