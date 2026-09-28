import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextResponse } from "next/server";
const state: { authz: unknown } = { authz: null }; Object.assign(globalThis, { __usageRouteState: state, __usageNextResponse: NextResponse });
const realAuthz = new URL("../../../lib/authz.ts", import.meta.url).href;
const authzSource = "import { can } from '" + realAuthz + "'; export * from '" + realAuthz + "'; export async function getAuthz(){return globalThis.__usageRouteState.authz} export async function guardPermission(p){const a=globalThis.__usageRouteState.authz;if(!a)return globalThis.__usageNextResponse.json({error:'unauthorized'},{status:401});return can(a,p)?a:globalThis.__usageNextResponse.json({error:'missing permission: '+p},{status:403})}"; const authzStub = { shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(authzSource) };
registerHooks({ resolve(s, c, next) { return s === "@/lib/authz" || (s === "./authz" && c.parentURL?.includes("/web/lib/feature-gates")) ? authzStub : next(s, c); } });
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts"), { sql } = await import("drizzle-orm"), { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts"), { isFeatureEnabled, orgFeatureState } = await import("../../../lib/features.ts");
const { GET: metersGet, POST: metersPost } = await import("./meters/route.ts"), { PATCH: metersPatch } = await import("./meters/[id]/route.ts"), { GET: recordsGet, POST: recordsPost } = await import("./records/route.ts"), { POST: reverseRecord } = await import("./records/[id]/reverse/route.ts"), { POST: plansPost, GET: plansGet } = await import("./plans/route.ts"), { POST: versionsPost } = await import("./plans/[id]/versions/route.ts"), { PUT: bandsPut } = await import("./versions/[id]/bands/route.ts"), { POST: publishPost } = await import("./versions/[id]/publish/route.ts");
const { GET: linksGet, POST: linksPost } = await import("./links/route.ts"), { GET: prepaidGet } = await import("./prepaid/route.ts"), { GET: runsGet, POST: runsPost } = await import("./runs/route.ts"), { POST: previewPost } = await import("./runs/preview/route.ts"), { POST: voidPost } = await import("./runs/[id]/void-and-rebill/route.ts"), { GET: metricsGet } = await import("../metrics/months/route.ts"), { PUT: pricingPut } = await import("../revenue/contracts/[id]/pricing/route.ts");
type Handler = (request?: Request, context?: { params?: Promise<unknown> }) => Promise<Response>; const DB = { skip: !process.env.OPENBOOKS_DB_URL };
async function setFeatures(orgId: string, features: Record<string, boolean>) {
  await withOrgContext(orgId, async () => { const row = await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(features)}::jsonb, true) where id = ${orgId} returning settings->'features' as features`); assert.equal(row.rows.length, 1); for (const [key, value] of Object.entries(features)) assert.equal((row.rows[0]!.features as Record<string, boolean>)[key], value); });
}
test("usage routes enforce gates, actor idempotency, subsidiary scope, and billing lifecycle", DB, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  let actor = "";
  try {
    actor = await withOrgContext(org.orgId, () => createScratchUser(org.orgId, "Usage route operator", "admin"));
    const itemId = randomUUID(), subPlanId = randomUUID(), subscriptionId = randomUUID(), contractId = randomUUID();
    await withOrgContext(org.orgId, async () => {
      const item = await db.execute(sql`insert into items (id, org_id, kind, name, income_account_id, is_active, custom) values (${itemId}, ${org.orgId}, 'service', 'Usage route item', ${org.accounts.revenue}, true, '{}'::jsonb) returning id`); assert.equal(item.rows.length, 1);
      const plan = await db.execute(sql`insert into subscription_plans (id, org_id, name, amount, currency_code, "interval", interval_count, created_by) values (${subPlanId}, ${org.orgId}, 'Usage route subscription', '100', 'CAD', 'monthly', 1, ${actor}) returning id`); assert.equal(plan.rows.length, 1);
      const sub = await db.execute(sql`insert into subscriptions (id, org_id, customer_id, plan_id, quantity, price_override, status, start_on, next_bill_on, auto_post, created_by) values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${subPlanId}, '1', '100', 'active', ${org.date}, ${org.date}, false, ${actor}) returning id`); assert.equal(sub.rows.length, 1); const customer = await db.execute(sql`update parties set subsidiary_id = ${org.subsidiaryId} where org_id = ${org.orgId} and id = ${org.customerId} returning id`); assert.equal(customer.rows.length, 1);
      const contract = await db.execute(sql`insert into revenue_contracts (id, org_id, subsidiary_id, customer_id, contract_number, status, starts_on, currency, total_transaction_price, created_by, updated_by) values (${contractId}, ${org.orgId}, ${org.subsidiaryId}, ${org.customerId}, ${contractId}, 'active', ${org.date}, 'CAD', '100', ${actor}, ${actor}) returning id`); assert.equal(contract.rows.length, 1);
    });
    const permissions = ["usage.read", "usage.manage", "usage.bill", "ar.post"];
    const setAuthz = (grants = permissions, allowedSubsidiaryIds: Set<string> | null = null) => { state.authz = { user: { id: actor, orgId: org.orgId }, permissions: new Set(grants), allowedSubsidiaryIds }; };
    const call = async (handler: Handler, path: string, method = "GET", body?: unknown, key?: string, params?: unknown) => {
      const response = await withOrgContext(org.orgId, () => handler(new Request("http://usage.test" + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key ? { "Idempotency-Key": key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), params === undefined ? undefined : { params: Promise.resolve(params) }));
      const text = await response.text(); return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
    };
    const gated = [["usage", "usageBilling", metersGet, "/api/usage/meters", "GET", undefined], ["records", "usageBilling", recordsGet, "/api/usage/records", "GET", undefined], ["plans", "usageBilling", plansGet, "/api/usage/plans", "GET", undefined], ["links", "usageBilling", linksGet, "/api/usage/links", "GET", undefined], ["prepaid", "usageBilling", prepaidGet, "/api/usage/prepaid", "GET", undefined], ["runs", "usageBilling", runsGet, "/api/usage/runs", "GET", undefined], ["metrics", "saasMetrics", metricsGet, "/api/metrics/months", "GET", undefined], ["pricing", "revenueRecognition", pricingPut, "/api/revenue/contracts/" + contractId + "/pricing", "PUT", { id: contractId }]] as const;
    setAuthz();
    for (const [family, feature, handler, path, method, params] of gated) {
      await setFeatures(org.orgId, { subscriptionBilling: true, usageBilling: feature !== "usageBilling", saasMetrics: feature !== "saasMetrics", revenueRecognition: feature !== "revenueRecognition" }); const featureState = await withOrgContext(org.orgId, () => orgFeatureState(org.orgId)); assert.equal(featureState[feature], false, JSON.stringify(featureState)); assert.equal(await withOrgContext(org.orgId, () => isFeatureEnabled(org.orgId, feature)), false); const off = await call(handler, path, method, method === "PUT" ? {} : undefined, undefined, params);
      assert.equal(off.status, 404, `${family} is hidden when its feature is off`); assert.deepEqual(off.json, { error: "not_found" });
    }
    await setFeatures(org.orgId, { subscriptionBilling: true, usageBilling: true, saasMetrics: true, revenueRecognition: true });
    setAuthz([]);
    for (const [family, , handler, path, method, params] of gated) { const denied = await call(handler, path, method, method === "PUT" ? {} : undefined, undefined, params); assert.equal(denied.status, 403, `${family} checks permission before handler input`); }
    setAuthz();
    const meterBody = { key: `requests-${randomUUID().slice(0, 8)}`, name: "API requests", unit: "request", aggregation: "sum", itemId };
    setAuthz(permissions, new Set());
    assert.equal((await call(metersPost, "/api/usage/meters", "POST", meterBody, randomUUID())).status, 403);
    setAuthz();
    const meterKey = randomUUID();
    const meter = await call(metersPost, "/api/usage/meters", "POST", meterBody, meterKey);
    const replay = await call(metersPost, "/api/usage/meters", "POST", meterBody, meterKey);
    const conflict = await call(metersPost, "/api/usage/meters", "POST", { ...meterBody, name: "Changed name" }, meterKey);
    assert.equal(meter.status, 201); assert.equal(replay.status, 201); assert.equal(meter.json.id, replay.json.id);
    assert.equal(conflict.status, 409); assert.equal(conflict.json.code, "idempotency_key_conflict"); assert.ok(conflict.json.remedy);
    const usageMeterId = String(meter.json.id), meterName = String(meter.json.key);
    const emptyMeterEdit = await call(metersPatch, `/api/usage/meters/${usageMeterId}`, "PATCH", {}, undefined, { id: usageMeterId });
    assert.equal(emptyMeterEdit.status, 422);
    assert.match(String(emptyMeterEdit.json.error), /Supply at least one meter field/);
    const renamedMeter = await call(metersPatch, `/api/usage/meters/${usageMeterId}`, "PATCH", { name: "Metered API requests" }, undefined, { id: usageMeterId });
    assert.equal(renamedMeter.status, 200);
    assert.equal(renamedMeter.json.name, "Metered API requests");
    const badRecord = await call(recordsPost, "/api/usage/records", "POST", { records: [{ meterKey: "missing-meter", customerId: org.customerId, occurredOn: org.date, quantity: "1", source: "api", idempotencyKey: randomUUID() }] });
    assert.equal(badRecord.status, 422); assert.equal(badRecord.json.code, "usage_meter_unknown"); assert.ok(badRecord.json.remedy);
    const plan = await call(plansPost, "/api/usage/plans", "POST", { name: `Route plan ${randomUUID().slice(0, 8)}`, currency: "CAD" }, randomUUID()), version = await call(versionsPost, `/api/usage/plans/${plan.json.id}/versions`, "POST", { effectiveFrom: org.date }, randomUUID(), { id: plan.json.id }), versionId = String(version.json.id);
    await call(bandsPut, `/api/usage/versions/${versionId}/bands`, "PUT", { bands: [{ meterId: usageMeterId, kind: "graduated", seq: 1, upToQty: null, unitPrice: "1.25" }] }, undefined, { id: versionId }); await call(publishPost, `/api/usage/versions/${versionId}/publish`, "POST", undefined, undefined, { id: versionId });
    const linkBody = { subscriptionId, customerId: org.customerId, planVersionId: versionId, meterIds: [usageMeterId], effectiveFrom: org.date, allowOverage: true };
    const link = await call(linksPost, "/api/usage/links", "POST", linkBody, randomUUID());
    const ingested = await call(recordsPost, "/api/usage/records", "POST", { records: [{ meterKey: meterName, customerId: org.customerId, subscriptionId, occurredOn: org.date, quantity: "3", source: "api", idempotencyKey: randomUUID() }] });
    assert.equal(ingested.status, 201); const recordId = String((ingested.json as { records: Array<{ id: string }> }).records[0]!.id);
    const hiddenId = randomUUID(); setAuthz(permissions, new Set());
    const hidden = await call(reverseRecord, `/api/usage/records/${recordId}/reverse`, "POST", { reason: "Correction" }, undefined, { id: recordId });
    const missing = await call(reverseRecord, `/api/usage/records/${hiddenId}/reverse`, "POST", { reason: "Correction" }, undefined, { id: hiddenId });
    assert.equal(hidden.status, 404); assert.equal(hidden.text, missing.text);
    setAuthz();
    const preview = await call(previewPost, "/api/usage/runs/preview", "POST", { linkId: link.json.id, periodStart: org.date, periodEnd: org.date }); assert.equal(preview.status, 200);
    const committed = await call(runsPost, "/api/usage/runs", "POST", { linkId: link.json.id, periodStart: org.date, periodEnd: org.date }); assert.equal(committed.status, 200); const runId = String((committed.json as { run: { id: string } }).run.id);
    const invalidReason = await call(voidPost, `/api/usage/runs/${runId}/void-and-rebill`, "POST", { reason: " " }, undefined, { id: runId });
    assert.equal(invalidReason.status, 422);
    assert.match(String(invalidReason.json.error), /reason|nonblank/i);
    const replacement = await call(voidPost, `/api/usage/runs/${runId}/void-and-rebill`, "POST", { reason: "Corrected usage" }, undefined, { id: runId });
    assert.equal(replacement.status, 200);
    const typedPricing = await call(pricingPut, `/api/revenue/contracts/${contractId}/pricing`, "PUT", { fixedConsideration: "-1" }, undefined, { id: contractId }); assert.equal(typedPricing.status, 422); assert.equal(typedPricing.json.code, "revenue_transaction_price_invalid"); assert.ok(typedPricing.json.remedy);
  } finally { state.authz = null; await dropScratchOrgReporting(org.orgId); }
});
