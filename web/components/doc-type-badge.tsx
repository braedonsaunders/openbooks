import type { ReactNode } from 'react'
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
  /** Full name, for headings/tooltips. */
  label: string
  /** Short label shown in the pill (keeps it small in rows). */
  short: string
  icon: ReactNode
  /** tailwind classes for the pill (bg/text/ring), light + dark. */
  cls: string
}

const ICON = 'h-3 w-3'

const AMBER = 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-400/20'
const TEAL = 'bg-teal-50 text-teal-700 ring-teal-600/20 dark:bg-teal-950/40 dark:text-teal-300 dark:ring-teal-400/20'
const BLUE = 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-400/20'
const SLATE = 'bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-400/20'
const VIOLET = 'bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-950/40 dark:text-violet-300 dark:ring-violet-400/20'
const ROSE = 'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-400/20'

export const DOC_TYPE_META: Record<string, DocTypeMeta> = {
  vendor_bill: { label: 'Vendor Bill', short: 'Bill', icon: <ClipboardList className={ICON} />, cls: AMBER },
  vendor_credit: { label: 'Vendor Credit', short: 'V. Credit', icon: <ClipboardList className={ICON} />, cls: AMBER },
  purchase_order: { label: 'Purchase Order', short: 'PO', icon: <ClipboardList className={ICON} />, cls: AMBER },
  customer_invoice: { label: 'Customer Invoice', short: 'Invoice', icon: <ClipboardCheck className={ICON} />, cls: TEAL },
  customer_credit: { label: 'Customer Credit', short: 'C. Credit', icon: <ClipboardCheck className={ICON} />, cls: TEAL },
  sales_order: { label: 'Sales Order', short: 'SO', icon: <ClipboardCheck className={ICON} />, cls: TEAL },
  quote: { label: 'Estimate', short: 'Estimate', icon: <FileText className={ICON} />, cls: TEAL },
  expense_report: { label: 'Expense Report', short: 'Expense', icon: <ReceiptText className={ICON} />, cls: VIOLET },
  journal: { label: 'Journal Entry', short: 'Journal', icon: <BookOpen className={ICON} />, cls: SLATE },
  vendor_payment: { label: 'Vendor Payment', short: 'Bill Pmt', icon: <Banknote className={ICON} />, cls: BLUE },
  customer_payment: { label: 'Customer Payment', short: 'Cust Pmt', icon: <Banknote className={ICON} />, cls: BLUE },
  check: { label: 'Check', short: 'Check', icon: <Banknote className={ICON} />, cls: BLUE },
  transfer: { label: 'Transfer', short: 'Transfer', icon: <ArrowLeftRight className={ICON} />, cls: SLATE },
  card_charge: { label: 'Card Charge', short: 'Card', icon: <CreditCard className={ICON} />, cls: ROSE },
  card_refund: { label: 'Card Refund', short: 'Card Cr.', icon: <CreditCard className={ICON} />, cls: ROSE },
}

const humanize = (kind: string) => kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export function docTypeMeta(kind: string): DocTypeMeta {
  return DOC_TYPE_META[kind] ?? { label: humanize(kind), short: humanize(kind), icon: <FileText className={ICON} />, cls: SLATE }
}

/**
 * The transaction-type pill. Small by default (short label, tight padding) so it
 * fits inside table rows; pass `full` to show the long name (e.g. a document
 * flyout header) and `icon={false}` to drop the glyph.
 */
export function DocTypeBadge({ kind, full = false, icon = true }: { kind: string; full?: boolean; icon?: boolean }) {
  const meta = docTypeMeta(kind)
  return (
    <span
      title={meta.label}
      className={
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1 ring-inset ' +
        meta.cls
      }
    >
      {icon && meta.icon}
      {full ? meta.label : meta.short}
    </span>
  )
}
