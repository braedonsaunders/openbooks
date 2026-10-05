import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { registerChannelAdapter } from "./adapters.ts";
import {
  createChannel,
  markChannelActive,
  pauseChannel,
  resumeChannel,
  retryChannel,
} from "./channels.ts";
import type { ChannelInboundDelivery } from "./contracts.ts";
import { CommerceError } from "./errors.ts";
import { processPendingEvents, receiveInboundEvent, replayEvent } from "./inbound.ts";
import { db, withOrgContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

const calls: ChannelInboundDelivery[] = [];
const failTopics = new Set<string>();

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
    const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"), "hex");
    let provided: Buffer;
    try {
      provided = Buffer.from(signature, "hex");
    } catch {
      throw new CommerceError(
        "channel_webhook_signature_invalid",
        "The webhook signature is not valid for this channel.",
        "Check the channel's webhook secret matches the secret registered with the provider.",
        { field: "signature" },
      );
    }
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
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
    calls.push(delivery);
    if (failTopics.has(delivery.topic)) {
      throw new CommerceError(
        "test_handler_failed",
        `Test handler refuses topic ${delivery.topic}.`,
        "Clear the failing topic and replay the event.",
        { field: "topic" },
      );
    }
    if (delivery.topic === "unknown.topic") return { action: "ignored", resultRef: { eventId: delivery.eventId } };
    return { action: "processed", resultRef: { eventId: delivery.eventId, topic: delivery.topic } };
  },
  workspaceTabs: () => [],
});

