import { PageHeader } from '@openbooks/ui'
import { CollectionsClient } from './CollectionsClient'

/**
 * The /collections page shell, shared by the native branch and the ViewSpec
 * widget. Moved here (verbatim) from page.tsx so both render paths mount one
 * implementation — the `mx-auto max-w-6xl` container is narrower than any
 * viewspec shell, so it travels with the island rather than being
 * re-expressed as spec chrome.
 */
export interface CollectionsShellProps {
  title: string
  description: string
  subscriptionsEnabled: boolean
  advancedSubscriptionsEnabled: boolean
  customers: { id: string; name?: string; label?: string }[]
  incomeAccounts: { id: string; name?: string; label?: string }[]
}

export function CollectionsShell({
  title,
  description,
  subscriptionsEnabled,
  advancedSubscriptionsEnabled,
  customers,
  incomeAccounts,
}: CollectionsShellProps) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <PageHeader title={title} description={description} />
      <CollectionsClient
        subscriptionsEnabled={subscriptionsEnabled}
        advancedSubscriptionsEnabled={advancedSubscriptionsEnabled}
        customers={customers}
        incomeAccounts={incomeAccounts}
      />
    </div>
  )
}
