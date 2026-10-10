import { decodeAttachmentBase64 } from '../connectors/attachment-content.ts';
import type { QboClient } from '../connectors/qbo.ts';
import type { XeroClient } from '../connectors/xero.ts';
import type { OdooClient } from '../connectors/odoo.ts';
import type { ErpNextClient } from '../connectors/erpnext.ts';
import type { DynamicsClient } from '../connectors/dynamics.ts';
import type { TransactionAttachment, TransactionAttachmentProvider } from './transaction-attachments.ts';

function date(value: unknown): Date | null {
  if (!value) return null;
  const parsed = new Date(String(value).replace(' ', 'T') + (/^\d{4}-\d{2}-\d{2} \d{2}:/.test(String(value)) ? 'Z' : ''));
  if (!Number.isFinite(parsed.getTime())) throw new Error('Source attachment modification date is invalid');
  return parsed;
}
function size(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Source attachment size is invalid');
  return parsed;
}
interface QboAttachment { Id: string; FileName?: string; Size?: number; TempDownloadUri?: string; MetaData?: { LastUpdatedTime?: string }; AttachableRef?: { EntityRef?: { type?: string; value?: string } }[] }
export function qboAttachmentProvider(client: QboClient): TransactionAttachmentProvider {
  return { source: 'qbo', refKey: 'qboId', inventory: async (transactions) => {
    const wanted = new Set(transactions.map((row) => row.sourceRef));
    const rows = await client.queryAll<QboAttachment>('Attachable');
    return rows.flatMap((row) => {
      const refs = (row.AttachableRef ?? []).map((ref) => `${ref.EntityRef?.type}:${ref.EntityRef?.value}`).filter((ref) => wanted.has(ref));
      // Note-only attachables have no file content.
      if (row.FileName && refs.length && !/^\d+$/.test(String(row.Id ?? ''))) throw new Error('QuickBooks file identity is unavailable');
      return row.FileName && refs.length ? [{ id: String(row.Id), name: row.FileName, transactionRefs: refs, modifiedAt: date(row.MetaData?.LastUpdatedTime), size: size(row.Size) }] : [];
    });
  }, download: async (attachment) => {
    if (!/^\d+$/.test(attachment.id)) throw new Error('QuickBooks attachment identity is invalid');
    const rows = await client.queryAll<QboAttachment>('Attachable', `Id = '${attachment.id}'`);
    const row = rows.find((row) => String(row.Id) === attachment.id);
    if (!row?.TempDownloadUri || row.FileName !== attachment.name) throw new Error('QuickBooks file access is unavailable or changed; reconnect and retry');
    return client.downloadAttachment(row.TempDownloadUri);
  } };
}

const xeroEndpoints: Record<string, string> = { Invoice: 'Invoices', CreditNote: 'CreditNotes', BankTransaction: 'BankTransactions', BankTransfer: 'BankTransfers', ManualJournal: 'ManualJournals', PurchaseOrder: 'PurchaseOrders' };
export function xeroAttachmentProvider(client: XeroClient): TransactionAttachmentProvider {
  const paths = new Map<string, { path: string; contentType: string }>();
  return { source: 'xero', refKey: 'xeroId', inventory: async (transactions) => {
    const attachments: TransactionAttachment[] = [];
    for (const transaction of transactions) {
      const split = transaction.sourceRef.indexOf(':');
      const endpoint = xeroEndpoints[transaction.sourceRef.slice(0, split)];
      const id = transaction.sourceRef.slice(split + 1);
      if (!endpoint) continue;
      if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('Xero transaction attachment identity is invalid');
      const result = await client.get<{ Attachments?: { AttachmentID: string; FileName: string; MimeType: string; ContentLength?: number }[] }>(`${endpoint}/${id}/Attachments`);
      if (!Array.isArray(result.Attachments)) throw new Error('Xero attachment inventory is incomplete; grant attachment read access and retry');
      for (const row of result.Attachments) {
        if (typeof row.AttachmentID !== 'string' || !row.AttachmentID || typeof row.FileName !== 'string' || !row.FileName || typeof row.MimeType !== 'string') throw new Error('Xero attachment metadata is incomplete; retry the sync');
        const sourceId = `${transaction.sourceRef}:${row.AttachmentID}`;
        paths.set(sourceId, { path: `${endpoint}/${id}/Attachments/${encodeURIComponent(row.FileName)}`, contentType: row.MimeType });
        // Xero exposes no reliable file modification marker. Hash bytes rather than inventing one.
        attachments.push({ id: sourceId, name: row.FileName, transactionRefs: [transaction.sourceRef], modifiedAt: null, size: size(row.ContentLength) });
      }
    }
    return attachments;
  }, download: (attachment) => {
    const path = paths.get(attachment.id);
    if (!path) throw new Error('Xero attachment is outside this transaction inventory');
    return client.attachmentContent(path.path, path.contentType);
  } };
}

