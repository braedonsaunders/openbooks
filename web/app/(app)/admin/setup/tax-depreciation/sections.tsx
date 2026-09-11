import 'server-only'

import Link from 'next/link'
import { cn } from '@openbooks/ui'
import type { TaxDepreciationPack } from '@openbooks/engine/src/tax-depreciation-packs.ts'
import { TaxDepreciationSetup } from './TaxDepreciationSetup'

/**
 * Shared chrome for the tax-depreciation setup workspace, plus the overview
 * tab's slot.
 *
 * The page owns its tab strip (underline links with `shrink-0` and
 * `aria-current`, not the `module-home-tabs` pill strip), so the whole
 * header — h1, description and nav — is one shared component over
 * loader-resolved strings. The active-vs-plain link PAIR (and aria-current
 * set-vs-omitted) is a component, not a spec construct: every tab's `href`,
 * `label` and `active` boolean travel as data. The widget registry renders the
 * header, so there is one implementation of it.
 *
 * The overview body is a client component (pack install and the assignment
 * Selects are fetch flows plus useState a spec cannot name), so it renders
 * through a WHOLE-COMPONENT slot: the loader resolves every prop the native
 * page passes `TaxDepreciationSetup` to presentation-ready data, and the
 * slot spreads that one object onto the same component. No org id, no Authz,
 * no actions travel through the spec — the props are data, not capabilities.
 * Country names stay client-side (`countryOptions(locale)` + `localeCompare`
 * sorting inside the component), so the loader passes raw country codes.
 */

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
  descriptionClassName,
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
    <>
      <header><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1><p className={descriptionClassName}>{description}</p></header>
      <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800" aria-label={tabsAria}>
        {tabs.map((item) => <Link key={item.key} href={item.href as never}
          aria-current={item.active ? 'page' : undefined}
          className={cn('-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium', item.active ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400')}>
          {item.label}
        </Link>)}
      </nav>
    </>
  )
}

export function TaxDepreciationOverviewSlot({ overview }: { overview: TaxDepreciationOverview }) {
  return <TaxDepreciationSetup {...overview} />
}
