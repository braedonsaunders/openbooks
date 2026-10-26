import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";

// Over-receipt tolerances live in the Setup registry (Company Settings →
// Features is not re-gated; the entity rides the orders feature): writes go
// through the generic setup machinery, so every row stores its reason and
// the before/after audit, and out-of-range values refuse before any write.
const { db } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/testing/fixtures");
const { SETUP_ENTITY_BY_KEY } = await import("./registry.ts");
const { createSetupRecord, updateSetupRecord } = await import("./write.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;
const KEY = "purchase-over-receipt-tolerances";

function actor(orgId: string, actorId: string) {
  return {
    orgId,
    id: actorId,
    permissions: new Set(["purchase_orders.create"]),
    allowedSubsidiaryIds: null,
  };
}

async function setFeatures(orgId: string, features: Record<string, boolean>) {
  await db.execute(
    sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(features)}::jsonb, true) where id = ${orgId}`,
  );
}

async function audits(orgId: string, rowId: string) {
  return await db.execute<{
    action: string;
    changes: {
      before: { tolerance_percent?: string; reason?: string };
      after: { tolerance_percent?: string; reason?: string };
    };
  }>(
    sql`
    select action, changes from audit_log
     where org_id = ${orgId} and table_name = 'purchase_over_receipt_tolerances' and row_id = ${rowId}
     order by at desc, id desc`,
    "objects",
  );
}

test("the tolerance entity is registered on the inventory rail under orders", () => {
  const entity = SETUP_ENTITY_BY_KEY.get(KEY);
  assert.ok(entity, "entity registered");
  assert.equal(entity.table, "purchase_over_receipt_tolerances");
  assert.equal(entity.groupKey, "inventory");
  assert.equal(entity.featureKey, "orders");
  assert.equal(entity.writePermission, "purchase_orders.create");
});

test(
  "a tolerance writes through Setup with its reason and a before/after audit",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await setFeatures(org.orgId, { orders: true });
      const me = actor(org.orgId, randomUUID());

      const created = await createSetupRecord(
        me,
        KEY,
        {
          itemCategory: "Consumables",
          tolerancePercent: "10",
          toleranceQuantity: "5",
          reason: "mill ships heavy bags; warehouse accepts ten percent",
          effectiveFrom: "2026-01-01",
        },
        { requestId: randomUUID() },
      );
      assert.equal(created.status, 200);
      const id = (created.body as { id: string }).id;

      const stored = (
        await db.execute<{
          item_category: string | null;
          tolerance_percent: string;
          reason: string;
        }>(
          sql`
      select item_category, tolerance_percent::text as tolerance_percent, reason
        from purchase_over_receipt_tolerances where id = ${id} and org_id = ${org.orgId}`,
          "objects",
        )
      )[0]!;
      assert.equal(stored.item_category, "Consumables");
      assert.equal(stored.tolerance_percent, "10.0000");
      assert.equal(stored.reason, "mill ships heavy bags; warehouse accepts ten percent");

      const [insert] = await audits(org.orgId, id);
      assert.equal(insert?.action, "insert");
      assert.equal(insert?.changes.after.reason, stored.reason);

      const updated = await updateSetupRecord(me, KEY, {
        id,
        itemCategory: "Consumables",
        tolerancePercent: "15",
        toleranceQuantity: "5",
        reason: "mill variance grew; raising the allowance",
        effectiveFrom: "2026-01-01",
      });
      assert.equal(updated.status, 200);
      const [update, _insert] = await audits(org.orgId, id);
      assert.equal(update?.action, "update");
      assert.equal(update?.changes.before.tolerance_percent, "10.0000");
      assert.equal(update?.changes.after.tolerance_percent, "15.0000");
      assert.equal(update?.changes.after.reason, "mill variance grew; raising the allowance");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "out-of-range tolerances and a missing reason refuse before any write",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await setFeatures(org.orgId, { orders: true });
      const me = actor(org.orgId, randomUUID());
      const base = {
        tolerancePercent: "10",
        toleranceQuantity: "5",
        reason: "mill ships heavy bags on every load",
        effectiveFrom: "2026-01-01",
      };
      for (const body of [
        { ...base, tolerancePercent: "101" },
        { ...base, tolerancePercent: "-1" },
        { ...base, toleranceQuantity: "-5" },
        { ...base, reason: "no" },
        { ...base, reason: "" },
      ]) {
        const result = await createSetupRecord(me, KEY, body, { requestId: randomUUID() });
        assert.ok(
          result.status === 400 || result.status === 422,
          `refused: ${JSON.stringify(body)}`,
        );
      }
      const count = (
        await db.execute<{ n: number }>(
          sql`
      select count(*)::int as n from purchase_over_receipt_tolerances where org_id = ${org.orgId}`,
          "objects",
        )
      )[0]!.n;
      assert.equal(count, 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
