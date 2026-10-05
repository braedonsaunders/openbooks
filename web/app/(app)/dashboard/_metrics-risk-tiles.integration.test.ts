import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const { stubModules } = await import("../../../testing/stub-modules");
stubModules({ intl: "export async function getTranslations(){return (key)=>key};export async function getLocale(){return 'en-CA'}" });
registerHooks({
  resolve(specifier, context, nextResolve) {
    // Worktree node_modules is a symlink to the main checkout's install, so
    // bare @openbooks self-imports would resolve to MAIN-checkout code (a
    // second db pool without the test bypass). Pin them to this checkout —
    // the same modules a real install resolves — process-wide, so the
    // loader under test and its transitive engine imports agree.
    if (specifier.startsWith("@openbooks/engine/src/")) {
      return nextResolve(
        new URL(`../../../../engine/${specifier.slice("@openbooks/engine/".length)}`, import.meta.url).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
// Fixture writes cross the maintenance boundary (withBypass); the loader
// under test runs tenant-scoped through withOrgContext — the same RLS
// posture as a production request via setRequestOrg.
const { db, env, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { loadRiskWidgetMetrics } = await import("./_metrics-risk.ts");
const { sentinelData } = await import("../../../lib/analytics/sentinel-data.ts");
const { analyticsConfig } = await import("../../../lib/analytics/config.ts");
type Authz = import("@/lib/authz.ts").Authz;
type DashboardWidgetContext = import("./_metrics-context.ts").DashboardWidgetContext;

const P = { presetId: "custom", from: "2026-07-01", to: "2026-07-31", label: "July 2026" };

function ctxFor(orgId: string): DashboardWidgetContext {
  const authz = {
    user: { orgId, id: randomUUID() },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  } as unknown as Authz;
  return { authz, orgId, today: "2026-07-15", subsidiaryIds: undefined, allowedSubsidiaryIds: null, period: async () => ({ ...P }) };
}

async function seedDuplicateBills(orgId: string, subsidiaryId: string) {
  const vendorId = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${vendorId}, ${orgId}, 'vendor', 'Double Bill Co', ${subsidiaryId}, true, '{}'::jsonb)`);
    for (const [num, date] of [["BILL-A", "2026-07-10"], ["BILL-B", "2026-07-13"]] as const) {
      await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id,
          document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total, open_balance, reference_number)
        values (${randomUUID()}, ${orgId}, 'vendor_bill', ${num}, ${vendorId}, ${subsidiaryId},
          ${date}, ${date}, 'USD', 1, 'draft', 250, 0, 250, 250, 'INV-101')`);
    }
  });
}

async function setDuplicateFloor(orgId: string) {
  await withBypass(async () => {
    // jsonb_set cannot create the intermediate `analytics` object on a
    // scratch org that has none, so merge the sentinel blob in with ||,
    // then prove the reader resolves the floor.
    await db.execute(sql`update orgs set settings = coalesce(settings, '{}'::jsonb)
      || jsonb_build_object('analytics', coalesce(settings -> 'analytics', '{}'::jsonb)
        || jsonb_build_object('sentinel', '{"duplicateMinAmount": "100.00", "duplicateDays": 14}'::jsonb))
      where id = ${orgId}`);
    // The reader canonicalizes money to four decimals: '100.00' reads back
    // '100.0000'. Asserting the canonical form proves the floor resolved.
    assert.equal((await analyticsConfig(orgId, 'sentinel')).duplicateMinAmount, '100.0000');
  });
}

/**
 * The home-dashboard risk tiles read the shared sentinelRiskSummary — the
 * same figures the Sentinel dashboard shows. A field mapping typo here
 * (score into flagged, duplicate value into total at risk) would render a
 * confident wrong number on home, so this pins the reader against the
 * loader over a seeded duplicate pair.
 */
test("risk widget reader returns the dashboard's own figures", { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await seedDuplicateBills(org.orgId, org.subsidiaryId);
    await setDuplicateFloor(org.orgId);
    const ctx = ctxFor(org.orgId);
    const [metrics, data] = await withOrgContext(org.orgId, () => Promise.all([
      loadRiskWidgetMetrics(ctx, () => true),
      sentinelData(org.orgId, P, ctx.authz),
    ]));
    const risk = metrics.forensicRisk;
    assert.ok(risk !== null && risk !== undefined && risk.available);
    assert.equal(risk.value.score, data.summary.overallRiskScore);
    assert.equal(risk.value.flagged, data.summary.flaggedCount);
    assert.equal(risk.value.value, data.summary.totalAtRisk);
    assert.equal(risk.value.currency, data.meta.presentationCurrency);
    assert.equal(risk.value.periodLabel, P.label);
    assert.deepEqual(risk.value.excluded, data.summary.excludedDetectors);
    const dup = metrics.duplicatePayments;
    assert.ok(dup !== null && dup !== undefined && dup.available);
    assert.equal(dup.value.groups, 1);
    assert.equal(dup.value.value, data.summary.totalDuplicateAmount);
    assert.equal(dup.value.currency, data.meta.presentationCurrency);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

/**
 * With no duplicate floor configured the duplicate tile carries the named
 * refusal — never a zero group count — while the forensic tile still
 * reports the score it can state.
 */
test("risk widget reader refuses the duplicate tile by name when the floor is unset", { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await seedDuplicateBills(org.orgId, org.subsidiaryId);
    const ctx = ctxFor(org.orgId);
    const metrics = await withOrgContext(org.orgId, () => loadRiskWidgetMetrics(ctx, () => true));
    const risk2 = metrics.forensicRisk;
    assert.ok(risk2 !== null && risk2 !== undefined && risk2.available);
    const dup = metrics.duplicatePayments;
    assert.ok(dup !== null && dup !== undefined && !dup.available);
    // The intl stub resolves keys verbatim, so the refusal must carry the
    // duplicate-floor key — and the catalog behind that key must name the
    // remedy, not just the problem.
    assert.equal(dup.reason, "sentinel.forensics.duplicateFloorUnset");
    const catalog = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "messages", "en", "analytics.json"), "utf8"),
    ) as { sentinel: { forensics: Record<string, string> } };
    assert.match(
      catalog.sentinel.forensics["duplicateFloorUnset"] ?? "",
      /Sentinel → Configuration/,
      "the refusal names where to set the floor",
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("risk widget reader runs no query for an absent widget", { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const metrics = await withOrgContext(org.orgId, () => loadRiskWidgetMetrics(ctxFor(org.orgId), () => false));
    assert.deepEqual(metrics, {});
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
