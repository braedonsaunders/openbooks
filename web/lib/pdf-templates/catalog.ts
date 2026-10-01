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
  /** Stable message key resolved by the localized template management UI. */
  labelKey: string
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
  { key: 'customer_sku', label: 'Customer part number', sample: 'ACME-STEEL-42' },
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
  docTitle: string
  partyHeading: string | null
  readPermission: string
  hasParty: boolean
  hasDue: boolean
  hasReference: boolean
  extraFields?: PdfMergeField[]
}): PdfRecordTypeMeta {
  return {
    key: meta.key,
    labelKey: meta.key,
    docKind: meta.key,
    docTitle: meta.docTitle,
    partyHeading: meta.partyHeading,
    readPermission: meta.readPermission,
    fields: [
      ...DOC_COMMON.slice(0, 4),
      ...(meta.hasReference ? [REFERENCE_FIELD] : []),
      ...(meta.hasParty ? PARTY_FIELDS : []),
      ...(meta.extraFields ?? []),
      ...(meta.hasDue ? DUE_FIELDS : []),
      ...DOC_COMMON.slice(4),
    ],
    collections: [LINES_COLLECTION],
  }
}

const JOURNAL_ENTRY: PdfRecordTypeMeta = {
  key: 'journal_entry',
  labelKey: 'journal_entry',
  docKind: null,
  docTitle: 'Journal Entry',
  partyHeading: null,
  readPermission: 'gl.read',
  fields: [
    { key: 'entry_number', label: 'Entry number', sample: 'JE-000045' },
    { key: 'posting_date', label: 'Posting date', sample: 'Jul 16, 2026' },
    { key: 'status', label: 'Status', sample: 'Posted' },
    { key: 'origin', label: 'Origin', sample: 'Manual' },
    { key: 'memo', label: 'Memo', sample: 'June labour overhead allocation.' },
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
        { key: 'account_name', label: 'Account', sample: 'Labour overhead' },
        { key: 'memo', label: 'Line memo', sample: 'June allocation' },
        { key: 'debit', label: 'Debit', sample: '$12,400.00' },
        { key: 'credit', label: 'Credit', sample: '' },
      ],
    },
  ],
}


/** Field ticket — the signed crew timesheet. Its merge surface is a superset
 * of what a weekly billable-timesheet PDF needs: per-crew-row
 * day columns (day1..day7 × reg/ot/dt) for exact grid replicas, plus the
 * summarized reg/OT/DT totals the modern starter uses. */
const CREW_DAY_FIELDS: PdfMergeField[] = Array.from({ length: 7 }, (_, i) => [
  { key: `day${i + 1}_reg`, label: `Day ${i + 1} regular`, sample: i === 2 ? '8' : '' },
  { key: `day${i + 1}_ot`, label: `Day ${i + 1} overtime`, sample: i === 3 ? '2' : '' },
  { key: `day${i + 1}_dt`, label: `Day ${i + 1} double`, sample: '' },
]).flat()

