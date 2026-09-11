import Link from 'next/link'
import { KpiStrip, type Kpi } from '../../../../components/kpi-strip'

/**
 * Pieces of the equipment register that the page and the widget registry share.
 *
 * They live here rather than inside `page.tsx` for the reason SortTh taught:
 * two implementations of the same visual element drift, and a conformance
 * harness that compares one against the other would then be measuring the
 * drift instead of the conversion. One implementation, two callers.
 *
 * The header link row is one composite the grid vocabulary cannot name: three
 * next/link anchors in a flex-wrap row, the first two present only while the
 * Fixed Assets feature is on. The KPI strip is KpiStrip markup, not
 * stat-tile — values arrive already formatted from the loader.
 */

/** The fixed-assets / tax-depreciation / documentation link row under the header. */
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

/** The four loader-formatted summary tiles above the list. */
export function EquipmentKpiStrip({ items }: { items: Kpi[] }) {
  return <KpiStrip items={items} />
}
