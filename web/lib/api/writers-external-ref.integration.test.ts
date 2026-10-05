import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

// externalRef/externalSource on invoice creates through the generic record
// writer: persisted, deduplicated with the winner named, both spellings
// accepted, and a half pair refused before anything writes.
const { withBypassContext, withOrgContext } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { createRecord, updateRecord } = await import("./writers.ts");
import type { ResolvedApiType } from "./registry-data.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const resolved: ResolvedApiType = {
  key: "invoices",
  table: "documents",
  searchColumn: "document_number",
  readPermission: "ar.read",
  writePermission: "ar.create",
  operations: ["list", "get", "create", "update", "delete"],
  writer: { kind: "document", docKind: "customer_invoice" },
  dynamic: false,
  documentKinds: null,
};

async function setup() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  const user = {
    id: actorId,
    email: "writers-external-ref@scratch.test",
    name: "Writers External Ref Test",
    roles: [{ key: "admin", name: "Admin" }],
    orgId: org.orgId,
    envKind: "production" as const,
    productionOrgId: org.orgId,
    isSuperAdmin: false,
    homeUserId: actorId,
    homeOrgId: org.orgId,
  };
  return { org, user };
}

test("invoice create persists the external pair and refuses a duplicate", { skip: !DB }, async () => {
  const { org, user } = await setup();
  try {
    const ref = `INV-${randomUUID().slice(0, 8)}`;
    const created = await withOrgContext(org.orgId, () =>
      createRecord(user, resolved, [], { partyId: org.customerId, externalRef: ref, externalSource: "stripe" }, {
        allowedSubsidiaryIds: null,
      }),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const doc = (created.body as { doc: Record<string, unknown> }).doc;
    assert.equal(doc.external_ref, ref);
    assert.equal(doc.external_source, "stripe");
    const id = String(doc.id);

    const duplicate = await withOrgContext(org.orgId, () =>
      createRecord(user, resolved, [], { partyId: org.customerId, externalRef: ref, externalSource: "stripe" }, {
        allowedSubsidiaryIds: null,
      }),
    );
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal((duplicate.body as { existingId?: string }).existingId, id);

    // The snake_case spelling the schema advertises is accepted, not dropped.
    const snakeRef = `INV-${randomUUID().slice(0, 8)}`;
    const snake = await withOrgContext(org.orgId, () =>
      createRecord(
        user,
        resolved,
        [],
        { partyId: org.customerId, external_ref: snakeRef, external_source: "stripe" },
        { allowedSubsidiaryIds: null },
      ),
    );
    assert.equal(snake.status, 201, JSON.stringify(snake.body));
    assert.equal((snake.body as { doc: Record<string, unknown> }).doc.external_ref, snakeRef);

    // A half pair is refused before anything writes.
    const half = await withOrgContext(org.orgId, () =>
      createRecord(user, resolved, [], { partyId: org.customerId, externalRef: "LONE" }, {
        allowedSubsidiaryIds: null,
      }),
    );
    assert.equal(half.status, 422, JSON.stringify(half.body));
    assert.match(String((half.body as { error?: string }).error), /travel together/);

    // Setting a new pair on update persists; claiming another row's pair 409s.
    const movedRef = `${ref}-moved`;
    const updated = await withOrgContext(org.orgId, () =>
      updateRecord(
        user,
        resolved,
        [],
        id,
        { expectedUpdatedAt: String(doc.updated_at), externalRef: movedRef, externalSource: "stripe" },
        { allowedSubsidiaryIds: null },
      ),
    );
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal((updated.body as { doc: Record<string, unknown> }).doc.external_ref, movedRef);
    const snakeDoc = (snake.body as { doc: Record<string, unknown> }).doc;
    const clash = await withOrgContext(org.orgId, () =>
      updateRecord(
        user,
        resolved,
        [],
        String(snakeDoc.id),
        {
          expectedUpdatedAt: String(snakeDoc.updated_at),
          externalRef: movedRef,
          externalSource: "stripe",
        },
        { allowedSubsidiaryIds: null },
      ),
    );
    assert.equal(clash.status, 409, JSON.stringify(clash.body));
    assert.equal((clash.body as { existingId?: string }).existingId, id);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
