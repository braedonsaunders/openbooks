import 'server-only'

import { PageHeader } from '@openbooks/ui'
import { ModuleHomeTabs } from '@/components/module-home/tabs'
import type { TaxDepreciationPack } from '@openbooks/engine/src/tax-returns/depreciation-packs.ts'
import { TaxDepreciationSetup } from './TaxDepreciationSetup'

/** Shared setup header and body adapters, composed from the native page components. */

export interface TaxDepreciationSetupTab {
  key: string
  href: string
  label: string
  active: boolean
}

export type TaxDepreciationSetupTabs = TaxDepreciationSetupTab[]

export interface TaxDepreciationOverview {
  companyCountry: string
  packs: TaxDepreciationPack[]
  installedCodes: string[]
  regimes: { code: string; name: string; classAttribute: string; classes: { code: string; name: string }[] }[]
  categories: { id: string; name: string; taxAttributes: Record<string, unknown> }[]
}

export function TaxDepreciationHeader({
  title,
  description,
  tabs,
  tabsAria,
}: {
  title: string
  description: string
  descriptionClassName: string
  tabs: TaxDepreciationSetupTabs
  tabsAria: string
}) {
  return (
    <PageHeader title={title} description={description} actions={<ModuleHomeTabs tabs={tabs} ariaLabel={tabsAria} />} />
  )
}

export function TaxDepreciationOverviewSlot({ overview }: { overview: TaxDepreciationOverview }) {
  return <TaxDepreciationSetup {...overview} />
}
