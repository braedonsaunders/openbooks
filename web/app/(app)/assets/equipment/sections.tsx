import Link from 'next/link'

/**
 * Equipment adapters retained for stored PageSpecs.
 *
 * New built-in layouts use ModuleHomeTabs for the Fixed Assets / Tax
 * Depreciation / Equipment switch. The old link-row renderer remains
 * registered so tenant layouts saved before that conversion still render.
 */

/** Legacy stored-layout adapter; built-in pages use ModuleHomeTabs. */
export function EquipmentHeaderLinks({
  fixedAssetsLabel,
  taxDepreciationLabel,
  documentationLabel,
  showFixedAssetsLinks,
}: {
  fixedAssetsLabel: string
  taxDepreciationLabel: string
  documentationLabel: string
  showFixedAssetsLinks: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {showFixedAssetsLinks ? (
        <>
          <Link href="/assets" className="text-sm text-teal-700 hover:underline dark:text-teal-300">
            {fixedAssetsLabel}
          </Link>
          <Link
            href="/assets?tab=tax-depreciation"
            className="text-sm text-teal-700 hover:underline dark:text-teal-300"
          >
            {taxDepreciationLabel}
          </Link>
        </>
      ) : null}
      <Link href="/docs/item-rates" className="text-sm text-teal-700 hover:underline dark:text-teal-300">
        {documentationLabel}
      </Link>
    </div>
  )
}

