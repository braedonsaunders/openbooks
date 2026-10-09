import assert from 'node:assert/strict';
import test from 'node:test';
import { germanInvoice } from '../einvoice/test-fixtures.ts';
import { renderEInvoiceXml } from '../einvoice/render.ts';
import { extractNativeInvoice } from './ap-einvoice.ts';

test('CII and UBL captures preserve invoice amounts and credit-note kind in the AP review contract', async () => {
  for (const profile of ['xrechnung-cii','xrechnung-ubl'] as const) {
    const source = germanInvoice({profile},{allowanceCharges:[]});
    const result = await extractNativeInvoice(Buffer.from(renderEInvoiceXml(source).xml),'application/xml');
    assert.ok(result);
    assert.equal(result.documentKind,'vendor_bill');
    assert.equal(result.normalized.total,source.totals.taxInclusive);
    assert.equal(result.normalized.invoiceNumber,source.number);
    assert.equal(result.normalized.vendorTaxId,source.seller.vatId);
    assert.equal(result.normalized.lines.length,source.lines.length);
    const credit = await extractNativeInvoice(Buffer.from(renderEInvoiceXml({...source,typeCode:'381'}).xml),'application/xml');
    assert.equal(credit?.documentKind,'vendor_credit');
  }
});

test('captured source allowances refuse instead of silently reducing the supplier liability', async () => {
  const source = germanInvoice();
  await assert.rejects(() => extractNativeInvoice(Buffer.from(renderEInvoiceXml(source).xml),'application/xml'),/allowances/i);
});

test('ordinary image captures remain on their native external extraction path', async () => {
  assert.equal(await extractNativeInvoice(new Uint8Array([0xff,0xd8,0xff]),'image/jpeg'),null);
});
