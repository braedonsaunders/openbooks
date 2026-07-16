/**
 * The PDF-template catalog — client-safe, pure data. Lists the record types
 * that can carry an org-authored PDF document template, and the merge fields /
 * line collections each type exposes to the template builder and renderer.
 *
 * Keys are the CONTRACT between an authored template and the value loader
 * (web/lib/pdf-templates/values.ts): every key listed here is guaranteed a
 * (possibly empty) value in the merge map. Custom fields (`cf_<key>`) are
 * per-org and appended at runtime by the server pages — not catalogued here.
 *
 * Mirrors the @openbooks/customization registry's record-type keys so the two
 * customization surfaces (forms + PDFs) speak the same language; adds
 * 'journal_entry', which lives outside the documents supertype.
 */

export type PdfMergeField = { key: string; label: string; sample: string }
export type PdfCollection = {
  key: string
  label: string
  fields: PdfMergeField[]
}
export type PdfRecordTypeMeta = {
  key: string
  label: string
  /** documents.kind for supertype records; null for journal_entry. */
  docKind: string | null
  /** Title printed by the starter template ("Invoice", "Quote"…). */
  docTitle: string
  /** Party column label in the starter ("Bill to" / "Vendor"…), null = none. */
  partyHeading: string | null
  /** Permission required to render this record type's PDF. */
  readPermission: string
  fields: PdfMergeField[]
  collections: PdfCollection[]
}

const ORG_FIELDS: PdfMergeField[] = [
  { key: 'org_name', label: 'Company name', sample: 'Northwind Industrial Ltd.' },
  { key: 'printed_date', label: 'Printed date', sample: 'Jul 16, 2026' },
]

const DOC_COMMON: PdfMergeField[] = [
  { key: 'document_number', label: 'Document number', sample: 'INV-000123' },
  { key: 'document_date', label: 'Date', sample: 'Jul 16, 2026' },
  { key: 'status', label: 'Status', sample: 'Posted' },
  { key: 'memo', label: 'Memo', sample: 'Progress billing for June.' },
  { key: 'currency', label: 'Currency', sample: 'CAD' },
  { key: 'subtotal', label: 'Subtotal', sample: '$4,350.00' },
  { key: 'tax_total', label: 'Tax total', sample: '$565.50' },
  { key: 'total', label: 'Total', sample: '$4,915.50' },
  ...ORG_FIELDS,
]

const PARTY_FIELDS: PdfMergeField[] = [
  { key: 'party_name', label: 'Party name', sample: 'Acme Construction Inc.' },
  { key: 'party_email', label: 'Party email', sample: 'ap@acme.example' },
  { key: 'party_phone', label: 'Party phone', sample: '(555) 010-0199' },
  { key: 'party_address', label: 'Party address', sample: '400 King St W, Suite 300, Toronto, ON M5V 1K2' },
]

const DUE_FIELDS: PdfMergeField[] = [
  { key: 'due_date', label: 'Due date', sample: 'Aug 15, 2026' },
  { key: 'balance_due', label: 'Balance due', sample: '$4,915.50' },
]

const REFERENCE_FIELD: PdfMergeField = {
  key: 'reference_number',
  label: 'Reference',
  sample: 'PO-2024-88',
}

const LINE_FIELDS: PdfMergeField[] = [
  { key: 'line_number', label: 'Line #', sample: '1' },
  { key: 'item_name', label: 'Item', sample: 'Structural steel' },
  { key: 'account_name', label: 'Account', sample: '5010 Materials' },
  { key: 'description', label: 'Description', sample: 'W12x26 beams — level 2 mezzanine' },
  { key: 'quantity', label: 'Quantity', sample: '12' },
  { key: 'unit', label: 'Unit', sample: 'ea' },
  { key: 'unit_price', label: 'Unit price', sample: '$362.50' },
  { key: 'tax_amount', label: 'Tax', sample: '$565.50' },
  { key: 'amount', label: 'Amount', sample: '$4,350.00' },
]

const LINES_COLLECTION: PdfCollection = { key: 'lines', label: 'Line items', fields: LINE_FIELDS }

function docType(meta: {
  key: string
  label: string
  docTitle: string
  partyHeading: string | null
  readPermission: string
  hasParty: boolean
  hasDue: boolean
  hasReference: boolean
}): PdfRecordTypeMeta {
  return {
    key: meta.key,
    label: meta.label,
    docKind: meta.key,
    docTitle: meta.docTitle,
    partyHeading: meta.partyHeading,
    readPermission: meta.readPermission,
    fields: [
      ...DOC_COMMON.slice(0, 4),
      ...(meta.hasReference ? [REFERENCE_FIELD] : []),
      ...(meta.hasParty ? PARTY_FIELDS : []),
      ...(meta.hasDue ? DUE_FIELDS : []),
      ...DOC_COMMON.slice(4),
    ],
    collections: [LINES_COLLECTION],
  }
}

