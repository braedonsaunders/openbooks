import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { SessionUser } from "./auth";

// Database partition: every case here drives the real route against
// PostgreSQL (scratch orgs, generated documents, audit rows). The unit
// partition has no database, so these live under the .integration suffix
// with no skip guards. The locale-message contract stays unit-safe in
// recurring-delete-audit.test.ts.

/**
 * Schedule deletion keeps its evidence: a missing schedule reports not
 * found without writing audit, a schedule that generated documents refuses
 * with 409 and keeps everything, a clean delete removes the row and
 * audits the exact before-state, and run-now attributes the generated
 * document to the authenticated caller.
 */

const root = pathToFileURL(process.cwd() + "/").href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __recurringDeleteAuditUser: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "next-intl/server") return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
      return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__recurringDeleteAuditUser.user}" };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { withSimClock } = await import("@openbooks/engine/src/platform/clock.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const detail = await import("../app/api/recurring/[id]/route");

const request = (method: string) => new Request("http://audit.local/api/recurring/x", { method });
const paramsFor = (id: string) => ({ params: Promise.resolve({ id }) });

type Seed = {
  orgId: string;
  actor: string;
  template: string;
  schedule: string;
  date: string;
};

async function seedSchedule(withOccurrence: boolean): Promise<Seed> {
  const org = await createScratchOrg();
  const seed = await withBypassContext(async () => {
    const actor = await createScratchUser(org.orgId, "Recurring manager", "recurring_manager");
    await db.execute(sql`update app_roles set permissions='["documents.manage","gl.post"]'::jsonb
      where org_id=${org.orgId} and key='recurring_manager'`);
    const template = randomUUID(), schedule = randomUUID();
    await db.execute(sql`insert into documents (id,org_id,kind,status,document_number,document_date,currency,party_id,subsidiary_id,created_by)
      values (${template},${org.orgId},'customer_invoice','draft',${`RECUR-${schedule.slice(0, 8)}`},${org.date},'CAD',${org.customerId},${org.subsidiaryId},${actor})`);
    await db.execute(sql`insert into document_lines (org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount)
      values (${org.orgId},${template},1,${org.accounts.revenue},'1','100','100','0')`);
    await db.execute(sql`insert into recurring_schedules (id,org_id,template_document_id,cadence,next_run_on,auto_post,is_active,created_by)
      values (${schedule},${org.orgId},${template},'monthly',${org.date},false,true,${actor})`);
    if (withOccurrence) {
      const generated = randomUUID();
      await db.execute(sql`insert into documents (id,org_id,kind,status,document_number,document_date,currency,party_id,subsidiary_id,created_by)
        values (${generated},${org.orgId},'customer_invoice','draft',${`GEN-${schedule.slice(0, 8)}`},${org.date},'CAD',${org.customerId},${org.subsidiaryId},${actor})`);
      await db.execute(sql`insert into recurring_occurrence_documents (org_id,schedule_id,occurrence_on,document_id,created_by)
        values (${org.orgId},${schedule},${org.date},${generated},${actor})`);
    }
    return { actor, template, schedule };
  });
  state.user = { id: seed.actor, orgId: org.orgId, name: "Recurring manager", email: "recurring@scratch.test", roles: [],
    isSuperAdmin: false, envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: seed.actor };
  return { orgId: org.orgId, actor: seed.actor, template: seed.template, schedule: seed.schedule, date: org.date };
}

async function auditRows(orgId: string, rowId: string): Promise<Array<{ action: string; changes: unknown }>> {
  return (await db.execute<{ action: string; changes: unknown }>(sql`select action, changes from audit_log
    where org_id=${orgId} and table_name='recurring_schedules' and row_id=${rowId} order by at`)).rows;
}

test("deleting a missing schedule reports not found and writes no audit", async () => {
  const { orgId } = await seedSchedule(false);
  try {
    const missing = randomUUID();
    const response = await withOrgContext(orgId, () => detail.DELETE(request("DELETE"), paramsFor(missing)));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not found" });
    assert.deepEqual(await auditRows(orgId, missing), [], "a refused delete must not invent audit history");
  } finally { state.user = null; await dropScratchOrg(orgId); }
});

test("deleting a schedule with generated documents refuses and deletes nothing", async () => {
  const { orgId, schedule, date } = await seedSchedule(true);
  try {
    const response = await withOrgContext(orgId, () => withSimClock(`${date}T00:00:00Z`, () =>
      detail.DELETE(request("DELETE"), paramsFor(schedule))));
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error: string; code: string };
    assert.equal(body.code, "generated_documents_exist");
    assert.match(body.error, /generated documents exist/, "the refusal names what blocks it");
    const remaining = (await db.execute<{ n: number }>(sql`select count(*)::int as n from recurring_schedules
      where org_id=${orgId} and id=${schedule}`)).rows[0]!.n;
    assert.equal(remaining, 1, "the refused delete removes nothing");
    assert.deepEqual((await auditRows(orgId, schedule)).map((row) => row.action), [],
      "the refused delete audits nothing");
  } finally { state.user = null; await dropScratchOrg(orgId); }
});

test("deleting a clean schedule removes it and audits the before state", async () => {
  const { orgId, schedule, date } = await seedSchedule(false);
  try {
    const response = await withOrgContext(orgId, () => withSimClock(`${date}T00:00:00Z`, () =>
      detail.DELETE(request("DELETE"), paramsFor(schedule))));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    const remaining = (await db.execute<{ n: number }>(sql`select count(*)::int as n from recurring_schedules
      where org_id=${orgId} and id=${schedule}`)).rows[0]!.n;
    assert.equal(remaining, 0, "the schedule row is gone");
    const audits = await auditRows(orgId, schedule);
    assert.equal(audits.length, 1, "exactly one audit row explains the disappearance");
    assert.equal(audits[0]!.action, "delete");
    const changes = audits[0]!.changes as { before: { auto_post: boolean }; after: null };
    assert.equal(changes.after, null);
    assert.equal(changes.before.auto_post, false, "the audit snapshots the state this transaction deleted");
  } finally { state.user = null; await dropScratchOrg(orgId); }
});

test("run now attributes the generated document to the authenticated caller", async () => {
  const { orgId, actor, template, schedule, date } = await seedSchedule(false);
  try {
    const response = await withOrgContext(orgId, () => withSimClock(`${date}T00:00:00Z`, () =>
      detail.POST(request("POST"), paramsFor(schedule))));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const generated = (await response.json()) as { documentId: string };
    const row = (await db.execute<{ createdBy: string }>(sql`select created_by as "createdBy" from documents
      where org_id=${orgId} and id=${generated.documentId}`)).rows[0]!;
    assert.equal(row.createdBy, actor, "the run records who ran it, and the template stays untouched");
    assert.notEqual(generated.documentId, template);
  } finally { state.user = null; await dropScratchOrg(orgId); }
});

