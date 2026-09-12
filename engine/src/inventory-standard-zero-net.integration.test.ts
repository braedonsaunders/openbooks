import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { withSimClock } from "./clock.ts";
import { documentRevisionSql } from "./document-revision.ts";
import { normalizeMoney } from "./money.ts";
import { getOnHand, issueInventory, receiveInventory, revalueOpenLayersToStandardCost } from "./inventory.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "./test-fixtures.ts";

// Exercise the actual profile HTTP handler. Only the authenticated request
// boundary is injected, as in inventory-costing-feature-race.integration.test.
const state: { gate: { user: { orgId: string; id: string }; allowedSubsidiaryIds: Set<string> | null } | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.standard-zero-net")] = state;
registerHooks({ resolve(specifier, context, next) {
  const parent = decodeURIComponent(context.parentURL ?? "");
  const virtual = (source: string) => ({ shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) });
  if (specifier === "server-only") return virtual("export {}");
  if (specifier.endsWith("/lib/feature-gates") && parent.endsWith("/costing/route.ts")) return virtual(
    "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.standard-zero-net')].gate}");
  if (specifier === "@/lib/api/json") return next(new URL("../../web/lib/api/json.ts", import.meta.url).href, context);
  return next(specifier, context);
} });
const { PUT }: { PUT: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> } =
  await import(new URL("../../web/app/api/items/[id]/costing/route.ts", import.meta.url).href);

async function profileRequest(org: ScratchOrg, varianceAccountId: string | null = null) {
  const revision = (await db.execute<{ revision: string }>(sql`select ${documentRevisionSql(sql`updated_at`)} as revision
    from item_inventory_profiles where org_id=${org.orgId} and item_id=${org.items.fifo}`)).rows[0]!.revision;
  return new Request(`http://localhost/api/items/${org.items.fifo}/costing`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      costingMethod: "standard", tracking: "none", standardCost: "10", expectedUpdatedAt: revision,
      assetAccountId: org.accounts.invAsset, cogsAccountId: org.accounts.cogs,
      adjustmentAccountId: org.accounts.adjustment, varianceAccountId,
      recostingAuthorization: "Controller authorized normalization of open FIFO layers to standard cost",
    }),
  });
}

async function layers(org: ScratchOrg) {
  return (await db.execute<{ id: string; unit_cost: string; remaining_original_cost: string | null; updated_by: string }>(sql`
    select id,unit_cost,remaining_original_cost,updated_by from cost_layers
    where org_id=${org.orgId} and item_id=${org.items.fifo} and remaining_quantity>0
    order by received_at,id`)).rows;
}

async function assetBalance(org: ScratchOrg) {
  return (await db.execute<{ balance: string }>(sql`select coalesce(sum(amount),0)::text as balance
    from journal_lines where org_id=${org.orgId} and account_id=${org.accounts.invAsset}`)).rows[0]!.balance;
}

async function financialEvidence(org: ScratchOrg) {
  return (await db.execute(sql`select
    (select jsonb_agg(to_jsonb(p) order by id) from item_inventory_profiles p where org_id=${org.orgId}) as profiles,
    (select jsonb_agg(to_jsonb(l) order by id) from cost_layers l where org_id=${org.orgId}) as layers,
    (select jsonb_agg(to_jsonb(a) order by id) from audit_log a where org_id=${org.orgId}) as audits,
    (select jsonb_agg(to_jsonb(j) order by id) from journal_entries j where org_id=${org.orgId}) as journals,
    (select jsonb_agg(to_jsonb(l) order by id) from journal_lines l where org_id=${org.orgId}) as lines`)).rows;
}

