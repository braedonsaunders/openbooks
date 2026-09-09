import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { registerHooks } from "node:module";
import type { Authz } from "./authz";
import { sql } from "drizzle-orm";
import { db, pool } from "@openbooks/engine/src/db.ts";
import { laborClearingReconciliation, postPayrollVariance } from "@openbooks/engine/src/labor-costing.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "@openbooks/engine/src/test-fixtures.ts";

const enabled = !!process.env.OPENBOOKS_DB_URL;
const periodStart = "2026-07-01";
const periodEnd = "2026-07-31";

async function configure(org: ScratchOrg) {
  await setProjects(org.orgId, true);
  await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts}',
    (settings->'controlAccounts') || ${JSON.stringify({
      laborClearing: org.accounts.clearing,
      payrollVariance: org.accounts.freight,
    })}::jsonb) where id = ${org.orgId}`);
  return (await seedFlowActors(org.orgId)).adminId;
}

async function postFixtureJournal(org: ScratchOrg, actorId: string, bookId: string,
  origin: string, clearingAmount: string, projectId: string | null = null) {
  return db.transaction(async (tx) => {
    const id = randomUUID();
    await tx.execute(sql`insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
       status, origin, created_by, updated_by)
      values (${id}, ${org.orgId}, ${bookId}, ${org.subsidiaryId}, ${`FIX-${id}`},
        ${periodEnd}, ${org.periodId}, 'draft', ${origin}, ${actorId}, ${actorId})`);
    await tx.execute(sql`insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount,
       currency, txn_amount, fx_rate, project_id)
      values (${org.orgId}, ${id}, 1, ${org.accounts.clearing}, ${org.subsidiaryId},
        ${clearingAmount}, 'CAD', ${clearingAmount}, 1, null),
        (${org.orgId}, ${id}, 2, ${org.accounts.cogs}, ${org.subsidiaryId},
        -${clearingAmount}::numeric, 'CAD', -${clearingAmount}::numeric, 1, ${projectId})`);
    await tx.execute(sql`update journal_entries set status = 'posted', posted_at = now(),
      posted_by = ${actorId} where org_id = ${org.orgId} and id = ${id}`);
    return id;
  });
}

async function seedBooks(org: ScratchOrg, actorId: string) {
  const taxBookId = randomUUID();
  const projectId = randomUUID();
  await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
    values (${taxBookId}, ${org.orgId}, 'TAX', 'Tax', false, true, true)`);
  await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status)
    values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'LAB-BOOK', 'Labor book scope', ${org.customerId}, 'active')`);
  for (const bookId of [org.bookId, taxBookId]) {
    await postFixtureJournal(org, actorId, bookId, "labor_burden", "-100", projectId);
    await postFixtureJournal(org, actorId, bookId, "payroll", "80");
  }
  return { taxBookId, projectId };
}


// Only the authenticated identity is substituted. Feature reads, request parsing,
// authorization helpers, tenant transactions, and financial services are native.
const state: { gate: Authz | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.labor-feature-race")] = state;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "../../../../../lib/authz" && decodeURIComponent(context.parentURL ?? "").endsWith("/api/admin/setup/labor-costing/route.ts")) {
    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
      `export * from ${JSON.stringify(new URL("./authz.ts", import.meta.url).href)};
       export async function guardPermission(){return globalThis[Symbol.for('openbooks.labor-feature-race')].gate}`) };
  }
  return next(specifier, context);
} });
const { PUT, POST } = await import("../app/api/admin/setup/labor-costing/route");

async function setProjects(orgId: string, projects: boolean) {
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb)||${JSON.stringify({ projects })}::jsonb) where id=${orgId}`);
}

async function snapshot(orgId: string) {
  const result: Record<string, unknown> = {};
  result.org = (await db.execute(sql`select settings,updated_at,updated_by from orgs where id=${orgId}`)).rows;
  for (const table of ["labor_cost_rates", "journal_entries", "journal_lines", "audit_log"]) {
    result[table] = (await db.execute(sql`select to_jsonb(t) as row from ${sql.identifier(table)} t
      where org_id=${orgId} order by to_jsonb(t)::text`)).rows;
  }
  return result;
}