const JOURNAL_ENTRY: PdfRecordTypeMeta = {
  key: 'journal_entry',
  label: 'Journal entry',
  docKind: null,
  docTitle: 'Journal Entry',
  partyHeading: null,
  readPermission: 'gl.read',
  fields: [
    { key: 'entry_number', label: 'Entry number', sample: 'JE-000045' },
    { key: 'posting_date', label: 'Posting date', sample: 'Jul 16, 2026' },
    { key: 'status', label: 'Status', sample: 'Posted' },
    { key: 'origin', label: 'Origin', sample: 'Manual' },
    { key: 'memo', label: 'Memo', sample: 'June labour burden allocation.' },
    { key: 'total_debits', label: 'Total debits', sample: '$12,400.00' },
    { key: 'total_credits', label: 'Total credits', sample: '$12,400.00' },
    ...ORG_FIELDS,
  ],
  collections: [
    {
      key: 'lines',
      label: 'Journal lines',
      fields: [
        { key: 'line_number', label: 'Line #', sample: '1' },
        { key: 'account_number', label: 'Account #', sample: '5120' },
        { key: 'account_name', label: 'Account', sample: 'Labour burden' },
        { key: 'memo', label: 'Line memo', sample: 'June allocation' },
        { key: 'debit', label: 'Debit', sample: '$12,400.00' },
        { key: 'credit', label: 'Credit', sample: '' },
      ],
    },
  ],
}

/** Every record type a PDF template can target, in nav order. */
export const PDF_RECORD_TYPES: PdfRecordTypeMeta[] = [
  docType({ key: 'customer_invoice', label: 'Customer invoice', docTitle: 'Invoice', partyHeading: 'Bill to', readPermission: 'ar.read', hasParty: true, hasDue: true, hasReference: true }),
  docType({ key: 'customer_credit', label: 'Customer credit', docTitle: 'Credit Memo', partyHeading: 'Bill to', readPermission: 'ar.read', hasParty: true, hasDue: true, hasReference: true }),
  docType({ key: 'quote', label: 'Quote', docTitle: 'Quote', partyHeading: 'Prepared for', readPermission: 'ar.read', hasParty: true, hasDue: false, hasReference: true }),
  docType({ key: 'sales_order', label: 'Sales order', docTitle: 'Sales Order', partyHeading: 'Sold to', readPermission: 'ar.read', hasParty: true, hasDue: false, hasReference: true }),
  docType({ key: 'purchase_order', label: 'Purchase order', docTitle: 'Purchase Order', partyHeading: 'Vendor', readPermission: 'ap.read', hasParty: true, hasDue: false, hasReference: true }),
  docType({ key: 'vendor_bill', label: 'Vendor bill', docTitle: 'Bill', partyHeading: 'Vendor', readPermission: 'ap.read', hasParty: true, hasDue: true, hasReference: true }),
  docType({ key: 'vendor_credit', label: 'Vendor credit', docTitle: 'Vendor Credit', partyHeading: 'Vendor', readPermission: 'ap.read', hasParty: true, hasDue: true, hasReference: true }),
  docType({ key: 'vendor_payment', label: 'Vendor payment', docTitle: 'Payment Remittance', partyHeading: 'Paid to', readPermission: 'ap.read', hasParty: true, hasDue: false, hasReference: true }),
  docType({ key: 'customer_payment', label: 'Customer payment', docTitle: 'Payment Receipt', partyHeading: 'Received from', readPermission: 'ar.read', hasParty: true, hasDue: false, hasReference: true }),
  docType({ key: 'expense_report', label: 'Expense report', docTitle: 'Expense Report', partyHeading: 'Employee', readPermission: 'expenses.read', hasParty: true, hasDue: false, hasReference: true }),
  docType({ key: 'check', label: 'Check', docTitle: 'Check', partyHeading: null, readPermission: 'ap.read', hasParty: false, hasDue: false, hasReference: true }),
  docType({ key: 'card_charge', label: 'Card charge', docTitle: 'Card Charge', partyHeading: null, readPermission: 'ap.read', hasParty: false, hasDue: false, hasReference: false }),
  docType({ key: 'card_refund', label: 'Card refund', docTitle: 'Card Refund', partyHeading: null, readPermission: 'ap.read', hasParty: false, hasDue: false, hasReference: false }),
  docType({ key: 'journal', label: 'Journal (document)', docTitle: 'Journal Entry', partyHeading: null, readPermission: 'gl.read', hasParty: false, hasDue: false, hasReference: false }),
  JOURNAL_ENTRY,
]

export const PDF_RECORD_TYPE_BY_KEY: Record<string, PdfRecordTypeMeta> = Object.fromEntries(
  PDF_RECORD_TYPES.map((t) => [t.key, t]),
)

/** Sample value map for previewing a template with no real record. */
export function sampleValues(meta: PdfRecordTypeMeta): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const f of meta.fields) values[f.key] = f.sample
  for (const c of meta.collections) {
    values[c.key] = [1, 2, 3].map((n) => {
      const row: Record<string, unknown> = {}
      for (const f of c.fields) row[f.key] = f.key === 'line_number' ? String(n) : f.sample
      return row
    })
  }
  return values
}
