import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { db, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";
import {
  approvePayApplication,
  createPayApplication,
  generatePayApplicationInvoice,
  submitPayApplication,
} from "./construction-billing.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { postDocument } from "../ledger/posting.ts";
import {
  approveVendorPayApplication,
  createVendorPayApplication,
  generateVendorPayApplicationBill,
  submitVendorPayApplication,
  updateVendorPayApplicationLines,
} from "./subcontracts.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL, timeout: 120_000 };

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

const sleep = (ms: number): Promise<"blocked"> =>
  new Promise((resolve) => setTimeout(() => resolve("blocked"), ms));

/** Parks a tenant transaction holding a row lock until released; rolls back without a trace. */
async function holdRowLock(
  orgId: string,
  table: "projects" | "subcontracts",
  id: string,
  held: () => void,
  released: Promise<unknown>,
): Promise<void> {
  const rollback = new Error("__f6_lock_holder_rollback__");
  await withOrgTransaction(orgId, async () => {
    await db.execute(sql`select 1 from ${sql.raw(table)} where org_id = ${orgId} and id = ${id} for update`);
    held();
    await released;
    throw rollback;
  }).catch((error: unknown) => {
    if (error !== rollback) throw error;
  });
}

async function adminActor(org: Org): Promise<{ actor: string; approver: string }> {
  const actor = await createScratchUser(org.orgId, "Lock controller", "admin");
  const approver = await createScratchUser(org.orgId, "Lock approver", "admin");
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
  return { actor, approver };
}

async function policyType(orgId: string, key: string): Promise<string> {
  const type = randomUUID();
  const profile = BUILTIN_PROJECT_TYPES.find((p) => p.key === "schedule_of_values")!;
  await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
    values(${type},${orgId},${key},'Lock test','fixed_price',${JSON.stringify(profile.invoicingProfile)}::jsonb,${JSON.stringify(profile.backupProfile)}::jsonb)`);
  await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
    values(${orgId},${type},'2000-01-01',${JSON.stringify(profile.financialProfile)}::jsonb,'Scratch lock policy')`);
  return type;
}

async function controlAccounts(org: Org): Promise<void> {
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('retainageReceivable',${org.accounts.invAsset}::text)) where id=${org.orgId}`);
}

function nextDay(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1));
  return next.toISOString().slice(0, 10);
}

async function postInvoice(org: Org, actor: string, approver: string, kind: string, id: string): Promise<void> {
  assert.equal((await submitAndReleaseIfUngated(kind, id, actor)).autoApproved, true);
  await postDocument(
    id,
    { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
    { audit: { actorId: approver, source: "test" } },
  );
}

test("concurrent customer draws serialize on the project lock during replay", enabled, async () => {
  // Two draws submitted at once must not replay the same settled history:
  // the second submit has to wait for the first's transaction, otherwise
  // both settle the same residual and a minor unit of dust strands.
  const org = await createScratchOrg();
  let releaseLock!: () => void;
  const released = new Promise<void>((resolve) => { releaseLock = resolve; });
  try {
    const { actor, approver } = await adminActor(org);
    await controlAccounts(org);
    const type = await policyType(org.orgId, "lock_cust");
    const project = randomUUID();
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status)
      values(${project},${org.orgId},${org.subsidiaryId},'LOCK-C','Lock job',${org.customerId},${type},'active')`);
    await db.execute(sql`insert into sov_lines(org_id,project_id,description,scheduled_value,sort_order,income_account_id)
      values(${org.orgId},${project},'Work','10000',1,${org.accounts.revenue})`);
    const sov = (await db.execute<{ id: string }>(sql`select id from sov_lines where org_id=${org.orgId} and project_id=${project}`)).rows[0]!.id;

    // The prior draw must be fully closed (submitted, approved, invoiced,
    // posted): the domain refuses a second open draw, so the race under test
    // is a later submit replaying settled history while another transaction
    // holds the project.
    const prior = await withOrgTransaction(org.orgId, () => createPayApplication(org.orgId, actor, project, org.date, "10"));
    await withOrgTransaction(org.orgId, () =>
      submitPayApplication(org.orgId, actor, prior.id, [{ sovLineId: sov, thisPeriodCompleted: "333.33", materialsStored: "0" }]));
    await withOrgTransaction(org.orgId, () => approvePayApplication(org.orgId, approver, prior.id));
    const generated = await withOrgTransaction(org.orgId, () => generatePayApplicationInvoice(org.orgId, actor, prior.id));
    await postInvoice(org, actor, approver, "customer_invoice", generated.invoiceId);
    const draft = await withOrgTransaction(org.orgId, () => createPayApplication(org.orgId, actor, project, nextDay(org.date), "10"));

    let held = false;
    const holder = holdRowLock(org.orgId, "projects", project, () => { held = true; }, released);
    while (!held) await sleep(50);

    const submit = withOrgTransaction(org.orgId, () =>
      submitPayApplication(org.orgId, actor, draft.id, [{ sovLineId: sov, thisPeriodCompleted: "333.33", materialsStored: "0" }]));
    const verdict = await Promise.race([submit.then(() => "finished" as const), sleep(3000)]);
    try {
      assert.equal(verdict, "blocked", "the second submit must wait on the project lock while the replay reads settled history");
    } finally {
      releaseLock();
    }
    const computed = await submit;
    // Cumulative 666.66 at 10% is 66.67; 33.33 already settled.
    assert.equal(computed.retainageThisPeriod, "33.3400");
    await holder;
  } finally {
    releaseLock();
    await dropScratchOrgReporting(org.orgId);
  }
});

