import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { workspaceTabsFor } from "./adapters.ts";
import { createChannel, updateChannel } from "./channels.ts";
import { CommerceError } from "./errors.ts";
import { db, withOrgContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

// NOTE: this file must never import the inbox, the workspace, the
// lifecycle route, or anything else that ensures the Shopify adapter.
// The first test proves the process arrives with no adapter installed,
// so channel writes initialize installed connectors themselves instead
// of refusing a known kind with an install remedy.
async function setup(
  run: (org: ScratchOrg, actor: string) => Promise<void>,
): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await withOrgContext(org.orgId, () => createScratchUser(org.orgId, "Channel tester", "admin"));
    await withOrgContext(org.orgId, async () => {
      const result = await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features','{}'::jsonb) || ${JSON.stringify({ salesChannels: true })}::jsonb, true) where id = ${org.orgId}`);
      assert.equal(result.rowCount, 1);
    });
    await run(org, actor);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

test("a fresh process creates and updates a shopify channel without visiting the workspace", DB, async () => {
  assert.deepEqual(workspaceTabsFor("shopify"), []);
  await setup(async (org, actor) => {
    const created = await withOrgContext(org.orgId, () =>
      createChannel(org.orgId, actor, {
        kind: "shopify",
        name: "Flow Shop",
        currency: "USD",
        externalAccount: "flow.myshopify.com",
      }),
    );
    assert.equal(created.channel.kind, "shopify");
    assert.equal(created.channel.status, "draft");
    const updated = await withOrgContext(org.orgId, () =>
      updateChannel(org.orgId, actor, created.channel.id, { settings: {} }),
    );
    assert.ok(updated.settings && typeof updated.settings === "object");
  });
});

test("an unknown kind still refuses by name with the install remedy", DB, async () => {
  await setup(async (org, actor) => {
    await assert.rejects(
      withOrgContext(org.orgId, () =>
        createChannel(org.orgId, actor, {
          kind: "nope",
          name: "Nowhere Shop",
          currency: "USD",
          externalAccount: "nowhere.example",
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof CommerceError);
        assert.equal(error.code, "channel_kind_unknown");
        assert.ok(error.message.includes('"nope"'), `names the kind: ${error.message}`);
        assert.ok(/install/i.test(error.remedy), `names the remedy: ${error.remedy}`);
        return true;
      },
    );
  });
});
