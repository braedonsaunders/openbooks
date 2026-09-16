import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("./tools-subscriptions.ts");

/**
 * Source contract for the subscription/recurring-billing assistant tools:
 * plan/subscription reads carry the `ar.read` gate and the
 * `subscriptionBilling` feature their route enforces; recurring-schedule
 * reads mirror GET /api/recurring (`documents.manage`, no feature flag —
 * the route has none). Money math stays in engine decimal helpers.
 */
test("subscription tools declare the right gates and features", () => {
  for (const [tool, perm, feature] of [
    ["list_subscription_plans", "ar.read", 'feature: "subscriptionBilling"'],
    ["list_subscriptions", "ar.read", 'feature: "subscriptionBilling"'],
    ["get_subscription", "ar.read", 'feature: "subscriptionBilling"'],
    ["subscription_mrr", "ar.read", 'feature: "subscriptionBilling"'],
    ["subscription_upcoming_invoices", "ar.read", 'feature: "subscriptionBilling"'],
    ["list_recurring_schedules", "documents.manage", ""],
  ] as const) {
    const start = source.indexOf(`name: "${tool}"`);
    assert.ok(start >= 0, `${tool} is registered`);
    const window = source.slice(start, start + 600);
    assert.ok(window.includes(`"${perm}"`), `${tool} gates on ${perm}`);
    if (feature) assert.ok(window.includes(feature), `${tool} declares the subscriptionBilling feature`);
  }
  const recurringStart = source.indexOf('name: "list_recurring_schedules"');
  assert.doesNotMatch(
    source.slice(recurringStart, recurringStart + 600),
    /feature: /,
    "recurring reads carry no feature flag, like their route",
  );
  assert.doesNotMatch(source, /category: "write"/, "subscription tools are read-only");
});

test("subscription lists scope to the customer boundary the route enforces", () => {
  assert.match(
    source,
    /subsidiaryVisibleFilter\(sql`c\.subsidiary_id`, authz\.allowedSubsidiaryIds, \{ orgWideNull: true \}\)/,
    "customer-subsidiary filter with org-wide nulls",
  );
  assert.match(
    source,
    /subsidiaryScopeAllows\(authz\.allowedSubsidiaryIds, head\.customerSubsidiaryId as string \| null, \{ orgWideNull: true \}\)/,
    "direct-read twin for one subscription",
  );
  assert.match(
    source,
    /recurringTemplateScopeFilter\(authz\.user\.orgId, sql`d\.id`, sql`d\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/,
    "recurring reads reuse the engine template scope",
  );
});

test("subscription money uses the engine billing math, never floats", () => {
  assert.match(source, /monthlyRecurringRevenue\(/);
  assert.match(source, /mulDecimal\(/);
  assert.doesNotMatch(source, /Number\(r\.priceOverride/);
  assert.match(source, /subscription_billing_feature_disabled/);
  assert.match(source, /subscription_not_found/);
});

test("subscription tools are exported and registered for the playbook", () => {
  assert.match(source, /export const SUBSCRIPTION_TOOLS: AssistantToolDef\[\]/);
  assert.ok(source.includes("listRecurringSchedules,\n];"));
});
