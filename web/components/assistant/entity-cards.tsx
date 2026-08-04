'use client'

import { ArrowUpRight, Building2, CalendarDays, FileText } from 'lucide-react'
import { useLocale } from 'next-intl'
import { cn } from '@openbooks/ui'
import { TxnLink } from '@/app/(app)/reports/TxnLink'
import { RelatedPartyLink } from '@/components/related-party-link'
import { createMoneyFormatter } from '@/lib/money-format'
import {
  assistantEntitiesFromToolOutput,
  type AssistantDocumentEntity,
  type AssistantPartyEntity,
} from '@/lib/assistant/entities'

const DISPLAY_LIMIT = 6

const KIND_LABELS: Record<string, string> = {
  vendor_bill: 'Vendor bill',
  vendor_payment: 'Vendor payment',
  vendor_credit: 'Vendor credit',
  purchase_order: 'Purchase order',
  check: 'Check',
  card_charge: 'Card charge',
  card_refund: 'Card refund',
  customer_invoice: 'Customer invoice',
  customer_payment: 'Customer payment',
  customer_credit: 'Customer credit',
  sales_order: 'Sales order',
  estimate: 'Estimate',
  expense_report: 'Expense report',
  journal: 'Journal',
  transfer: 'Transfer',
}

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replaceAll('_', ' ')
}

function statusClass(status: string | undefined): string {
  if (status === 'posted' || status === 'approved') {
    return 'bg-emerald-50 text-emerald-700 ring-emerald-600/15 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-400/20'
  }
  if (status === 'voided') {
    return 'bg-red-50 text-red-700 ring-red-600/15 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-400/20'
  }
  return 'bg-amber-50 text-amber-700 ring-amber-600/15 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-400/20'
}

function formattedDate(value: string | undefined, locale: string): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

function DocumentCard({ document }: { document: AssistantDocumentEntity }) {
  const locale = useLocale()
  const date = formattedDate(document.documentDate, locale)
  const dueDate = formattedDate(document.dueDate, locale)
  const amount =
    document.total !== undefined && document.currency
      ? createMoneyFormatter(locale, document.currency).money(document.total, {
          currencyDisplay: 'code',
        })
      : null

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-colors hover:border-teal-300 dark:border-slate-800 dark:bg-slate-900/80 dark:hover:border-teal-800">
      <TxnLink
        entryId={document.postedEntryId ?? ''}
        docKind={document.kind}
        docId={document.id}
        className="group flex min-w-0 items-start gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
          <FileText className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex items-center gap-1 font-semibold text-teal-700 group-hover:underline dark:text-teal-300">
              {document.documentNumber}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </span>
            {document.status ? (
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ring-1 ring-inset',
                  statusClass(document.status),
                )}
              >
                {document.status.replaceAll('_', ' ')}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {kindLabel(document.kind)}
            {document.referenceNumber ? ` · Ref ${document.referenceNumber}` : ''}
          </div>
        </div>
        {amount ? (
          <div className="shrink-0 text-right text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {amount}
          </div>
        ) : null}
      </TxnLink>
      {document.party || date || dueDate ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-slate-100 pt-2.5 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-300">
          {document.party ? (
            document.partyId ? (
              <RelatedPartyLink
                partyId={document.partyId}
                className="inline-flex min-w-0 items-center gap-1.5 font-medium text-slate-700 hover:text-teal-700 hover:underline dark:text-slate-200 dark:hover:text-teal-300"
              >
                <Building2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span className="truncate">{document.party}</span>
                <ArrowUpRight className="h-3 w-3 shrink-0" />
              </RelatedPartyLink>
            ) : (
              <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-slate-700 dark:text-slate-200">
                <Building2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span className="truncate">{document.party}</span>
              </span>
            )
          ) : null}
          {date ? (
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
              {date}
            </span>
          ) : null}
          {dueDate ? (
            <span className="text-slate-400 dark:text-slate-500">Due {dueDate}</span>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function PartyCard({ party }: { party: AssistantPartyEntity }) {
  return (
    <RelatedPartyLink
      partyId={party.id}
      className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-colors hover:border-teal-300 dark:border-slate-800 dark:bg-slate-900/80 dark:hover:border-teal-800"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
        <Building2 className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-slate-900 group-hover:text-teal-700 dark:text-slate-100 dark:group-hover:text-teal-300">
          {party.displayName}
        </span>
        <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
          {[party.kind?.replaceAll('_', ' '), party.shortCode, party.email]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-400 group-hover:text-teal-600 dark:group-hover:text-teal-300" />
    </RelatedPartyLink>
  )
}

export function AssistantEntityCards({ name, output }: { name: string; output: unknown }) {
  const { documents, parties } = assistantEntitiesFromToolOutput(name, output)
  if (documents.length === 0 && parties.length === 0) return null

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {documents.slice(0, DISPLAY_LIMIT).map((document) => (
        <DocumentCard key={`${document.kind}:${document.id}`} document={document} />
      ))}
      {parties.slice(0, DISPLAY_LIMIT).map((party) => (
        <PartyCard key={party.id} party={party} />
      ))}
    </div>
  )
}
