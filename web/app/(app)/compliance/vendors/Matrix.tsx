import Link from 'next/link'
import { Badge } from '@openbooks/ui'
import { RegisteredListTable } from '../../../../components/registered-list-table'
import { stateTone, type ComplianceMatrix } from '../../../../lib/compliance'
import { decimalCmp } from '../../../../lib/statement-format'

/**
 * The subcontractor compliance matrix: one row per classified vendor, one cell
 * per policy that applies to it. The grid is the point — a per-vendor list makes
 * it impossible to see that nine subs all let the same certificate lapse.
 *
 * Every cell is the SAME evaluation the payment engine performs, so a green row
 * here is a promise the pay run will keep.
 *
 * A component rather than a `table` block because its COLUMNS come from data:
 * one per active policy. The table block deliberately models a fixed column
 * list over a row collection, and generating columns per request would make a
 * serialized spec describe only the render that produced it. Same call as the
 * statement matrix — a domain component stays whole and is placed by name.
 */
export function VendorComplianceMatrix({
  rows,
  columns,
  classId,
  stateFilter,
  labels,
}: {
  rows: ComplianceMatrix['rows']
  columns: ComplianceMatrix['policies']
  classId: string | null
  stateFilter: string | null
  /** Pre-resolved labels: the component takes strings, not a translator, so
   *  it stays free of request-scoped context. */
  labels: {
    vendor: string
    class: string
    status: string
    exposure: string
    states: Record<string, string>
    reasons: Record<string, string>
    money: Record<string, string>
  }
}) {
  return (
    <RegisteredListTable
      source="compliance_vendors"
      rows={rows}
      rowKey={(row) => row.partyId}
      empty=""
      columns={[
        {
          key: 'vendor',
          header: labels.vendor,
          className: 'sticky left-0 bg-white font-medium dark:bg-slate-900',
          headerClassName: 'sticky left-0 bg-white dark:bg-slate-900',
          search: (row) => row.vendorName,
          cell: (row) => (
            <Link
              href={`/compliance/vendors?${new URLSearchParams({ ...(classId ? { class: classId } : {}), ...(stateFilter ? { state: stateFilter } : {}), vendor: row.partyId })}`}
              className="hover:underline"
            >
              {row.vendorName}
            </Link>
          ),
        },
        {
          key: 'class',
          header: labels.class,
          search: (row) => row.className ?? '',
          cell: (row) => row.className,
          className: 'text-slate-500 dark:text-slate-400',
        },
        {
          key: 'status',
          header: labels.status,
          search: (row) => labels.states[row.overall] ?? row.overall,
          cell: (row) => (
            <Badge variant={stateTone(row.overall)}>
              {labels.states[row.overall] ?? row.overall}
            </Badge>
          ),
        },
        ...columns.map((policy) => ({
          key: `policy:${policy.id}`,
          header: policy.code,
          align: 'center' as const,
          headerClassName: 'whitespace-nowrap text-center',
          cell: (row: ComplianceMatrix['rows'][number]) => {
            const finding = row.findings.find(
              (f) => f.requirementId === policy.id,
            )
            if (!finding)
              return (
                <span className="text-slate-300 dark:text-slate-600">—</span>
              )
            return (
              <span
                title={`${labels.states[finding.state] ?? finding.state}${finding.expiresOn ? ` · ${finding.expiresOn}` : ''}${finding.reasons.length ? ` · ${finding.reasons.map((r) => labels.reasons[r] ?? r).join(', ')}` : ''}`}
              >
                <Badge variant={stateTone(finding.state)}>
                  {finding.state === 'compliant'
                    ? '✓'
                    : finding.state === 'expiring'
                      ? `${finding.daysToExpiry ?? 0}d`
                      : finding.state === 'waived'
                        ? '~'
                        : '!'}
                </Badge>
              </span>
            )
          },
        })),
        {
          key: 'exposure',
          header: labels.exposure,
          align: 'right',
          className: 'text-right tabular-nums',
          cell: (row) =>
            decimalCmp(row.openBalance, '0') > 0 ? (
              <span
                className={
                  row.blocksPayment
                    ? 'font-semibold text-red-600 dark:text-red-400'
                    : ''
                }
              >
                {labels.money[row.partyId] ?? ''}
              </span>
            ) : (
              <span className="text-slate-300 dark:text-slate-600">—</span>
            ),
        },
      ]}
    />
  )
}