const FIELD_TICKET: PdfRecordTypeMeta = {
  key: 'field_ticket',
  labelKey: 'field_ticket',
  docKind: 'field_ticket',
  docTitle: 'Field Ticket',
  partyHeading: 'Customer',
  readPermission: 'time.read',
  fields: [
    { key: 'document_number', label: 'Ticket number', sample: 'FT-000123' },
    { key: 'document_date', label: 'Date', sample: 'Jul 18, 2026' },
    { key: 'status', label: 'Status', sample: 'Approved' },
    { key: 'period', label: 'Period kind', sample: 'Weekly' },
    { key: 'period_start', label: 'Period start', sample: 'Jul 12, 2026' },
    { key: 'period_end', label: 'Period end', sample: 'Jul 18, 2026' },
    ...Array.from({ length: 7 }, (_, i) => ({ key: `day${i + 1}_label`, label: `Day ${i + 1} header`, sample: ['Sun 07-12', 'Mon 07-13', 'Tue 07-14', 'Wed 07-15', 'Thu 07-16', 'Fri 07-17', 'Sat 07-18'][i]! })),
    { key: 'project_name', label: 'Project / job', sample: 'S26-0471 Splitter Box' },
    { key: 'po_number', label: 'Customer PO', sample: 'PO-2024-88' },
    { key: 'foreman_name', label: 'Foreman', sample: 'J. Martin' },
    { key: 'work_description', label: 'Work description', sample: 'Mudroom splitter box tie-ins, levels 1–2.' },
    ...PARTY_FIELDS,
    { key: 'labor_total', label: 'Labor total', sample: '$3,264.00' },
    { key: 'lines_total', label: 'Equipment & materials total', sample: '$1,086.00' },
    { key: 'grand_total', label: 'Grand total', sample: '$4,350.00' },
    { key: 'total_hours', label: 'Total hours', sample: '32.0' },
    { key: 'customer_signature_image', label: 'Customer signature (image)', sample: '' },
    { key: 'customer_signature_name', label: 'Customer signed by', sample: 'D. Alvarez' },
    { key: 'customer_signed_at', label: 'Customer signed on', sample: 'Jul 19, 2026' },
    { key: 'customer_comment', label: 'Customer comment', sample: '' },
    { key: 'foreman_signature_image', label: 'Foreman signature (image)', sample: '' },
    ...ORG_FIELDS,
  ],
  collections: [
    {
      key: 'crew',
      label: 'Crew hours',
      fields: [
        { key: 'employee_name', label: 'Employee', sample: 'P. Benko' },
        { key: 'labor_class', label: 'Labor class', sample: 'Journeyman Electrician' },
        { key: 'class_code', label: 'Class code', sample: 'J' },
        { key: 'reg_hours', label: 'Regular hours', sample: '24.0' },
        { key: 'ot_hours', label: 'Overtime hours', sample: '6.0' },
        { key: 'dt_hours', label: 'Double-time hours', sample: '2.0' },
        { key: 'total_hours', label: 'Total hours', sample: '32.0' },
        { key: 'reg_rate', label: 'Regular rate', sample: '$102.00' },
        { key: 'ot_rate', label: 'Overtime rate', sample: '$130.00' },
        { key: 'dt_rate', label: 'Double rate', sample: '$204.00' },
        { key: 'amount', label: 'Amount', sample: '$3,264.00' },
        ...CREW_DAY_FIELDS,
      ],
    },
    {
      key: 'lines',
      label: 'Equipment & materials',
      fields: [
        { key: 'item_name', label: 'Item', sample: 'Scissor lift 19ft' },
        { key: 'description', label: 'Description', sample: 'Week rental' },
        { key: 'quantity', label: 'Quantity', sample: '1' },
        { key: 'unit_price', label: 'Rate', sample: '$1,086.00' },
        { key: 'amount', label: 'Amount', sample: '$1,086.00' },
      ],
    },
  ],
}

/**
 * Shipment — the packing slip that travels with the goods. It names what is
 * in the box, not what it costs: lines carry item, quantity and carton, and
 * the header carries the ship-to address, carrier, service and tracking.
 */
const SHIPMENT: PdfRecordTypeMeta = {
  key: 'shipment',
  labelKey: 'shipment',
  docKind: 'shipment',
  docTitle: 'Packing Slip',
  partyHeading: 'Ship to',
  readPermission: 'orders.fulfill',
  fields: [
    { key: 'document_number', label: 'Shipment number', sample: 'SHP-000042' },
    { key: 'document_date', label: 'Ship date', sample: 'Jul 16, 2026' },
    { key: 'status', label: 'Status', sample: 'Draft' },
    { key: 'sales_order_number', label: 'Sales order', sample: 'SO-000118' },
    { key: 'pick_list_number', label: 'Pick list', sample: 'PICK-000077' },
    { key: 'party_name', label: 'Customer', sample: 'Acme Construction Inc.' },
    { key: 'party_email', label: 'Customer email', sample: 'receiving@acme.example' },
    { key: 'party_phone', label: 'Customer phone', sample: '(555) 010-0199' },
    { key: 'ship_to_name', label: 'Ship-to name', sample: 'Acme — Site 4 receiving' },
    { key: 'ship_to_address', label: 'Ship-to address', sample: '400 King St W, Suite 300, Toronto, ON M5V 1K2, CA' },
    { key: 'warehouse_name', label: 'Ship from warehouse', sample: 'MAIN · Main warehouse' },
    { key: 'carrier_name', label: 'Carrier', sample: 'Northline Freight' },
    { key: 'carrier_service', label: 'Service', sample: 'Ground' },
    { key: 'tracking_number', label: 'Tracking number', sample: '1Z999AA10123456784' },
    { key: 'tracking_url', label: 'Tracking link', sample: 'https://track.example/1Z999AA10123456784' },
    { key: 'carton_count', label: 'Cartons', sample: '2' },
    { key: 'memo', label: 'Memo', sample: 'Deliver to the loading dock.' },
    ...ORG_FIELDS,
  ],
  collections: [
    {
      key: 'lines',
      label: 'Packed lines',
      fields: [
        { key: 'line_number', label: 'Line #', sample: '1' },
        { key: 'item_name', label: 'Item', sample: 'W12x26 beam' },
        { key: 'customer_sku', label: 'Customer part number', sample: 'ACME-STEEL-42' },
        { key: 'description', label: 'Description', sample: 'Structural steel — level 2 mezzanine' },
        { key: 'quantity', label: 'Quantity', sample: '12' },
        { key: 'unit', label: 'Unit', sample: 'ea' },
        { key: 'carton', label: 'Carton', sample: 'C1' },
        { key: 'bin', label: 'Bin', sample: 'A-01-03' },
        { key: 'lot_serial', label: 'Lot / serial', sample: 'LOT-2407' },
      ],
    },
  ],
}

