import { CollectionsClient } from './CollectionsClient'

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
  subscriptionsEnabled,
  advancedSubscriptionsEnabled,
  customers,
  incomeAccounts,
}: CollectionsShellProps) {
  return <CollectionsClient title={title} description={description} worklistEnabled={!!worklistHref}
    subscriptionsEnabled={subscriptionsEnabled} advancedSubscriptionsEnabled={advancedSubscriptionsEnabled}
    customers={customers} incomeAccounts={incomeAccounts} />
}
