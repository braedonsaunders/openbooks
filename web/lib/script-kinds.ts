/**
 * The record-kind vocabulary scripts can narrow to. Pure + client-safe: shared
 * by the Scripts admin list, the flyout's kind picker, and the API validator.
 *
 * A script's documentKind is one of:
 *   null                    — no record scoping (fires for every kind at its
 *                             trigger; the only shape endpoint/bulk/scheduled
 *                             scripts have — they aren't tied to a record)
 *   '<builtin kind>'        — a posting/document kind, e.g. 'vendor_bill'
 *   'custrec:<typeKey>'     — a custom record type (same prefix convention as
 *                             number_sequences); fires on custom-record saves
 */

export const CUSTREC_PREFIX = 'custrec:'

/** Every built-in document kind with its scripts.kinds.* message key. */
export const BUILT_IN_SCRIPT_KINDS: { value: string; labelKey: string }[] = [
  { value: 'vendor_bill', labelKey: 'kinds.vendorBill' },
  { value: 'vendor_credit', labelKey: 'kinds.vendorCredit' },
  { value: 'customer_invoice', labelKey: 'kinds.customerInvoice' },
  { value: 'customer_credit', labelKey: 'kinds.customerCredit' },
  { value: 'vendor_payment', labelKey: 'kinds.vendorPayment' },
  { value: 'customer_payment', labelKey: 'kinds.customerPayment' },
  { value: 'card_charge', labelKey: 'kinds.cardCharge' },
  { value: 'card_refund', labelKey: 'kinds.cardRefund' },
  { value: 'check', labelKey: 'kinds.check' },
  { value: 'deposit', labelKey: 'kinds.deposit' },
  { value: 'transfer', labelKey: 'kinds.transfer' },
  { value: 'expense_report', labelKey: 'kinds.expenseReport' },
  { value: 'journal', labelKey: 'kinds.journal' },
  { value: 'purchase_order', labelKey: 'kinds.purchaseOrder' },
  { value: 'sales_order', labelKey: 'kinds.salesOrder' },
  { value: 'quote', labelKey: 'kinds.quote' },
]

export function isCustomRecordKind(kind: string): boolean {
  return kind.startsWith(CUSTREC_PREFIX)
}

export function customRecordTypeKey(kind: string): string {
  return kind.slice(CUSTREC_PREFIX.length)
}

export function customRecordKind(typeKey: string): string {
  return CUSTREC_PREFIX + typeKey
}