function sign(secret: string, body: Buffer): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function setup(run: (org: ScratchOrg, actor: string) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await withOrgContext(org.orgId, () => createScratchUser(org.orgId, "Inbox tester", "admin"));
    await withOrgContext(org.orgId, async () => {
      const result = await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features','{}'::jsonb) || ${JSON.stringify({ salesChannels: true })}::jsonb, true) where id = ${org.orgId}`);
      assert.equal(result.rowCount, 1);
    });
    await run(org, actor);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

async function activeChannel(orgId: string, actor: string): Promise<{ id: string; secret: string }> {
  const { channel, webhookSecret } = await createChannel(orgId, actor, {
    kind: "shopify",
    name: "Test shop",
    currency: "USD",
    externalAccount: "test.myshopify.com",
    settings: {},
  });
  assert.ok(webhookSecret);
  await retryChannel(orgId, actor, channel.id, "Starting the test connection");
  await markChannelActive(orgId, actor, channel.id);
  return { id: channel.id, secret: webhookSecret };
}

function delivery(secret: string, eventId: string, topic = "orders/create", extra: Record<string, string> = {}) {
  const rawBody = Buffer.from(JSON.stringify({ id: eventId, topic }));
  return {
    rawBody,
    headers: {
      "x-test-signature": sign(secret, rawBody),
      "x-test-topic": topic,
      "x-test-event-id": eventId,
      "x-customer-email": "someone@example.test",
      ...extra,
    },
  };
}

async function eventCount(orgId: string): Promise<number> {
  const rows = (await withOrgContext(orgId, () => db.execute<{ n: number }>(sql`
    select count(*)::int as n from integration_inbound_events where org_id = ${orgId}`))).rows;
  return rows[0]!.n;
}

test("a bad signature stores nothing and an unknown channel refuses", DB, async () => {
  await setup(async (org, actor) => {
    const { id, secret } = await activeChannel(org.orgId, actor);
    const good = delivery(secret, "evt-bad-1");
    await assert.rejects(
      receiveInboundEvent({ channelId: id, rawBody: good.rawBody, headers: { ...good.headers, "x-test-signature": "00".repeat(32) } }),
      (error: unknown) => error instanceof CommerceError && error.code === "channel_webhook_signature_invalid",
    );
    assert.equal(await eventCount(org.orgId), 0);
    await assert.rejects(
      receiveInboundEvent({ channelId: "00000000-0000-0000-0000-000000000000", rawBody: good.rawBody, headers: good.headers }),
      (error: unknown) => error instanceof CommerceError && error.code === "channel_not_found",
    );
    assert.equal(await eventCount(org.orgId), 0);
  });
});

test("a duplicate delivery stores once and one effect follows two runs", DB, async () => {
  await setup(async (org, actor) => {
    calls.length = 0;
    const { id, secret } = await activeChannel(org.orgId, actor);
    const first = delivery(secret, "evt-dupe-1");
    const stored = await receiveInboundEvent({ channelId: id, ...first });
    const redelivered = await receiveInboundEvent({ channelId: id, ...delivery(secret, "evt-dupe-1") });
    assert.equal(redelivered.id, stored.id);
    assert.equal(await eventCount(org.orgId), 1);
    // Only the signature, topic, id, and shop headers are kept; customer data in headers is dropped.
    const headers = (await withOrgContext(org.orgId, () => db.execute<{ headers: Record<string, string> }>(sql`
      select headers from integration_inbound_events where id = ${stored.id}`))).rows[0]!.headers;
    assert.equal(headers["x-customer-email"], undefined);
    assert.equal(headers["x-test-topic"], "orders/create");
    const firstRun = await processPendingEvents(10);
    assert.deepEqual([firstRun.processed, calls.length], [1, 1]);
    const secondRun = await processPendingEvents(10);
    assert.deepEqual([secondRun.processed, calls.length], [0, 1]);
    const status = (await withOrgContext(org.orgId, () => db.execute<{ status: string; result_ref: unknown }>(sql`
      select status, result_ref from integration_inbound_events where id = ${stored.id}`))).rows[0]!;
    assert.equal(status.status, "processed");
    assert.ok(JSON.stringify(status.result_ref).includes("evt-dupe-1"));
    // Replay is the audited operator action that re-runs the adapter on purpose.
    await replayEvent(org.orgId, actor, stored.id, "Replaying after a mapping fix");
    const thirdRun = await processPendingEvents(10);
    assert.deepEqual([thirdRun.processed, calls.length], [1, 2]);
    await assert.rejects(replayEvent(org.orgId, actor, stored.id, "   "), /reason is required/);
  });
});

test("a failing handler backs off and then dead-letters", DB, async () => {
  await setup(async (org, actor) => {
    calls.length = 0;
    failTopics.add("boom");
    try {
      const { id, secret } = await activeChannel(org.orgId, actor);
      const stored = await receiveInboundEvent({ channelId: id, ...delivery(secret, "evt-boom-1", "boom") });
      await processPendingEvents(10);
      const failed = (await withOrgContext(org.orgId, () => db.execute<{ status: string; attempts: number; error: string | null; next_attempt_at: string }>(sql`
        select status, attempts, error, next_attempt_at from integration_inbound_events where id = ${stored.id}`))).rows[0]!;
      assert.equal(failed.status, "failed");
      assert.equal(failed.attempts, 1);
      assert.ok(failed.error?.includes("boom"));
      assert.ok(new Date(failed.next_attempt_at).getTime() > Date.now(), "backs off before retrying");
      await withOrgContext(org.orgId, async () => {
        const result = await db.execute(sql`update integration_inbound_events set attempts = 7, next_attempt_at = now(), status = 'failed' where id = ${stored.id}`);
        assert.equal(result.rowCount, 1);
      });
      await processPendingEvents(10);
      const dead = (await withOrgContext(org.orgId, () => db.execute<{ status: string; attempts: number }>(sql`
        select status, attempts from integration_inbound_events where id = ${stored.id}`))).rows[0]!;
      assert.deepEqual([dead.status, dead.attempts], ["dead", 8]);
    } finally {
      failTopics.delete("boom");
    }
  });
});

test("a paused channel holds events and lifecycle guards refuse", DB, async () => {
  await setup(async (org, actor) => {
    calls.length = 0;
    const { id, secret } = await activeChannel(org.orgId, actor);
    await pauseChannel(org.orgId, actor, id, "Holding orders during stocktake");
    const stored = await receiveInboundEvent({ channelId: id, ...delivery(secret, "evt-held-1") });
    await processPendingEvents(10);
    assert.equal(calls.length, 0);
    const held = (await withOrgContext(org.orgId, () => db.execute<{ status: string }>(sql`
      select status from integration_inbound_events where id = ${stored.id}`))).rows[0]!;
    assert.equal(held.status, "pending");
    await resumeChannel(org.orgId, actor, id, "Stocktake finished");
    // Resuming an active channel is not a move: the guard names the refusal instead of no-op success.
    await assert.rejects(resumeChannel(org.orgId, actor, id, "No-op"), /cannot move to active/);
    const run = await processPendingEvents(10);
    assert.deepEqual([run.processed, calls.length], [1, 1]);
  });
});
