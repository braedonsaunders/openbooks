import { before as initializeNativeComposition } from "node:test";

initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { getOnHand } = await import("@openbooks/engine/inventory");
const { getItemFamily } = await import("@openbooks/engine/inventory");
const { getStockCountDetail } = await import("@openbooks/engine/inventory/stock-count-queries");
const { getItemRateVersions } = await import("../item-rate-version-service.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;
const scratchOrgIds: string[] = [];

after(async () => {
  for (const orgId of scratchOrgIds.reverse()) await dropScratchOrg(orgId);
});

function ctxFor(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "Test",
        orgId,
        roles: [{ key: "inventory-role", name: "Inventory role" }],
        envKind: "sandbox",
        productionOrgId: orgId,
        isSuperAdmin: false,
        homeUserId: userId,
        homeOrgId: orgId,
      },
      permissions: new Set(permissions),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

async function setFeatures(orgId: string, features: Record<string, boolean>): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
      update orgs
         set settings = jsonb_set(
           settings,
           '{features}',
           coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(features)}::jsonb,
           true
         )
       where id = ${orgId}`),
  );
}

test(
  "inventory commands generate item variants and post one idempotent stock receipt",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    scratchOrgIds.push(org.orgId);
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    await setFeatures(org.orgId, { inventory: true, itemVariants: true, projects: true });
    const context = ctxFor(org.orgId, actors.adminId, ["items.read", "items.manage", "items.post"]);
    const run = async (name: string, input: Record<string, unknown>) => {
      return withOrgContext(org.orgId, () =>
        executeApplicationTool(applicationTool(name)!, context, input),
      );
    };

    const familyCode = `FAMILY-${randomUUID().slice(0, 8)}`;
    const created = await run("create_item_family", {
      code: familyCode,
      name: "Workshop Shirt",
      kind: "inventory",
      defaultUnit: "ea",
      defaultRate: "18.50",
      options: [{ name: "Size", values: ["S", "M"] }],
      idempotencyKey: randomUUID(),
    });
    const family = created.family as { id: string };
    const generationInput = {
      familyId: family.id,
      idempotencyKey: randomUUID(),
    };
    const generated = await run("generate_item_variants", generationInput);
    assert.equal(generated.replayed, false);
    const generatedReplay = await run("generate_item_variants", generationInput);
    assert.equal(generatedReplay.replayed, true);

    const familyRead = await withBypassContext(() => getItemFamily(org.orgId, family.id));
    assert.equal(familyRead?.variants.length, 2);
    assert.deepEqual(
      familyRead?.variants.map((variant) => variant.code).sort(),
      [`${familyCode}-M`, `${familyCode}-S`].sort(),
    );

    const receiptInput = {
      itemId: org.items.movingAvg,
      stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
      quantity: "3.0000",
      unitCost: "12.2500",
      offsetAccountId: org.accounts.clearing,
      idempotencyKey: randomUUID(),
    };
    const receipt = await run("receive_inventory_stock", receiptInput);
    const replay = await run("receive_inventory_stock", receiptInput);
    assert.equal(receipt.replayed, false);
    assert.equal(replay.replayed, true);
    const position = await withOrgContext(org.orgId, () =>
      getOnHand(org.orgId, org.items.movingAvg, org.stockLocationId),
    );
    assert.equal(position.quantity, "3.0000");
    assert.equal(position.value, "36.7500");

    const count = await run("create_stock_count", {
      locationId: org.locationId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
      lines: [{ itemId: org.items.movingAvg, stockLocationId: org.stockLocationId }],
      idempotencyKey: randomUUID(),
    });
    const countId = count.id as string;
    await run("start_stock_count", { countId, idempotencyKey: randomUUID() });
    const countBefore = await withOrgContext(org.orgId, () =>
      getStockCountDetail(org.orgId, countId, null),
    );
    const lineId = countBefore.lines[0]!.id;
    await run("record_stock_count_quantity", {
      countId,
      lineId,
      countedQuantity: "3.0000",
      idempotencyKey: randomUUID(),
    });
    const countAfter = await withOrgContext(org.orgId, () =>
      getStockCountDetail(org.orgId, countId, null),
    );
    assert.equal(countAfter.header.status, "counting");
    assert.equal(countAfter.lines[0]?.countedQuantity, "3.0000");

    await run("create_item_rate_version", {
      itemId: org.items.service,
      effectiveFrom: org.date,
      baseUnit: "hour",
      pricingPolicy: "capped_ladder",
      invoicePresentation: "rate_components",
      tiers: [
        {
          unitCode: "hour",
          unitName: "Hour",
          baseQuantity: "1.0000",
          costRate: "10.0000",
          billRate: "20.0000",
        },
      ],
      idempotencyKey: randomUUID(),
    });
    const rateReadResponse = await withOrgContext(org.orgId, () =>
      getItemRateVersions(org.items.service, context.authz),
    );
    const rateRead = (await rateReadResponse.json()) as {
      versions: Array<{ effective_from: string; tiers: unknown[] }>;
    };
    assert.equal(rateRead.versions[0]?.effective_from.slice(0, 10), org.date);
    assert.equal(rateRead.versions[0]?.tiers.length, 1);
  },
);

test("inventory commands enforce permissions and feature gates", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  scratchOrgIds.push(org.orgId);
  const actors = await withBypassContext(() => seedFlowActors(org.orgId));
  await setFeatures(org.orgId, { inventory: true, itemVariants: true });
  const input = {
    code: `DENIED-${randomUUID().slice(0, 8)}`,
    name: "Permission Probe",
    kind: "inventory",
    options: [{ name: "Size", values: ["S"] }],
    idempotencyKey: randomUUID(),
  };
  const denied = ctxFor(org.orgId, actors.adminId, ["items.read"]);
  await assert.rejects(
    withOrgContext(org.orgId, () =>
      executeApplicationTool(applicationTool("create_item_family")!, denied, input),
    ),
    /forbidden/,
  );

  await setFeatures(org.orgId, { itemVariants: false });
  const manager = ctxFor(org.orgId, actors.adminId, ["items.manage"]);
  await assert.rejects(
    withOrgContext(org.orgId, () =>
      executeApplicationTool(applicationTool("create_item_family")!, manager, input),
    ),
    /route not found/,
  );
  const families = await withBypassContext(() =>
    db.execute<{ count: string }>(
      sql`
        select count(*)::text as count from item_families where org_id = ${org.orgId}
      `,
      "objects",
    ),
  );
  assert.equal(families[0]?.count, "0");
});

test(
  "inventory commands do not expose an item family across organizations",
  { skip: !DB },
  async () => {
    const first = await withBypassContext(() => createScratchOrg());
    scratchOrgIds.push(first.orgId);
    const second = await withBypassContext(() => createScratchOrg());
    scratchOrgIds.push(second.orgId);
    const firstActors = await withBypassContext(() => seedFlowActors(first.orgId));
    const secondActors = await withBypassContext(() => seedFlowActors(second.orgId));
    await setFeatures(first.orgId, { inventory: true, itemVariants: true });
    await setFeatures(second.orgId, { inventory: true, itemVariants: true });
    const creator = ctxFor(first.orgId, firstActors.adminId, ["items.manage", "items.read"]);
    const created = await withOrgContext(first.orgId, () =>
      executeApplicationTool(applicationTool("create_item_family")!, creator, {
        code: `CROSS-${randomUUID().slice(0, 8)}`,
        name: "Scoped Family",
        kind: "inventory",
        options: [{ name: "Size", values: ["S"] }],
        idempotencyKey: randomUUID(),
      }),
    );
    const familyId = (created.family as { id: string }).id;
    const other = ctxFor(second.orgId, secondActors.adminId, ["items.read"]);
    await assert.rejects(
      withOrgContext(second.orgId, () =>
        executeApplicationTool(applicationTool("get_item_family")!, other, { familyId }),
      ),
      /item family not found/,
    );
  },
);
