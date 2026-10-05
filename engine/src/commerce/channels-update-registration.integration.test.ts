import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { workspaceTabsFor } from "./adapters.ts";
import { updateChannel } from "./channels.ts";
import { db, withOrgContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

// NOTE: same freshness rule as the create companion: this file must never
// import the inbox, the workspace, the lifecycle route, or anything else
// that ensures the Shopify adapter. The channel row below arrives through
// raw SQL (as other suites seed it), so the ONLY registration in this
// process comes from updateChannel itself: removing its ensure must fail
// this test with channel_kind_unknown.
async function setup(
  run: (org: ScratchOrg, actor: string, channelId: string) => Promise<void>,
): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await withOrgContext(org.orgId, () => createScratchUser(org.orgId, "Channel tester", "admin"));
    await withOrgContext(org.orgId, async () => {
      const result = await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features','{}'::jsonb) || ${JSON.stringify({ salesChannels: true })}::jsonb, true) where id = ${org.orgId}`);
      assert.equal(result.rowCount, 1);
    });
    const channelId = (await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`
      insert into sales_channels (org_id, kind, name, status, currency, external_account, settings, created_by, updated_by)
      values (${org.orgId}, 'shopify', 'Cold Shop', 'draft', 'USD', 'cold.myshopify.com', '{}'::jsonb, ${actor}, ${actor})
      returning id`))).rows[0]!.id;
    await run(org, actor, channelId);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

test("a fresh process updates channel settings without a prior create", DB, async () => {
  assert.deepEqual(workspaceTabsFor("shopify"), []);
  await setup(async (org, actor, channelId) => {
    const updated = await withOrgContext(org.orgId, () =>
      updateChannel(org.orgId, actor, channelId, { settings: { pushCatalog: true } }),
    );
    assert.equal(updated.settings.pushCatalog, true);
    const reread = (await withOrgContext(org.orgId, () => db.execute<{ settings: { pushCatalog?: boolean } }>(sql`
      select settings from sales_channels where org_id = ${org.orgId} and id = ${channelId}`))).rows[0]!;
    assert.equal(reread.settings.pushCatalog, true);
  });
});
