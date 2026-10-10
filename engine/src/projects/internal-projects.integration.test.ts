import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { registerHooks } from "node:module";
import type { SessionUser } from "../../../lib/auth";

/**
 * Internal (shop/overhead) projects: a non-billable time target per legal
 * entity for shop days, so they stop booking to customer jobs. Creation
 * refuses a customer or invoicing configuration on an internal project;
 * internal time posts no labor cost (overhead stays statistical, no company
 * ledger moves); and the flag locks once time is booked — at the API with a
 * named refusal and in storage with a guard trigger.
 */
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __internalProjectSession: session });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next-intl/server") {
      return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
    }
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
      return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__internalProjectSession.user}" };
    }
    return next(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { createProject } = await import("./project-create.ts");
const { postProjectLaborCost } = await import("./recognition.ts");
const projectRoute = await import("../../../app/api/projects/[id]/route.ts");

function asUser(id: string, orgId: string): SessionUser {
  return {
    id, orgId, name: "Internal project probe", email: `probe-${id.slice(0, 8)}@scratch.test`, roles: [],
    isSuperAdmin: false, envKind: "production", productionOrgId: orgId, homeOrgId: orgId, homeUserId: id,
  };
}

async function seed() {
  const org = await createScratchOrg();
  const actor = await createScratchUser(org.orgId, "Project editor", "reviewer");
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
  await db.execute(sql`update orgs set settings=settings || ${JSON.stringify({
    features: { projects: true, timeTracking: true },
    controlAccounts: { laborWip: org.accounts.cogs, laborClearing: org.accounts.clearing },
  })}::jsonb where id=${org.orgId}`);
  const employeeId = randomUUID();
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values(${employeeId},${org.orgId},'employee','Shop tech',${org.subsidiaryId},true,'{}'::jsonb)`);
  await db.execute(sql`insert into employee_roles(id,org_id,party_id,is_active)
    values(${randomUUID()},${org.orgId},${employeeId},true)`);
  session.user = asUser(actor, org.orgId);
  return { org, actor, employeeId };
}

async function projectFlag(orgId: string, projectId: string): Promise<boolean> {
  return (await db.execute<{ is_internal: boolean }>(sql`
    select is_internal from projects where org_id = ${orgId} and id = ${projectId}
  `)).rows[0]!.is_internal;
}

test("an internal project creates customer-less and refuses customer or invoicing configuration", async () => {
  const { org, actor } = await seed();
  try {
    const ctx = { orgId: org.orgId, actorId: actor, allowedSubsidiaryIds: null };
    const shop = randomUUID();
    const created = await createProject(ctx, shop, { name: "Shop", subsidiaryId: org.subsidiaryId, isInternal: true });
    assert.equal(created.created, true);
    assert.equal(await projectFlag(org.orgId, shop), true, "the internal flag persists");

    await assert.rejects(
      createProject(ctx, randomUUID(), { name: "Bad shop", subsidiaryId: org.subsidiaryId, isInternal: true, customerId: org.customerId }),
      /no customer/,
      "an internal project cannot name a customer",
    );
    await assert.rejects(
      createProject(ctx, randomUUID(), {
        name: "Bad shop", subsidiaryId: org.subsidiaryId, isInternal: true,
        invoicingPreference: { defaultBasis: "time_selection" },
      }),
      /no invoicing configuration/,
      "an internal project cannot carry invoicing configuration",
    );
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("internal time posts no labor cost while customer time does", async () => {
  const { org, actor, employeeId } = await seed();
  try {
    const ctx = { orgId: org.orgId, actorId: actor, allowedSubsidiaryIds: null };
    const shop = randomUUID();
    await createProject(ctx, shop, { name: "Shop", subsidiaryId: org.subsidiaryId, isInternal: true });
    const job = randomUUID();
    await createProject(ctx, job, { name: "Customer job", subsidiaryId: org.subsidiaryId, customerId: org.customerId });
    const shopEntry = randomUUID();
    const jobEntry = randomUUID();
    for (const [entry, project] of [[shopEntry, shop], [jobEntry, job]] as const) {
      await db.execute(sql`insert into time_entries
        (id,org_id,employee_party_id,worked_on,hours,project_id,status,cost_rate,cost_rate_currency,cost_rate_subsidiary_id,costing_basis,is_billable,custom,created_by,updated_by)
        values(${entry},${org.orgId},${employeeId},${org.date},2,${project},'approved',25,'CAD',${org.subsidiaryId},'actual',false,'{}'::jsonb,${actor},${actor})`);
    }
    const posted = await postProjectLaborCost(org.orgId, actor, [shopEntry, jobEntry]);
    assert.equal(posted.length, 1, "only the customer job posts a labor journal");
    const states = (await db.execute<{ id: string; cost_journal_entry_id: string | null }>(sql`
      select id, cost_journal_entry_id from time_entries where org_id = ${org.orgId} and id in (${shopEntry}, ${jobEntry})
    `)).rows;
    assert.equal(
      states.find((row) => row.id === shopEntry)?.cost_journal_entry_id,
      null,
      "internal time stays statistical: no cost journal",
    );
    assert.ok(
      states.find((row) => row.id === jobEntry)?.cost_journal_entry_id,
      "customer time still costs to WIP",
    );
    const journals = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries where org_id = ${org.orgId}
    `)).rows[0]!.n;
    assert.equal(journals, 1, "internal time alone moves no company ledger");
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});

test("the internal flag locks once time is booked, in storage and at the API", async () => {
  const { org, actor, employeeId } = await seed();
  try {
    const ctx = { orgId: org.orgId, actorId: actor, allowedSubsidiaryIds: null };
    const shop = randomUUID();
    await createProject(ctx, shop, { name: "Shop", subsidiaryId: org.subsidiaryId, isInternal: true });
    const entry = randomUUID();
    await db.execute(sql`insert into time_entries
      (id,org_id,employee_party_id,worked_on,hours,project_id,status,cost_rate,cost_rate_currency,cost_rate_subsidiary_id,costing_basis,is_billable,custom,created_by,updated_by)
      values(${entry},${org.orgId},${employeeId},${org.date},2,${shop},'approved',25,'CAD',${org.subsidiaryId},'actual',false,'{}'::jsonb,${actor},${actor})`);

    await assert.rejects(
      db.execute(sql`update projects set is_internal = false where id = ${shop} and org_id = ${org.orgId}`),
      /immutable/,
      "storage refuses the flip under booked time",
    );
    assert.equal(await projectFlag(org.orgId, shop), true);

    const res = await withOrgContext(org.orgId, () => projectRoute.PATCH(
      new Request("http://audit.local/api", { method: "PATCH", body: JSON.stringify({ isInternal: false }) }),
      { params: Promise.resolve({ id: shop }) },
    ));
    assert.equal(res.status, 422);
    assert.match(((await res.json()) as { error: string }).error, /immutable/);
    assert.equal(await projectFlag(org.orgId, shop), true, "the refused flip writes nothing");
  } finally {
    session.user = null;
    await dropScratchOrg(org.orgId);
  }
});
