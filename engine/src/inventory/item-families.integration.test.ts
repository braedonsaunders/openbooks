import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import {
  bulkEditVariants,
  convertItemToFamily,
  createItemFamily,
  detachVariant,
  generateFamilyVariants,
  getItemFamily,
  ItemFamilyError,
  replaceFamilyOptions,
} from "./item-families.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function enableItemVariants(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"itemVariants":true}'::jsonb)
     where id = ${orgId}`);
}

async function disableItemVariants(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"itemVariants":false}'::jsonb)
     where id = ${orgId}`);
}

async function setup() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId);
  await withBypassContext(() => enableItemVariants(org.orgId));
  return { org, actorId };
}

const SIZE_COLOR = [
  { name: "Size", values: ["S", "M"] },
  { name: "Color", values: ["Red", "Blue"] },
];

async function createTee(orgId: string, actorId: string) {
  return withBypassContext(() =>
    createItemFamily(orgId, actorId, {
      code: "TEE",
      name: "Classic Tee",
      category: "Apparel",
      kind: "inventory",
      defaultUnit: "each",
      defaultRate: "19.99",
      options: SIZE_COLOR,
    }),
  );
}

async function auditEvents(orgId: string, table: string, rowId: string): Promise<string[]> {
  return withBypassContext(async () =>
    (await db.execute<{ changes: { event: string } }>(sql`
      select changes from audit_log where org_id = ${orgId} and table_name = ${table} and row_id = ${rowId}
       order by at`)).rows.map((row) => String(row.changes?.event ?? "")),
  );
}

