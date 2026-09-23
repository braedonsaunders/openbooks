import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { ApiField, ResolvedApiType } from "./registry-data.ts";

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
const { createRecord, updateRecord, deleteRecord } = await import("./writers.ts");
const { db, env, withBypass, withOrgContext } =
  await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
  await import("@openbooks/engine/src/testing/fixtures.ts");

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

test(
  "an entity PATCH validates supplied custom fields without re-requiring omitted required fields",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId;
    const requiredId = randomUUID();
    const optionalId = randomUUID();
    const itemId = randomUUID();
    const user = {
      id: actorId,
      email: "writers-partial-patch@scratch.test",
      name: "Writers Partial Patch Test",
      roles: [{ key: "admin", name: "Admin" }],
      orgId: org.orgId,
      envKind: "production" as const,
      productionOrgId: org.orgId,
      isSuperAdmin: false,
      homeUserId: actorId,
      homeOrgId: org.orgId,
    };
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
      { name: "cf_required_code", type: "string", required: true, writable: true, description: "Required code", custom: true },
      { name: "cf_optional_note", type: "string", required: false, writable: true, description: "Optional note", custom: true },
    ];

    try {
      await withBypass(() => db.execute(sql`
        insert into custom_field_defs
          (id, org_id, target_table, key, label, field_type, config, is_required, is_active, created_by, updated_by)
        values
          (${requiredId}, ${org.orgId}, 'items', 'required_code', 'Required code', 'text', '{}'::jsonb, true, true, ${actorId}, ${actorId}),
          (${optionalId}, ${org.orgId}, 'items', 'optional_note', 'Optional note', 'text', '{}'::jsonb, false, true, ${actorId}, ${actorId})
      `));
      await withBypass(() => db.execute(sql`
        insert into items (id, org_id, kind, name, custom, created_by, updated_by)
        values (${itemId}, ${org.orgId}, 'service', 'Partial patch item', '{"required_code":"R-1"}'::jsonb, ${actorId}, ${actorId})
      `));

      const result = await withOrgContext(org.orgId, () =>
        updateRecord(
          user,
          resolved,
          fields,
          itemId,
          { cf_optional_note: "updated" },
          { allowedSubsidiaryIds: null },
        ),
      );
      assert.equal(result.status, 200);
      const stored = await withBypass(() =>
        db.execute<{ custom: Record<string, unknown> }>(sql`
          select custom from items where id = ${itemId} and org_id = ${org.orgId}
        `),
      );
      assert.deepEqual(stored.rows[0]?.custom, { required_code: "R-1", optional_note: "updated" });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "custom-record writes through the shared writer leave audit evidence",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId;
    const typeKey = `audit-${randomUUID().slice(0, 8)}`;
    const typeId = randomUUID();
    const user = {
      id: actorId,
      email: "writers-audit@scratch.test",
      name: "Writers Audit Test",
      roles: [{ key: "admin", name: "Admin" }],
      orgId: org.orgId,
      envKind: "production" as const,
      productionOrgId: org.orgId,
      isSuperAdmin: false,
      homeUserId: actorId,
      homeOrgId: org.orgId,
    };
    const resolved: ResolvedApiType = {
      key: typeKey,
      table: "custom_records",
      searchColumn: "search_text",
      readPermission: "records.read",
      writePermission: "records.create",
      operations: ["list", "get", "create", "update", "delete"],
      writer: { kind: "custom_record" },
      dynamic: true,
      documentKinds: null,
    };
    const fields: ApiField[] = [];
    const auditRows = () =>
      withBypass(() =>
        db.execute<{
          action: string;
          actor_id: string | null;
          changes: Record<string, unknown>;
          row_id: string;
        }>(sql`
          select action, actor_id, changes, row_id from audit_log
           where org_id = ${org.orgId} and table_name = 'custom_records'
           order by at, id
        `),
      );

    try {
      await withBypass(() =>
        db.execute(sql`
          insert into custom_record_types
            (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
          values
            (${typeId}, ${org.orgId}, ${typeKey}, 'Audit Record', 'Audit Records',
             ${JSON.stringify([{ id: "main", fields: [{ id: "name", type: "text", label: "Name" }] }])}::jsonb,
             'published', ${actorId}, ${actorId})
        `),
      );

      // A bare create seeds an inert draft (same as the interactive draft
      // route) and leaves no evidence yet.
      const bare = await withOrgContext(org.orgId, () =>
        createRecord(user, resolved, fields, {}, { allowedSubsidiaryIds: null }),
      );
      assert.equal(bare.status, 201);
      const bareId = (bare.body as { record: { id: string } }).record.id;
      assert.deepEqual(
        (await auditRows()).rows.map((row) => row.action),
        [],
      );

      // Creating with data is material: one update row with before/after.
      const created = await withOrgContext(org.orgId, () =>
        createRecord(
          user,
          resolved,
          fields,
          { data: { name: "audited" }, expectedUpdatedAt: undefined },
          { allowedSubsidiaryIds: null },
        ),
      );
      assert.equal(created.status, 201);
      const id = (created.body as { record: { id: string } }).record.id;
      {
        const rows = (await auditRows()).rows.filter((row) => row.row_id === id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.action, "update");
        assert.equal(rows[0]!.actor_id, actorId);
        const changes = rows[0]!.changes as {
          before: { data: { name: string } };
          after: { data: { name: string } };
        };
        assert.equal(changes.after.data.name, "audited");
        assert.ok(changes.before, "an update carries its before-image");
      }

      // A data update appends a second update row; the live row is intact.
      const revision = (
        await withBypass(() =>
          db.execute<{ revision: string }>(sql`
            select (revision_seq)::text as revision
              from custom_records where id = ${id} and org_id = ${org.orgId}
          `),
        )
      ).rows[0]!.revision;
      const updated = await withOrgContext(org.orgId, () =>
        updateRecord(
          user,
          resolved,
          fields,
          id,
          { data: { name: "audited twice" }, expectedUpdatedAt: revision },
          { allowedSubsidiaryIds: null },
        ),
      );
      assert.equal(updated.status, 200);
      {
        const rows = (await auditRows()).rows.filter((row) => row.row_id === id);
        assert.equal(rows.length, 2);
        assert.equal(rows[1]!.action, "update");
        assert.equal(rows[1]!.actor_id, actorId);
        const changes = rows[1]!.changes as {
          before: { data: { name: string } };
          after: { data: { name: string } };
        };
        assert.equal(changes.before.data.name, "audited");
        assert.equal(changes.after.data.name, "audited twice");
      }

      // Deleting the draft appends a delete row with the before-image.
      const deleted = await withOrgContext(org.orgId, () =>
        deleteRecord(user, resolved, bareId, { allowedSubsidiaryIds: null }),
      );
      assert.equal(deleted.status, 200);
      {
        const rows = (await auditRows()).rows.filter((row) => row.row_id === bareId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.action, "delete");
        assert.equal(rows[0]!.actor_id, actorId);
        assert.ok(
          (rows[0]!.changes as { before?: unknown }).before,
          "a delete carries its before-image",
        );
      }
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "entity writes through the shared writer leave audit evidence",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId;
    const user = {
      id: actorId,
      email: "writers-entity-audit@scratch.test",
      name: "Writers Entity Audit Test",
      roles: [{ key: "admin", name: "Admin" }],
      orgId: org.orgId,
      envKind: "production" as const,
      productionOrgId: org.orgId,
      isSuperAdmin: false,
      homeUserId: actorId,
      homeOrgId: org.orgId,
    };
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
    const auditRows = () =>
      withBypass(() =>
        db.execute<{
          action: string;
          actor_id: string | null;
          changes: Record<string, unknown>;
          row_id: string;
        }>(sql`
          select action, actor_id, changes, row_id from audit_log
           where org_id = ${org.orgId} and table_name = 'items'
           order by at, id
        `),
      );

    try {
      // Create leaves one insert row carrying the after-image and actor.
      const created = await withOrgContext(org.orgId, () =>
        createRecord(
          user,
          resolved,
          fields,
          { kind: "service", name: "Audited item" },
          { allowedSubsidiaryIds: null },
        ),
      );
      assert.equal(created.status, 201);
      const id = (created.body as { id: string }).id;
      {
        const rows = (await auditRows()).rows.filter((row) => row.row_id === id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.action, "insert");
        assert.equal(rows[0]!.actor_id, actorId);
        assert.equal(
          ((rows[0]!.changes as { after: { name: string } }).after.name),
          "Audited item",
        );
      }

      // Update appends an update row with before/after.
      const updated = await withOrgContext(org.orgId, () =>
        updateRecord(user, resolved, fields, id, { name: "Audited item v2" }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(updated.status, 200);
      {
        const rows = (await auditRows()).rows.filter((row) => row.row_id === id);
        assert.equal(rows.length, 2);
        assert.equal(rows[1]!.action, "update");
        assert.equal(rows[1]!.actor_id, actorId);
        const changes = rows[1]!.changes as { before: { name: string }; after: { name: string } };
        assert.equal(changes.before.name, "Audited item");
        assert.equal(changes.after.name, "Audited item v2");
      }

      // Delete appends a delete row with the before-image.
      const deleted = await withOrgContext(org.orgId, () =>
        deleteRecord(user, resolved, id, { allowedSubsidiaryIds: null }),
      );
      assert.equal(deleted.status, 200);
      {
        const rows = (await auditRows()).rows.filter((row) => row.row_id === id);
        assert.equal(rows.length, 3);
        assert.equal(rows[2]!.action, "delete");
        assert.equal(rows[2]!.actor_id, actorId);
        assert.equal(
          ((rows[2]!.changes as { before: { name: string } }).before.name),
          "Audited item v2",
        );
      }
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "generic record writes back a parties role kind with its role row (OM-16)",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    // OM-16: the v1/MCP record writer persists parties.kind with no role
    // inputs, so a kind "vendor" stranded a "Kind: Vendor" no read could
    // back. The writer now ensures the canonical role row beside the party
    // row; company/person kinds back nothing, and an existing role row is
    // never flipped.
    const org = await withBypass(() => createScratchOrg());
    const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId;
    const user = {
      id: actorId,
      email: "writers-party-roles@scratch.test",
      name: "Writers Party Roles Test",
      roles: [{ key: "admin", name: "Admin" }],
      orgId: org.orgId,
      envKind: "production" as const,
      productionOrgId: org.orgId,
      isSuperAdmin: false,
      homeUserId: actorId,
      homeOrgId: org.orgId,
    };
    const resolved: ResolvedApiType = {
      key: "parties",
      table: "parties",
      searchColumn: "display_name",
      readPermission: "parties.read",
      writePermission: "parties.manage",
      operations: ["list", "get", "create", "update", "delete"],
      writer: { kind: "entity", table: "parties" },
      dynamic: false,
      documentKinds: null,
    };
    const fields: ApiField[] = [
      { name: "kind", type: "string", required: true, writable: true, description: null, custom: false },
      { name: "display_name", type: "string", required: true, writable: true, description: null, custom: false },
    ];
    const roleCount = (partyId: string) =>
      withBypass(() =>
        db.execute<{ n: string }>(sql`
          select count(*)::text as n from vendor_roles where org_id = ${org.orgId} and party_id = ${partyId}
        `),
      ).then((result) => result.rows[0]?.n);

    try {
      const created = await withOrgContext(org.orgId, () =>
        createRecord(
          user,
          resolved,
          fields,
          { kind: "vendor", display_name: "Record Vendor" },
          { allowedSubsidiaryIds: null },
        ),
      );
      assert.equal(created.status, 201);
      const vendorId = (created.body as { id: string }).id;
      assert.equal(await roleCount(vendorId), "1");

      // Renaming the kind away keeps the (now history) role row: the ensure
      // is insert-only and never deactivates an existing role.
      const renamed = await withOrgContext(org.orgId, () =>
        updateRecord(user, resolved, fields, vendorId, { kind: "company" }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(renamed.status, 200);
      assert.equal(await roleCount(vendorId), "1");

      // A company kind backs nothing …
      const plain = await withOrgContext(org.orgId, () =>
        createRecord(
          user,
          resolved,
          fields,
          { kind: "company", display_name: "Record Company" },
          { allowedSubsidiaryIds: null },
        ),
      );
      assert.equal(plain.status, 201);
      const companyId = (plain.body as { id: string }).id;
      assert.equal(await roleCount(companyId), "0");

      // … until the kind names a role, on update as on create.
      const adopted = await withOrgContext(org.orgId, () =>
        updateRecord(user, resolved, fields, companyId, { kind: "vendor" }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(adopted.status, 200);
      assert.equal(await roleCount(companyId), "1");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
