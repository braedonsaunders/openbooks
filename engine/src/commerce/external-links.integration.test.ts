import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { CommerceError } from "./errors.ts";
import {
  bulkFindNative,
  findExternal,
  findNative,
  linkExternal,
  listExternalLinks,
  unlinkExternal,
} from "./external-links.ts";
import { db, withOrgContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

async function setup(run: (org: ScratchOrg, actor: string) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await withOrgContext(org.orgId, () => createScratchUser(org.orgId, "Link tester", "admin"));
    await withOrgContext(org.orgId, async () => {
      const result = await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features','{}'::jsonb) || ${JSON.stringify({ subscriptionBilling: true, usageBilling: true, salesChannels: true })}::jsonb, true) where id = ${org.orgId}`);
      assert.equal(result.rowCount, 1);
    });
    await run(org, actor);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

async function shopifyChannel(orgId: string, actor: string): Promise<string> {
  const rows = (await withOrgContext(orgId, () => db.execute<{ id: string }>(sql`
    insert into sales_channels (org_id, kind, name, status, currency, external_account, settings, created_by, updated_by)
    values (${orgId}, 'shopify', 'Maple Shop', 'active', 'USD', 'maple.myshopify.com', '{}'::jsonb, ${actor}, ${actor})
    returning id`))).rows;
  return rows[0]!.id;
}

test("both uniqueness sides refuse naming both records", DB, async () => {
  await setup(async (org, actor) => {
    const first = await linkExternal(org.orgId, actor, {
      provider: "stripe",
      externalAccount: "acct_1",
      objectType: "customer",
      externalId: "cus_first",
      nativeTable: "parties",
      nativeId: org.customerId,
    }, "usageBilling");
    assert.equal(first.externalId, "cus_first");
    // Same external identity, a different native record: the message names the external id and the record already holding it.
    await assert.rejects(
      linkExternal(org.orgId, actor, {
        provider: "stripe",
        externalAccount: "acct_1",
        objectType: "customer",
        externalId: "cus_first",
        nativeTable: "parties",
        nativeId: org.vendorId,
      }, "usageBilling"),
      (error: unknown) => {
        assert.ok(error instanceof CommerceError);
        assert.equal(error.code, "external_link_conflict");
        assert.ok(error.message.includes("cus_first"), `names the external id: ${error.message}`);
        assert.ok(error.message.includes(org.customerId), `names the record holding it: ${error.message}`);
        return true;
      },
    );
    // Same native record, a different external identity: the message names the native record.
    await assert.rejects(
      linkExternal(org.orgId, actor, {
        provider: "stripe",
        externalAccount: "acct_1",
        objectType: "customer",
        externalId: "cus_second",
        nativeTable: "parties",
        nativeId: org.customerId,
      }, "usageBilling"),
      (error: unknown) => {
        assert.ok(error instanceof CommerceError);
        assert.equal(error.code, "external_link_target_in_use");
        assert.ok(error.message.includes(org.customerId), `names the native record: ${error.message}`);
        assert.ok(error.message.includes("cus_second") || error.message.includes("cus_first"), `names an external side: ${error.message}`);
        return true;
      },
    );
    // Relinking the identical pair is idempotent, not a conflict.
    const same = await linkExternal(org.orgId, actor, {
      provider: "stripe",
      externalAccount: "acct_1",
      objectType: "customer",
      externalId: "cus_first",
      nativeTable: "parties",
      nativeId: org.customerId,
    }, "usageBilling");
    assert.equal(same.id, first.id);
  });
});

test("channel-scoped links enforce the provider agreement", DB, async () => {
  await setup(async (org, actor) => {
    const channelId = await shopifyChannel(org.orgId, actor);
    const linked = await linkExternal(org.orgId, actor, {
      channelId,
      provider: "shopify",
      externalAccount: "maple.myshopify.com",
      objectType: "customer",
      externalId: "701",
      nativeTable: "parties",
      nativeId: org.customerId,
    }, "salesChannels");
    assert.equal(linked.channelId, channelId);
    // A storefront link without its channel refuses: the identity would resolve to no storefront.
    await assert.rejects(
      linkExternal(org.orgId, actor, {
        provider: "shopify",
        externalAccount: "maple.myshopify.com",
        objectType: "customer",
        externalId: "702",
        nativeTable: "parties",
        nativeId: org.customerId,
      }, "salesChannels"),
      /belongs to a channel/,
    );
    // A platform link through a channel refuses: Stripe identities are account-wide.
    await assert.rejects(
      linkExternal(org.orgId, actor, {
        channelId,
        provider: "stripe",
        externalAccount: "acct_1",
        objectType: "customer",
        externalId: "cus_channeled",
        nativeTable: "parties",
        nativeId: org.vendorId,
      }, "usageBilling"),
      /carry no channel/,
    );
    // A link to a deleted record refuses instead of resolving to nothing.
    await assert.rejects(
      linkExternal(org.orgId, actor, {
        channelId,
        provider: "shopify",
        externalAccount: "maple.myshopify.com",
        objectType: "customer",
        externalId: "703",
        nativeTable: "parties",
        nativeId: "00000000-0000-0000-0000-000000000000",
      }, "salesChannels"),
      /does not belong to this organization/,
    );
  });
});

test("links are tenant-isolated and unlink with audit evidence", DB, async () => {
  await setup(async (org, actor) => {
    await linkExternal(org.orgId, actor, {
      provider: "stripe",
      externalAccount: "acct_1",
      objectType: "customer",
      externalId: "cus_private",
      nativeTable: "parties",
      nativeId: org.customerId,
    }, "usageBilling");
    const other = await createScratchOrg();
    try {
      const otherActor = await withOrgContext(other.orgId, () => createScratchUser(other.orgId, "Other tester", "admin"));
      await withOrgContext(other.orgId, async () => {
        const result = await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features','{}'::jsonb) || ${JSON.stringify({ subscriptionBilling: true, usageBilling: true })}::jsonb, true) where id = ${other.orgId}`);
        assert.equal(result.rowCount, 1);
      });
      // The other tenant sees nothing, and may link the same external id to its own record.
      assert.equal(await withOrgContext(other.orgId, () => findNative(other.orgId, { provider: "stripe", externalAccount: "acct_1", objectType: "customer", externalId: "cus_private" })), null);
      await linkExternal(other.orgId, otherActor, {
        provider: "stripe",
        externalAccount: "acct_1",
        objectType: "customer",
        externalId: "cus_private",
        nativeTable: "parties",
        nativeId: other.customerId,
      }, "usageBilling");
      assert.equal(
        (await withOrgContext(other.orgId, () => findNative(other.orgId, { provider: "stripe", externalAccount: "acct_1", objectType: "customer", externalId: "cus_private" })))?.nativeId,
        other.customerId,
      );
    } finally {
      await dropScratchOrgReporting(other.orgId);
    }
    // Reads resolve both directions, including bulk.
    assert.equal(
      (await withOrgContext(org.orgId, () => findExternal(org.orgId, { provider: "stripe", externalAccount: "acct_1", objectType: "customer", nativeTable: "parties", nativeId: org.customerId })))?.externalId,
      "cus_private",
    );
    const bulk = await withOrgContext(org.orgId, () => bulkFindNative(org.orgId, "stripe", "acct_1", "customer", ["cus_private", "cus_missing"]));
    assert.equal(bulk.get("cus_private")?.nativeId, org.customerId);
    assert.equal(bulk.has("cus_missing"), false);
    assert.equal((await withOrgContext(org.orgId, () => listExternalLinks(org.orgId, { provider: "stripe", externalAccount: "acct_1", objectType: "customer" }))).length, 1);
    // Unlinking needs a reason, removes the mapping, and leaves evidence; the native record stays.
    await assert.rejects(unlinkExternal(org.orgId, actor, { provider: "stripe", externalAccount: "acct_1", objectType: "customer", externalId: "cus_private" }, "  ", "usageBilling"), /reason is required/);
    await unlinkExternal(org.orgId, actor, { provider: "stripe", externalAccount: "acct_1", objectType: "customer", externalId: "cus_private" }, "Wrong customer linked", "usageBilling");
    assert.equal(await withOrgContext(org.orgId, () => findNative(org.orgId, { provider: "stripe", externalAccount: "acct_1", objectType: "customer", externalId: "cus_private" })), null);
    await assert.rejects(
      unlinkExternal(org.orgId, actor, { provider: "stripe", externalAccount: "acct_1", objectType: "customer", externalId: "cus_private" }, "Again", "usageBilling"),
      /has no link/,
    );
    const audit = (await withOrgContext(org.orgId, () => db.execute<{ action: string }>(sql`
      select action from audit_log where org_id = ${org.orgId} and table_name = 'external_links' order by at`))).rows;
    assert.ok(audit.some((row) => row.action === "insert"));
    assert.ok(audit.some((row) => row.action === "delete"));
    const customer = (await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`
      select id from parties where org_id = ${org.orgId} and id = ${org.customerId}`))).rows;
    assert.equal(customer.length, 1);
  });
});
