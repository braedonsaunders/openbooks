import assert from "node:assert/strict";
import test from "node:test";
import { germanInvoice } from "../einvoice/test-fixtures.ts";
import { renderEInvoiceXml } from "../einvoice/render.ts";
import { extractNativeInvoice } from "./ap-einvoice.ts";
import { validateNormalizedCapture } from "./ap-capture.ts";

test("CII and UBL captures preserve invoice amounts and credit-note kind in the AP review contract", async () => {
  for (const profile of ["xrechnung-cii", "xrechnung-ubl"] as const) {
    const source = germanInvoice({ profile }, { allowanceCharges: [] });
    const result = await extractNativeInvoice(
      Buffer.from(renderEInvoiceXml(source).xml),
      "application/xml",
    );
    assert.ok(result);
    assert.equal(result.documentKind, "vendor_bill");
    assert.equal(result.normalized.total, source.totals.taxInclusive);
    assert.equal(result.normalized.invoiceNumber, source.number);
    assert.equal(result.normalized.vendorTaxId, source.seller.vatId);
    assert.equal(result.normalized.lines.length, source.lines.length);
    const validationIssues = validateNormalizedCapture(result.normalized);
    for (const line of result.normalized.lines) {
      assert.match(line.unitPrice, /^-?\d+\.\d{4}$/);
      assert.ok(
        !validationIssues.some(
          (issue) => issue.code === "invalid_amount" && issue.field === "unitPrice",
        ),
      );
    }
    const credit = await extractNativeInvoice(
      Buffer.from(renderEInvoiceXml({ ...source, typeCode: "381" }).xml),
      "application/xml",
    );
    assert.equal(credit?.documentKind, "vendor_credit");
  }
});

test("capture validation preserves eight-decimal invoice quantities without binary rounding", () => {
  assert.deepEqual(
    validateNormalizedCapture({
      vendorName: "Acme",
      vendorTaxId: null,
      invoiceNumber: "INV-1",
      invoiceDate: "2026-07-01",
      dueDate: null,
      purchaseOrderNumber: null,
      currency: "CAD",
      subtotal: "1.2346",
      taxTotal: "0.0000",
      total: "1.2346",
      memo: null,
      lines: [
        {
          description: "Precision part",
          productCode: null,
          quantity: "1.23456789",
          unit: "ea",
          unitPrice: "1.0000",
          amount: "1.2346",
          taxAmount: "0.0000",
          confidence: "1.0000",
        },
      ],
    }),
    [],
  );
});

test("captured source allowances refuse instead of silently reducing the supplier liability", async () => {
  const source = germanInvoice();
  await assert.rejects(
    () => extractNativeInvoice(Buffer.from(renderEInvoiceXml(source).xml), "application/xml"),
    /allowances/i,
  );
});

test("ordinary image captures remain on their native external extraction path", async () => {
  assert.equal(await extractNativeInvoice(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg"), null);
});