test("generation creates one variant per combination with family codes and names", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    const family = await createTee(org.orgId, actorId);
    const generated = await withBypassContext(() => generateFamilyVariants(org.orgId, actorId, family.id));
    assert.equal(generated.variants.length, 4);
    assert.deepEqual(
      generated.variants.map((variant) => variant.code),
      ["TEE-S-RED", "TEE-S-BLUE", "TEE-M-RED", "TEE-M-BLUE"],
    );
    assert.ok(generated.variants.every((variant) => variant.created));
    const first = generated.variants[0]!;
    assert.equal(first.name, "Classic Tee — S / Red");
    assert.deepEqual(first.optionValues, { Size: "S", Color: "Red" });
    const rows = await withBypassContext(async () =>
      (await db.execute<{ kind: string; unit: string; default_rate: string; category: string }>(sql`
        select kind, unit, default_rate::text, category from items
         where org_id = ${org.orgId} and family_id = ${family.id}`)).rows);
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.kind, "inventory");
      assert.equal(row.unit, "each");
      assert.equal(row.default_rate, "19.9900");
      assert.equal(row.category, "Apparel");
    }
    const events = await auditEvents(org.orgId, "item_families", family.id);
    assert.ok(events.includes("family_created"));
    assert.ok(events.includes("variants_generated"));
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("generation is idempotent: re-running creates only missing combinations", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    const family = await createTee(org.orgId, actorId);
    const first = await withBypassContext(() => generateFamilyVariants(org.orgId, actorId, family.id));
    assert.ok(first.variants.every((variant) => variant.created));
    const second = await withBypassContext(() => generateFamilyVariants(org.orgId, actorId, family.id));
    assert.ok(second.variants.every((variant) => !variant.created));
    assert.deepEqual(
      second.variants.map((variant) => variant.id).sort(),
      first.variants.map((variant) => variant.id).sort(),
    );
    const count = await withBypassContext(async () =>
      (await db.execute<{ count: string }>(sql`
        select count(*)::text as count from items where org_id = ${org.orgId} and family_id = ${family.id}`)).rows[0]!.count);
    assert.equal(count, "4");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("generation refuses a code taken by another item, naming it, and creates nothing", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    const family = await createTee(org.orgId, actorId);
    await withBypassContext(() => db.execute(sql`
      insert into items (org_id, kind, code, name, is_active, created_by)
      values (${org.orgId}, 'non_inventory', 'TEE-S-RED', 'Existing Shirt', true, ${actorId})`));
    await assert.rejects(
      withBypassContext(() => generateFamilyVariants(org.orgId, actorId, family.id)),
      /variant code TEE-S-RED is already used by Existing Shirt/,
    );
    const count = await withBypassContext(async () =>
      (await db.execute<{ count: string }>(sql`
        select count(*)::text as count from items where org_id = ${org.orgId} and family_id = ${family.id}`)).rows[0]!.count);
    assert.equal(count, "0");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("removing a used option value is refused naming the variants", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    const family = await createTee(org.orgId, actorId);
    await withBypassContext(() => generateFamilyVariants(org.orgId, actorId, family.id));
    const options = (await withBypassContext(() => getItemFamily(org.orgId, family.id)))!.options;
    await assert.rejects(
      withBypassContext(() =>
        replaceFamilyOptions(org.orgId, actorId, family.id, [
          { id: options[0]!.id, name: "Size", values: ["S", "M"] },
          { id: options[1]!.id, name: "Color", values: ["Blue"] },
        ]),
      ),
      /value Red of option Color is used by 2 variants \(TEE-M-RED, TEE-S-RED\); deactivate the variants instead of removing the value/,
    );
    const after = (await withBypassContext(() => getItemFamily(org.orgId, family.id)))!;
    assert.deepEqual(after.options[1]!.values, ["Red", "Blue"]);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("removing a used option is refused naming the variants", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    const family = await createTee(org.orgId, actorId);
    await withBypassContext(() => generateFamilyVariants(org.orgId, actorId, family.id));
    const options = (await withBypassContext(() => getItemFamily(org.orgId, family.id)))!.options;
    await assert.rejects(
      withBypassContext(() =>
        replaceFamilyOptions(org.orgId, actorId, family.id, [
          { id: options[0]!.id, name: "Size", values: ["S", "M"] },
        ]),
      ),
      /option Color is used by 4 variants .*; deactivate the variants instead of removing the option/,
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("renaming a value renames variant names and never codes", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    const family = await createTee(org.orgId, actorId);
    await withBypassContext(() => generateFamilyVariants(org.orgId, actorId, family.id));
    const options = (await withBypassContext(() => getItemFamily(org.orgId, family.id)))!.options;
    await withBypassContext(() =>
      replaceFamilyOptions(org.orgId, actorId, family.id, [
        { id: options[0]!.id, name: "Size", values: ["S", "M"] },
        { id: options[1]!.id, name: "Color", values: [{ value: "Crimson", previousValue: "Red" }, "Blue"] },
      ]),
    );
    const detail = (await withBypassContext(() => getItemFamily(org.orgId, family.id)))!;
    assert.deepEqual(detail.options[1]!.values, ["Crimson", "Blue"]);
    const codes = detail.variants.map((variant) => variant.code).sort();
    assert.deepEqual(codes, ["TEE-M-BLUE", "TEE-M-RED", "TEE-S-BLUE", "TEE-S-RED"]);
    const names = detail.variants.map((variant) => variant.name).sort();
    assert.ok(names.includes("Classic Tee — S / Crimson"));
    assert.ok(names.includes("Classic Tee — M / Crimson"));
    assert.ok(!names.some((name) => name.includes("Red")));
    for (const variant of detail.variants) {
      assert.deepEqual(Object.keys(variant.optionValues), ["Size", "Color"]);
    }
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("adding an option backfills existing variants with its default value", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    const family = await createTee(org.orgId, actorId);
    await withBypassContext(() => generateFamilyVariants(org.orgId, actorId, family.id));
    const options = (await withBypassContext(() => getItemFamily(org.orgId, family.id)))!.options;
    await withBypassContext(() =>
      replaceFamilyOptions(org.orgId, actorId, family.id, [
        { id: options[0]!.id, name: "Size", values: ["S", "M"] },
        { id: options[1]!.id, name: "Color", values: ["Red", "Blue"] },
        { name: "Material", values: ["Cotton", "Linen"], defaultValue: "Cotton" },
      ]),
    );
    const detail = (await withBypassContext(() => getItemFamily(org.orgId, family.id)))!;
    assert.equal(detail.options.length, 3);
    for (const variant of detail.variants) {
      assert.equal(variant.optionValues.Material, "Cotton");
      assert.ok(variant.name.includes("Cotton"));
    }
    const generated = await withBypassContext(() =>
      generateFamilyVariants(org.orgId, actorId, family.id, { only: [{ Size: "S", Color: "Red", Material: "Linen" }] }),
    );
    assert.equal(generated.variants.length, 1);
    assert.ok(generated.variants[0]!.created);
    assert.equal(generated.variants[0]!.code, "TEE-S-RED-LINEN");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("adding an option without a default for existing variants is refused", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    const family = await createTee(org.orgId, actorId);
    await withBypassContext(() => generateFamilyVariants(org.orgId, actorId, family.id));
    const options = (await withBypassContext(() => getItemFamily(org.orgId, family.id)))!.options;
    await assert.rejects(
      withBypassContext(() =>
        replaceFamilyOptions(org.orgId, actorId, family.id, [
          { id: options[0]!.id, name: "Size", values: ["S", "M"] },
          { id: options[1]!.id, name: "Color", values: ["Red", "Blue"] },
          { name: "Material", values: ["Cotton"] },
        ]),
      ),
      /new option Material needs a default value for the 4 existing variants/,
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("bulk edit sets price, cost, barcode and status in one audited transaction", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    const family = await createTee(org.orgId, actorId);
    const generated = await withBypassContext(() => generateFamilyVariants(org.orgId, actorId, family.id));
    const ids = generated.variants.map((variant) => variant.id);
    const result = await withBypassContext(() =>
      bulkEditVariants(org.orgId, actorId, {
        variantIds: ids,
        price: "24.50",
        cost: "9.75",
        barcode: { value: "810055012345", kind: "gtin" },
        isActive: false,
      }),
    );
    assert.equal(result.familyId, family.id);
    assert.deepEqual(result.updated.sort(), ids.sort());
    const rows = await withBypassContext(async () =>
      (await db.execute<{ default_rate: string; default_cost: string; is_active: boolean }>(sql`
        select default_rate::text, default_cost::text, is_active from items
         where org_id = ${org.orgId} and family_id = ${family.id}`)).rows);
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.default_rate, "24.5000");
      assert.equal(row.default_cost, "9.7500");
      assert.equal(row.is_active, false);
    }
    const barcodes = await withBypassContext(async () =>
      (await db.execute<{ count: string }>(sql`
        select count(*)::text as count from item_identifiers
         where org_id = ${org.orgId} and kind = 'gtin' and value = '810055012345'`)).rows[0]!.count);
    assert.equal(barcodes, "1");
    for (const id of ids) {
      const events = await auditEvents(org.orgId, "items", id);
      assert.ok(events.includes("variant_bulk_edited"));
    }
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("bulk edit refuses a barcode taken by another item, naming it", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    const family = await createTee(org.orgId, actorId);
    const generated = await withBypassContext(() => generateFamilyVariants(org.orgId, actorId, family.id));
    await withBypassContext(() => db.execute(sql`
      insert into item_identifiers (org_id, item_id, kind, value, created_by)
      values (${org.orgId}, ${org.items.service}, 'gtin', '810055099999', ${actorId})`));
    await assert.rejects(
      withBypassContext(() =>
        bulkEditVariants(org.orgId, actorId, {
          variantIds: generated.variants.map((variant) => variant.id),
          barcode: { value: "810055099999", kind: "gtin" },
        }),
      ),
      /barcode 810055099999 is already used by/,
    );
    const barcodes = await withBypassContext(async () =>
      (await db.execute<{ count: string }>(sql`
        select count(*)::text as count from item_identifiers
         where org_id = ${org.orgId} and value = '810055099999'`)).rows[0]!.count);
    assert.equal(barcodes, "1");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("bulk edit refuses items that are not variants, naming the item", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    const family = await createTee(org.orgId, actorId);
    const generated = await withBypassContext(() => generateFamilyVariants(org.orgId, actorId, family.id));
    await assert.rejects(
      withBypassContext(() =>
        bulkEditVariants(org.orgId, actorId, {
          variantIds: [generated.variants[0]!.id, org.items.service],
          price: "10",
        }),
      ),
      /is not a variant of any family/,
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("detach keeps the item and clears only its family membership", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    const family = await createTee(org.orgId, actorId);
    const generated = await withBypassContext(() => generateFamilyVariants(org.orgId, actorId, family.id));
    const target = generated.variants[0]!;
    const detached = await withBypassContext(() => detachVariant(org.orgId, actorId, target.id));
    assert.equal(detached.familyId, family.id);
    const row = await withBypassContext(async () =>
      (await db.execute<{ code: string; name: string; family_id: string | null }>(sql`
        select code, name, family_id from items where org_id = ${org.orgId} and id = ${target.id}`)).rows[0]!);
    assert.equal(row.code, target.code);
    assert.equal(row.name, target.name);
    assert.equal(row.family_id, null);
    const events = await auditEvents(org.orgId, "items", target.id);
    assert.ok(events.includes("variant_detached"));
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("convert makes a standalone item the first variant of its new family", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    const converted = await withBypassContext(() =>
      convertItemToFamily(org.orgId, actorId, {
        itemId: org.items.service,
        code: "CONSULT",
        options: [{ name: "Tier", value: "Standard" }],
      }),
    );
    assert.equal(converted.code, "CONSULT");
    assert.equal(converted.options.length, 1);
    assert.equal(converted.options[0]!.name, "Tier");
    const row = await withBypassContext(async () =>
      (await db.execute<{ family_id: string; option_values: Record<string, string> }>(sql`
        select family_id, option_values from items where org_id = ${org.orgId} and id = ${org.items.service}`)).rows[0]!);
    assert.equal(row.family_id, converted.id);
    assert.deepEqual(row.option_values, { Tier: "Standard" });
    const generated = await withBypassContext(() =>
      generateFamilyVariants(org.orgId, actorId, converted.id, { only: [{ Tier: "Standard" }] }),
    );
    assert.equal(generated.variants.length, 1);
    assert.equal(generated.variants[0]!.created, false);
    assert.equal(generated.variants[0]!.id, org.items.service);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("family writes refuse while the feature is off and leave nothing behind", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    await withBypassContext(() => disableItemVariants(org.orgId));
    await assert.rejects(
      withBypassContext(() =>
        createItemFamily(org.orgId, actorId, {
          code: "TEE",
          name: "Classic Tee",
          kind: "inventory",
          options: SIZE_COLOR,
        }),
      ),
      /item variants are turned off for this organization; turn on Item variants in Company Settings → Features/,
    );
    const count = await withBypassContext(async () =>
      (await db.execute<{ count: string }>(sql`
        select count(*)::text as count from item_families where org_id = ${org.orgId}`)).rows[0]!.count);
    assert.equal(count, "0");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("families are isolated per organization", { skip: !DB }, async () => {
  const first = await setup();
  const second = await setup();
  try {
    const family = await createTee(first.org.orgId, first.actorId);
    assert.equal(await withBypassContext(() => getItemFamily(second.org.orgId, family.id)), null);
    await assert.rejects(
      withBypassContext(() => generateFamilyVariants(second.org.orgId, second.actorId, family.id)),
      /the product family is not in this organization/,
    );
    const sibling = await withBypassContext(() =>
      createItemFamily(second.org.orgId, second.actorId, {
        code: "TEE",
        name: "Classic Tee",
        kind: "inventory",
        options: SIZE_COLOR,
      }),
    );
    assert.equal(sibling.code, "TEE");
  } finally {
    await withBypassContext(() => dropScratchOrg(first.org.orgId));
    await withBypassContext(() => dropScratchOrg(second.org.orgId));
  }
});

test("family creation refuses a taken code and an unknown kind", { skip: !DB }, async () => {
  const { org, actorId } = await setup();
  try {
    await createTee(org.orgId, actorId);
    await assert.rejects(
      withBypassContext(() =>
        createItemFamily(org.orgId, actorId, {
          code: "TEE",
          name: "Other Tee",
          kind: "inventory",
          options: SIZE_COLOR,
        }),
      ),
      /family code TEE is already in use/,
    );
    await assert.rejects(
      withBypassContext(() =>
        createItemFamily(org.orgId, actorId, {
          code: "LABOR",
          name: "Labor",
          kind: "labor",
          options: SIZE_COLOR,
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof ItemFamilyError);
        assert.match(error.message, /family kind labor cannot carry variants/);
        assert.equal(error.code, "invalid_family_kind");
        return true;
      },
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
