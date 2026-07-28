import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import {
  ClipboardList,
  ClipboardCheck,
  BookOpen,
  Banknote,
  ArrowLeftRight,
  CreditCard,
  FileText,
  ReceiptText,
} from 'lucide-react'

/**
 * Compact, consistent transaction-type identity used across flyout headers,
 * report rows and ledgers — so you always know whether you're looking at a Bill,
 * an Invoice, a Journal, etc. Short labels keep it small in dense tables.
 * Colour-coded by money-flow family (purchases amber · sales teal ·
 * money-movement blue · ledger slate · expense violet · cards rose).
 */
export interface DocTypeMeta {
  /** Translation keys within common.transactionTypes. */
  labelKey: string
  shortLabelKey: string
  icon: ReactNode
  /** tailwind classes for the pill (bg/text/ring), light + dark. */
  cls: string
  /** Subtle record-type wash for the corresponding flyout. */
  surfaceCls: string
}

const ICON = 'h-3 w-3'

const palette = (cls: string, surfaceCls: string) => ({ cls, surfaceCls })

const P = {
  amber: palette('bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-400/20', 'bg-gradient-to-b from-amber-50 via-white to-white dark:from-amber-950/30 dark:via-slate-900 dark:to-slate-900'),
  orange: palette('bg-orange-50 text-orange-700 ring-orange-600/20 dark:bg-orange-950/40 dark:text-orange-300 dark:ring-orange-400/20', 'bg-gradient-to-b from-orange-50 via-white to-white dark:from-orange-950/30 dark:via-slate-900 dark:to-slate-900'),
  yellow: palette('bg-yellow-50 text-yellow-700 ring-yellow-600/20 dark:bg-yellow-950/40 dark:text-yellow-300 dark:ring-yellow-400/20', 'bg-gradient-to-b from-yellow-50 via-white to-white dark:from-yellow-950/30 dark:via-slate-900 dark:to-slate-900'),
  teal: palette('bg-teal-50 text-teal-700 ring-teal-600/20 dark:bg-teal-950/40 dark:text-teal-300 dark:ring-teal-400/20', 'bg-gradient-to-b from-teal-50 via-white to-white dark:from-teal-950/30 dark:via-slate-900 dark:to-slate-900'),
  emerald: palette('bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-400/20', 'bg-gradient-to-b from-emerald-50 via-white to-white dark:from-emerald-950/30 dark:via-slate-900 dark:to-slate-900'),
  cyan: palette('bg-cyan-50 text-cyan-700 ring-cyan-600/20 dark:bg-cyan-950/40 dark:text-cyan-300 dark:ring-cyan-400/20', 'bg-gradient-to-b from-cyan-50 via-white to-white dark:from-cyan-950/30 dark:via-slate-900 dark:to-slate-900'),
  indigo: palette('bg-indigo-50 text-indigo-700 ring-indigo-600/20 dark:bg-indigo-950/40 dark:text-indigo-300 dark:ring-indigo-400/20', 'bg-gradient-to-b from-indigo-50 via-white to-white dark:from-indigo-950/30 dark:via-slate-900 dark:to-slate-900'),
  violet: palette('bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-950/40 dark:text-violet-300 dark:ring-violet-400/20', 'bg-gradient-to-b from-violet-50 via-white to-white dark:from-violet-950/30 dark:via-slate-900 dark:to-slate-900'),
  slate: palette('bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-400/20', 'bg-gradient-to-b from-slate-100 via-white to-white dark:from-slate-800 dark:via-slate-900 dark:to-slate-900'),
  sky: palette('bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-400/20', 'bg-gradient-to-b from-sky-50 via-white to-white dark:from-sky-950/30 dark:via-slate-900 dark:to-slate-900'),
  blue: palette('bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-400/20', 'bg-gradient-to-b from-blue-50 via-white to-white dark:from-blue-950/30 dark:via-slate-900 dark:to-slate-900'),
  lime: palette('bg-lime-50 text-lime-700 ring-lime-600/20 dark:bg-lime-950/40 dark:text-lime-300 dark:ring-lime-400/20', 'bg-gradient-to-b from-lime-50 via-white to-white dark:from-lime-950/30 dark:via-slate-900 dark:to-slate-900'),
  green: palette('bg-green-50 text-green-700 ring-green-600/20 dark:bg-green-950/40 dark:text-green-300 dark:ring-green-400/20', 'bg-gradient-to-b from-green-50 via-white to-white dark:from-green-950/30 dark:via-slate-900 dark:to-slate-900'),
  zinc: palette('bg-zinc-100 text-zinc-700 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-400/20', 'bg-gradient-to-b from-zinc-100 via-white to-white dark:from-zinc-800 dark:via-slate-900 dark:to-slate-900'),
  rose: palette('bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-400/20', 'bg-gradient-to-b from-rose-50 via-white to-white dark:from-rose-950/30 dark:via-slate-900 dark:to-slate-900'),
  pink: palette('bg-pink-50 text-pink-700 ring-pink-600/20 dark:bg-pink-950/40 dark:text-pink-300 dark:ring-pink-400/20', 'bg-gradient-to-b from-pink-50 via-white to-white dark:from-pink-950/30 dark:via-slate-900 dark:to-slate-900'),
}

