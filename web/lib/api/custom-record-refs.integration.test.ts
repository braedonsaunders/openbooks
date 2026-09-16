import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { ApiField, ResolvedApiType } from "./registry-data.ts";

// A `party`/`gl_account` record field is shape-checked (uuid syntax) by
// `validateRecordData`, but nothing proves the referenced row belongs to the
// caller's organization: the custom-record writer persists a foreign-org (or
// dangling) uuid blind into the tenant jsonb bag. The entity writers fence
// the same gap with a batched per-table ownership check and refuse with a
// tenant-opaque 404 — the metadata-driven record path must fail closed the
// same way, on create and on update, for header and repeating-row fields.
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

function resolvedFor(typeKey: string): ResolvedApiType {
  return {
    key: typeKey,
    table: "custom_records",
    searchColumn: "search_text",
    readPermission: "records.read",
    writePermission: "records.manage",
    operations: ["list", "get", "create", "update", "delete"],
    writer: { kind: "custom_record" },
    dynamic: true,
    documentKinds: null,
  };
}

const fields: ApiField[] = [];

function userFor(orgId: string, actorId: string) {
  return {
    id: actorId,
    email: "custom-record-refs@scratch.test",
    name: "Custom Record Refs Test",
    roles: [{ key: "admin", name: "Admin" }],
    orgId,
    envKind: "production" as const,
    productionOrgId: orgId,
    isSuperAdmin: false,
    homeUserId: actorId,
    homeOrgId: orgId,
  };
}

async function seedType(orgId: string, actorId: string, typeKey: string) {
  const sections = [
    {
      id: "main",
      fields: [
        { id: "vendor", type: "party", label: "Vendor" },
        { id: "acct", type: "gl_account", label: "Account" },
      ],
    },
    {
      id: "lines",
      repeating: true,
      fields: [{ id: "billto", type: "party", label: "Bill to" }],
    },
  ];
  await withBypass(() => db.execute(sql`
    insert into custom_record_types
      (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
    values
      (${randomUUID()}, ${orgId}, ${typeKey}, 'Ref Record', 'Ref Records',
       ${JSON.stringify(sections)}::jsonb,
       'published', ${actorId}, ${actorId})
  `));
}

async function recordCount(orgId: string, typeKey: string): Promise<number> {
  const r = await withBypass(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from custom_records where org_id = ${orgId} and type_key = ${typeKey}`),
  );
  return r.rows[0]!.n;
}

test(
  "custom-record writes refuse party and account references owned by another organization",
  { skip: !DB },
  async () => {
    const orgA = await withBypass(() => createScratchOrg());
    const orgB = await withBypass(() => createScratchOrg());
    const actorId = (await withBypass(() => seedFlowActors(orgA.orgId))).adminId;
    const user = userFor(orgA.orgId, actorId);
    const typeKey = `refrec-${randomUUID().slice(0, 8)}`;
    const resolved = resolvedFor(typeKey);
    const foreignParty = orgB.vendorId;
    const foreignAccount = orgB.accounts.bank;
    const ownParty = orgA.vendorId;
    const ownAccount = orgA.accounts.bank;
    try {
      await seedType(orgA.orgId, actorId, typeKey);

      // CREATE with foreign-org header references must fail closed.
      const refusedCreate = await withOrgContext(orgA.orgId, () =>
        createRecord(user, resolved, fields, {
          status: "active",
          data: { vendor: foreignParty, acct: foreignAccount },
        }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(
        refusedCreate.status,
        404,
        `expected tenant-opaque 404, got ${refusedCreate.status}: ${JSON.stringify(refusedCreate.body)}`,
      );
      assert.equal(await recordCount(orgA.orgId, typeKey), 0);

      // CREATE with a dangling (well-formed but nonexistent) uuid must also fail closed.
      const refusedDangling = await withOrgContext(orgA.orgId, () =>
        createRecord(user, resolved, fields, {
          status: "active",
          data: { vendor: randomUUID(), acct: ownAccount },
        }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(
        refusedDangling.status,
        404,
        `expected tenant-opaque 404, got ${refusedDangling.status}: ${JSON.stringify(refusedDangling.body)}`,
      );
      assert.equal(await recordCount(orgA.orgId, typeKey), 0);

      // CREATE with a foreign-org reference inside a repeating row must fail closed.
      const refusedRow = await withOrgContext(orgA.orgId, () =>
        createRecord(user, resolved, fields, {
          status: "active",
          data: { vendor: ownParty, acct: ownAccount, lines: [{ billto: foreignParty }] },
        }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(
        refusedRow.status,
        404,
        `expected tenant-opaque 404, got ${refusedRow.status}: ${JSON.stringify(refusedRow.body)}`,
      );
      assert.equal(await recordCount(orgA.orgId, typeKey), 0);

      // CREATE with own-org references still succeeds (header + repeating row).
      const created = await withOrgContext(orgA.orgId, () =>
        createRecord(user, resolved, fields, {
          status: "active",
          data: { vendor: ownParty, acct: ownAccount, lines: [{ billto: ownParty }] },
        }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(
        created.status,
        201,
        `expected 201, got ${created.status}: ${JSON.stringify(created.body)}`,
      );
      const createdId = (created.body as { record: { id: string } }).record.id;

      // UPDATE swapping in a foreign-org reference must fail closed and leave the row untouched.
      const refusedUpdate = await withOrgContext(orgA.orgId, () =>
        updateRecord(user, resolved, fields, createdId, {
          data: { vendor: foreignParty },
        }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(
        refusedUpdate.status,
        404,
        `expected tenant-opaque 404, got ${refusedUpdate.status}: ${JSON.stringify(refusedUpdate.body)}`,
      );
      const afterUpdate = await withBypass(() =>
        db.execute<{ data: unknown }>(sql`select data from custom_records where id = ${createdId}`),
      );
      assert.equal(
        (afterUpdate.rows[0]!.data as { vendor: string }).vendor,
        ownParty,
      );

      // UPDATE touching only an unrelated key on a row carrying a legacy
      // (pre-fence) foreign value must NOT lock the row: ownership applies to
      // newly supplied references only.
      const legacyId = randomUUID();
      await withBypass(() => db.execute(sql`
        insert into custom_records
          (id, org_id, type_id, type_key, record_number, data, search_text, status, created_by, updated_by)
        values
          (${legacyId}, ${orgA.orgId},
           (select id from custom_record_types where org_id = ${orgA.orgId} and key = ${typeKey}),
           ${typeKey}, 'LEG-00001',
           ${JSON.stringify({ vendor: foreignParty, acct: ownAccount })}::jsonb,
           'legacy', 'active', ${actorId}, ${actorId})
      `));
      const legacyTouch = await withOrgContext(orgA.orgId, () =>
        updateRecord(user, resolved, fields, legacyId, {
          data: { acct: ownAccount },
        }, { allowedSubsidiaryIds: null }),
      );
      assert.equal(
        legacyTouch.status,
        200,
        `expected 200, got ${legacyTouch.status}: ${JSON.stringify(legacyTouch.body)}`,
      );
    } finally {
      await withBypass(() => dropScratchOrg(orgA.orgId));
      await withBypass(() => dropScratchOrg(orgB.orgId));
    }
  },
);