for (const provenance of ["known", "legacy unknown"] as const) {
  test(`zero-net standard profile transition normalizes ${provenance} layers before the next issue`, { skip: !process.env.OPENBOOKS_DB_URL }, async (t) => {
    const org = await createScratchOrg();
    try {
      const { adminId: actorId, submitterId: receiptActorId } = await seedFlowActors(org.orgId);
      state.gate = { user: { orgId: org.orgId, id: actorId }, allowedSubsidiaryIds: null };
      const position = { itemId: org.items.fifo, stockLocationId: org.stockLocationId,
        subsidiaryId: org.subsidiaryId, date: org.date };
      for (const unitCost of ["5", "15"]) await receiveInventory(org.orgId, receiptActorId, {
        ...position, quantity: "1", unitCost, offsetAccountId: org.accounts.clearing,
      });
      if (provenance === "legacy unknown") await db.execute(sql`update cost_layers
        set remaining_original_cost=null where org_id=${org.orgId}`);
      const before = await layers(org);
      const request = await profileRequest(org);
      const staleRequest = request.clone();
      const deniedRequest = request.clone();
      state.gate.allowedSubsidiaryIds = new Set();
      const deniedBefore = await financialEvidence(org);
      const denied = await withSimClock(org.date, () => PUT(deniedRequest, {
        params: Promise.resolve({ id: org.items.fifo }),
      }));
      assert.equal(denied.status, 422);
      assert.match((await denied.json()).error, /requires access to every subsidiary/);
      assert.deepEqual(await financialEvidence(org), deniedBefore);
      state.gate.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
      const response = await withSimClock(org.date, () => PUT(request, {
        params: Promise.resolve({ id: org.items.fifo }),
      }));
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.revaluationEntryId, null, "zero owner delta must not create a journal");
      const repriced = await layers(org);
      const staleBefore = await financialEvidence(org);
      const stale = await PUT(staleRequest, { params: Promise.resolve({ id: org.items.fifo }) });
      assert.equal(stale.status, 409);
      assert.deepEqual(await financialEvidence(org), staleBefore, "stale profile replay must preserve all financial evidence");
      const journals = (await db.execute<{ count: number }>(sql`select count(*)::int as count
        from journal_entries where org_id=${org.orgId}`)).rows[0]!.count;
      assert.equal(journals, 2, "only the two receipt journals exist");
      const issue = await issueInventory(org.orgId, actorId, { ...position, quantity: "1" });
      const onHand = await getOnHand(org.orgId, position.itemId, position.stockLocationId);
      const gl = await assetBalance(org);
      t.diagnostic(JSON.stringify({ provenance, before, repriced, profile: result, issue: issue.value, remainingLayerValue: onHand.value, assetGL: gl }));
      assert.equal(issue.value, "-10.0000");
      assert.equal(onHand.value, gl, "standard issue must preserve layer value = inventory GL");
      assert.equal(gl, "10.0000");
      assert.deepEqual(repriced.map((layer) => [layer.unit_cost, layer.remaining_original_cost, layer.updated_by]),
        before.map(() => ["10.0000", provenance === "known" ? "10.0000" : null, actorId]));
      const audits = (await db.execute<{ actor_id: string; changes: { before: typeof before[number]; after: typeof before[number] } }>(sql`
        select actor_id,changes from audit_log where org_id=${org.orgId} and table_name='cost_layers'
          and changes->>'reason'='Costing method revaluation to standard'`)).rows;
      assert.equal(audits.length, 2, "rate changes require audit evidence even when legacy basis remains null");
      for (const audit of audits) {
        assert.equal(audit.actor_id, actorId);
        assert.equal(audit.changes.before.updated_by, receiptActorId);
        assert.equal(audit.changes.after.updated_by, actorId);
        assert.equal(normalizeMoney(String(audit.changes.before.unit_cost)), before.find((layer) => layer.id === audit.changes.before.id)!.unit_cost);
        assert.equal(normalizeMoney(String(audit.changes.after.unit_cost)), "10.0000");
        assert.equal(audit.changes.after.remaining_original_cost == null ? null : normalizeMoney(String(audit.changes.after.remaining_original_cost)),
          provenance === "known" ? "10.0000" : null);
      }
      const unchanged = await financialEvidence(org);
      assert.equal(await db.transaction((tx) => revalueOpenLayersToStandardCost(tx, org.orgId, actorId, org.items.fifo, {
        standardCost: "10", assetAccountId: org.accounts.invAsset, varianceAccountId: null,
      })), null);
      assert.deepEqual(await financialEvidence(org), unchanged, "repeating normalization does not rewrite layers or audit evidence");
    } finally { state.gate = null; await dropScratchOrg(org.orgId); }
  });
}

