import Link from 'next/link'
import { Alert, AlertDescription, Badge, Button } from '@openbooks/ui'
import { HomePanel } from '../../../components/module-home/client'

/**
 * The compliance cockpit's bespoke panel bodies, extracted from the page.
 *
 * Each panel row is a small composite — a badge beside a link over a summary
 * line, three optional badges in a wrapper — that no leaf cell can express.
 * The brief's corollary applies: a cell that is more than one element is a
 * small component here, placed by the spec as a widget, and the native page
 * imports it back so both paths share one implementation and cannot drift.
 *
 * Every panel owns its empty state (the purchasing CommitmentsSection idiom):
 * expressing "render A when the list is empty, otherwise B" would need a
 * negated conditional in the spec, so the component renders its own empty
 * <p> and the spec places exactly one block per panel.
 */

export interface BlockedBillItem {
  documentId: string
  documentNumber: string
  billHref: string
  vendorName: string
  decisionLabel: string
  decisionVariant: 'destructive' | 'warning'
  reasons: string
  openBalance: string
}

export function BlockedBillsSection({
  rows,
  empty,
}: {
  rows: BlockedBillItem[]
  empty: string
}) {
  if (rows.length === 0) {
    return <p className="p-4 text-sm text-slate-500 dark:text-slate-400">{empty}</p>
  }
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {rows.map((bill) => (
        <li key={bill.documentId} className="flex items-start justify-between gap-3 px-4 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge variant={bill.decisionVariant}>{bill.decisionLabel}</Badge>
              <Link
                href={bill.billHref as never}
                className="truncate text-sm font-medium text-slate-800 hover:underline dark:text-slate-100"
              >
                {bill.documentNumber}
              </Link>
              <span className="truncate text-sm text-slate-500 dark:text-slate-400">{bill.vendorName}</span>
            </div>
            <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{bill.reasons}</p>
          </div>
          <span className="shrink-0 text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
            {bill.openBalance}
          </span>
        </li>
      ))}
    </ul>
  )
}

export interface ExpiringVendorItem {
  partyId: string
  vendorHref: string
  vendorName: string
  stateLabel: string
  stateVariant: 'success' | 'warning' | 'destructive' | 'secondary'
  nextExpiry: string | null
}

export function ExpiringVendorsSection({
  rows,
  empty,
}: {
  rows: ExpiringVendorItem[]
  empty: string
}) {
  if (rows.length === 0) {
    return <p className="p-4 text-sm text-slate-500 dark:text-slate-400">{empty}</p>
  }
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {rows.map((row) => (
        <li key={row.partyId} className="flex items-center justify-between gap-3 px-4 py-2.5">
          <Link
            href={row.vendorHref as never}
            className="truncate text-sm font-medium text-slate-800 hover:underline dark:text-slate-100"
          >
            {row.vendorName}
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant={row.stateVariant}>{row.stateLabel}</Badge>
            <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{row.nextExpiry}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}

export interface OutstandingWaiverItem {
  id: string
  waiverHref: string
  waiverNumber: string
  context: string
  statusLabel: string
  throughDate: string
}

export function OutstandingWaiversSection({
  rows,
  empty,
}: {
  rows: OutstandingWaiverItem[]
  empty: string
}) {
  if (rows.length === 0) {
    return <p className="p-4 text-sm text-slate-500 dark:text-slate-400">{empty}</p>
  }
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {rows.map((waiver) => (
        <li key={waiver.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
          <div className="min-w-0">
            <Link
              href={waiver.waiverHref as never}
              className="truncate text-sm font-medium text-slate-800 hover:underline dark:text-slate-100"
            >
              {waiver.waiverNumber}
            </Link>
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">{waiver.context}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="warning">{waiver.statusLabel}</Badge>
            <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{waiver.throughDate}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}

export interface ReadinessQueueItem {
  partyId: string
  vendorHref: string
  vendorName: string
  issue: string
  paidThisYear: string
}

/**
 * The "finish setup" banner. The native page renders a plain Alert (not the
 * dashed-card EmptyState), so it gets its own component rather than the
 * shared `empty-state` widget.
 */
export function ComplianceSetupBanner({
  prompt,
  actionHref,
  actionLabel,
}: {
  prompt: string
  actionHref: string
  actionLabel: string
}) {
  return (
    <Alert className="mb-4">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>{prompt}</span>
        <Button asChild size="sm">
          <Link href={actionHref as never}>{actionLabel}</Link>
        </Button>
      </AlertDescription>
    </Alert>
  )
}

/**
 * A panel WITH header actions. `panel` blocks carry only title/icon/hint —
 * actions are JSX, which a spec cannot express — so the two panels that have
 * one (waivers, readiness) render here as the same HomePanel the native page
 * uses, with their body component inside.
 */
export function WaiversPanel({
  title,
  hint,
  actionHref,
  actionLabel,
  rows,
  empty,
}: {
  title: string
  hint: string
  actionHref: string
  actionLabel: string
  rows: OutstandingWaiverItem[]
  empty: string
}) {
  return (
    <HomePanel
      icon="clipboard"
      title={title}
      hint={hint}
      bodyClassName="p-0"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href={actionHref as never}>{actionLabel}</Link>
        </Button>
      }
    >
      <OutstandingWaiversSection rows={rows} empty={empty} />
    </HomePanel>
  )
}

export function ReadinessPanel({
  title,
  hint,
  actionHref,
  actionLabel,
  rows,
  empty,
}: {
  title: string
  hint: string
  actionHref: string
  actionLabel: string
  rows: ReadinessQueueItem[]
  empty: string
}) {
  return (
    <HomePanel
      icon="receipt"
      title={title}
      hint={hint}
      bodyClassName="p-0"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href={actionHref as never}>{actionLabel}</Link>
        </Button>
      }
    >
      <ReadinessQueueSection rows={rows} empty={empty} />
    </HomePanel>
  )
}

export function ReadinessQueueSection({
  rows,
  empty,
}: {
  rows: ReadinessQueueItem[]
  empty: string
}) {
  if (rows.length === 0) {
    return <p className="p-4 text-sm text-slate-500 dark:text-slate-400">{empty}</p>
  }
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {rows.map((row) => (
        <li key={row.partyId} className="flex items-center justify-between gap-3 px-4 py-2.5">
          <div className="min-w-0">
            <Link
              href={row.vendorHref as never}
              className="truncate text-sm font-medium text-slate-800 hover:underline dark:text-slate-100"
            >
              {row.vendorName}
            </Link>
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">{row.issue}</p>
          </div>
          <span className="shrink-0 text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
            {row.paidThisYear}
          </span>
        </li>
      ))}
    </ul>
  )
}