const SHIPMENT_CARTON_LABEL: PdfRecordTypeMeta = {
  ...SHIPMENT,
  key: 'shipment_carton_label',
  labelKey: 'shipment_carton_label',
  docTitle: 'Carton Label',
  fields: [
    { key: 'document_number', label: 'Shipment number', sample: 'SHP-000042' },
    { key: 'ship_to_name', label: 'Ship-to name', sample: 'Acme — Site 4 receiving' },
    { key: 'ship_to_address', label: 'Ship-to address', sample: '400 King St W, Suite 300, Toronto, ON M5V 1K2, CA' },
    { key: 'warehouse_name', label: 'Ship from warehouse', sample: 'MAIN · Main warehouse' },
    { key: 'warehouse_address', label: 'Ship-from address', sample: '400 King St W, Toronto, ON M5V 1K2, CA' },
  ],
  collections: [
    {
      key: 'cartons',
      label: 'Cartons',
      fields: [
        { key: 'carton', label: 'Carton', sample: 'C1' },
        { key: 'carton_number', label: 'Carton number', sample: '1' },
        { key: 'carton_total', label: 'Carton count', sample: '2' },
        { key: 'barcode', label: 'Shipment and carton barcode', sample: 'SHP-000042-C1' },
      ],
    },
  ],
}

const SHIPMENT_SHIPPING_LABEL: PdfRecordTypeMeta = {
  ...SHIPMENT,
  key: 'shipment_shipping_label',
  labelKey: 'shipment_shipping_label',
  docTitle: 'Shipping Label',
  fields: [
    { key: 'document_number', label: 'Shipment number', sample: 'SHP-000042' },
    { key: 'ship_to_name', label: 'Ship-to name', sample: 'Acme — Site 4 receiving' },
    { key: 'ship_to_address', label: 'Ship-to address', sample: '400 King St W, Suite 300, Toronto, ON M5V 1K2, CA' },
    { key: 'warehouse_name', label: 'Ship-from warehouse', sample: 'MAIN · Main warehouse' },
    { key: 'warehouse_address', label: 'Ship-from address', sample: '400 King St W, Toronto, ON M5V 1K2, CA' },
    { key: 'carrier_name', label: 'Carrier', sample: 'Northline Freight' },
    { key: 'carrier_service', label: 'Service', sample: 'Ground' },
    { key: 'tracking_number', label: 'Tracking number', sample: '1Z999AA10123456784' },
  ],
  collections: [],
}

