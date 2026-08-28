import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The writer imports server-only services. Shim the marker package so this
// focused integration suite can load the production module under node:test.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    return nextResolve(specifier, context);
  },
});

const { createApplicationRecord } = await import("../application/records.ts");
const { createRecord } = await import("./writers.ts");
const { db, env, withBypass, withOrgContext } =
  await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
  await import("@openbooks/engine/src/test-fixtures.ts");

test(
  "a rejected custom-record create rolls back its draft and number allocation",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId;
    const typeKey = `writer-${randomUUID().slice(0, 8)}`;
    const typeId = randomUUID();
    const user = {
      id: actorId,
      email: "writers@scratch.test",
      name: "Writers Test",
      roles: [{ key: "admin", name: "Admin" }],
      orgId: org.orgId,
      envKind: "production" as const,
      productionOrgId: org.orgId,
      isSuperAdmin: false,
      homeUserId: actorId,
      homeOrgId: org.orgId,
    };
    const context = {
      authz: { user, permissions: new Set(["*"]), allowedSubsidiaryIds: null },
      source: "api" as const,
      requestId: randomUUID(),
      apiKeyId: null,
    };

    try {
      await withBypass(async () => {
        await db.execute(sql`
          insert into custom_record_types
            (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
          values
            (${typeId}, ${org.orgId}, ${typeKey}, 'Writer Record', 'Writer Records',
             ${JSON.stringify([{ id: "main", fields: [{ id: "name", type: "text", label: "Name" }] }])}::jsonb,
             'published', ${actorId}, ${actorId})
        `);
      });

      await assert.rejects(
        withOrgContext(org.orgId, () =>
          createApplicationRecord(context, {
            typeKey,
            body: { status: "inactive" },
            idempotencyKey: `writer-rejected-${randomUUID()}`,
          }),
        ),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          (error as { status?: unknown }).status === 422,
      );

      const afterRejected = await withBypass(() =>
        db.execute<{
          records: string;
          sequences: string;
        }>(sql`
        select
          (select count(*)::text from custom_records where org_id = ${org.orgId} and type_key = ${typeKey}) as records,
          (select count(*)::text from number_sequences where org_id = ${org.orgId} and document_kind = ${`custrec:${typeKey}`}) as sequences
      `),
      );
      assert.deepEqual(afterRejected.rows[0], { records: "0", sequences: "0" });

      const created = await withOrgContext(org.orgId, () =>
        createApplicationRecord(context, {
          typeKey,
          body: { status: "active", data: { name: "accepted" } },
          idempotencyKey: `writer-accepted-${randomUUID()}`,
        }),
      );
      assert.equal(created.status, 201);
      const payload = created.result as {
        record: { record_number: string; status: string };
      };
      assert.equal(payload.record.status, "active");
      assert.equal(payload.record.record_number, "WRI-00001");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "an entity writer rejects custom fields outside the actor's allowed roles",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const actorId = (await withBypass(() => seedFlowActors(org.orgId)))
      .outsiderId;
    const fieldId = randomUUID();
    const user = {
      id: actorId,
      email: "writers-permissions@scratch.test",
      name: "Writers Permissions Test",
      roles: [{ key: "viewer", name: "Viewer" }],
      orgId: org.orgId,
      envKind: "production" as const,
      productionOrgId: org.orgId,
      isSuperAdmin: false,
      homeUserId: actorId,
      homeOrgId: org.orgId,
    };

    try {
      await withBypass(() =>
        db.execute(sql`
          insert into custom_field_defs
            (id, org_id, target_table, key, label, field_type, config, is_active, created_by, updated_by)
          values
            (${fieldId}, ${org.orgId}, 'items', 'secret', 'Secret', 'text',
             '{"allowedRoles":["manager"]}'::jsonb, true, ${actorId}, ${actorId})
        `),
      );

      const result = await withOrgContext(org.orgId, () =>
        createRecord(
          user,
          {
            key: "items",
            table: "items",
            searchColumn: "name",
            readPermission: "items.read",
            writePermission: "items.manage",
            operations: ["list", "get", "create", "update", "delete"],
            writer: { kind: "entity", table: "items" },
            dynamic: false,
            documentKinds: null,
          },
          [
            {
              name: "kind",
              type: "string",
              required: true,
              writable: true,
              description: null,
              custom: false,
            },
            {
              name: "name",
              type: "string",
              required: true,
              writable: true,
              description: null,
              custom: false,
            },
            {
              name: "cf_secret",
              type: "string",
              required: false,
              writable: true,
              description: "Secret",
              custom: true,
            },
          ],
          { kind: "service", name: "should-not-exist", cf_secret: "hidden" },
          { allowedSubsidiaryIds: null },
        ),
      );
      assert.equal(result.status, 403);

      const rows = await withBypass(() =>
        db.execute<{ count: string }>(sql`
          select count(*)::text as count from items where org_id = ${org.orgId} and name = 'should-not-exist'
        `),
      );
      assert.equal(rows.rows[0]?.count, "0");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
