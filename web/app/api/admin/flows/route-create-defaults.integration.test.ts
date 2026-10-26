import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "../../../../lib/auth";

/**
 * A new flow starts enabled exactly when its initial graph validates: the
 * save path refuses to leave an enabled flow warning-bearing, so creation
 * applies the same lint. An empty draft graph stays disabled (it cannot
 * fire); a timer graph that lints clean starts enabled, audited.
 */
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __adminFlowsCreateUser: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier === "./auth" || specifier.endsWith("/lib/auth")) &&
      context.parentURL?.endsWith("/web/lib/authz.ts")
    ) {
      return virtual(
        "export async function currentUser(){return globalThis.__adminFlowsCreateUser.user}",
      );
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { POST: create } = await import("./route");

function sessionUser(id: string, orgId: string): SessionUser {
  return {
    id,
    orgId,
    name: "tester",
    email: `tester-${id.slice(0, 8)}@scratch.test`,
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: id,
  };
}

async function setupOrg(permissions: string[]) {
  const org = await withBypassContext(() => createScratchOrg());
  await withBypassContext(() =>
    db.execute(sql`
      update orgs set settings = jsonb_set(
        settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"flows":true,"hrm":true,"hrmShiftPlanning":true}'::jsonb, true)
      where id = ${org.orgId}`),
  );
  const userId = await withBypassContext(() =>
    createScratchUser(org.orgId, "flow_author", "flow_author"),
  );
  await withBypassContext(() =>
    db.execute(sql`
    update app_roles set permissions = ${JSON.stringify(permissions)}::jsonb
     where org_id = ${org.orgId} and key = 'flow_author'`),
  );
  state.user = sessionUser(userId, org.orgId);
  return { org, userId };
}

async function flowRow(orgId: string, id: string) {
  return (
    await withBypassContext(() =>
      db.execute<{ enabled: boolean }>(
        sql`
    select enabled from flows where id = ${id} and org_id = ${orgId}`,
        "objects",
      ),
    )
  )[0];
}

async function auditInserts(orgId: string, id: string) {
  return (
    await withBypassContext(() =>
      db.execute<{ n: string }>(
        sql`
    select count(*)::text as n from audit_log
     where org_id = ${orgId} and table_name = 'flows' and row_id = ${id} and action = 'insert'`,
        "objects",
      ),
    )
  )[0]?.n;
}

function post(body: unknown) {
  return new Request("http://admin.test/api/admin/flows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a draft-graph flow is created disabled and audited", async () => {
  const { org } = await setupOrg(["flows.manage"]);
  try {
    const res = await withOrgContext(org.orgId, () =>
      create(post({ name: "Bill approval", subjectKind: "vendor_bill" })),
    );
    assert.equal(res.status, 200, `create status: ${res.status}`);
    const { id } = (await res.json()) as { id: string };
    assert.equal(
      (await flowRow(org.orgId, id))?.enabled,
      false,
      "an empty draft graph cannot fire, so it stays disabled",
    );
    assert.equal(await auditInserts(org.orgId, id), "1", "creation is audited");
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a validating timer-graph flow is created enabled and audited", async () => {
  const { org } = await setupOrg(["flows.manage", "hrm.shifts.manage"]);
  try {
    const boardId = randomUUID();
    await withBypassContext(() =>
      db.execute(sql`
      insert into schedule_boards (id, org_id, code, name, row_kind, views, default_view, time_zone, subsidiary_id)
      values (${boardId}, ${org.orgId}, 'PEOPLE', 'People schedule', 'people', '{grid}', 'grid', 'America/Toronto', ${org.subsidiaryId})`),
    );
    const res = await withOrgContext(org.orgId, () =>
      create(post({ name: "Shift reminders", subjectKind: "schedule_board", boardId })),
    );
    assert.equal(res.status, 200, `create status: ${res.status}`);
    const { id } = (await res.json()) as { id: string };
    assert.equal(
      (await flowRow(org.orgId, id))?.enabled,
      true,
      "a graph that validates starts enabled",
    );
    assert.equal(await auditInserts(org.orgId, id), "1", "creation is audited");
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