const PAY_STUB: PdfRecordTypeMeta = {
  key: 'pay_stub',
  labelKey: 'pay_stub',
  docKind: null,
  docTitle: 'Pay Stub',
  partyHeading: 'Employee',
  readPermission: 'payroll.read',
  fields: [
    { key: 'employee_name', label: 'Employee', sample: 'Jordan Sparks' },
    { key: 'document_number', label: 'Pay run number', sample: 'PAY-000012' },
    { key: 'period_start', label: 'Period start', sample: 'Jul 5, 2026' },
    { key: 'period_end', label: 'Period end', sample: 'Jul 18, 2026' },
    { key: 'pay_date', label: 'Pay date', sample: 'Jul 21, 2026' },
    { key: 'province', label: 'Province / state', sample: 'ON' },
    { key: 'currency', label: 'Currency', sample: 'CAD' },
    { key: 'gross', label: 'Gross pay', sample: '$2,400.00' },
    { key: 'non_cash_earnings', label: 'Non-cash benefits', sample: '$0.00' },
    { key: 'cash_gross', label: 'Cash earnings', sample: '$2,400.00' },
    { key: 'has_non_cash_earnings', label: 'Has non-cash benefits', sample: '' },
    { key: 'total_deductions', label: 'Total deductions', sample: '$505.31' },
    { key: 'net_pay', label: 'Net pay', sample: '$1,894.69' },
    { key: 'vacation_accrued', label: 'Vacation accrued', sample: '$96.00' },
    { key: 'ytd_gross', label: 'YTD gross', sample: '$33,600.00' },
    { key: 'ytd_tax', label: 'YTD income tax', sample: '$4,120.10' },
    { key: 'ytd_net', label: 'YTD net pay', sample: '$26,525.66' },
    ...ORG_FIELDS,
  ],
  collections: [
    {
      key: 'earnings',
      label: 'Earnings',
      fields: [
        { key: 'description', label: 'Earning', sample: 'Regular' },
        { key: 'non_cash', label: 'Non-cash earning', sample: '' },
        { key: 'hours', label: 'Hours', sample: '80.00' },
        { key: 'rate', label: 'Rate', sample: '$30.00' },
        { key: 'amount', label: 'Amount', sample: '$2,400.00' },
      ],
    },
    {
      key: 'deductions',
      label: 'Deductions',
      fields: [
        { key: 'description', label: 'Deduction', sample: 'CPP' },
        { key: 'amount', label: 'Amount', sample: '$110.99' },
      ],
    },
    {
      key: 'employer_contributions',
      label: 'Employer contributions',
      fields: [
        { key: 'description', label: 'Contribution', sample: 'CPP (employer)' },
        { key: 'amount', label: 'Amount', sample: '$110.99' },
      ],
    },
  ],
}

/**
 * The printed pay cheque. Keyed on the STUB, like the pay stub itself — one
 * employee's pay on this run — so an employer who wants a cheque-and-voucher
 * on one page can put the earnings/deductions collections on the same sheet.
 */
const PAYROLL_CHEQUE: PdfRecordTypeMeta = {
  key: 'payroll_cheque',
  labelKey: 'payroll_cheque',
  docKind: null,
  docTitle: 'Pay Cheque',
  partyHeading: 'Pay to the order of',
  readPermission: 'payroll.read',
  fields: [
    { key: 'cheque_number', label: 'Cheque number', sample: 'CHQ-00042' },
    { key: 'employee_name', label: 'Payee', sample: 'Jordan Sparks' },
    { key: 'employee_address', label: 'Payee address', sample: '18 Maple Ave, Toronto, ON M4E 2T1' },
    { key: 'pay_date', label: 'Date', sample: 'Jul 21, 2026' },
    { key: 'amount', label: 'Amount', sample: '$1,894.69' },
    { key: 'amount_in_words', label: 'Amount in words', sample: 'One thousand eight hundred ninety-four and 69/100' },
    { key: 'currency', label: 'Currency', sample: 'CAD' },
    { key: 'memo', label: 'Memo', sample: 'Pay period Jul 5 – Jul 18, 2026' },
    { key: 'document_number', label: 'Pay run number', sample: 'PAY-000012' },
    { key: 'period_start', label: 'Period start', sample: 'Jul 5, 2026' },
    { key: 'period_end', label: 'Period end', sample: 'Jul 18, 2026' },
    { key: 'gross', label: 'Gross pay', sample: '$2,400.00' },
    { key: 'non_cash_earnings', label: 'Non-cash benefits', sample: '$0.00' },
    { key: 'cash_gross', label: 'Cash earnings', sample: '$2,400.00' },
    { key: 'has_non_cash_earnings', label: 'Has non-cash benefits', sample: '' },
    { key: 'total_deductions', label: 'Total deductions', sample: '$505.31' },
    { key: 'net_pay', label: 'Net pay', sample: '$1,894.69' },
    ...ORG_FIELDS,
  ],
  collections: [
    {
      key: 'earnings',
      label: 'Earnings (voucher)',
      fields: [
        { key: 'description', label: 'Earning', sample: 'Regular' },
        { key: 'non_cash', label: 'Non-cash earning', sample: '' },
        { key: 'hours', label: 'Hours', sample: '80.00' },
        { key: 'rate', label: 'Rate', sample: '$30.00' },
        { key: 'amount', label: 'Amount', sample: '$2,400.00' },
      ],
    },
    {
      key: 'deductions',
      label: 'Deductions (voucher)',
      fields: [
        { key: 'description', label: 'Deduction', sample: 'CPP' },
        { key: 'amount', label: 'Amount', sample: '$110.99' },
      ],
    },
  ],
}

