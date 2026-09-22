import Link from 'next/link'
import { cn } from '@openbooks/ui'

/**
 * Fixed-assets adapters retained for stored PageSpecs plus the live
 * documentation action used by the built-in page.
 *
 * New built-in layouts use ModuleHomeTabs for route switching. The old tab
 * and equipment-link renderers remain registered so a tenant layout saved
 * before that conversion still renders instead of falling through the spec
 * boundary.
 */

/** Legacy stored-layout adapter; built-in pages use ModuleHomeTabs. */
export function AssetsTabs({
  tabs,
}: {
  tabs: { key: string; href: string; label: string; active: boolean }[]
}) {
  return (
    <nav className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href as never}
          aria-current={tab.active ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            tab.active
              ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
              : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100',
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}

/** The documentation link in the register header actions. */
export function AssetsDocLink({ label }: { label: string }) {
  return (
    <Link
      href="/docs/fixed-assets-depreciation"
      className="text-sm text-teal-700 hover:underline dark:text-teal-300"
    >
      {label}
    </Link>
  )
}

/** Legacy stored-layout adapter; Equipment is now in ModuleHomeTabs. */
export function AssetsEquipmentLink({ label }: { label: string }) {
  return (
    <Link
      href="/assets/equipment"
      className="text-sm text-teal-700 hover:underline dark:text-teal-300"
    >
      {label}
    </Link>
  )
}
