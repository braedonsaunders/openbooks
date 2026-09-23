import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Only in-service assets reach the delete path with planned lines and no
// posted history: the DELETE must refuse by status (409) instead of deleting
// the asset with its planned schedule. Drafts still delete.

const stateKey = Symbol.for("openbooks.asset-delete-status-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.asset-delete-status-test')]
  export async function guardFeaturePermission() {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (
      specifier === "../../../../lib/feature-gates" &&
      context.parentURL?.includes("/api/assets/")
    ) {
      return { url: "mock:asset-delete-feature-gates", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:asset-delete-feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?asset-delete-status-test";
const { DELETE } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { buildSchedule } = await import("@openbooks/engine/src/assets/depreciation.ts");
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  actorId: string;
  assetId: string;
}

async function seedAsset(status: "draft" | "in_service", tag: string): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
       depreciation_expense_account_id, gain_loss_account_id, default_method,
       default_life_months, default_convention, tax_attributes, is_active)
    values (${categoryId}, ${org.orgId}, 'Delete-gate equipment', ${org.accounts.invAsset},
            ${org.accounts.clearing}, ${org.accounts.adjustment}, ${org.accounts.adjustment},
            'straight_line', 12, 'full_month', '{}'::jsonb, true)`);
  await db.execute(sql`
    insert into fixed_assets
      (id, org_id, subsidiary_id, category_id, asset_number, name, status,
       acquired_on, in_service_on, acquisition_cost, salvage_value,
       depreciation_method, useful_life_months, custom)
    values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, ${tag},
            'Delete-gate asset', ${status}, ${org.date}, ${org.date}, '12000.0000',
            '2000.0000', 'straight_line', 12, '{}'::jsonb)`);
  if (status === "in_service") await buildSchedule(assetId, org.orgId, actorId, org.bookId);
  return { orgId: org.orgId, actorId, assetId };
}

function deleteRequest(fixture: Fixture): Request {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    allowedSubsidiaryIds: null,
  };
  return new Request(`http://openbooks.test/api/assets/${fixture.assetId}`, { method: "DELETE" });
}

test(
  "asset DELETE refuses an in-service asset with only planned lines",
  { skip: !DB },
  async () => {
    const fixture = await seedAsset("in_service", "INSERVICE-NODELETE");
    try {
      const planned = await db.execute(sql`
        select count(*)::int as n
          from depreciation_schedule_lines l
          join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
         where l.org_id = ${fixture.orgId} and s.asset_id = ${fixture.assetId}
           and l.posted_amount is null`);
      assert.ok((planned.rows[0] as { n: number }).n > 0, "the fixture must carry planned lines");
      const posted = await db.execute(sql`
        select count(*)::int as n
          from depreciation_schedule_lines l
          join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
         where l.org_id = ${fixture.orgId} and s.asset_id = ${fixture.assetId}
           and l.posted_amount is not null`);
      assert.equal((posted.rows[0] as { n: number }).n, 0, "the fixture must have no posted lines");

      const response = await DELETE(deleteRequest(fixture), {
        params: Promise.resolve({ id: fixture.assetId }),
      });
      const body = (await response.json()) as { error?: string };
      assert.equal(response.status, 409, `in-service delete must be refused: ${JSON.stringify(body)}`);
      assert.match(body.error ?? "", /only draft assets can be deleted/i);

      const kept = await db.execute(sql`
        select count(*)::int as n from fixed_assets where org_id = ${fixture.orgId} and id = ${fixture.assetId}`);
      assert.equal((kept.rows[0] as { n: number }).n, 1, "the refused delete must keep the asset");
      const lines = await db.execute(sql`
        select count(*)::int as n
          from depreciation_schedule_lines l
          join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
         where l.org_id = ${fixture.orgId} and s.asset_id = ${fixture.assetId}`);
      assert.ok((lines.rows[0] as { n: number }).n > 0, "the refused delete must keep the planned lines");
    } finally {
      routeState.authz = null;
      await dropScratchOrgReporting(fixture.orgId);
    }
  },
);

test(
  "asset DELETE still removes a draft asset",
  { skip: !DB },
  async () => {
    const fixture = await seedAsset("draft", "DRAFT-CANDELETE");
    try {
      const response = await DELETE(deleteRequest(fixture), {
        params: Promise.resolve({ id: fixture.assetId }),
      });
      assert.equal(response.status, 200, `draft delete must succeed: ${JSON.stringify(await response.json())}`);
      const kept = await db.execute(sql`
        select count(*)::int as n from fixed_assets where org_id = ${fixture.orgId} and id = ${fixture.assetId}`);
      assert.equal((kept.rows[0] as { n: number }).n, 0, "the draft must be gone");
    } finally {
      routeState.authz = null;
      await dropScratchOrgReporting(fixture.orgId);
    }
  },
);
