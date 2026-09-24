import assert from "node:assert/strict";
import test from "node:test";
import { deriveEmailDeliveryKey } from "./outcome";
import { sendVia, type EmailDeliveryIdentity, type EmailTransport } from "./transport";

const ORG = "018f6b2a-7c1d-7d3e-9f4a-2b8c4d5e6f70";
const base = { to: "customer@example.com", subject: "Invoice overdue", html: "<p>Pay</p>", text: "Pay" };

const transport = (replyTo?: string): EmailTransport => ({
  provider: "resend",
  apiKey: "re_test",
  from: "billing@example.com",
  ...(replyTo ? { replyTo } : {}),
});

const identity = (scope: string): EmailDeliveryIdentity => ({
  deliveryKey: deriveEmailDeliveryKey({ orgId: ORG, scope, to: "customer@example.com" }),
});

/** Stub the provider HTTP layer, capturing the Resend request body. */
function stubResend(captured: { body?: unknown; calls: number }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    captured.calls += 1;
    captured.body = JSON.parse(String((init?.body as string | undefined) ?? "{}"));
    return new Response(JSON.stringify({ id: "re_test123" }), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("a per-message reply-to overrides the transport default at the provider", async () => {
  const captured: { body?: unknown; calls: number } = { calls: 0 };
  const restore = stubResend(captured);
  try {
    const outcome = await sendVia(
      transport("default@example.com"),
      { ...base, replyTo: "ar@example.com" },
      identity("reply-override"),
    );
    assert.equal(outcome.kind, "sent");
    assert.equal((captured.body as { reply_to?: unknown }).reply_to, "ar@example.com");
  } finally {
    restore();
  }
});

test("without a per-message reply-to the transport default is used", async () => {
  const captured: { body?: unknown; calls: number } = { calls: 0 };
  const restore = stubResend(captured);
  try {
    await sendVia(transport("default@example.com"), base, identity("reply-default"));
    assert.equal((captured.body as { reply_to?: unknown }).reply_to, "default@example.com");
  } finally {
    restore();
  }
});

test("an invalid per-message reply-to refuses before any provider request", async () => {
  const captured: { body?: unknown; calls: number } = { calls: 0 };
  const restore = stubResend(captured);
  try {
    await assert.rejects(
      sendVia(transport("default@example.com"), { ...base, replyTo: "not-an-address" }, identity("reply-bad")),
      /reply-to address is invalid/,
    );
    assert.equal(captured.calls, 0, "no provider request may be allocated");
  } finally {
    restore();
  }
});

test("a refused connection surfaces its classified cause, not a generic failure", async () => {
  // E09: classifyNetworkFailure names the pre-transmission cause
  // (ECONNREFUSED); providerDispatch must carry it into the thrown error
  // instead of discarding it as 'network request failed'.
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("fetch failed", { cause: { code: "ECONNREFUSED" } });
  }) as typeof fetch;
  try {
    await assert.rejects(
      sendVia(transport("default@example.com"), base, identity("conn-refused")),
      /Resend: network request failed \(ECONNREFUSED\)/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
