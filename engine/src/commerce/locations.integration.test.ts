import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { CommerceError } from "./errors.ts";
import { listChannelLocations, unlinkChannelLocation, upsertChannelLocation } from "./locations.ts";
import { db, withOrgContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

async function setup(
  run: (org: ScratchOrg, actor: string, channelId: string) => Promise<void>,
): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await withOrgContext(org.orgId, () => createScratchUser(org.orgId, "Location tester", "admin"));
    await withOrgContext(org.orgId, async () => {
      const result = await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features','{}'::jsonb) || ${JSON.stringify({ salesChannels: true })}::jsonb, true) where id = ${org.orgId}`);
      assert.equal(result.rowCount, 1);
    });
    const channelId = (await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`
      insert into sales_channels (org_id, kind, name, status, currency, external_account, settings, created_by, updated_by)
      values (${org.orgId}, 'shopify', 'Maple Shop', 'active', 'USD', 'maple.myshopify.com', '{}'::jsonb, ${actor}, ${actor})
      returning id`))).rows[0]!.id;
    await run(org, actor, channelId);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

test("upserting a storefront location maps it, and a re-sync updates it in place", DB, async () => {
  await setup(async (org, actor, channelId) => {
    const first = await withOrgContext(org.orgId, () => upsertChannelLocation(org.orgId, actor, {
      channelId,
      externalLocationId: "loc-1",
      externalName: "Toronto warehouse",
      stockLocationId: org.stockLocationId,
    }));
    assert.equal(first.stockLocationId, org.stockLocationId);
    assert.equal(first.syncInventory, true);
    const second = await withOrgContext(org.orgId, () => upsertChannelLocation(org.orgId, actor, {
      channelId,
      externalLocationId: "loc-1",
      externalName: "Toronto flagship",
      stockLocationId: org.stockLocationId2,
      syncInventory: false,
    }));
    assert.equal(second.id, first.id);
    assert.equal(second.externalName, "Toronto flagship");
    const listed = await withOrgContext(org.orgId, () => listChannelLocations(org.orgId, channelId));
    assert.equal(listed.length, 1);
  });
});

test("detaching without a reason refuses, and with a reason removes the mapping", DB, async () => {
  await setup(async (org, actor, channelId) => {
    await withOrgContext(org.orgId, () => upsertChannelLocation(org.orgId, actor, {
      channelId,
      externalLocationId: "loc-9",
      externalName: "Pop-up",
    }));
    await assert.rejects(
      withOrgContext(org.orgId, () => unlinkChannelLocation(org.orgId, actor, channelId, "loc-9", "  ")),
      (error: unknown) => {
        assert.ok(error instanceof CommerceError);
        assert.equal(error.code, "channel_location_reason_missing");
        return true;
      },
    );
    await withOrgContext(org.orgId, () => unlinkChannelLocation(org.orgId, actor, channelId, "loc-9", "Pop-up closed"));
    assert.equal(await withOrgContext(org.orgId, () => listChannelLocations(org.orgId, channelId)).then((rows) => rows.length), 0);
  });
});

test("a channel in another organization is not visible to locations", DB, async () => {
  await setup(async (org, actor, channelId) => {
    const other = await createScratchOrg();
    try {
      const otherActor = await withOrgContext(other.orgId, () => createScratchUser(other.orgId, "Other tester", "admin"));
      await withOrgContext(other.orgId, async () => {
        await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features','{}'::jsonb) || '{"salesChannels":true}'::jsonb, true) where id = ${other.orgId}`);
      });
      await assert.rejects(
        withOrgContext(other.orgId, () => listChannelLocations(other.orgId, channelId)),
        (error: unknown) => {
          assert.ok(error instanceof CommerceError);
          assert.equal(error.code, "channel_not_found");
          return true;
        },
      );
      assert.equal(await withOrgContext(org.orgId, () => listChannelLocations(org.orgId, channelId)).then((rows) => rows.length), 0);
      void actor;
      void otherActor;
    } finally {
      await dropScratchOrgReporting(other.orgId);
    }
  });
});
