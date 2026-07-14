import Link from 'next/link'
import { PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { dimensionOptions, trialBalance } from '../../../../lib/reports'
import { money } from '../../../../lib/format'
import { DimensionFilter } from '../DimensionFilter'
import { SaveViewButton } from '../SaveViewButton'

export const dynamic = 'force-dynamic'

export default async function TrialBalance({
  searchParams,
}: {
  searchParams: Promise<{ asof?: string; dept?: string; project?: string }>
}) {
  const sp = await searchParams
  const date = sp.asof ?? new Date().toISOString().slice(0, 10)
  const dims = { departmentId: sp.dept || undefined, projectId: sp.project || undefined }
  const [rows, opts] = await Promise.all([trialBalance(date, dims), dimensionOptions()])
  const totalDebits = rows.reduce((a, r) => a + Number(r.debits), 0)
  const totalCredits = rows.reduce((a, r) => a + Number(r.credits), 0)

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Trial Balance"
            description={`as of ${date} · ${rows.length} accounts with activity`}
            back={{ href: '/reports', label: 'Reports' }}
            actions={<SaveViewButton />}
          />
          <DimensionFilter departments={opts.departments} projects={opts.projects} />
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead className="text-right">Debits</TableHead>
            <TableHead className="text-right">Credits</TableHead>
            <TableHead className="text-right">Balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <Link href={`/accounts/${r.id}`} className="hover:text-teal-700 dark:hover:text-teal-300">
                  <span className="mr-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">{r.number}</span>
                  {r.name}
                </Link>
              </TableCell>
              <TableCell className="text-right tabular-nums">{money(r.debits)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(r.credits)}</TableCell>
              <TableCell className={cn('text-right tabular-nums', Number(r.balance) < 0 && 'text-red-600 dark:text-red-400')}>
                {money(r.balance)}
              </TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell className="font-bold">Totals</TableCell>
            <TableCell className="text-right font-bold tabular-nums">{money(totalDebits)}</TableCell>
            <TableCell className="text-right font-bold tabular-nums">{money(totalCredits)}</TableCell>
            <TableCell
              className={cn(
                'text-right font-bold tabular-nums',
                Math.abs(totalDebits - totalCredits) >= 0.01 && 'text-red-600 dark:text-red-400',
              )}
            >
              {money(totalDebits - totalCredits)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </ListPageLayout>
  )
}