interface OdooAttachment { id: number; name: string; res_id: number; type: string; write_date?: string; file_size?: number; datas?: string | false }
export function odooAttachmentProvider(client: OdooClient): TransactionAttachmentProvider {
  return { source: 'odoo', refKey: 'odooId', inventory: async (transactions) => {
    const ids = transactions.map((row) => Number(row.sourceRef));
    if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('Odoo transaction attachment identity is invalid');
    if (!ids.length) return [];
    const rows = await client.searchReadAll<OdooAttachment>('ir.attachment', [ ['res_model', '=', 'account.move'], ['res_id', 'in', ids], '|', ['res_field', '=', false], ['res_field', '!=', false] ], ['id', 'name', 'res_id', 'type', 'write_date', 'file_size']);
    return rows.map((row) => {
      if (!Number.isSafeInteger(row.id) || row.id < 1) throw new Error('Odoo attachment identity is invalid');
      if (row.type !== 'binary') throw new Error('Odoo transaction contains an external-link attachment; store its file in Odoo before syncing');
      return { id: String(row.id), name: row.name, transactionRefs: [String(row.res_id)], modifiedAt: date(row.write_date), size: size(row.file_size) };
    });
  }, download: async (attachment) => {
    const rows = await client.executeKw<OdooAttachment[]>('ir.attachment', 'read', [[Number(attachment.id)]], { fields: ['id', 'name', 'res_id', 'datas'], context: { bin_size: false } });
    const row = rows[0];
    if (!row || String(row.id) !== attachment.id || row.name !== attachment.name || !attachment.transactionRefs.includes(String(row.res_id)) || typeof row.datas !== 'string') throw new Error('Odoo attachment content or transaction access is unavailable; grant read access and retry');
    return decodeAttachmentBase64(row.datas);
  } };
}

const erpDoctypes: Record<string, string> = { customer_invoice: 'Sales Invoice', customer_credit: 'Sales Invoice', vendor_bill: 'Purchase Invoice', vendor_credit: 'Purchase Invoice', customer_order: 'Sales Order', purchase_order: 'Purchase Order', customer_payment: 'Payment Entry', vendor_payment: 'Payment Entry', transfer: 'Payment Entry', journal: 'Journal Entry' };
interface ErpFile { name: string; file_name: string; file_url: string; attached_to_doctype: string; attached_to_name: string; modified?: string; file_size?: number }
export function erpnextAttachmentProvider(client: ErpNextClient): TransactionAttachmentProvider {
  const rowsById = new Map<string, ErpFile>();
  return { source: 'erpnext', refKey: 'erpId', inventory: async (transactions) => {
    const byName = new Map(transactions.map((row) => [`${erpDoctypes[row.kind]}:${row.sourceRef}`, row.sourceRef]));
    if (!transactions.length) return [];
    const rows = await client.listAll<ErpFile>('File', ['name', 'file_name', 'file_url', 'attached_to_doctype', 'attached_to_name', 'modified', 'file_size'], [['is_folder', '=', 0], ['attached_to_name', 'in', transactions.map((row) => row.sourceRef)]]);
    return rows.flatMap((row) => {
      const ref = byName.get(`${row.attached_to_doctype}:${row.attached_to_name}`);
      if (!ref) return [];
      rowsById.set(row.name, row);
      return [{ id: row.name, name: row.file_name, transactionRefs: [ref], modifiedAt: date(row.modified), size: size(row.file_size) }];
    });
  }, download: async (attachment) => {
    const expected = rowsById.get(attachment.id);
    const row = await client.getDoc<ErpFile>('File', attachment.id);
    if (!expected || row.name !== attachment.id || row.file_url !== expected.file_url || row.attached_to_doctype !== expected.attached_to_doctype || row.attached_to_name !== expected.attached_to_name) throw new Error('ERPNext file relationship changed; retry the sync');
    return client.attachmentContent(row.file_url);
  } };
}

const bcParentTypes: Record<string, string> = { 'Sales Invoice': 'salesInvoice', 'Purchase Invoice': 'purchaseInvoice', 'Sales Credit Memo': 'salesCreditMemo', 'Purchase Credit Memo': 'purchaseCreditMemo', 'Sales Order': 'salesOrder', 'Purchase Order': 'purchaseOrder', 'Sales Quote': 'salesQuote' };
const bcParentRef = (type: string, id: string) => `${bcParentTypes[type.replace(/_x([0-9a-f]{4})_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))]}:${id}`;
export function dynamicsAttachmentProvider(client: DynamicsClient): TransactionAttachmentProvider {
  return { source: 'dynamics', refKey: 'bcId', inventory: async (transactions) => {
    const wanted = new Set(transactions.map((row) => row.sourceRef));
    const rows = await client.list<{ id: string; fileName: string; byteSize?: number; parentId: string; parentType: string; lastModifiedDateTime?: string }>('documentAttachments', { $select: 'id,fileName,byteSize,parentId,parentType,lastModifiedDateTime' });
    return rows.flatMap((row) => {
      const ref = bcParentRef(row.parentType, row.parentId);
      if (!wanted.has(ref)) return [];
      return [{ id: row.id, name: row.fileName, transactionRefs: [ref], modifiedAt: date(row.lastModifiedDateTime), size: size(row.byteSize) }];
    });
  }, download: async (attachment) => {
    const result = await client.attachmentContent(attachment.id);
    if (result.fileName !== attachment.name || !attachment.transactionRefs.includes(bcParentRef(result.parentType, result.parentId))) throw new Error('Business Central attachment changed; retry the sync');
    return result.bytes;
  } };
}
