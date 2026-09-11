import Link from 'next/link'
import { cn } from '@openbooks/ui'

/**
 * Pieces of the assets screen that the page and the widget registry share.
 *
 * They live here rather than inside `page.tsx` for the reason SortTh taught:
 * two implementations of the same visual element drift, and a conformance
 * harness that compares one against the other would then be measuring the
 * drift instead of the conversion. One implementation, two callers.
 */

/** The register / tax-depreciation tab strip. */
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

/** The equipment-register link under the register header. */
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
