import assert from "node:assert/strict";
import test from "node:test";
import { quoteSignatureReminderEmail, quoteSignatureRequestEmail } from "./index";

test("quote signature requests name the quote, value, and link in both parts", () => {
  const email = quoteSignatureRequestEmail({
    orgName: "Acme Corp",
    quoteNumber: "Q-1042",
    signerName: "Ada",
    totalContractValue: "1920.00",
    currency: "CAD",
    termMonths: 12,
    signUrl: "https://books.example.com/sign/quotes/abc123",
    expiresDate: "2026-10-21",
  });
  assert.ok(email.subject.includes("Q-1042"));
  assert.ok(email.html.includes("https://books.example.com/sign/quotes/abc123"));
  assert.ok(email.text.includes("Sign here: https://books.example.com/sign/quotes/abc123"));
  assert.ok(email.text.includes("1920.00 CAD total contract value"));
});

test("quote reminders name the expiry and reuse the same link", () => {
  const email = quoteSignatureReminderEmail({
    orgName: "Acme Corp",
    quoteNumber: "Q-1042",
    signUrl: "https://books.example.com/sign/quotes/abc123",
    expiresDate: "2026-10-21",
  });
  assert.ok(email.subject.includes("Q-1042"));
  assert.ok(email.text.includes("expires 2026-10-21"));
  assert.ok(email.html.includes("https://books.example.com/sign/quotes/abc123"));
});
