import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { registerChannelAdapter } from "./adapters.ts";
import { createChannel, markChannelActive, retryChannel } from "./channels.ts";
import type { ChannelInboundDelivery } from "./contracts.ts";
import { CommerceError } from "./errors.ts";
import { channelAttention, processPendingEvents, receiveInboundEvent } from "./inbound.ts";
import { db, withOrgContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

registerChannelAdapter({
  kind: "shopify",
  describeSettings: () => z.object({}).strict(),
  verifyWebhook(rawBody: Buffer, headers: Record<string, string>, secret: string) {
    const signature = headers["x-test-signature"];
    const topic = headers["x-test-topic"];
    const eventId = headers["x-test-event-id"];
    if (!signature || !topic || !eventId) {
      throw new CommerceError(
        "channel_webhook_unverified",
        "The delivery is missing its signature, topic, or event id headers.",
        "Check the provider's webhook subscription sends the signature, topic, and event id with every delivery.",
        { field: "headers" },
      );
    }
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    if (signature !== expected) {
      throw new CommerceError(
        "channel_webhook_signature_invalid",
        "The webhook signature is not valid for this channel.",
        "Check the channel's webhook secret matches the secret registered with the provider.",
        { field: "signature" },
      );
    }
    return { eventId, topic };
  },
  async testConnection() {
    return { ok: true, detail: "test adapter" };
  },
  async handleEvent(delivery: ChannelInboundDelivery) {
    if (delivery.topic === "boom") {
      throw new CommerceError("test_handler_failed", "Test handler refuses topic boom.", "Replay after fixing the topic.", { field: "topic" });
    }
    return { action: "processed", resultRef: { eventId: delivery.eventId } };
  },
  workspaceTabs: () => [],
});

async function setup(run: (org: ScratchOrg, actor: string) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await withOrgContext(org.orgId, () => createScratchUser(org.orgId, "Attention tester", "admin"));
    await withOrgContext(org.orgId, async () => {
      const result = await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features','{}'::jsonb) || ${JSON.stringify({ salesChannels: true })}::jsonb, true) where id = ${org.orgId}`);
      assert.equal(result.rowCount, 1);
    });
    await run(org, actor);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

async function connect(orgId: string, actor: string, account: string): Promise<{ id: string; secret: string }> {
  const { channel, webhookSecret } = await createChannel(orgId, actor, {
    kind: "shopify",
    name: account,
    currency: "USD",
    externalAccount: account,
    settings: {},
  });
  assert.ok(webhookSecret);
  await retryChannel(orgId, actor, channel.id, "Starting the attention test");
  await markChannelActive(orgId, actor, channel.id);
  return { id: channel.id, secret: webhookSecret! };
}

function headers(secret: string, body: Buffer, topic: string, eventId: string): Record<string, string> {
  return {
    "x-test-signature": createHmac("sha256", secret).update(body).digest("hex"),
    "x-test-topic": topic,
    "x-test-event-id": eventId,
  };
}

async function deliver(orgId: string, channelId: string, secret: string, topic: string, eventId: string): Promise<void> {
  const body = Buffer.from(JSON.stringify({ id: eventId }));
  await withOrgContext(orgId, () => receiveInboundEvent({ channelId, rawBody: body, headers: headers(secret, body, topic, eventId) }));
}

test("attention counts failed and dead deliveries per channel with the newest delivery time", DB, async () => {
  await setup(async (org, actor) => {
    const first = await withOrgContext(org.orgId, () => connect(org.orgId, actor, "one.myshopify.com"));
    const second = await withOrgContext(org.orgId, () => connect(org.orgId, actor, "two.myshopify.com"));
    await deliver(org.orgId, first.id, first.secret, "orders/create", "evt-ok");
    await deliver(org.orgId, first.id, first.secret, "boom", "evt-fail-1");
    await deliver(org.orgId, first.id, first.secret, "boom", "evt-fail-2");
    await withOrgContext(org.orgId, () => processPendingEvents(10));
    // One failure ages into a dead letter while the other stays retryable.
    await withOrgContext(org.orgId, () => db.execute(sql`
      update integration_inbound_events set status = 'dead', attempts = 8
       where org_id = ${org.orgId} and provider_event_id = 'evt-fail-1'`));
    const attention = await withOrgContext(org.orgId, () => channelAttention(org.orgId));
    assert.deepEqual(
      { failed: attention[first.id]?.failed, dead: attention[first.id]?.dead },
      { failed: 1, dead: 1 },
    );
    assert.ok(attention[first.id]?.lastReceivedAt);
    assert.equal(attention[second.id], undefined);
  });
});

test("attention is scoped to the organization", DB, async () => {
  await setup(async (org, actor) => {
    const channel = await withOrgContext(org.orgId, () => connect(org.orgId, actor, "scoped.myshopify.com"));
    await deliver(org.orgId, channel.id, channel.secret, "boom", "evt-scoped");
    const other = await createScratchOrg();
    try {
      const attention = await withOrgContext(other.orgId, () => channelAttention(other.orgId));
      assert.deepEqual(attention, {});
      const own = await withOrgContext(org.orgId, () => channelAttention(org.orgId));
      assert.equal(own[channel.id]?.failed, 0);
    } finally {
      await dropScratchOrgReporting(other.orgId);
    }
  });
});
