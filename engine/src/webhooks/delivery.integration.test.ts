import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgTransaction } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { grant, setFeatures } from "../testing/hrm-harness.ts";
import { emitDomainEvent } from "./emit.ts";
import {
  createWebhookEndpoint,
  redeliverWebhookDelivery,
  rotateWebhookEndpointSecret,
  sendWebhookTestPing,
} from "./endpoints.ts";
import { runWebhookDeliveryScan, verifyWebhookSignature } from "./deliver.ts";

/**
 * Outbound webhook transport coverage (integration partition): the
 * transactional outbox (a rolled-back emit delivers nothing), signed
 * delivery against a local HTTP server with an independently computed
 * HMAC, retries inside the 3-day budget, 410 disabling the endpoint,
 * auto-disable after the failure threshold with audit and admin notice,
 * rotation signing with both secrets, and manual redelivery plus test
 * pings. Proofs are read back from storage and the captured HTTP
 * requests, never from service returns alone.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

type SeenRequest = {
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

type CaptureServer = {
  server: Server;
  url: string;
  seen: SeenRequest[];
  respondWith: { status: number; body: string };
};

async function startCaptureServer(): Promise<CaptureServer> {
  const capture: CaptureServer = {
    server: null as unknown as Server,
    url: "",
    seen: [],
    respondWith: { status: 200, body: "{}" },
  };
  capture.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      capture.seen.push({ headers: { ...req.headers }, body });
      res.writeHead(capture.respondWith.status, { "content-type": "application/json" });
      res.end(capture.respondWith.body);
    });
  });
  await new Promise<void>((resolve) => capture.server.listen(0, "127.0.0.1", resolve));
  const address = capture.server.address();
  if (typeof address !== "object" || !address) throw new Error("the capture server did not bind");
  capture.url = `http://127.0.0.1:${address.port}/hook`;
  return capture;
}

async function stopCaptureServer(capture: CaptureServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    capture.server.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

async function setupOrg(): Promise<{ org: ScratchOrg; adminId: string }> {
  const org = await withBypass(() => createScratchOrg());
  await setFeatures(org.orgId, { apiAccess: true, outboundWebhooks: true });
  const adminId = await createScratchUser(org.orgId, "Webhook Admin", "webhook_admin");
  await grant(org.orgId, adminId, ["webhooks.manage", "webhooks.read"]);
  // The endpoint-disabled notice addresses role permissions directly
  // (the scheduler scan-failure convention), not permission overrides.
  await db.execute(sql`
    update app_roles set permissions = '["webhooks.manage", "webhooks.read"]'::jsonb
     where org_id = ${org.orgId} and key = 'webhook_admin'
  `);
  return { org, adminId };
}

async function makeEndpoint(
  orgId: string,
  adminId: string,
  url: string,
  events: string[],
  key = `ep-${Math.random().toString(36).slice(2, 8)}`,
): Promise<{ id: string; secret: string }> {
  return createWebhookEndpoint(orgId, adminId, { key, url, description: "test endpoint", events });
}

async function emitItemUpdated(orgId: string, itemId: string, dedupe: string): Promise<string> {
  const result = await emitDomainEvent(db, {
    orgId,
    type: "item.updated",
    entityKind: "item",
    entityId: itemId,
    dedupeKey: dedupe,
    payload: { v: 1, occurredAt: new Date().toISOString(), itemId },
  });
  if (!result) throw new Error("emission returned null with the gate on");
  return result.eventId;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function independentHmac(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

async function deliveryCount(orgId: string): Promise<number> {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from webhook_deliveries where org_id = ${orgId}
  `)).rows[0]!.n;
}

test("an event emitted in a rolled-back transaction is never delivered", { skip: !DB }, async () => {
  const { org, adminId } = await setupOrg();
  const capture = await startCaptureServer();
  try {
    await makeEndpoint(org.orgId, adminId, capture.url, ["item.updated"], "rollback");
    await assert.rejects(
      withOrgTransaction(org.orgId, async () => {
        await emitItemUpdated(org.orgId, org.items.service, "rollback-probe");
        throw new Error("boom");
      }),
      /boom/,
    );
    const events = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from webhook_events where org_id = ${org.orgId}
    `)).rows[0]!.n;
    assert.equal(events, 0, "the rolled-back emit stored no event");
    const scan = await runWebhookDeliveryScan();
    assert.equal(scan.attempted, 0, "no delivery was queued");
    assert.equal(capture.seen.length, 0, "nothing reached the subscriber");
  } finally {
    await stopCaptureServer(capture);
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("delivery carries the documented signature, verifiable independently", { skip: !DB }, async () => {
  const { org, adminId } = await setupOrg();
  const capture = await startCaptureServer();
  try {
    const endpoint = await makeEndpoint(org.orgId, adminId, capture.url, ["item.updated"], "signed");
    await emitItemUpdated(org.orgId, org.items.service, "signed-probe");
    assert.equal(await deliveryCount(org.orgId), 1, "the subscribed emit queued exactly one delivery");
    const scan = await runWebhookDeliveryScan();
    assert.ok(scan.attempted >= 1, "the scan attempted work");
    assert.equal(capture.seen.length, 1, "one POST reached the subscriber");
    const seen = capture.seen[0]!;
    assert.equal(headerValue(seen.headers, "openbooks-event"), "item.updated");
    const envelope = JSON.parse(seen.body) as { id: string; event: string; occurredAt: string; data: { itemId: string } };
    assert.equal(envelope.event, "item.updated");
    assert.equal(envelope.data.itemId, org.items.service);
    assert.equal(headerValue(seen.headers, "openbooks-delivery"), envelope.id);
    const signature = headerValue(seen.headers, "openbooks-signature");
    const timestamp = signature.split(",").find((p) => p.startsWith("t="))?.slice(2) ?? "";
    assert.match(timestamp, /^\d+$/, "the signature carries a unix timestamp");
    // Independent recomputation, not the signer's own output: the exact
    // "t.body" scheme the help article documents.
    const expected = independentHmac(endpoint.secret, timestamp, seen.body);
    const presented = signature.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
    assert.ok(presented.includes(expected), "the header carries the independently computed HMAC");
    assert.equal(verifyWebhookSignature(endpoint.secret, signature, seen.body), true);
    assert.equal(verifyWebhookSignature(endpoint.secret, signature, `${seen.body} `), false, "a tampered body refuses");
    const deliveries = (await db.execute<{ status: string; code: number }>(sql`
      select status, last_response_code as code from webhook_deliveries where org_id = ${org.orgId}
    `)).rows;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.status, "delivered");
    assert.equal(deliveries[0]!.code, 200);
  } finally {
    await stopCaptureServer(capture);
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a failing endpoint retries with backoff, then goes dead after 3 days", { skip: !DB }, async () => {
  const { org, adminId } = await setupOrg();
  const capture = await startCaptureServer();
  capture.respondWith = { status: 500, body: '{"error":"down"}' };
  try {
    await makeEndpoint(org.orgId, adminId, capture.url, ["item.updated"], "retry");
    await emitItemUpdated(org.orgId, org.items.service, "retry-probe");
    assert.equal(await deliveryCount(org.orgId), 1, "the subscribed emit queued exactly one delivery");
    const firstScan = await runWebhookDeliveryScan();
    assert.ok(firstScan.attempted >= 1, "the scan attempted work");
    const afterFirst = (await db.execute<{
      status: string; attempts: number; nextAttempt: Date; code: number;
    }>(sql`
      select status, attempt_count as attempts, next_attempt_at as "nextAttempt",
             last_response_code as code
        from webhook_deliveries where org_id = ${org.orgId}
    `)).rows[0]!;
    assert.equal(afterFirst.status, "pending", "a 500 stays queued");
    assert.equal(afterFirst.attempts, 1);
    assert.equal(afterFirst.code, 500);
    assert.ok(
      new Date(afterFirst.nextAttempt).getTime() > Date.now() - 1000,
      "the next attempt backs off instead of firing immediately",
    );
    // Age the event past the retry budget and make the redelivery due.
    await db.execute(sql`
      update webhook_events set occurred_at = now() - interval '4 days' where org_id = ${org.orgId}
    `);
    await db.execute(sql`
      update webhook_deliveries set next_attempt_at = now() - interval '1 second' where org_id = ${org.orgId}
    `);
    await runWebhookDeliveryScan();
    const terminal = (await db.execute<{ status: string; error: string }>(sql`
      select status, last_error as error from webhook_deliveries where org_id = ${org.orgId}
    `)).rows[0]!;
    assert.equal(terminal.status, "dead");
    assert.match(terminal.error ?? "", /3 days/);
  } finally {
    await stopCaptureServer(capture);
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a 410 disables the endpoint with audit evidence and an admin notice", { skip: !DB }, async () => {
  const { org, adminId } = await setupOrg();
  const capture = await startCaptureServer();
  capture.respondWith = { status: 410, body: '{"gone":true}' };
  try {
    const endpoint = await makeEndpoint(org.orgId, adminId, capture.url, ["item.updated"], "gone");
    await emitItemUpdated(org.orgId, org.items.service, "gone-probe");
    assert.equal(await deliveryCount(org.orgId), 1, "the subscribed emit queued exactly one delivery");
    const goneScan = await runWebhookDeliveryScan();
    assert.ok(goneScan.attempted >= 1, "the scan attempted work");
    const delivery = (await db.execute<{ status: string }>(sql`
      select status from webhook_deliveries where org_id = ${org.orgId}
    `)).rows[0]!;
    assert.equal(delivery.status, "failed");
    const state = (await db.execute<{ status: string; reason: string }>(sql`
      select status, disabled_reason as reason from webhook_endpoints where id = ${endpoint.id}::uuid
    `)).rows[0]!;
    assert.equal(state.status, "disabled");
    assert.match(state.reason ?? "", /410/);
    const audit = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log
       where org_id = ${org.orgId} and table_name = 'webhook_endpoints'
         and row_id = ${endpoint.id} and changes->>'event' = 'endpoint_auto_disabled'
    `)).rows[0]!.n;
    assert.equal(audit, 1, "the auto-disable wrote audit evidence");
    const notices = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from notifications
       where org_id = ${org.orgId} and user_id = ${adminId}
         and kind = 'webhook_endpoint_disabled' and href = '/admin/webhooks' and read_at is null
    `)).rows[0]!.n;
    assert.equal(notices, 1, "an admin was notified where they work");
  } finally {
    await stopCaptureServer(capture);
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("repeated failures auto-disable the endpoint at its threshold", { skip: !DB }, async () => {
  const { org, adminId } = await setupOrg();
  const capture = await startCaptureServer();
  capture.respondWith = { status: 500, body: "down" };
  try {
    const endpoint = await makeEndpoint(org.orgId, adminId, capture.url, ["item.updated"], "flaky");
    await db.execute(sql`
      update webhook_endpoints set auto_disable_after = 2 where id = ${endpoint.id}::uuid
    `);
    await emitItemUpdated(org.orgId, org.items.service, "flaky-probe");
    assert.equal(await deliveryCount(org.orgId), 1, "the subscribed emit queued exactly one delivery");
    const flakyScan = await runWebhookDeliveryScan();
    assert.ok(flakyScan.attempted >= 1, "the scan attempted work");
    const first = (await db.execute<{ failures: number; status: string }>(sql`
      select e.consecutive_failures as failures, e.status
        from webhook_endpoints e where e.id = ${endpoint.id}::uuid
    `)).rows[0]!;
    assert.equal(first.failures, 1);
    assert.equal(first.status, "active", "below the threshold the endpoint stays up");
    await db.execute(sql`
      update webhook_deliveries set next_attempt_at = now() - interval '1 second' where org_id = ${org.orgId}
    `);
    await runWebhookDeliveryScan();
    const second = (await db.execute<{ failures: number; status: string }>(sql`
      select e.consecutive_failures as failures, e.status
        from webhook_endpoints e where e.id = ${endpoint.id}::uuid
    `)).rows[0]!;
    assert.equal(second.failures, 2);
    assert.equal(second.status, "disabled", "reaching the threshold disables the endpoint");
  } finally {
    await stopCaptureServer(capture);
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("rotation signs with both the current and the previous secret", { skip: !DB }, async () => {
  const { org, adminId } = await setupOrg();
  const capture = await startCaptureServer();
  try {
    const endpoint = await makeEndpoint(org.orgId, adminId, capture.url, ["item.updated"], "rotating");
    const rotated = await rotateWebhookEndpointSecret(org.orgId, adminId, endpoint.id);
    assert.notEqual(rotated.secret, endpoint.secret, "rotation mints a fresh secret");
    await emitItemUpdated(org.orgId, org.items.service, "rotation-probe");
    assert.equal(await deliveryCount(org.orgId), 1, "the subscribed emit queued exactly one delivery");
    const rotationScan = await runWebhookDeliveryScan();
    assert.ok(rotationScan.attempted >= 1, "the scan attempted work");
    assert.equal(capture.seen.length, 1);
    const signature = headerValue(capture.seen[0]!.headers, "openbooks-signature");
    const timestamp = signature.split(",").find((p) => p.startsWith("t="))?.slice(2) ?? "";
    const presented = signature.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
    assert.equal(presented.length, 2, "the overlap window carries both signatures");
    assert.ok(
      presented.includes(independentHmac(rotated.secret, timestamp, capture.seen[0]!.body)),
      "the current secret verifies",
    );
    assert.ok(
      presented.includes(independentHmac(endpoint.secret, timestamp, capture.seen[0]!.body)),
      "the previous secret still verifies during the overlap",
    );
  } finally {
    await stopCaptureServer(capture);
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("test pings and manual redeliveries run synchronously with audit", { skip: !DB }, async () => {
  const { org, adminId } = await setupOrg();
  const capture = await startCaptureServer();
  try {
    const endpoint = await makeEndpoint(org.orgId, adminId, capture.url, ["item.updated"], "pinged");
    const ping = await sendWebhookTestPing(org.orgId, adminId, endpoint.id);
    assert.equal(ping.status, "delivered");
    assert.equal(ping.responseCode, 200);
    assert.equal(capture.seen.length, 1);
    const pingAudit = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log
       where org_id = ${org.orgId} and table_name = 'webhook_deliveries'
         and changes->>'event' = 'test_ping'
    `)).rows[0]!.n;
    assert.equal(pingAudit, 1, "the test ping wrote audit evidence");
    // A refused ping fails terminally, then redelivers cleanly.
    capture.respondWith = { status: 400, body: "bad" };
    const badPing = await sendWebhookTestPing(org.orgId, adminId, endpoint.id);
    assert.equal(badPing.status, "failed");
    capture.respondWith = { status: 200, body: "{}" };
    const redelivered = await redeliverWebhookDelivery(org.orgId, adminId, badPing.deliveryId);
    assert.equal(redelivered.status, "delivered");
    assert.equal(redelivered.responseCode, 200);
    await assert.rejects(
      redeliverWebhookDelivery(org.orgId, adminId, redelivered.deliveryId),
      /already succeeded/,
      "a delivered delivery refuses redelivery by name",
    );
  } finally {
    await stopCaptureServer(capture);
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
