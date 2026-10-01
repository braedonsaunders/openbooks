import 'server-only'

import { PageHeader } from '@openbooks/ui'
import { ModuleHomeTabs } from '@/components/module-home/tabs'

/** Shared setup header and body adapters, composed from the native page components. */

export interface DepreciationSetupTab {
  key: string
  href: string
  label: string
  active: boolean
}

export type DepreciationSetupTabs = DepreciationSetupTab[]

export function DepreciationSetupHeader({
  title,
  description,
  tabs,
  tabsAria,
}: {
  title: string
  description: string
  tabs: DepreciationSetupTabs
  tabsAria: string
}) {
  return (
    <PageHeader title={title} description={description} actions={<ModuleHomeTabs tabs={tabs} ariaLabel={tabsAria} />} />
  )
}
