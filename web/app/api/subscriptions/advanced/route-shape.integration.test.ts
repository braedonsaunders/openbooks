import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * The advanced subscriptions route must validate transport shape before
 * touching it: a non-object components element throws a TypeError inside the
 * createVersion loop (HTTP 500 — the handler only maps
 * AdvancedSubscriptionError), and the amend path spreads the whole body into
 * the engine call and the persisted request snapshot.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const engineRoot = new URL("../../../../../engine/", import.meta.url).href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __subscriptionShapeState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__subscriptionShapeState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['ar.create']), allowedSubsidiaryIds: null };
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
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = settings || '{"features":{"subscriptionBilling":true,"advancedSubscriptions":true}}'::jsonb
     where id = ${org.orgId}`));
  const planId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into subscription_plans (id, org_id, name, amount, currency_code, interval, interval_count,
                                    income_account_id, is_active, created_by)
    values (${planId}, ${org.orgId}, 'Shape Plan', '0', 'CAD', 'monthly', 1, ${org.accounts.revenue}, true, ${actorId})`));
  return { org, planId };
}

const post = (body: unknown) =>
  withOrgContext(state.orgId, () =>
    POST(new Request("http://subs.test/api/subscriptions/advanced", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })),
  );

async function versionCount(orgId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from subscription_plan_versions where org_id = ${orgId}`))).rows;
  return rows[0]!.n;
}

for (const element of [null, 42, "x"]) {
  test(`createVersion refuses components[${JSON.stringify(element)}] with an indexed 422 and no draft`, { skip: !DB }, async () => {
    const { org, planId } = await fixture();
    try {
      const response = await post({
        action: "createVersion", planId, effectiveFrom: "2026-10-01",
        components: [element],
      });
      const json = (await response.json().catch(() => null)) as { error?: string } | null;
      assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
      assert.match(json?.error ?? "", /components\[0\]/, `the refusal must name the index: ${JSON.stringify(json)}`);
      assert.equal(await versionCount(org.orgId), 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}

test("createVersion still files a well-formed component list", { skip: !DB }, async () => {
  const { org, planId } = await fixture();
  try {
    const response = await post({
      action: "createVersion", planId, effectiveFrom: "2026-10-01",
      components: [{ componentKey: "fee", name: "Fee", quantity: "1", unitPrice: "10.00" }],
    });
    assert.equal(response.status, 201, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await versionCount(org.orgId), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("amend refuses a mistyped field with a named 422", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    const response = await post({
      action: "amend",
      subscriptionId: randomUUID(),
      type: "add_component",
      effectiveOn: "2026-10-01",
      idempotencyKey: randomUUID(),
      componentKey: 42,
      name: "Add-on",
    });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /amendment field componentKey/, `the refusal must name the field: ${JSON.stringify(json)}`);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("amend persists only allowlisted fields in the request snapshot", { skip: !DB }, async () => {
  const { org, planId } = await fixture();
  try {
    const created = await post({
      action: "createVersion", planId, effectiveFrom: "2026-01-01",
      components: [{ componentKey: "fee", name: "Fee", quantity: "1", unitPrice: "10.00" }],
    });
    assert.equal(created.status, 201);
    const versionId = ((await created.json()) as { id: string }).id;
    const published = await post({ action: "publishVersion", versionId });
    assert.equal(published.status, 200);
    const subscriptionId = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into subscriptions (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on, auto_post, created_by)
      values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${planId}, '1', 'active', '2026-01-01', '2026-01-01', false, ${state.actorId})`));
    const activated = await post({
      action: "activateLifecycle", subscriptionId, planVersionId: versionId,
      termStartsOn: "2026-01-01", renewalPolicy: "none",
    });
    assert.equal(activated.status, 200, JSON.stringify(await activated.json().catch(() => null)));
    const amended = await post({
      action: "amend",
      subscriptionId,
      type: "add_component",
      effectiveOn: "2026-02-01",
      idempotencyKey: randomUUID(),
      componentKey: "addon",
      name: "Add-on",
      unitPrice: "5.00",
      injected: "x",
    });
    assert.equal(amended.status, 201, JSON.stringify(await amended.json().catch(() => null)));
    const snapshot = (await withBypassContext(() => db.execute(
      sql`select request from subscription_amendments where org_id = ${org.orgId} and subscription_id = ${subscriptionId}`,
    ))).rows[0]!.request as Record<string, unknown>;
    assert.equal(snapshot.componentKey, "addon");
    assert.ok(!("injected" in snapshot), "unvalidated input must not reach the persisted snapshot");
    assert.ok(!("action" in snapshot), "the transport envelope must not reach the persisted snapshot");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
