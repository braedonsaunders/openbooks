import Link from 'next/link'
import { PageHeader } from '@openbooks/ui'
import { CollectionsClient } from './CollectionsClient'

/**
 * The /collections page shell, placed by the ViewSpec
 * widget. Moved here (verbatim) from page.tsx so the page and the widget registry mount one
 * implementation — the `mx-auto max-w-6xl` container is narrower than any
 * viewspec shell, so it travels with the island rather than being
 * re-expressed as spec chrome.
 *
 * This page is recurring/subscription/dunning CONFIGURATION. The overdue
 * chase list lives on /ar — the shell links there (when the reader may open
 * it) instead of letting the page read as the worklist itself.
 */
export interface CollectionsShellProps {
  title: string
  description: string
  worklistHref: string | null
  worklistLabel: string
  subscriptionsEnabled: boolean
  advancedSubscriptionsEnabled: boolean
  customers: { id: string; name?: string; label?: string }[]
  incomeAccounts: { id: string; name?: string; label?: string }[]
}

export function CollectionsShell({
  title,
  description,
  worklistHref,
  worklistLabel,
  subscriptionsEnabled,
  advancedSubscriptionsEnabled,
  customers,
  incomeAccounts,
}: CollectionsShellProps) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <PageHeader title={title} description={description} />
      {worklistHref ? (
        <p className="mt-2 text-sm">
          <Link href={worklistHref} className="text-teal-700 hover:underline dark:text-teal-300">
            {worklistLabel} →
          </Link>
        </p>
      ) : null}
      <CollectionsClient
        subscriptionsEnabled={subscriptionsEnabled}
        advancedSubscriptionsEnabled={advancedSubscriptionsEnabled}
        customers={customers}
        incomeAccounts={incomeAccounts}
      />
    </div>
  )
}