function request(method: string, body: Record<string, unknown>) {
  return new Request("https://openbooks.test/api/admin/setup/labor-costing", {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

async function fixture() {
  const org = await createScratchOrg();
  const actorId = await configure(org);
  await seedBooks(org, actorId);
  state.gate = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(["*"]), allowedSubsidiaryIds: null } as Authz;
  return { org, actorId };
}

test("disabled Projects refuses labor reconciliation and variance before configuration or journal changes", { skip: !enabled }, async () => {
  const { org, actorId } = await fixture();
  try {
    const opts = { orgId: org.orgId, actorId, periodStart, periodEnd, subsidiaryId: org.subsidiaryId };
    await setProjects(org.orgId, false);
    const unposted = await snapshot(org.orgId);
    await assert.rejects(() => postPayrollVariance(opts), /projects feature is disabled/);
    assert.deepEqual(await snapshot(org.orgId), unposted, "disabled initial variance must not create a journal");
    await setProjects(org.orgId, true);
    const first = await postPayrollVariance(opts);
    assert.equal(first.variance, "20.0000");
    await setProjects(org.orgId, false);
    const before = await snapshot(org.orgId);
    await assert.rejects(() => laborClearingReconciliation(org.orgId, periodStart, periodEnd, org.subsidiaryId), /projects feature is disabled/);
    await assert.rejects(() => postPayrollVariance(opts), /projects feature is disabled/);
    assert.deepEqual(await snapshot(org.orgId), before, "disabled reruns must not reverse the retained variance or add audit evidence");
    await setProjects(org.orgId, true);
    const recovered = await postPayrollVariance(opts);
    assert.equal(recovered.variance, "20.0000");
    assert.ok(recovered.entryId);
    assert.notEqual(recovered.entryId, first.entryId);
    assert.equal((await laborClearingReconciliation(org.orgId, periodStart, periodEnd, org.subsidiaryId))?.openBalance, "0.0000");
  } finally { state.gate = null; await dropScratchOrg(org.orgId); }
});

for (const action of ["settings", "save-rate", "end-rate", "delete-rate", "reconcile", "post-variance"]) {
  test(`${action} rejects a Projects disable committed during request parsing without changing retained data`, { skip: !enabled }, async () => {
    const { org } = await fixture();
    try {
      const seeded = await POST(request("POST", { action: "save-rate", currency: "CAD", rate: "30", effectiveFrom: periodStart }));
      assert.equal(seeded.status, 200);
      const rate = (await db.execute<{ id: string }>(sql`select id from labor_cost_rates where org_id=${org.orgId}`)).rows[0]!;
      const method = action === "settings" ? "PUT" : "POST";
      const handler = action === "settings" ? PUT : POST;
      const body: Record<string, unknown> = action === "settings"
        ? { settings: { mode: "post", hoursPerDay: "7.5" }, laborClearing: org.accounts.clearing }
        : { action, id: rate.id, currency: "CAD", rate: "35", effectiveFrom: "2026-07-10", effectiveTo: periodEnd,
            periodStart, periodEnd, subsidiaryId: action === "save-rate" ? undefined : org.subsidiaryId };
      const req = request(method, body);
      const original = req.json.bind(req);
      let before: Awaited<ReturnType<typeof snapshot>> | undefined;
      req.json = async () => {
        // This executes only after the route's native initial feature guard.
        await setProjects(org.orgId, false);
        before = await snapshot(org.orgId);
        return original();
      };
      const denied = await handler(req);
      assert.ok(before, "request must pass the enabled feature guard before disabling Projects");
      assert.equal(denied.status, 404, JSON.stringify(await denied.json()));
      assert.deepEqual(await snapshot(org.orgId), before, "no policy, rates, GL, or audit writes after disable");
      assert.equal((await handler(request(method, body))).status, 404, "already disabled requests also fail closed");
      await setProjects(org.orgId, true);
      const recovered = await handler(request(method, body));
      assert.equal(recovered.status, 200, JSON.stringify(await recovered.json()));
    } finally { state.gate = null; await dropScratchOrg(org.orgId); }
  });
}

async function waitForBlocker(pid: number) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const row = (await pool.query<{ blocked: boolean }>(
      "select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))) as blocked", [pid],
    )).rows[0]!;
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("request must reach the transaction's row lock before the concurrent change commits");
}

test("labor settings refuse an account deactivation committed while the account validation waits", { skip: !enabled }, async () => {
  const { org } = await fixture();
  const writer = await pool.connect();
  let pending: Promise<Response> | undefined;
  try {
    const before = await snapshot(org.orgId);
    await writer.query("begin");
    await writer.query("select set_config('app.bypass_rls','on',true)");
    await writer.query("update accounts set is_active=false where org_id=$1 and id=$2", [org.orgId, org.accounts.freight]);
    const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    pending = PUT(request("PUT", { settings: { mode: "post" }, payrollVariance: org.accounts.freight }));
    void pending.catch(() => {});
    await waitForBlocker(pid);
    await writer.query("commit");
    const denied = await pending;
    assert.equal(denied.status, 422, JSON.stringify(await denied.json()));
    assert.deepEqual(await snapshot(org.orgId), before, "invalid account must not change configuration or audit evidence");
  } finally {
    await writer.query("rollback");
    writer.release();
    await pending?.catch(() => {});
    state.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("concurrent labor settings saves serialize their before/after audit images", { skip: !enabled, timeout: 10_000 }, async () => {
  const { org } = await fixture();
  try {
    const responses = await Promise.all(["7", "9"].map((hoursPerDay) =>
      PUT(request("PUT", { settings: { mode: "post", hoursPerDay } })),
    ));
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    const images = (await db.execute<{ before: { hoursPerDay: string } | null; after: { hoursPerDay: string } }>(sql`
      select changes->'laborCosting'->0 as before, changes->'laborCosting'->1 as after
        from audit_log where org_id=${org.orgId} and table_name='orgs'`)).rows;
    assert.equal(images.length, 2);
    const first = images.find((row) => row.before === null)!;
    assert.ok(first, "exactly one settings save observes the original absent policy");
    const second = images.find((row) => row.before !== null)!;
    assert.deepEqual(second.before, first.after, "later save's before image must include the committed first save");
    const persisted = (await db.execute<{ policy: unknown }>(sql`select settings->'laborCosting' as policy from orgs where id=${org.orgId}`)).rows[0]!;
    assert.deepEqual(persisted.policy, second.after);
  } finally { state.gate = null; await dropScratchOrg(org.orgId); }
});
