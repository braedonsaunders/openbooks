import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * The next-bill-date edit must serialize with the billing tick on the
 * subscription row lock: an edit validated against a pre-bill cursor must
 * never commit after the tick and rewind into billed service. The edit
 * either applies after the bill against fresh state (a forward skip with a
 * reason) or is refused by name — and no interleaving double-bills a period.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const engineRoot = new URL("../../../../engine/", import.meta.url).href;
const state: { orgId: string; actorId: string; allowedSubsidiaryIds: ReadonlySet<string> | null } = {
  orgId: "", actorId: "", allowedSubsidiaryIds: null,
};
Object.assign(globalThis, { __subscriptionRaceState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__subscriptionRaceState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['ar.create']), allowedSubsidiaryIds: s.allowedSubsidiaryIds };
        }
        export function guardSubsidiaryScope(authz, subsidiaryId, opts = {}) {
          if (authz.allowedSubsidiaryIds === null || (subsidiaryId == null && opts.orgWideNull) || authz.allowedSubsidiaryIds.has(subsidiaryId)) return null;
          return new Response(JSON.stringify({error:'not found'}), {status:404});
        }
        export function guardUnrestrictedScope(authz) {
          return authz.allowedSubsidiaryIds === null ? null : new Response(JSON.stringify({error:'requires unrestricted subsidiary access'}), {status:403});
        }
      `);
    if (specifier.endsWith("/lib/features"))
      return virtual("export async function isFeatureEnabled() { return true }");
    if (specifier.startsWith("@openbooks/engine/")) {
      return next(new URL(specifier.slice("@openbooks/engine/".length), engineRoot).href, context);
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, pool, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, createScratchUser } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { runDueSubscriptions } = await import("@openbooks/engine/src/billing/subscription-billing.ts");
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture(): Promise<{ orgId: string; subscriptionId: string; subsidiaryId: string }> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Race Tester", "admin"));
  state.orgId = org.orgId;
  state.actorId = actorId;
  state.allowedSubsidiaryIds = null;
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = settings || '{"features":{"subscriptionBilling":true}}'::jsonb
     where id = ${org.orgId}`));
  // The scratch spine opens only July 2026; September billing needs its period.
  const calendarId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    select fiscal_calendar_id::text as id from accounting_periods where org_id = ${org.orgId} limit 1`))).rows[0]!.id;
  for (const month of [8, 9, 10]) {
    const startsOn = `2026-${String(month).padStart(2, "0")}-01`;
    const endsOn = new Date(Date.UTC(2026, month, 1) - 86_400_000).toISOString().slice(0, 10);
    await withBypassContext(() => db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${randomUUID()}, ${org.orgId}, 2026, ${month},
              ${startsOn.slice(0, 7)}, ${startsOn}, ${endsOn}, false, ${calendarId})`));
  }
  const planId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into subscription_plans
      (id, org_id, name, amount, interval, interval_count, income_account_id, is_active, created_by)
    values (${planId}, ${org.orgId}, 'Race Plan', '100.00', 'monthly', 1,
            ${org.accounts.revenue}, true, ${actorId})`));
  const subscriptionId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into subscriptions
      (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on, auto_post, created_by)
    values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${planId}, '1', 'active',
            '2026-09-01', '2026-09-01', true, ${actorId})`));
  return { orgId: org.orgId, subscriptionId, subsidiaryId: org.subsidiaryId };
}

