import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// A save that changes nothing writes no audit row: the shared edit service
// compares the before/after snapshots ignoring write stamps, so a no-op
// PATCH answers 200 without recording an 'Updated' row, while a real change
// still records its before/after evidence. Only the session gate is stubbed.
const state: { orgId: string; actorId: string } = { orgId: "", actorId: "" };
Object.assign(globalThis, { __m25NoChangeAuditState: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "../../../../lib/authz" || specifier === "@/lib/authz")
      return virtual(`
      import { permissionSetCovers } from '@openbooks/engine/organization/permissions';
      export async function getAuthz() {
        const s = globalThis.__m25NoChangeAuditState;
        return { user: { roles: [], orgId: s.orgId, id: s.actorId, isSuperAdmin: false }, permissions: new Set(['ap.read', 'ap.create', 'ap.post']), allowedSubsidiaryIds: null };
      }
      export function can(authz, permission) { return permissionSetCovers(authz.permissions, permission) }
      export function guardSubsidiaryScope() { return null }
      export function subsidiariesInScope() { return true }
    `);
    if (context.parentURL?.startsWith("data:") && specifier.startsWith("@openbooks/")) {
      return next(specifier, { ...context, parentURL: import.meta.url });
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/testing/fixtures");
const { documentRevisionCounterSql } = await import("@openbooks/engine/records/revision");
const { PATCH } = await import("./route.ts");

async function makeDraftBill(orgId: string, subsidiaryId: string, date: string): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
    values (${id}, ${orgId}, 'vendor_bill', 'draft', ${"BILL-" + id.slice(0, 8)}, ${date}, ${subsidiaryId}, 'CAD', '0', '0', '0', '{}'::jsonb)`),
  );
  return id;
}

async function revision(orgId: string, id: string): Promise<string> {
  return (
    await withOrgContext(orgId, () =>
      db.execute<{ revision: string }>(
        sql`select ${documentRevisionCounterSql(sql`revision_seq`)} as revision from documents where id=${id} and org_id=${orgId}`,
        "objects",
      ),
    )
  )[0]!.revision;
}

async function auditCount(orgId: string, id: string): Promise<number> {
  return Number(
    (
      await withBypassContext(() =>
        db.execute<{ n: string }>(
          sql`select count(*) as n from audit_log where org_id=${orgId} and table_name='documents' and row_id=${id} and action='update'`,
          "objects",
        ),
      )
    )[0]!.n,
  );
}

async function patchDoc(
  orgId: string,
  id: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await withOrgContext(orgId, () =>
    PATCH(
      new Request(`http://documents.test/api/documents/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
  return { status: response.status, json: await response.json().catch(() => null) };
}

test("a no-change PATCH writes no audit row; a real change writes exactly one", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.orgId = org.orgId;
    state.actorId = randomUUID();
    const id = await makeDraftBill(org.orgId, org.subsidiaryId, org.date);
    assert.equal(await auditCount(org.orgId, id), 0);

    const noop = await patchDoc(org.orgId, id, {
      expectedUpdatedAt: await revision(org.orgId, id),
      memo: null,
    });
    assert.equal(noop.status, 200, JSON.stringify(noop.json));
    assert.equal(
      await auditCount(org.orgId, id),
      0,
      "a save that changes nothing must leave no Updated row",
    );

    const changed = await patchDoc(org.orgId, id, {
      expectedUpdatedAt: await revision(org.orgId, id),
      memo: "audited change",
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    assert.equal(
      await auditCount(org.orgId, id),
      1,
      "a save that changes the memo must record its evidence",
    );
    const latest = (
      await withBypassContext(() =>
        db.execute<{ changes: { mode: string } }>(
          sql`select changes from audit_log where org_id=${org.orgId} and table_name='documents' and row_id=${id} and action='update' order by id desc limit 1`,
          "objects",
        ),
      )
    )[0]!;
    assert.equal(latest.changes.mode, "record_update");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