const meta = (key: string, shortKey: string, icon: ReactNode, colors: { cls: string; surfaceCls: string }): DocTypeMeta => ({
  labelKey: key,
  shortLabelKey: shortKey,
  icon,
  ...colors,
})

export const DOC_TYPE_META: Record<string, DocTypeMeta> = {
  vendor_bill: meta('vendorBill', 'bill', <ClipboardList className={ICON} />, P.amber),
  vendor_credit: meta('vendorCredit', 'credit', <ClipboardList className={ICON} />, P.orange),
  purchase_order: meta('purchaseOrder', 'purchaseOrderShort', <ClipboardList className={ICON} />, P.yellow),
  customer_invoice: meta('customerInvoice', 'invoice', <ClipboardCheck className={ICON} />, P.teal),
  customer_credit: meta('customerCredit', 'customerCreditShort', <ClipboardCheck className={ICON} />, P.emerald),
  sales_order: meta('salesOrder', 'salesOrderShort', <ClipboardCheck className={ICON} />, P.cyan),
  quote: meta('estimate', 'estimate', <FileText className={ICON} />, P.indigo),
  expense_report: meta('expenseReport', 'expense', <ReceiptText className={ICON} />, P.violet),
  journal: meta('journalEntry', 'journal', <BookOpen className={ICON} />, P.slate),
  vendor_payment: meta('vendorPayment', 'vendorPaymentShort', <Banknote className={ICON} />, P.sky),
  customer_payment: meta('customerPayment', 'customerPaymentShort', <Banknote className={ICON} />, P.blue),
  check: meta('check', 'check', <Banknote className={ICON} />, P.lime),
  deposit: meta('bankDeposit', 'deposit', <Banknote className={ICON} />, P.green),
  transfer: meta('transfer', 'transfer', <ArrowLeftRight className={ICON} />, P.zinc),
  card_charge: meta('cardCharge', 'cardChargeShort', <CreditCard className={ICON} />, P.rose),
  card_refund: meta('cardRefund', 'cardRefundShort', <CreditCard className={ICON} />, P.pink),
  project_charge: meta('projectCharge', 'projectChargeShort', <ReceiptText className={ICON} />, P.indigo),
  field_ticket: meta('fieldTicket', 'fieldTicketShort', <ClipboardCheck className={ICON} />, P.cyan),
}

const humanize = (kind: string) => kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export function docTypeMeta(kind: string): DocTypeMeta {
  return DOC_TYPE_META[kind] ?? { labelKey: humanize(kind), shortLabelKey: humanize(kind), icon: <FileText className={ICON} />, ...P.slate }
}

/**
 * The transaction-type pill. Small by default (short label, tight padding) so it
 * fits inside table rows; pass `full` to show the long name (e.g. a document
 * flyout header) and `icon={false}` to drop the glyph.
 */
export function DocTypeBadge({ kind, full = false, icon = true }: { kind: string; full?: boolean; icon?: boolean }) {
  const t = useTranslations('common.transactionTypes')
  const meta = docTypeMeta(kind)
  const translated = (key: string) => t.has(key as never) ? t(key as never) : key
  return (
    <span
      title={translated(meta.labelKey)}
      className={
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1 ring-inset ' +
        meta.cls
      }
    >
      {icon && meta.icon}
      {translated(full ? meta.labelKey : meta.shortLabelKey)}
    </span>
  )
}
