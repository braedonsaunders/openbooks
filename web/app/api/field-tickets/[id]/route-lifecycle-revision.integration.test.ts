import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

const key = Symbol.for("openbooks.field-ticket-lifecycle-revision-test");
type Session = {
  user: { orgId: string; id: string };
  permissions: Set<string>;
  allowedSubsidiaryIds: Set<string> | null;
};
const state: { authz: Session | null } = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[key] = state;
// Only HTTP authentication is substituted; authority, revision locks, Flows and storage are native.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("/api/field-tickets/"))
      return { url: "mock:ticket-session", shortCircuit: true };
    if (specifier === "@/lib/feature-gates" && context.parentURL?.includes("/lib/api/route"))
      return { url: "mock:ticket-session", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "mock:ticket-session")
      return {
        format: "module",
        shortCircuit: true,
        source: `
      const state=globalThis[Symbol.for('openbooks.field-ticket-lifecycle-revision-test')];
      export async function guardPermission(){return state.authz??Response.json({error:'unauthorized'},{status:401})}
      export const guardFeaturePermission=guardPermission;
      export function guardSubsidiaryScope(authz,id){return authz.allowedSubsidiaryIds===null||authz.allowedSubsidiaryIds.has(id)?null:Response.json({error:'not_found'},{status:404})}
    `,
      };
    return next(url, context);
  },
});
const { POST } = await import("./route.ts");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, seedFlowActors, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { createFieldTicket, loadFieldTicket, saveCrewGrid, updateTicketHeader } =
  await import("../../../../lib/field-tickets");
const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

async function setup() {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => seedFlowActors(org.orgId));
    const id = await withBypassContext(async () => {
      await db.execute(
        sql`insert into user_permission_overrides (org_id,user_id,permission,effect) values (${org.orgId},${actor.adminId},'time.manage','grant')`,
      );
      await db.execute(
        sql`update orgs set settings=settings||${JSON.stringify({ features: { projects: true, fieldTickets: true } })}::jsonb where id=${org.orgId}`,
      );
      const project = randomUUID(),
        employee = randomUUID(),
        timeType = randomUUID();
      await db.execute(sql`insert into projects (id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
        values (${project},${org.orgId},${org.subsidiaryId},'CREW','Crew job',${org.customerId},'active',true,'{}'::jsonb)`);
      await db.execute(sql`insert into parties (id,org_id,kind,display_name,subsidiary_id,is_active,custom)
        values (${employee},${org.orgId},'employee','Crew member',${org.subsidiaryId},true,'{}'::jsonb)`);
      await db.execute(
        sql`insert into employee_roles (party_id,org_id,is_active) values (${employee},${org.orgId},true)`,
      );
      await db.execute(sql`insert into time_types (id,org_id,name,is_active,show_on_field_ticket,classification)
        values (${timeType},${org.orgId},'Regular',true,true,'regular')`);
      state.authz = {
        user: { orgId: org.orgId, id: actor.adminId },
        permissions: new Set(["time.manage"]),
        allowedSubsidiaryIds: null,
      };
      const created = await createFieldTicket(org.orgId, actor.adminId, {
        projectId: project,
        period: "daily",
        date: "2026-04-01",
        allowedSubsidiaryIds: null,
      });
      const ticket = await loadFieldTicket(org.orgId, created.id);
      await saveCrewGrid(
        org.orgId,
        actor.adminId,
        created.id,
        [
          {
            employeePartyId: employee,
            itemId: null,
            timeTypeId: timeType,
            hours: { "2026-04-01": "2" },
          },
        ],
        ticket.revision,
        null,
      );
      return created.id;
    });
    return { org, actor: actor.adminId, id };
  } catch (error) {
    state.authz = null;
    await dropScratchOrg(org.orgId);
    throw error;
  }
}
async function post(orgId: string, id: string, body: unknown) {
  return withOrgContext(orgId, () =>
    POST(
      new Request(`http://openbooks.test/api/field-tickets/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
}
async function read(orgId: string, id: string) {
  return withOrgContext(orgId, () => loadFieldTicket(orgId, id));
}
async function cleanup(orgId: string) {
  state.authz = null;
  await dropScratchOrg(orgId);
}

test(
  "field-ticket submit admits the drawer revision and refuses stale or undeclared inputs without lifecycle effects",
  enabled,
  async () => {
    const { org, actor, id } = await setup();
    try {
      const old = await read(org.orgId, id);
      await withOrgContext(org.orgId, () =>
        updateTicketHeader(org.orgId, actor, id, { memo: "Reviewed crew" }, old.revision, null),
      );
      const current = await read(org.orgId, id);
      assert.equal(
        (await post(org.orgId, id, { action: "submit", expectedRevision: old.revision })).status,
        409,
      );
      assert.equal(
        (
          await post(org.orgId, id, {
            action: "submit",
            expectedRevision: current.revision,
            approve: true,
          })
        ).status,
        400,
      );
      assert.equal((await post(org.orgId, id, { action: "submit" })).status, 400);
      assert.equal((await read(org.orgId, id)).revision, current.revision);
      assert.equal((await read(org.orgId, id)).status, "draft");
      const result = await post(org.orgId, id, {
        action: "submit",
        expectedRevision: current.revision,
      });
      assert.equal(result.status, 200, JSON.stringify(await result.clone().json()));
      assert.equal((await read(org.orgId, id)).status, "approved");
      assert.equal((await read(org.orgId, id)).entries.length, 1);
    } finally {
      await cleanup(org.orgId);
    }
  },
);

test(
  "field-ticket lifecycle commands recheck live authority and signature revision before retaining delivery work",
  enabled,
  async () => {
    const { org, actor, id } = await setup();
    try {
      const draft = await read(org.orgId, id);
      await withBypassContext(() =>
        db.execute(
          sql`update user_permission_overrides set effect='deny' where org_id=${org.orgId} and user_id=${actor} and permission='time.manage'`,
        ),
      );
      assert.equal(
        (await post(org.orgId, id, { action: "submit", expectedRevision: draft.revision })).status,
        404,
      );
      assert.equal((await read(org.orgId, id)).status, "draft");
      await withBypassContext(() =>
        db.execute(
          sql`update user_permission_overrides set effect='grant' where org_id=${org.orgId} and user_id=${actor} and permission='time.manage'`,
        ),
      );
      assert.equal(
        (await post(org.orgId, id, { action: "submit", expectedRevision: draft.revision })).status,
        200,
      );
      const approved = await read(org.orgId, id);
      const request = { action: "send-signature", to: "customer@example.test" };
      assert.equal(
        (await post(org.orgId, id, { ...request, expectedRevision: draft.revision })).status,
        409,
      );
      assert.equal((await post(org.orgId, id, request)).status, 400);
      // With current identity, the normal missing-delivery configuration refusal is reachable.
      const refused = await post(org.orgId, id, {
        ...request,
        expectedRevision: approved.revision,
      });
      assert.equal(refused.status, 422, JSON.stringify(await refused.clone().json()));
      const count = await withBypassContext(() =>
        db.execute<{ n: number }>(
          sql`select count(*)::int n from field_ticket_signature_requests where org_id=${org.orgId}`,
          "objects",
        ),
      );
      assert.equal(count[0]?.n, 0);
      assert.equal((await read(org.orgId, id)).revision, approved.revision);
    } finally {
      await cleanup(org.orgId);
    }
  },
);