/** Every record type a PDF template can target, in nav order. */
export const PDF_RECORD_TYPES: PdfRecordTypeMeta[] = [
  docType({ key: 'customer_invoice', docTitle: 'Invoice', partyHeading: 'Bill to', readPermission: 'ar.read', hasParty: true, hasDue: true, hasReference: true }),
  docType({ key: 'customer_credit', docTitle: 'Credit Memo', partyHeading: 'Bill to', readPermission: 'ar.read', hasParty: true, hasDue: true, hasReference: true }),
  docType({ key: 'quote', docTitle: 'Quote', partyHeading: 'Prepared for', readPermission: 'ar.read', hasParty: true, hasDue: false, hasReference: true }),
  docType({ key: 'sales_order', docTitle: 'Sales Order', partyHeading: 'Sold to', readPermission: 'ar.read', hasParty: true, hasDue: false, hasReference: true }),
  docType({ key: 'purchase_order', docTitle: 'Purchase Order', partyHeading: 'Vendor', readPermission: 'ap.read', hasParty: true, hasDue: false, hasReference: true, extraFields: [
    { key: 'ship_to_name', label: 'Ship-to name', sample: 'Acme — Site 4 receiving' },
    { key: 'ship_to_address', label: 'Ship-to address', sample: '400 King St W, Suite 300, Toronto, ON M5V 1K2, CA' },
  ] }),
  docType({ key: 'vendor_bill', docTitle: 'Bill', partyHeading: 'Vendor', readPermission: 'ap.read', hasParty: true, hasDue: true, hasReference: true }),
  docType({ key: 'vendor_credit', docTitle: 'Vendor Credit', partyHeading: 'Vendor', readPermission: 'ap.read', hasParty: true, hasDue: true, hasReference: true }),
  docType({ key: 'vendor_payment', docTitle: 'Payment Remittance', partyHeading: 'Paid to', readPermission: 'ap.read', hasParty: true, hasDue: false, hasReference: true }),
  docType({ key: 'customer_payment', docTitle: 'Payment Receipt', partyHeading: 'Received from', readPermission: 'ar.read', hasParty: true, hasDue: false, hasReference: true }),
  docType({ key: 'expense_report', docTitle: 'Expense Report', partyHeading: 'Employee', readPermission: 'expenses.read', hasParty: true, hasDue: false, hasReference: true }),
  docType({ key: 'check', docTitle: 'Check', partyHeading: null, readPermission: 'ap.read', hasParty: false, hasDue: false, hasReference: true }),
  docType({ key: 'card_charge', docTitle: 'Card Charge', partyHeading: null, readPermission: 'ap.read', hasParty: false, hasDue: false, hasReference: false }),
  docType({ key: 'card_refund', docTitle: 'Card Refund', partyHeading: null, readPermission: 'ap.read', hasParty: false, hasDue: false, hasReference: false }),
  docType({ key: 'journal', docTitle: 'Journal Entry', partyHeading: null, readPermission: 'gl.read', hasParty: false, hasDue: false, hasReference: false }),
  SHIPMENT,
  SHIPMENT_CARTON_LABEL,
  SHIPMENT_SHIPPING_LABEL,
  FIELD_TICKET,
  JOURNAL_ENTRY,
  PAY_STUB,
  PAYROLL_CHEQUE,
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
