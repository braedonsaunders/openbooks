import Link from 'next/link'
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
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
    <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 bg-white dark:bg-slate-900">{labels.vendor}</TableHead>
            <TableHead>{labels.class}</TableHead>
            <TableHead>{labels.status}</TableHead>
            {columns.map((policy) => (
              <TableHead key={policy.id} className="whitespace-nowrap text-center">
                {policy.code}
              </TableHead>
            ))}
            <TableHead className="text-right">{labels.exposure}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.partyId}>
              <TableCell className="sticky left-0 bg-white font-medium dark:bg-slate-900">
                <Link
                  href={`/compliance/vendors?${new URLSearchParams({
                    ...(classId ? { class: classId } : {}),
                    ...(stateFilter ? { state: stateFilter } : {}),
                    vendor: row.partyId,
                  })}`}
                  className="hover:underline"
                >
                  {row.vendorName}
                </Link>
              </TableCell>
              <TableCell className="text-slate-500 dark:text-slate-400">{row.className}</TableCell>
              <TableCell>
                <Badge variant={stateTone(row.overall)}>{labels.states[row.overall] ?? row.overall}</Badge>
              </TableCell>
              {columns.map((policy) => {
                const finding = row.findings.find((f) => f.requirementId === policy.id)
                if (!finding) {
                  return (
                    <TableCell key={policy.id} className="text-center text-slate-300 dark:text-slate-600">
                      —
                    </TableCell>
                  )
                }
                return (
                  <TableCell key={policy.id} className="text-center">
                    <span
                      title={`${labels.states[finding.state] ?? finding.state}${
                        finding.expiresOn ? ` · ${finding.expiresOn}` : ''
                      }${finding.reasons.length ? ` · ${finding.reasons.map((r) => labels.reasons[r] ?? r).join(', ')}` : ''}`}
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
                  </TableCell>
                )
              })}
              <TableCell className="text-right tabular-nums">
                {decimalCmp(row.openBalance, '0') > 0 ? (
                  <span className={row.blocksPayment ? 'font-semibold text-red-600 dark:text-red-400' : ''}>
                    {labels.money[row.partyId] ?? ''}
                  </span>
                ) : (
                  <span className="text-slate-300 dark:text-slate-600">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
