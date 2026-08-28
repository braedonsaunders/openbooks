import type { ExportData, Translator } from './report-pdf'

export type AccountRegisterExportFormat = 'pdf' | 'xlsx' | 'csv'

export interface AccountRegisterExportLine {
  entry_number: string | null
  posting_date: string
  entry_memo: string | null
  amount: string
  memo: string | null
  party: string | null
  doc_kind: string | null
  doc_number: string | null
}

export interface AccountRegisterExportResult {
  account: { number: string | null; name: string }
  lines: AccountRegisterExportLine[]
  total: number
  balance: string
}

const DOC_TYPE_KEYS: Record<string, string> = {
  vendor_bill: 'vendorBill',
  vendor_credit: 'vendorCredit',
  purchase_order: 'purchaseOrder',
  customer_invoice: 'customerInvoice',
  customer_credit: 'customerCredit',
  sales_order: 'salesOrder',
  quote: 'estimate',
  expense_report: 'expenseReport',
  journal: 'journalEntry',
  vendor_payment: 'vendorPayment',
  customer_payment: 'customerPayment',
  check: 'check',
  deposit: 'bankDeposit',
  transfer: 'transfer',
  card_charge: 'cardCharge',
  card_refund: 'cardRefund',
  project_charge: 'projectCharge',
  field_ticket: 'fieldTicket',
}

function humanize(kind: string): string {
  return kind.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

export function accountRegisterDocTypeLabel(kind: string | null, t: Translator): string {
  const normalized = kind || 'journal'
  const key = DOC_TYPE_KEYS[normalized]
  return key ? t(`transactionTypes.${key}`) : humanize(normalized)
}

export function accountRegisterExportHref(
  accountId: string,
  format: AccountRegisterExportFormat,
  period: { from?: string | null; to?: string | null; search?: string | null } = {},
): string {
  const query = new URLSearchParams({ format })
  if (period.from) query.set('from', period.from)
  if (period.to) query.set('to', period.to)
  if (period.search) query.set('q', period.search)
  return `/api/accounts/${encodeURIComponent(accountId)}/register?${query}`
}

function decimalText(value: string): string {
  // Keep ledger amounts as text all the way to the export adapters. A Number
  // round-trip here would silently alter values once they exceed 2^53.
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid register amount')
  return value
}

function decimalIsZero(value: string): boolean {
  return /^-?0(?:\.0+)?$/.test(value)
}

export function accountRegisterExportData(
  result: AccountRegisterExportResult,
  labels: {
    register: string
    date: string
    type: string
    number: string
    party: string
    memo: string
    debit: string
    credit: string
    balance: string
    lines: string
    dateRange: string
    docType: (kind: string | null) => string
  },
): ExportData {
  const accountLabel = `${result.account.number ?? ''} ${result.account.name}`.trim()
  const rows = result.lines.map((line) => {
    const amount = decimalText(line.amount)
    const isZero = decimalIsZero(amount)
    const isCredit = amount.startsWith('-') && !isZero
    return [
      line.posting_date,
      labels.docType(line.doc_kind),
      line.doc_number || line.entry_number || '',
      line.party || '',
      line.memo ?? line.entry_memo ?? '',
      !isCredit && !isZero ? amount : null,
      isCredit ? amount.slice(1) : null,
    ]
  })

  return {
    title: `${accountLabel} — ${labels.register}`,
    dateRangeLabel: labels.dateRange,
    summary: [
      { label: labels.balance, value: decimalText(result.balance), money: true },
      { label: labels.lines, value: result.total },
    ],
    groups: [{
      kind: 'results',
      title: accountLabel,
      columns: [
        labels.date,
        labels.type,
        labels.number,
        labels.party,
        labels.memo,
        labels.debit,
        labels.credit,
      ],
      rows,
      money: [false, false, false, false, false, true, true],
      align: ['left', 'left', 'left', 'left', 'left', 'right', 'right'],
    }],
  }
}
