import 'server-only'

import Link from 'next/link'
import { cn } from '@openbooks/ui'

/**
 * Shared chrome for the book-depreciation setup workspace.
 *
 * The page owns its tab strip (underline links with `aria-current`, not the
 * `module-home-tabs` pill strip), so the whole header — h1, description and
 * nav — is one shared component over loader-resolved strings. The
 * active-vs-plain link PAIR (and aria-current set-vs-omitted) is a
 * component, not a spec construct: every tab's `href`, `label` and `active`
 * boolean travel as data. The widget registry renders the header, so there is
 * one implementation of it — the tax-depreciation precedent.
 *
 * Class strings transcribed from the native page verbatim. Note the nav
 * here has NO `overflow-x-auto` and NO `shrink-0` on the links (the
 * tax-depreciation header has both) — two tabs fit, so the native page omits
 * them, and the conformance harness compares byte for byte.
 */

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
    <>
      <header><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p></header>
      <nav className="flex gap-1 border-b border-slate-200 dark:border-slate-800" aria-label={tabsAria}>
        {tabs.map((item) => <Link key={item.key} href={item.href as never}
          aria-current={item.active ? 'page' : undefined}
          className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium', item.active ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400')}>
          {item.label}
        </Link>)}
      </nav>
    </>
  )
}
