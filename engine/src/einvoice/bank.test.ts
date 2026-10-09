import assert from "node:assert/strict";
import test from "node:test";
import { paymentAccountRefusal, paymentProviderRefusal, validPaymentIban } from "./bank.ts";
import { germanInvoice } from "./test-fixtures.ts";
import { renderEInvoiceXml } from "./render.ts";

test("payment identifiers detect an IBAN typo without excluding domestic accounts and bank codes", () => {
  assert.equal(paymentAccountRefusal("de89 3704-0044 0532 0130 00"), null);
  assert.match(paymentAccountRefusal("DE89370400440532013001")!, /check digits/);
  assert.match(paymentAccountRefusal("123456789", "58")!, /IBAN/);
  assert.equal(paymentAccountRefusal("123-456789", "30"), null);
  for (const identifier of ["021000021", "123456789012", "HDFC0001234", "COBADEFFXXX"]) assert.equal(paymentProviderRefusal(identifier), null);
  assert.equal(validPaymentIban("DE89370400440532013000"), true);
  assert.equal(validPaymentIban("DE275001051754073249311000"), false);
  assert.match(paymentAccountRefusal("123/456789")!, /identifier/);
  assert.match(paymentProviderRefusal("<bad>")!, /identifier/);
});

test("strict issuance refuses typo accounts and preserves domestic bank instructions in UBL", () => {
  const invoice = germanInvoice();
  invoice.payment.creditTransfer!.accountId = "DE89370400440532013001";
  assert.throws(() => renderEInvoiceXml(invoice), /valid IBAN/);
  invoice.profile = "en16931-ubl";
  invoice.payment.meansCode = "30";
  invoice.payment.creditTransfer!.accountId = "123-456789";
  invoice.payment.creditTransfer!.providerId = "021000021";
  const xml = renderEInvoiceXml(invoice).xml;
  assert.match(xml, /<cbc:ID>123456789<\/cbc:ID>/);
  assert.match(xml, /<cbc:ID>021000021<\/cbc:ID>/);
});
