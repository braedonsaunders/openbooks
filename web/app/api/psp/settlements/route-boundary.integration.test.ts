import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Pool } from "pg";

/**
 * PSP settlement boundary: a malformed batch id on post/reverse must fail
 * closed as a clean 404 (never a Postgres uuid cast error surfacing as a
 * 500) — the same boundary the payment, view, and report-definition routes
 * keep for restricted callers.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" }, allowed: new Set<string>() };
Object.assign(globalThis, { __pspSettlementScopeState: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/api/json") {
      return next(root + "web/lib/api/json.ts", context);
    }
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/psp/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            export async function getAuthz(){
              return {
                user: globalThis.__pspSettlementScopeState.user,
                permissions: new Set(['banking.reconcile']),
                allowedSubsidiaryIds: new Set(globalThis.__pspSettlementScopeState.allowed),
              };
            }
            export function can(authz, permission){ return authz.permissions.has(permission); }
            export function guardSubsidiaryScope(authz, subsidiaryId, opts = {}){
              const allowed = authz.allowedSubsidiaryIds;
              if (allowed === null) return null;
              if (subsidiaryId != null && allowed.has(subsidiaryId)) return null;
              if (subsidiaryId == null && opts.orgWideNull) return null;
              return { status: 404, json: async () => ({ error: 'not found' }) };
            }
            export function guardUnrestrictedScope(authz){
              if (authz.allowedSubsidiaryIds === null) return null;
              return { status: 403, json: async () => ({ error: 'requires unrestricted subsidiary access' }) };
            }
          `),
      };
    }
    if (specifier.endsWith("/lib/features") && context.parentURL?.includes("/api/psp/")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function isFeatureEnabled(){ return true; } export async function subsidiaryFeatureEnabled(){ return true; }",
      };
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { importSettlementBatch, parseStripeBalanceTransactions, postSettlementBatch } = await import("@openbooks/engine/src/payments/psp-settlement.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { POST } = await import("./route.ts");

const json = (body: unknown) =>
  new Request("http://audit.local/api/psp/settlements", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("post rechecks the locked batch after a concurrent subsidiary rehome", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const holder = await new Pool({ connectionString: process.env.OPENBOOKS_DB_URL }).connect();
  try {
    const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
    const subsidiaryB = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into subsidiaries (id, org_id, name, base_currency, country, parent_id, tax_ids, is_elimination, is_active, custom)
      values (${subsidiaryB}, ${org.orgId}, 'Other Entity', 'CAD', 'CA', ${org.subsidiaryId}, '{}'::jsonb, false, true, '{}'::jsonb)
    `));
    const parsed = parseStripeBalanceTransactions([
      { id: "race-charge", type: "charge", amount: 10000, currency: "cad", fee: 0, net: 10000 },
    ], `psp-rehome-${org.orgId}`, org.date);
    const imported = await withOrgContext(org.orgId, () => importSettlementBatch(org.orgId, actorId, parsed, {
      bankAccountId: org.accounts.bank,
      feeAccountId: org.accounts.freight,
      clearingAccountId: org.accounts.clearing,
      subsidiaryId: org.subsidiaryId,
    }));
    state.user = { orgId: org.orgId, id: actorId };
    state.allowed = new Set([org.subsidiaryId]);
    await holder.query("begin");
    await holder.query("select set_config('app.bypass_rls', 'on', true)");
    const held = await holder.query("select id from psp_settlement_batches where id = $1 for update", [imported.batchId]);
    assert.equal(held.rows.length, 1);
    let settled = false;
    const pending = withOrgContext(org.orgId, () => POST(json({ action: "post", batchId: imported.batchId })))
      .then((response) => { settled = true; return response; });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.equal(settled, false, "POST must wait on the batch row lock");
    const waiting = (await holder.query(`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'
        and query ilike '%psp_settlement_batches%for update%'`)).rows[0].n as number;
    assert.ok(waiting > 0, "POST reached the locked batch row");
    await holder.query("update psp_settlement_batches set subsidiary_id = $1 where id = $2", [subsidiaryB, imported.batchId]);
    await holder.query("commit");
    const response = await pending;
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not found" });
    const batch = (await withBypassContext(() => db.execute(sql`
      select status, subsidiary_id from psp_settlement_batches where org_id = ${org.orgId} and id = ${imported.batchId}
    `))).rows[0] as { status: string; subsidiary_id: string };
    assert.deepEqual(batch, { status: "draft", subsidiary_id: subsidiaryB });
  } finally {
    await holder.query("rollback").catch(() => undefined);
    holder.release();
    state.user = { orgId: "", id: "" };
    state.allowed.clear();
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("reverse rechecks the locked batch after a concurrent subsidiary rehome", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const holder = await new Pool({ connectionString: process.env.OPENBOOKS_DB_URL }).connect();
  try {
    const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
    const subsidiaryB = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into subsidiaries (id, org_id, name, base_currency, country, parent_id, tax_ids, is_elimination, is_active, custom)
      values (${subsidiaryB}, ${org.orgId}, 'Other Entity', 'CAD', 'CA', ${org.subsidiaryId}, '{}'::jsonb, false, true, '{}'::jsonb)
    `));
    const parsed = parseStripeBalanceTransactions([
      { id: "reverse-race-charge", type: "charge", amount: 10000, currency: "cad", fee: 0, net: 10000 },
    ], `psp-reverse-rehome-${org.orgId}`, org.date);
    const imported = await withOrgContext(org.orgId, () => importSettlementBatch(org.orgId, actorId, parsed, {
      bankAccountId: org.accounts.bank,
      feeAccountId: org.accounts.freight,
      clearingAccountId: org.accounts.clearing,
      subsidiaryId: org.subsidiaryId,
    }));
    await postSettlementBatch(org.orgId, imported.batchId, actorId, null);
    state.user = { orgId: org.orgId, id: actorId };
    state.allowed = new Set([org.subsidiaryId]);
    await holder.query("begin");
    await holder.query("select set_config('app.bypass_rls', 'on', true)");
    const held = await holder.query("select id from psp_settlement_batches where id = $1 for update", [imported.batchId]);
    assert.equal(held.rows.length, 1);
    let settled = false;
    const pending = withOrgContext(org.orgId, () => POST(json({
      action: "reverse", batchId: imported.batchId, reversalDate: org.date, reason: "duplicate payout",
    }))).then((response) => { settled = true; return response; });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.equal(settled, false, "POST must wait on the batch row lock");
    const waiting = (await holder.query(`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'
        and query ilike '%psp_settlement_batches%for update%'`)).rows[0].n as number;
    assert.ok(waiting > 0, "POST reached the locked batch row");
    await holder.query("update psp_settlement_batches set subsidiary_id = $1 where id = $2", [subsidiaryB, imported.batchId]);
    await holder.query("commit");
    const response = await pending;
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not found" });
    const batch = (await withBypassContext(() => db.execute(sql`
      select status, subsidiary_id, reversal_entry_id from psp_settlement_batches where org_id = ${org.orgId} and id = ${imported.batchId}
    `))).rows[0] as { status: string; subsidiary_id: string; reversal_entry_id: string | null };
    assert.deepEqual(batch, { status: "posted", subsidiary_id: subsidiaryB, reversal_entry_id: null });
  } finally {
    await holder.query("rollback").catch(() => undefined);
    holder.release();
    state.user = { orgId: "", id: "" };
    state.allowed.clear();
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("post/reverse answer a malformed batch id with 404, never a 500", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    const subsidiaryId = (
      await withBypassContext(
        () =>
          db.execute<{ id: string }>(
            sql`select id from subsidiaries where org_id = ${org.orgId} and parent_id is null order by created_at limit 1`,
          ),
      )
    ).rows[0]!.id;
    state.allowed = new Set([subsidiaryId]);
    for (const body of [
      { action: "post", batchId: "not-a-uuid" },
      { action: "reverse", batchId: "not-a-uuid", reversalDate: "2026-02-01", reason: "duplicate" },
    ]) {
      const response = await POST(json(body));
      assert.equal(response.status, 404, `${body.action} not-a-uuid`);
      assert.deepEqual(await response.json(), { error: "not found" });
    }
    // A well-formed id that names nothing keeps the miss shape.
    const missing = await POST(json({ action: "post", batchId: randomUUID() }));
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not found" });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
