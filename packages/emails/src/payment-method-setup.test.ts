import assert from "node:assert/strict";
import test from "node:test";
import { paymentMethodSetupEmail } from "./payment-method-setup";

test("paymentMethodSetupEmail carries the setup link and the no-charge statement in both bodies", () => {
  const mail = paymentMethodSetupEmail({
    orgName: "Acme Corp",
    customerName: "Northwind Traders",
    linkUrl: "https://books.example.com/pay/setup/abc123",
  });
  assert.ok(mail.subject.includes("Acme Corp"));
  for (const body of [mail.text, mail.html]) {
    assert.ok(body.includes("https://books.example.com/pay/setup/abc123"));
    assert.ok(body.includes("Northwind Traders"));
    assert.ok(body.includes("Nothing is charged"));
  }
});

test("paymentMethodSetupEmail escapes organization and customer names", () => {
  const mail = paymentMethodSetupEmail({
    orgName: "<b>Acme</b>",
    customerName: "<i>Northwind</i>",
    linkUrl: "https://books.example.com/pay/setup/x",
  });
  assert.ok(!mail.html.includes("<b>Acme</b>"));
  assert.ok(!mail.html.includes("<i>Northwind</i>"));
  assert.ok(mail.html.includes("&lt;b&gt;Acme&lt;/b&gt;"));
});
