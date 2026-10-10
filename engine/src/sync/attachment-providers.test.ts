import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAttachmentBase64 } from '../connectors/attachment-content.ts';
import { qboAttachmentProvider, xeroAttachmentProvider, odooAttachmentProvider, erpnextAttachmentProvider, dynamicsAttachmentProvider } from './attachment-providers.ts';
import type { QboClient } from '../connectors/qbo.ts';
import type { XeroClient } from '../connectors/xero.ts';
import type { OdooClient } from '../connectors/odoo.ts';
import type { ErpNextClient } from '../connectors/erpnext.ts';
import type { DynamicsClient } from '../connectors/dynamics.ts';

const bytes = Buffer.from('%PDF-1.7 receipt');
test('QuickBooks files retain source identity and only reference synced transactions, including bills', async () => {
  let queries = 0;
  const provider = qboAttachmentProvider({ queryAll: async (entity: string, where: string) => {
    assert.equal(entity, 'Attachable'); queries++;
    if (where) { assert.equal(where, "Id = '7'"); return [{ Id: '7', FileName: 'bill.pdf', TempDownloadUri: 'https://files.example/signed' }]; }
    return [{ Id: '7', FileName: 'bill.pdf', Size: bytes.length, MetaData: { LastUpdatedTime: '2026-10-10T09:00:00Z' }, AttachableRef: [{ EntityRef: { type: 'Bill', value: '2' } }, { EntityRef: { type: 'Purchase', value: '3' } }, { EntityRef: { type: 'Bill', value: 'foreign' } }] }, { Id: '8', Note: 'note only' }];
  }, downloadAttachment: async (url: string) => { assert.equal(url, 'https://files.example/signed'); return bytes; } } as unknown as QboClient);
  const rows = await provider.inventory([{ id: 'native-bill', sourceRef: 'Bill:2', kind: 'vendor_bill' }, { id: 'native-expense', sourceRef: 'Purchase:3', kind: 'expense_report' }]);
  assert.equal(rows.length, 1); assert.equal(rows[0]!.id, '7');
  assert.deepEqual(rows[0]!.transactionRefs, ['Bill:2', 'Purchase:3']);
  assert.deepEqual(await provider.download(rows[0]!), bytes); assert.equal(queries, 2);
});

test('Xero attachment reads preserve MIME type and honestly require byte comparison without a modification marker', async () => {
  const provider = xeroAttachmentProvider({ get: async (path: string) => { assert.equal(path, 'Invoices/abc/Attachments'); return { Attachments: [{ AttachmentID: 'file-1', FileName: 'bill receipt.pdf', MimeType: 'application/pdf', ContentLength: bytes.length }] }; }, attachmentContent: async (path: string, mime: string) => { assert.equal(path, 'Invoices/abc/Attachments/bill%20receipt.pdf'); assert.equal(mime, 'application/pdf'); return bytes; } } as unknown as XeroClient);
  const rows = await provider.inventory([{ id: 'native', sourceRef: 'Invoice:abc', kind: 'vendor_bill' }]);
  assert.equal(rows[0]!.modifiedAt, null); assert.deepEqual(await provider.download(rows[0]!), bytes);
});

test('Odoo includes field-bound receipts and refuses external-link files or moved transaction relationships', async () => {
  let moved = false;
  const provider = odooAttachmentProvider({ searchReadAll: async (model: string, domain: unknown[]) => {
    assert.equal(model, 'ir.attachment'); assert.deepEqual(domain.slice(-3), ['|', ['res_field', '=', false], ['res_field', '!=', false]]);
    return [{ id: 9, name: 'receipt.pdf', res_id: 2, type: 'binary', write_date: '2026-10-10 09:00:00', file_size: bytes.length }];
  }, executeKw: async (_model: string, _method: string, _ids: unknown, options: { context: unknown }) => { assert.deepEqual(options.context, { bin_size: false }); return [{ id: 9, name: 'receipt.pdf', res_id: moved ? 3 : 2, datas: bytes.toString('base64') }]; } } as unknown as OdooClient);
  const rows = await provider.inventory([{ id: 'native', sourceRef: '2', kind: 'vendor_bill' }]);
  assert.equal(rows[0]!.modifiedAt!.toISOString(), '2026-10-10T09:00:00.000Z');
  assert.deepEqual(await provider.download(rows[0]!), bytes); moved = true;
  await assert.rejects(provider.download(rows[0]!), /transaction access/);
  const external = odooAttachmentProvider({ searchReadAll: async () => [{ id: 9, res_id: 2, type: 'url' }] } as unknown as OdooClient);
  await assert.rejects(external.inventory([{ id: 'native', sourceRef: '2', kind: 'vendor_bill' }]), /external-link/);
});

test('ERPNext and Business Central resolve only the matching transaction type and reject changed evidence', async () => {
  const file = { name: 'file-1', file_name: 'bill.pdf', file_url: '/private/files/bill.pdf', attached_to_doctype: 'Purchase Invoice', attached_to_name: 'BILL-2', modified: '2026-10-10 09:00:00', file_size: bytes.length };
  let changed = false;
  const erp = erpnextAttachmentProvider({ listAll: async () => [file, { ...file, name: 'foreign', attached_to_doctype: 'Customer' }], getDoc: async () => ({ ...file, attached_to_name: changed ? 'BILL-3' : 'BILL-2' }), attachmentContent: async (url: string) => { assert.equal(url, file.file_url); return bytes; } } as unknown as ErpNextClient);
  const rows = await erp.inventory([{ id: 'native', sourceRef: 'BILL-2', kind: 'vendor_bill' }]);
  assert.equal(rows.length, 1); assert.deepEqual(await erp.download(rows[0]!), bytes); changed = true;
  await assert.rejects(erp.download(rows[0]!), /relationship changed/);
  const bc = dynamicsAttachmentProvider({ list: async () => [{ id: 'file-1', fileName: 'bill.pdf', parentType: 'Purchase_x0020_Invoice', parentId: 'abc', byteSize: bytes.length, lastModifiedDateTime: '2026-10-10T09:00:00Z' }, { id: 'foreign', fileName: 'bill.pdf', parentType: 'Sales Invoice', parentId: 'abc' }], attachmentContent: async () => ({ id: 'file-1', fileName: 'bill.pdf', parentType: 'Purchase Invoice', parentId: 'abc', bytes }) } as unknown as DynamicsClient);
  const bcRows = await bc.inventory([{ id: 'native', sourceRef: 'purchaseInvoice:abc', kind: 'vendor_bill' }]);
  assert.equal(bcRows.length, 1); assert.deepEqual(await bc.download(bcRows[0]!), bytes);
});

test('source evidence decoding preserves exact bytes and refuses malformed or noncanonical base64', () => {
  assert.deepEqual(decodeAttachmentBase64(bytes.toString('base64')), bytes);
  for (const content of ['not base64!', 'AAAA=', 'a', 'ab==']) assert.throws(() => decodeAttachmentBase64(content), /invalid encoding/);
});