const post = (body: unknown) =>
  withOrgContext(state.orgId, () =>
    POST(new Request("http://subs.test/api/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })),
  );

async function guards(orgId: string, subscriptionId: string): Promise<{ startsOn: string; endsOn: string }[]> {
  return (await withBypassContext(() => db.execute<{ startsOn: string; endsOn: string }>(sql`
    select period_starts_on as "startsOn", period_ends_on as "endsOn"
      from subscription_period_invoices
     where org_id = ${orgId} and subscription_id = ${subscriptionId}
     order by period_starts_on`))).rows;
}

async function cursor(orgId: string, subscriptionId: string): Promise<string> {
  return (await withBypassContext(() => db.execute<{ nextBillOn: string }>(sql`
    select next_bill_on as "nextBillOn" from subscriptions where id = ${subscriptionId} and org_id = ${orgId}`))).rows[0]!.nextBillOn;
}

async function invoiceCount(orgId: string): Promise<number> {
  return (await withBypassContext(() => db.execute<{ n: number }>(sql`
    select count(*)::int as n from documents
     where org_id = ${orgId} and kind = 'customer_invoice' and status <> 'voided'`))).rows[0]!.n;
}

test("an edit after the bill validates against fresh billed state, or refuses it", { skip: !DB }, async () => {
  const { orgId, subscriptionId } = await fixture();
  try {
    const billed = await runDueSubscriptions();
    assert.equal(billed.billed, 1);
    assert.equal(await cursor(orgId, subscriptionId), "2026-10-01");

    // Rewinding into the just-billed September window refuses by name.
    const rewind = await post({ action: "updateSubscription", id: subscriptionId, nextBillOn: "2026-09-15" });
    assert.equal(rewind.status, 422);
    assert.match(String((await rewind.json() as { error: string }).error), /already-billed service through 2026-10-01/);
    assert.equal(await cursor(orgId, subscriptionId), "2026-10-01");

    // A forward skip past the fresh boundary applies with its audit trail.
    const skip = await post({
      action: "updateSubscription", id: subscriptionId, nextBillOn: "2026-11-01",
      skipUnbilledService: true, skipReason: "tenant paused October",
    });
    assert.equal(skip.status, 200);
    assert.deepEqual((await skip.json() as { skippedWindow: unknown }).skippedWindow, {
      from: "2026-10-01", to: "2026-11-01",
    });

    // September was billed exactly once, under exactly one guard.
    assert.deepEqual(await guards(orgId, subscriptionId), [{ startsOn: "2026-09-01", endsOn: "2026-10-01" }]);
    assert.equal(await invoiceCount(orgId), 1);
  } finally {
    await withBypassContext(() => db.execute(sql`delete from scheduler_outbox where org_id = ${orgId}`));
    await withBypassContext(() => dropScratchOrg(orgId));
  }
});

test("add subscription rechecks customer scope after a concurrent rehome", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Add race tester", "admin"));
  state.orgId = org.orgId;
  state.actorId = actorId;
  state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
  const customerId = org.customerId;
  const planId = randomUUID();
  const outsideSubsidiaryId = randomUUID();
  const holder = await pool.connect();
  try {
    await withBypassContext(() => db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, is_elimination, is_active, custom)
      values (${outsideSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Other Co', 'CAD', 'CA', false, true, '{}'::jsonb)`));
    await withBypassContext(() => db.execute(sql`
      update parties set subsidiary_id = ${org.subsidiaryId} where id = ${customerId} and org_id = ${org.orgId}`));
    await withBypassContext(() => db.execute(sql`
      insert into subscription_plans
        (id, org_id, name, amount, interval, interval_count, income_account_id, is_active, created_by)
      values (${planId}, ${org.orgId}, 'Scope Race Plan', '100.00', 'monthly', 1,
              ${org.accounts.revenue}, true, ${actorId})`));

    // The preflight scope read sees subsidiary A. Hold the customer row while
    // the request reaches its in-transaction FOR SHARE, then rehome it to B.
    await holder.query("begin");
    await holder.query("select set_config('app.bypass_rls', 'on', true)");
    await holder.query("select id from parties where id = $1 for update", [customerId]);
    const adding = post({
      action: "addSubscription", customerId, planId,
      startOn: "2026-09-01", firstBillOn: "2026-09-01",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await holder.query("update parties set subsidiary_id = $2 where id = $1", [customerId, outsideSubsidiaryId]);
    await holder.query("commit");

    const response = await adding;
    assert.equal(response.status, 404);
    assert.match(String((await response.json() as { error: string }).error), /not found/);
    const count = (await withBypassContext(() => db.execute<{ count: number }>(sql`
      select count(*)::int as count from subscriptions
       where org_id = ${org.orgId} and customer_id = ${customerId}`))).rows[0]!.count;
    assert.equal(count, 0, "the scoped request must not commit a subscription after the customer leaves its scope");
  } finally {
    try { await holder.query("rollback"); } catch { /* already released */ }
    holder.release();
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an edit racing a concurrent bill validates under the row lock", { skip: !DB }, async () => {
  const { orgId, subscriptionId } = await fixture();
  const holder = await pool.connect();
  const writer = await pool.connect();
  try {
    // September is billed first: cursor Oct 1, one guard. A move to Oct 15
    // with an explicit skip is allowed against exactly this state.
    assert.equal((await runDueSubscriptions()).billed, 1);
    assert.equal(await cursor(orgId, subscriptionId), "2026-10-01");

    // Barrier, part one: hold the subscription row from a second connection
    // while the edit parks. FOR KEY SHARE (not the claim's FOR UPDATE)
    // deliberately: it still blocks the edit's SELECT ... FOR UPDATE, but it
    // stays compatible with the replayed bill's foreign-key check below, so
    // the bill can commit while the edit stays parked.
    await holder.query("begin");
    await holder.query("select set_config('app.bypass_rls', 'on', true)");
    await holder.query("select id from subscriptions where id = $1 for key share", [subscriptionId]);

    // The edit starts and parks on the held lock — before reading a row on
    // the fixed code (SELECT ... FOR UPDATE first), after validating stale
    // state on the old code (which only locks at the UPDATE). The pause lets
    // it park; green does not depend on the timing, because the October bill
    // below always commits before the holder releases.
    const edit = post({
      action: "updateSubscription", id: subscriptionId, nextBillOn: "2026-10-15",
      skipUnbilledService: true, skipReason: "tenant paused early October",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Barrier, part two: while the edit is parked, a concurrent October bill
    // commits its invoice plus its guard (its row claim serializes behind
    // the holder, so the invoice and guard are replayed here directly — the
    // validation input the edit must see). The boundary is now Nov 1, which
    // turns the parked Oct 15 skip into a backward move into billed service.
    // Each guard needs its own invoice (one guard per invoice, by constraint).
    const customerId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
      select customer_id as "id" from subscriptions where id = ${subscriptionId}`))).rows[0]!.id;
    const octoberInvoiceId = randomUUID();
    await writer.query("begin");
    await writer.query("select set_config('app.bypass_rls', 'on', true)");
    await writer.query(
      `insert into documents
         (id, org_id, kind, status, document_number, party_id, document_date, due_date,
          currency, fx_rate, subtotal, tax_total, total)
       values ($1, $2, 'customer_invoice', 'draft', $3, $4, '2026-10-01', '2026-10-31',
               'CAD', '1', '100', '0', '100')`,
      [octoberInvoiceId, orgId, `OCT-${randomUUID().slice(0, 8)}`, customerId],
    );
    await writer.query(
      `insert into subscription_period_invoices
         (org_id, subscription_id, period_starts_on, period_ends_on, contract_revision, invoice_id, created_by, updated_by)
       values ($1, $2, '2026-10-01', '2026-11-01', 1, $3, null, null)`,
      [orgId, subscriptionId, octoberInvoiceId],
    );
    await writer.query("commit");

    // Release: the edit now reads under the lock. Fresh state refuses the
    // Oct 15 skip as already-billed through Nov 1; stale validation would
    // have allowed it and committed a jump over the October bill.
    await holder.query("rollback");
    const response = await edit;
    assert.equal(response.status, 422);
    assert.match(String((await response.json() as { error: string }).error), /already-billed service through 2026-11-01/);
    assert.equal(await cursor(orgId, subscriptionId), "2026-10-01");
    assert.deepEqual(await guards(orgId, subscriptionId), [
      { startsOn: "2026-09-01", endsOn: "2026-10-01" },
      { startsOn: "2026-10-01", endsOn: "2026-11-01" },
    ]);
  } finally {
    try { await holder.query("rollback"); } catch { /* already released */ }
    holder.release();
    writer.release();
    await withBypassContext(() => db.execute(sql`delete from scheduler_outbox where org_id = ${orgId}`));
    await withBypassContext(() => dropScratchOrg(orgId));
  }
});

test("a bill-vs-edit race never double-bills: the edit loses against fresh state", { skip: !DB }, async () => {
  const { orgId, subscriptionId } = await fixture();
  try {
    // The editor's Sep 15 move is valid against the pre-bill cursor only as
    // an explicit forward skip — and invalid once September is billed. The
    // two run together; every interleaving must end with one September
    // invoice and a refused (never half-applied) edit. A stale write would
    // rewind the cursor behind the tick and the follow-up tick would cut a
    // second, overlapping invoice.
    const editFirst = post({ action: "updateSubscription", id: subscriptionId, nextBillOn: "2026-09-15" });
    const [edit, billed] = await Promise.all([editFirst, runDueSubscriptions()]);
    assert.equal(edit.status, 422);
    assert.match(String((await edit.json() as { error: string }).error), /billed service|skips unbilled service/);
    assert.equal((await billed).billed, 1);
    assert.deepEqual(await guards(orgId, subscriptionId), [{ startsOn: "2026-09-01", endsOn: "2026-10-01" }]);
    assert.equal(await invoiceCount(orgId), 1);
    assert.equal(await cursor(orgId, subscriptionId), "2026-10-01");
    const followUp = await runDueSubscriptions();
    assert.equal(followUp.billed, 0);
    assert.equal(await invoiceCount(orgId), 1, "no overlapping second invoice after the race");
  } finally {
    await withBypassContext(() => db.execute(sql`delete from scheduler_outbox where org_id = ${orgId}`));
    await withBypassContext(() => dropScratchOrg(orgId));
  }
});

test("change and bill-now refuse after a customer rehome while waiting on its row lock", { skip: !DB }, async () => {
  for (const action of ["changeSubscription", "billNow"] as const) {
    const { orgId, subscriptionId, subsidiaryId } = await fixture();
    const holder = await pool.connect();
    try {
      const customerId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
        select customer_id as id from subscriptions where id = ${subscriptionId} and org_id = ${orgId}`))).rows[0]!.id;
      const subsidiaryB = randomUUID();
      await withBypassContext(() => db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${subsidiaryB}, ${orgId}, ${subsidiaryId}, 'Rehomed Entity', 'CAD', 'CA')`));
      await withBypassContext(() => db.execute(sql`
        update parties set subsidiary_id = ${subsidiaryId} where id = ${customerId} and org_id = ${orgId}`));
      state.allowedSubsidiaryIds = new Set([subsidiaryId]);

      await holder.query("begin");
      await holder.query("select set_config('app.bypass_rls', 'on', true)");
      await holder.query("select id from parties where id = $1 for update", [customerId]);
      const pending = post(action === "changeSubscription"
        ? { action, id: subscriptionId, quantity: "2" }
        : { action, id: subscriptionId });

      let waiting = 0;
      const deadline = Date.now() + 10_000;
      while (waiting === 0 && Date.now() < deadline) {
        waiting = (await holder.query(`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'`)).rows[0].n as number;
        if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(waiting > 0, `${action} must wait on the customer row`);
      await holder.query("update parties set subsidiary_id = $1 where id = $2 and org_id = $3", [subsidiaryB, customerId, orgId]);
      await holder.query("commit");

      const response = await pending;
      assert.equal(response.status, 404, `${action}: ${JSON.stringify(await response.clone().json())}`);
      assert.deepEqual(await response.json(), { error: "not found" });
      const after = (await withBypassContext(() => db.execute<{ quantity: string; runCount: number; lastInvoiceId: string | null }>(sql`
        select quantity::text as quantity, run_count as "runCount", last_invoice_id as "lastInvoiceId"
          from subscriptions where id = ${subscriptionId} and org_id = ${orgId}`))).rows[0]!;
      assert.equal(after.quantity, "1.0000", `${action} must not change subscription quantity`);
      assert.equal(after.runCount, 0, `${action} must not book an invoice`);
      assert.equal(after.lastInvoiceId, null);
      assert.equal(await invoiceCount(orgId), 0);
    } finally {
      try { await holder.query("rollback"); } catch { /* already released */ }
      holder.release();
      state.allowedSubsidiaryIds = null;
      await withBypassContext(() => db.execute(sql`delete from scheduler_outbox where org_id = ${orgId}`));
      await withBypassContext(() => dropScratchOrg(orgId));
    }
  }
});
