import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const paymentsSource = readFileSync(new URL("./payments.ts", import.meta.url), "utf8");

test("automatic remittance stays pending until the email worker confirms delivery", () => {
  assert.match(paymentsSource, /paymentRemittanceId:\s*staged\.remittanceId/);
  assert.match(paymentsSource, /status in \('pending', 'sent'\)/);
  assert.match(paymentsSource, /jobId:\s*`payment-remittance\|\$\{staged\.remittanceId\}`/);
  assert.doesNotMatch(
    paymentsSource,
    /update payment_remittances set status = 'sent'[\s\S]*?remittance_email_sent_at/,
  );
  assert.doesNotMatch(paymentsSource, /set remittance_email_sent_at = now\(\)/);
});

test("posting finisher reconciles worker-confirmed remittances under the claim", () => {
  const finishStart = paymentsSource.indexOf("async function finishPaymentRunPosting");
  const finishEnd = paymentsSource.indexOf("async function releaseFailedPaymentRunPosting", finishStart);
  assert.ok(finishStart >= 0 && finishEnd > finishStart, "posting finisher must remain identifiable");
  const finishSource = paymentsSource.slice(finishStart, finishEnd);
  assert.match(finishSource, /await assertPostingClaimLive\(runId, orgId, claim\)/);
  assert.match(
    finishSource,
    /update payment_instructions instruction[\s\S]*?from payment_remittances remittance[\s\S]*?remittance\.status = 'sent'/,
  );
  assert.match(finishSource, /remittance_email_sent_at = coalesce\(instruction\.remittance_email_sent_at, remittance\.sent_at\)/);
});
