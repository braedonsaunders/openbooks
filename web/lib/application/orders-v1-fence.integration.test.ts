import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

// v1 order conversion requires the caller's revision token: an omitted
// expectedUpdatedAt used to skip the revision fence entirely, so a stale
// view could create the downstream document.
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { convertApplicationOrder } = await import("./orders");
const { ApplicationError } = await import("./errors");
const { applicationContextFromSession } = await import("./context");
const DB = !!process.env.OPENBOOKS_DB_URL;

test("v1 purchase-order convert without expectedUpdatedAt is refused", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = randomUUID();
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"orders":true}'::jsonb)
      where id = ${org.orgId}`));
    const id = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into documents (id, org_id, kind, document_number, subsidiary_id, document_date, currency, fx_rate, status, subtotal, tax_total, total)
      values (${id}, ${org.orgId}, 'purchase_order', ${"PO-" + id.slice(0, 8)}, ${org.subsidiaryId}, ${org.date}, 'CAD', 1, 'approved', '0', '0', '0')`));
    const context = applicationContextFromSession(
      {
        user: {
          id: actor,
          orgId: org.orgId,
          name: "Fence harness",
          email: "fence-harness@scratch.test",
          roles: [],
          isSuperAdmin: false,
          envKind: "production",
          productionOrgId: org.orgId,
          homeOrgId: org.orgId,
          homeUserId: actor,
        },
        permissions: new Set(["*"]),
        allowedSubsidiaryIds: null,
      },
      "api",
      randomUUID(),
    );
    const error = await withOrgContext(org.orgId, () =>
      convertApplicationOrder(context, {
        documentId: id,
        targetKind: "vendor_bill",
        idempotencyKey: "v1-fence-probe-key",
        expectedKind: "purchase_order",
      }).then(
        () => null,
        (cause) => cause,
      ),
    );
    assert.ok(error instanceof ApplicationError, `expected an ApplicationError, got ${String(error)}`);
    assert.equal(error.code, "invalid_input");
    assert.match(error.message, /expectedUpdatedAt/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
