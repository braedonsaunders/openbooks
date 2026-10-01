import { ModuleHomeTabs } from '@/components/module-home/tabs'
import Link from 'next/link'

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
  return <ModuleHomeTabs tabs={tabs} />
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
