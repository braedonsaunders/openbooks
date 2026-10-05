import { CollectionsClient } from './CollectionsClient'

export interface CollectionsShellProps {
  title: string
  description: string
  tabs?: { href: string; label: string; active?: boolean; count?: number | null }[]
  initialView?: string
  autopayOn?: boolean
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
  tabs = [],
  initialView,
  autopayOn = false,
  worklistHref,
  subscriptionsEnabled,
  advancedSubscriptionsEnabled,
  customers,
  incomeAccounts,
}: CollectionsShellProps) {
  return <CollectionsClient title={title} description={description} tabs={tabs} initialView={initialView}
    autopayOn={autopayOn} worklistEnabled={!!worklistHref}
    subscriptionsEnabled={subscriptionsEnabled} advancedSubscriptionsEnabled={advancedSubscriptionsEnabled}
    customers={customers} incomeAccounts={incomeAccounts} />
}
