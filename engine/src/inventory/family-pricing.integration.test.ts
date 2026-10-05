import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import { createFamilyWithVariants } from "./item-families.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function setup() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId);
  await withBypassContext(async () => {
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"itemVariants":true}'::jsonb)
       where id = ${org.orgId}`);
  });
  return { org, actorId };
}

const SIZE_COLOR = [
  { name: "Size", values: ["S", "M"] },
  { name: "Color", values: ["Red", "Green", "Blue"] },
];

/** One transaction must yield one family and the chosen variants, never a half-built range. */
test("createFamilyWithVariants creates the family and chosen variants atomically", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    const { family, variants } = await withBypassContext(() =>
      createFamilyWithVariants(org.orgId, actorId, {
        code: "TEE",
        name: "Classic Tee",
        category: "Apparel",
        kind: "inventory",
        defaultUnit: "each",
        defaultRate: "24.99",
        options: SIZE_COLOR,
        variants: [
          { optionValues: { Size: "S", Color: "Red" } },
          { optionValues: { Size: "S", Color: "Green" }, include: false },
          { optionValues: { Size: "S", Color: "Blue" }, price: "29.99" },
          { optionValues: { Size: "M", Color: "Red" }, barcode: { value: "123456789012", kind: "upc" } },
          { optionValues: { Size: "M", Color: "Green" } },
          { optionValues: { Size: "M", Color: "Blue" } },
        ],
      }),
    );
    assert.equal(family.code, "TEE");
    assert.equal(family.options.length, 2);
    assert.equal(variants.length, 5);
    assert.ok(variants.every((variant) => variant.created));
    assert.deepEqual(
      variants.map((variant) => variant.code),
      ["TEE-S-RED", "TEE-S-BLUE", "TEE-M-RED", "TEE-M-GREEN", "TEE-M-BLUE"],
    );
    const rows = await withBypassContext(async () =>
      (await db.execute<{ code: string; default_rate: string }>(sql`
        select code, default_rate::text from items
         where org_id = ${org.orgId} and family_id = ${family.id} order by code`)).rows);
    assert.equal(rows.length, 5);
    assert.equal(rows.find((row) => row.code === "TEE-S-BLUE")?.default_rate, "29.9900");
    assert.equal(rows.find((row) => row.code === "TEE-M-GREEN")?.default_rate, "24.9900");
    const barcode = await withBypassContext(async () =>
      (await db.execute<{ value: string }>(sql`
        select value from item_identifiers where org_id = ${org.orgId}
         and item_id = (select id from items where org_id = ${org.orgId} and code = 'TEE-M-RED')`)).rows[0]);
    assert.equal(barcode?.value, "123456789012");
    const events = await withBypassContext(async () =>
      (await db.execute<{ event: string }>(sql`
        select changes->>'event' as event from audit_log
         where org_id = ${org.orgId} and table_name = 'item_families' and row_id = ${family.id}
         order by at`)).rows.map((row) => row.event));
    assert.ok(events.includes("family_created"));
    assert.ok(events.includes("variants_generated"));
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("createFamilyWithVariants leaves nothing behind when a variant is refused", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    await withBypassContext(() => createFamilyWithVariants(org.orgId, actorId, {
      code: "TEE",
      name: "Classic Tee",
      kind: "inventory",
      options: [{ name: "Size", values: ["S", "M"] }],
    }));
    await assert.rejects(
      withBypassContext(() => createFamilyWithVariants(org.orgId, actorId, {
        code: "HOOD",
        name: "Hoodie",
        kind: "inventory",
        options: [{ name: "Size", values: ["S", "M"] }],
        variants: [
          { optionValues: { Size: "S" }, code: "HOOD-S" },
          { optionValues: { Size: "M" }, code: "HOOD-S" },
        ],
      })),
      /used twice/,
    );
    const leftover = await withBypassContext(async () =>
      (await db.execute<{ count: string }>(sql`
        select count(*)::text as count from item_families where org_id = ${org.orgId} and code = 'HOOD'`)).rows[0]);
    assert.equal(leftover?.count, "0");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("createFamilyWithVariants refuses when the variants gate is off", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    await withBypassContext(async () => {
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"itemVariants":false}'::jsonb)
         where id = ${org.orgId}`);
    });
    await assert.rejects(
      withBypassContext(() => createFamilyWithVariants(org.orgId, actorId, {
        code: "TEE",
        name: "Classic Tee",
        kind: "inventory",
        options: SIZE_COLOR,
      })),
      /turned off/,
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("createFamilyWithVariants defaults to the full cartesian product", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    const { family, variants } = await withBypassContext(() =>
      createFamilyWithVariants(org.orgId, actorId, {
        code: "TEE",
        name: "Classic Tee",
        kind: "non_inventory",
        options: [
          { name: "Size", values: ["S", "M"] },
          { name: "Color", values: ["Red", "Blue"] },
        ],
      }),
    );
    assert.equal(variants.length, 4);
    assert.equal(family.variants.length, 4);
    assert.deepEqual(
      family.variants.map((variant) => variant.code).sort(),
      ["TEE-M-BLUE", "TEE-M-RED", "TEE-S-BLUE", "TEE-S-RED"],
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
