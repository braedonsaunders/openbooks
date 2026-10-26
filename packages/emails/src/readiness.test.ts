import assert from "node:assert/strict";
import test from "node:test";
import {
  EMAIL_SETUP_LOCATION,
  emailDeliveryBlockedMessage,
  emailDeliveryBlockedParts,
  emailDeliveryReadiness,
} from "./readiness";
import { resolveEmailTransportDetailed, type EmailTransportResolution } from "./transport";

const ORG = "00000000-0000-4000-8000-000000000001";

test("an organization that has not enabled delivery is refused with a remedy it can perform", () => {
  const block = resolveEmailTransportDetailed(null, ORG);
  assert.equal(block.state, "unconfigured");
  const parts = emailDeliveryBlockedParts(block);
  assert.equal(parts.summary, "Email delivery is not enabled for this organization.");
  assert.ok(
    parts.remedy.includes(EMAIL_SETUP_LOCATION),
    "the remedy names the page the organization can open",
  );
  assert.equal(emailDeliveryBlockedMessage(block), `${parts.summary} ${parts.remedy}`);
});

test("a configured but unusable credential surfaces its engine reason and a re-entry remedy", () => {
  const block: EmailTransportResolution = {
    state: "unusable",
    reason: "the stored provider credential could not be unsealed with the current data key",
  };
  const parts = emailDeliveryBlockedParts(
    block as Exclude<EmailTransportResolution, { state: "ready" }>,
  );
  assert.equal(
    parts.summary,
    "Email delivery cannot send: the stored provider credential could not be unsealed with the current data key.",
  );
  assert.match(parts.remedy, /re-enter the provider settings in Admin → Email\.$/u);
});

test("refusal copy never points at a page or setting that does not exist", () => {
  const blocks: Array<Exclude<EmailTransportResolution, { state: "ready" }>> = [
    { state: "unconfigured" },
    {
      state: "unusable",
      reason: "the stored email configuration is missing its sending credential or sender identity",
    },
  ];
  for (const block of blocks) {
    const message = emailDeliveryBlockedMessage(block);
    for (const invented of [
      "Settings → Email",
      "Company Settings → Email",
      "Administration → Email",
      "Set up email delivery",
    ]) {
      assert.ok(!message.includes(invented), `"${invented}" is not a real location: ${message}`);
    }
    assert.ok(message.includes("Admin → Email"), message);
  }
});

test("readiness exposes only the state and reason, and ready means a send may be attempted", () => {
  assert.deepEqual(emailDeliveryReadiness({ state: "unconfigured" }), { state: "unconfigured" });
  assert.deepEqual(emailDeliveryReadiness({ state: "unusable", reason: "r" }), {
    state: "unusable",
    reason: "r",
  });
  const ready = emailDeliveryReadiness({
    state: "ready",
    transport: { provider: "resend", apiKey: "re_secret", from: "a@example.com" },
  });
  assert.deepEqual(ready, { state: "ready" });
  assert.ok(
    !JSON.stringify(ready).includes("re_secret"),
    "readiness must never carry transport secrets",
  );
});