test("concurrent vendor draws serialize on the subcontract lock during replay", enabled, async () => {
  const org = await createScratchOrg();
  let releaseLock!: () => void;
  const released = new Promise<void>((resolve) => { releaseLock = resolve; });
  try {
    const { actor, approver } = await adminActor(org);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"subcontracts":true}'::jsonb) where id=${org.orgId}`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('retainageReceivable',${org.accounts.invAsset}::text,'retainagePayable',${org.accounts.invAsset}::text)) where id=${org.orgId}`);
    const type = await policyType(org.orgId, "lock_vend");
    const project = randomUUID(), vendor = randomUUID(), subcontract = randomUUID(), sov = randomUUID();
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status)
      values(${project},${org.orgId},${org.subsidiaryId},'LOCK-V','Vendor lock job',${org.customerId},${type},'active')`);
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,is_active) values(${vendor},${org.orgId},'vendor','Lock vendor',true)`);
    await db.execute(sql`insert into subcontracts(id,org_id,project_id,vendor_id,number,title,currency,original_commitment,status) values(${subcontract},${org.orgId},${project},${vendor},'SC-LOCK','Lock scope','CAD','5000','active')`);
    await db.execute(sql`insert into subcontract_sov_lines(id,org_id,subcontract_id,description,scheduled_value,expense_account_id,sort_order) values(${sov},${org.orgId},${subcontract},'Work','10000',${org.accounts.cogs},1)`);

    const draw = async (work: string, date: string) => {
      const app = await withOrgTransaction(org.orgId, () => createVendorPayApplication({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: date }));
      await withOrgTransaction(org.orgId, () => updateVendorPayApplicationLines({ orgId: org.orgId, userId: actor, payApplicationId: app.id, lines: [{ sovLineId: sov, workCompletedThisPeriod: work, materialsStoredCurrent: "0" }] }));
      return app.id;
    };
    // Fully close the prior draw first: the domain refuses a second open
    // draw, so the race under test is a later submit replaying settled
    // history while another transaction holds the subcontract.
    const closeDraw = async (work: string, date: string): Promise<string> => {
      const appId = await draw(work, date);
      await withOrgTransaction(org.orgId, () => submitVendorPayApplication(org.orgId, actor, appId));
      await withOrgTransaction(org.orgId, () => approveVendorPayApplication(org.orgId, approver, appId));
      const generated = await withOrgTransaction(org.orgId, () => generateVendorPayApplicationBill(org.orgId, actor, appId));
      await postInvoice(org, actor, approver, "vendor_bill", generated.vendorBillDocumentId);
      return appId;
    };
    await closeDraw("333.33", org.date);
    const draftId = await draw("333.33", nextDay(org.date));

    let held = false;
    const holder = holdRowLock(org.orgId, "subcontracts", subcontract, () => { held = true; }, released);
    while (!held) await sleep(50);

    const submit = withOrgTransaction(org.orgId, () => submitVendorPayApplication(org.orgId, actor, draftId));
    const verdict = await Promise.race([submit.then(() => "finished" as const), sleep(3000)]);
    try {
      assert.equal(verdict, "blocked", "the second submit must wait on the subcontract lock while the replay reads settled history");
    } finally {
      releaseLock();
    }
    const computed = await submit;
    assert.equal(computed.retainageThisPeriod, "33.3400");
    await holder;
  } finally {
    releaseLock();
    await dropScratchOrgReporting(org.orgId);
  }
});
