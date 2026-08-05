import assert from "node:assert/strict";
import test from "node:test";
import { documentEmail } from "./index";

test("documentEmail renders the payment link as a call-to-action in html and text", () => {
  const withLink = documentEmail({
    orgName: "Acme Corp",
    docTitle: "Invoice",
    reference: "INV-1042",
    partyName: "Dana",
    attachmentName: "Invoice-INV-1042.pdf",
    paymentUrl: "https://books.example.com/pay/abc123",
  });
  assert.ok(withLink.html.includes("https://books.example.com/pay/abc123"));
  assert.ok(withLink.html.includes("Pay online"));
  assert.ok(withLink.text.includes("Pay online: https://books.example.com/pay/abc123"));

  const without = documentEmail({
    orgName: "Acme Corp",
    docTitle: "Invoice",
    reference: "INV-1043",
    attachmentName: "Invoice-INV-1043.pdf",
  });
  assert.ok(!without.html.includes("Pay online"));
  assert.ok(!without.text.includes("Pay online"));
});
