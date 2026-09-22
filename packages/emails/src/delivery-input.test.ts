import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEmailDeliveryInput } from "./delivery-input";

const base = { to: "a@example.com", subject: "s", html: "<p>x</p>", text: "x" };

test("normalize passes a valid per-message reply-to through, trimmed", () => {
  const normalized = normalizeEmailDeliveryInput({ ...base, replyTo: "  ar@example.com  " });
  assert.equal(normalized.replyTo, "ar@example.com");
});

test("normalize omits reply-to when absent", () => {
  assert.ok(!("replyTo" in normalizeEmailDeliveryInput(base)));
});

test("normalize refuses an invalid reply-to before any provider request", () => {
  for (const replyTo of ["not-an-address", "", "   ", "a@b", "a@@b.com"]) {
    assert.throws(
      () => normalizeEmailDeliveryInput({ ...base, replyTo }),
      /reply-to address is invalid/,
      `replyTo ${JSON.stringify(replyTo)} must not reach a provider`,
    );
  }
});
