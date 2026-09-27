import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { resolveScan, ScanRefusal, validateIdentifierUnit } from "./item-identifiers.ts";

const skip = !process.env.OPENBOOKS_DB_URL;

const setupResourcesModule = "../../../web/lib/data-io/setup-resources.ts";
const setupRegistryModule = "../../../web/lib/setup/registry.ts";

test("exact scan resolution is tenant-bound and refuses ambiguity with distinct candidates", { skip }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const other = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(async () => {
      for (const orgId of [org.orgId, other.orgId]) {
        await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"orders":true,"barcodeScanning":true,"customerPartNumbers":true}'::jsonb)
          where id = ${orgId}`);
      }
      await db.execute(sql`insert into customer_roles (org_id, party_id, is_active)
        values (${org.orgId}, ${org.customerId}, true), (${org.orgId}, ${org.vendorId}, true),
               (${other.orgId}, ${other.customerId}, true)`);
      const unit = (await db.execute<{ unit: string }>(sql`
        select base_unit as unit from item_inventory_profiles
         where org_id = ${org.orgId} and item_id = ${org.items.fifo}`)).rows[0]!.unit;
      const identifier = randomUUID();
      await db.execute(sql`insert into item_identifiers (org_id, item_id, kind, value, unit)
        values (${org.orgId}, ${org.items.fifo}, 'gtin', ${identifier}, ${unit})`);
      const itemCode = `ITEM-${randomUUID()}`;
      await db.execute(sql`update items set code = ${itemCode}
        where org_id = ${org.orgId} and id = ${org.items.standard}`);
      const foreignIdentifier = randomUUID();
      await db.execute(sql`insert into item_identifiers (org_id, item_id, kind, value)
        values (${other.orgId}, ${other.items.fifo}, 'gtin', ${foreignIdentifier})`);
      const customerSku = `CUST-${randomUUID()}`;
      await db.execute(sql`insert into customer_item_refs (org_id, customer_id, item_id, customer_sku)
        values (${org.orgId}, ${org.customerId}, ${org.items.fifo}, ${customerSku})`);

      const binCode = `BIN-${randomUUID()}`;
      const binId = randomUUID();
      await db.execute(sql`insert into stock_locations (id, org_id, location_id, code, kind, is_active)
        values (${binId}, ${org.orgId}, ${org.locationId}, ${binCode}, 'bin', true)`);
      const lotNumber = `LOT-${randomUUID()}`;
      const lotId = randomUUID();
      await db.execute(sql`insert into lots (id, org_id, item_id, lot_number)
        values (${lotId}, ${org.orgId}, ${org.items.fifo}, ${lotNumber})`);
      const serialNumber = `SER-${randomUUID()}`;
      const serialId = randomUUID();
      await db.execute(sql`insert into serials (id, org_id, item_id, serial_number, current_stock_location_id)
        values (${serialId}, ${org.orgId}, ${org.items.fifo}, ${serialNumber}, ${org.stockLocationId})`);

      assert.deepEqual(await resolveScan(db, org.orgId, { field: 'item', value: identifier }), {
        id: org.items.fifo, itemId: org.items.fifo, label: 'FIFO Widget', kind: 'gtin', unit, field: 'item',
      });
      assert.equal((await resolveScan(db, org.orgId, { field: 'item', value: itemCode })).id, org.items.standard);
      await validateIdentifierUnit(db, org.orgId, org.items.fifo, unit);
      await assert.rejects(validateIdentifierUnit(db, org.orgId, org.items.fifo, 'crate'),
        (error: unknown) => error instanceof ScanRefusal && error.code === 'invalid_identifier_unit');
      assert.equal((await resolveScan(db, org.orgId, { field: 'bin', value: binCode })).id, binId);
      assert.equal((await resolveScan(db, org.orgId, { field: 'lot', value: lotNumber, itemId: org.items.fifo })).id, lotId);
      assert.equal((await resolveScan(db, org.orgId, { field: 'serial', value: serialNumber, itemId: org.items.fifo })).id, serialId);
      assert.equal((await resolveScan(db, org.orgId, { field: 'item', value: customerSku, customerId: org.customerId })).id, org.items.fifo);
      await assert.rejects(resolveScan(db, org.orgId, { field: 'item', value: customerSku }),
        (error: unknown) => error instanceof ScanRefusal && error.code === 'scan_not_found');
      await assert.rejects(resolveScan(db, org.orgId, { field: 'item', value: customerSku, customerId: org.vendorId }),
        (error: unknown) => error instanceof ScanRefusal && error.code === 'scan_not_found');
      await assert.rejects(resolveScan(db, org.orgId, { field: 'item', value: customerSku, customerId: other.customerId }),
        (error: unknown) => error instanceof ScanRefusal && error.code === 'scan_not_found');
      await assert.rejects(resolveScan(db, org.orgId, { field: 'item', value: foreignIdentifier }),
        (error: unknown) => error instanceof ScanRefusal && error.code === 'scan_not_found');
      await assert.rejects(resolveScan(db, org.orgId, { field: 'item', value: `UNKNOWN-${randomUUID()}` }),
        (error: unknown) => error instanceof ScanRefusal && error.code === 'scan_not_found');

      const collision = `COL-${randomUUID()}`;
      await db.execute(sql`update items set code = ${collision} where org_id = ${org.orgId} and id = ${org.items.standard}`);
      await db.execute(sql`insert into item_identifiers (org_id, item_id, kind, value)
        values (${org.orgId}, ${org.items.fifo}, 'internal', ${collision})`);
      await assert.rejects(resolveScan(db, org.orgId, { field: 'item', value: collision }), (error: unknown) => {
        assert.ok(error instanceof ScanRefusal);
        assert.equal(error.code, 'ambiguous_scan');
        assert.deepEqual(new Set(error.candidates.map((candidate) => candidate.label)),
          new Set(['FIFO Widget', `${collision} · Std Widget`]));
        assert.equal(error.candidates.length, 2);
        assert.notEqual(error.candidates[0]?.id, error.candidates[1]?.id);
        return true;
      });
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
    await withBypassContext(() => dropScratchOrg(other.orgId));
  }
});

test("setup imports enforce identifier validation and entity write permission", { skip }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(() => db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"barcodeScanning":true}'::jsonb)
      where id = ${org.orgId}`));

    const resourceModule = await import(setupResourcesModule) as {
      setupResource: (entity: Record<string, unknown>, orgId: string) => {
        write: (rows: Record<string, unknown>[], mode: "insert", ctx: {
          orgId: string; actorId: string; dryRun: boolean; permissions?: ReadonlySet<string>
        }) => Promise<{ created: number; failed: number; errors: { message: string }[] }>
      }
    };
    const registryModule = await import(setupRegistryModule) as {
      SETUP_ENTITY_BY_KEY: Map<string, Record<string, unknown>>
    };
    const entity = registryModule.SETUP_ENTITY_BY_KEY.get("item-identifiers");
    assert.ok(entity);
    const resource = resourceModule.setupResource(entity, org.orgId);
    const item = (await db.execute<{ item_ref: string }>(sql`
      select coalesce(code, name) as item_ref from items where org_id = ${org.orgId} and id = ${org.items.fifo}`)).rows[0];
    assert.ok(item);
    const row = { itemId: item.item_ref, kind: "gtin", value: `GTIN-${randomUUID()}`, unit: "crate" };
    const actorId = randomUUID();

    const denied = await resource.write([row], "insert", {
      orgId: org.orgId, actorId, dryRun: true, permissions: new Set(),
    });
    assert.equal(denied.created, 0);
    assert.equal(denied.failed, 1);
    assert.match(denied.errors[0]!.message, /items\.manage.*grant it to the importing role and retry/);

    const invalidUnit = await resource.write([row], "insert", {
      orgId: org.orgId, actorId, dryRun: true, permissions: new Set(["items.manage"]),
    });
    assert.equal(invalidUnit.created, 0);
    assert.equal(invalidUnit.failed, 1);
    assert.match(invalidUnit.errors[0]!.message, /unit crate is not a base or converted unit/);
    assert.match(invalidUnit.errors[0]!.message, /use the item's base unit or add this unit to its inventory conversions/);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