for (const scenario of ["zero and nonzero owners", "offsetting owner deltas"] as const) {
  test(`standard profile transition preserves separate accounting for ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      state.gate = { user: { orgId: org.orgId, id: actorId }, allowedSubsidiaryIds: null };
      const ownerId = randomUUID();
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${ownerId},${org.orgId},${org.subsidiaryId},'Second owner','CAD','CA')`);
      const costs = scenario === "zero and nonzero owners" ? [["5", "15"], ["5"]] : [["5"], ["15"]];
      for (const [index, subsidiaryId] of [org.subsidiaryId, ownerId].entries()) {
        for (const unitCost of costs[index]!) await receiveInventory(org.orgId, actorId, {
          itemId: org.items.fifo, stockLocationId: org.stockLocationId, subsidiaryId, date: org.date,
          quantity: "1", unitCost, offsetAccountId: org.accounts.clearing,
        });
      }
      const response = await withSimClock(org.date, async () => PUT(await profileRequest(org, org.accounts.adjustment), {
        params: Promise.resolve({ id: org.items.fifo }),
      }));
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.revaluationEntryId.length, scenario === "zero and nonzero owners" ? 1 : 2);
      assert.ok((await layers(org)).every((layer) => layer.unit_cost === "10.0000" && layer.remaining_original_cost === "10.0000"));
      const entries = (await db.execute<{ subsidiary_id: string; amount: string }>(sql`select j.subsidiary_id,l.amount
        from journal_entries j join journal_lines l on l.org_id=j.org_id and l.entry_id=j.id
        where j.org_id=${org.orgId} and j.memo='Costing method revaluation to standard'
          and l.account_id=${org.accounts.invAsset} order by j.subsidiary_id`)).rows;
      assert.deepEqual(new Map(entries.map((row) => [row.subsidiary_id, row.amount])),
        scenario === "zero and nonzero owners" ? new Map([[ownerId, "5.0000"]])
          : new Map([[org.subsidiaryId, "5.0000"], [ownerId, "-5.0000"]]));
      for (const subsidiaryId of [org.subsidiaryId, ownerId]) {
        const balance = (await db.execute<{ layers: string; gl: string }>(sql`select
          (select sum(round(remaining_quantity*unit_cost,4))::text from cost_layers
            where org_id=${org.orgId} and subsidiary_id=${subsidiaryId}) as layers,
          (select sum(amount)::text from journal_lines where org_id=${org.orgId}
            and subsidiary_id=${subsidiaryId} and account_id=${org.accounts.invAsset}) as gl`)).rows[0]!;
        assert.equal(balance.layers, balance.gl);
      }
    } finally { state.gate = null; await dropScratchOrg(org.orgId); }
  });
}

test("zero-net layer audit failure rolls back the entire native costing profile transition", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const failureName = `test_zero_net_audit_${randomUUID().replaceAll("-", "")}`;
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    state.gate = { user: { orgId: org.orgId, id: actorId }, allowedSubsidiaryIds: null };
    for (const unitCost of ["5", "15"]) await receiveInventory(org.orgId, actorId, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, subsidiaryId: org.subsidiaryId,
      date: org.date, quantity: "1", unitCost, offsetAccountId: org.accounts.clearing,
    });
    const before = await financialEvidence(org);
    await db.execute(sql.raw(`create function public.${failureName}() returns trigger language plpgsql as $$
      begin raise exception 'forced zero-net layer audit failure'; end $$`));
    // The injected failure applies only to this fixture and this financial
    // audit event. No other tenant or normal provenance audit is affected.
    await db.execute(sql.raw(`create trigger ${failureName} before insert on public.audit_log for each row
      when (new.org_id='${org.orgId}'::uuid and new.table_name='cost_layers'
        and new.changes->>'reason'='Costing method revaluation to standard')
      execute function public.${failureName}()`));
    const response = await withSimClock(org.date, async () => PUT(await profileRequest(org), {
      params: Promise.resolve({ id: org.items.fifo }),
    }));
    const result = await response.json();
    assert.equal(response.status, 400, JSON.stringify(result));
    assert.match(result.error, /insert into audit_log/);
    assert.deepEqual(await financialEvidence(org), before,
      "audit refusal restores profile, all layers, journals, lines and audit history");
  } finally {
    await db.execute(sql.raw(`drop trigger if exists ${failureName} on public.audit_log`));
    await db.execute(sql.raw(`drop function if exists public.${failureName}()`));
    state.gate = null;
    await dropScratchOrg(org.orgId);
  }
});
