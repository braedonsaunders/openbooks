import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { sql } from "drizzle-orm";
import { postDocument } from "../ledger/posting-document.ts";
import { db, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "../testing/fixtures.ts";
import { createRetainer, draftHoursDrawdown, retainerBalance, updateRetainerDraft } from "./retainers.ts";
import { generateRetainerInvoice, postDrawdown, syncRetainerActivation } from "./retainer-billing.ts";
import { ResourcingRefusal } from "./errors.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
let org: ScratchOrg;
let actorId: string;

beforeEach(async () => {
  org = await withBypassContext(() => createScratchOrg());
  actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  await withBypassContext(() => write(db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
    coalesce(settings->'features', '{}'::jsonb) || '{"projects":true,"resourcing":true,"retainerBilling":true,"revenueRecognition":true}'::jsonb, true)
    where id = ${org.orgId}`), "test feature setup"));
});
afterEach(async () => { if (org) await withBypassContext(() => dropScratchOrg(org.orgId)); });

test("retainer invoicing refuses missing deferral, the wrong method, and forecast rules", { skip: !DB }, async () => {
  const retainer = await fixtureRetainer();
  const refused = async (code: string) => assert.rejects(
    generateRetainerInvoice(input(retainer.id)),
    (error: unknown) => error instanceof ResourcingRefusal && error.status === 422 && error.code === code && error.remedy.length > 0,
  );
  await withBypassContext(() => write(db.execute(sql`update items set deferred_account_id = null where org_id = ${org.orgId} and id = ${org.items.service}`), "remove item deferral"));
  await withBypassContext(() => write(db.execute(sql`update recognition_rules set deferred_account_id = null where org_id = ${org.orgId} and id = ${org.recognitionRuleId}`), "remove rule deferral"));
  await refused("retainer_deferred_account_required");
  await withBypassContext(() => write(db.execute(sql`update items set deferred_account_id = ${org.accounts.deferred} where org_id = ${org.orgId} and id = ${org.items.service}`), "restore item deferral"));
  await withBypassContext(() => write(db.execute(sql`update recognition_rules set method = 'straight_line_even', deferred_account_id = ${org.accounts.deferred} where org_id = ${org.orgId} and id = ${org.recognitionRuleId}`), "set wrong recognition method"));
  await refused("retainer_recognition_method_mismatch");
  await withBypassContext(() => write(db.execute(sql`update recognition_rules set method = 'usage', is_forecast = true where org_id = ${org.orgId} and id = ${org.recognitionRuleId}`), "set forecast recognition rule"));
  await refused("retainer_forecast_rule");
});

test("hours invoices activate and post idempotent monthly drawdown events", { skip: !DB }, async () => {
  const retainer = await fixtureRetainer({ totalHours: "4.0000", unitRate: "100.0000" });
  await configureHoursRule();
  await ensureAugustPeriod();
  const { invoiceId } = await generateRetainerInvoice(input(retainer.id));
  await approveAndPostInvoice(invoiceId);
  const activated = await withOrgTransaction(org.orgId, () => syncRetainerActivation(db, org.orgId, retainer.id, actorId));
  assert.equal(activated?.state, "active");
  assert.ok(activated?.obligationId);
  const obligationId = activated!.obligationId!;
  const timeEntries = [
    { id: randomUUID(), workedOn: "2026-07-31" },
    { id: randomUUID(), workedOn: "2026-08-01" },
  ];
  const employeeId = retainer.employeeId;
  await withBypassContext(() => write(db.execute(sql`insert into time_entries
    (id, org_id, employee_party_id, project_id, worked_on, hours, status, is_billable, billing_status, created_by, updated_by)
    select v.id::uuid, ${org.orgId}, ${employeeId}, ${retainer.projectId}, v.day::date, '2.0000', 'approved', true, 'unbilled', ${actorId}, ${actorId}
      from (values (${timeEntries[0]!.id}, ${timeEntries[0]!.workedOn}), (${timeEntries[1]!.id}, ${timeEntries[1]!.workedOn})) v(id, day)`), "test time-entry setup", 2));
  const draft = await draftHoursDrawdown({ ...input(retainer.id), sunday: "2026-07-26" });
  assert.equal(draft.amount, "400.0000");
  assert.equal((await withOrgTransaction(org.orgId, () => retainerBalance(org.orgId, activated!))).amount, "400.0000");
  const posted = await postDrawdown({ ...input(retainer.id), drawdownId: draft.id });
  assert.deepEqual(posted, { id: draft.id, state: "posted", balance: "0.0000", retainerState: "exhausted" });
  const events = await withBypassContext(() => db.execute<{ source_reference: string; period_month: string }>(sql`
    select source_reference, period_month::text as period_month from recognition_events
     where org_id = ${org.orgId} and obligation_id = ${obligationId} order by period_month`));
  assert.deepEqual(events.rows, [
    { source_reference: `resourcing:retainer-drawdown:${draft.id}:2026-07`, period_month: "2026-07-01" },
    { source_reference: `resourcing:retainer-drawdown:${draft.id}:2026-08`, period_month: "2026-08-01" },
  ]);
  const replay = await postDrawdown({ ...input(retainer.id), drawdownId: draft.id });
  assert.deepEqual(replay, posted);
  assert.equal((await withBypassContext(() => db.execute<{ count: number }>(sql`select count(*)::int as count from recognition_events where org_id = ${org.orgId} and obligation_id = ${obligationId}`))).rows[0]?.count, 2);
  const audits = await withBypassContext(() => db.execute<{ count: number }>(sql`select count(*)::int as count from audit_log where org_id = ${org.orgId} and table_name = 'res_retainers' and row_id = ${retainer.id} and changes->'after'->>'state' = 'exhausted'`));
  assert.equal(audits.rows[0]?.count, 1);
});

test("extra recognition lines block activation and draft edits stop at invoice linkage", { skip: !DB }, async () => {
  const retainer = await fixtureRetainer();
  await configureHoursRule();
  const edited = await updateRetainerDraft({ ...input(retainer.id), endsOn: "2026-09-30" });
  assert.equal(edited.endsOn, "2026-09-30");
  const { invoiceId } = await generateRetainerInvoice(input(retainer.id));
  await assert.rejects(updateRetainerDraft({ ...input(retainer.id), endsOn: "2026-10-31" }),
    (error: unknown) => error instanceof ResourcingRefusal && error.status === 409 && error.code === "retainer_invoice_linked");
  await withBypassContext(async () => db.transaction(async (tx) => {
    await write(tx.execute(sql`insert into document_lines (org_id, document_id, line_number, item_id, description, quantity, unit_price, amount, created_by)
      values (${org.orgId}, ${invoiceId}, 2, ${org.items.service}, 'Additional service', '1', '1', '1', ${actorId})`), "add second recognition line");
    await write(tx.execute(sql`update documents d
      set subtotal = lines.subtotal, tax_total = lines.tax_total, total = lines.subtotal + lines.tax_total
      from (select sum(amount) as subtotal, sum(tax_amount) as tax_total
              from document_lines where org_id = ${org.orgId} and document_id = ${invoiceId}) lines
      where d.org_id = ${org.orgId} and d.id = ${invoiceId}`), "update invoice totals");
  }));
  await approveAndPostInvoice(invoiceId);
  await assert.rejects(withOrgTransaction(org.orgId, () => syncRetainerActivation(db, org.orgId, retainer.id, actorId)),
    (error: unknown) => error instanceof ResourcingRefusal && error.status === 409 && error.code === "retainer_obligation_allocation_mismatch");
});

async function fixtureRetainer(terms: { totalHours?: string; unitRate?: string } = {}) {
  const projectId = randomUUID(), employeeId = randomUUID();
  await withBypassContext(async () => {
    await write(db.execute(sql`insert into projects
      (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, ${`RB-${projectId.slice(0, 8)}`}, 'Retainer project', ${org.customerId}, 'active', true, '{}'::jsonb)`), "test project setup");
    await write(db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'employee', 'Retainer consultant', ${org.subsidiaryId}, true, '{}'::jsonb)`), "test employee setup");
  });
  const retainer = await createRetainer({
    ...writeBase(), projectId, customerPartyId: org.customerId, kind: "hours",
    totalHours: terms.totalHours ?? "8.0000", unitRate: terms.unitRate ?? "100.0000",
    startsOn: "2026-07-01", endsOn: "2026-08-31", retainerItemId: org.items.service,
  });
  return { ...retainer, projectId, employeeId };
}

function writeBase() { return { orgId: org.orgId, actorId, allowedSubsidiaryIds: new Set([org.subsidiaryId]) }; }
function input(retainerId: string) { return { ...writeBase(), retainerId }; }
async function configureHoursRule() { await withBypassContext(() => write(db.execute(sql`update recognition_rules set method = 'usage', is_forecast = false where org_id = ${org.orgId} and id = ${org.recognitionRuleId}`), "set usage recognition rule")); }
async function ensureAugustPeriod() { await withBypassContext(() => write(db.execute(sql`insert into accounting_periods (org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
  select ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, id from fiscal_calendars where org_id = ${org.orgId} and is_default`), "test August period setup")); }
async function approveAndPostInvoice(invoiceId: string) {
  await withBypassContext(() => write(db.execute(sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${invoiceId}`), "approve test invoice"));
  await withOrgTransaction(org.orgId, () => postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } }, { audit: { actorId, source: "retainer-billing-test" } }));
}

async function write(result: Promise<{ rowCount: number | null }>, label: string, expected = 1) {
  assert.equal((await result).rowCount, expected, `${label} must affect ${expected} row(s)`);
}
