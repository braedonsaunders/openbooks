import Link from 'next/link'
import { Badge, EmptyState } from '@openbooks/ui'
import { RegisteredListTable } from '../../../../components/registered-list-table'
import type { CompHomeData } from '../../../../lib/hrm/compensation'

const recordLink = 'font-medium text-teal-700 hover:underline dark:text-teal-300'

export function CompensationCycleRegister({ data }: { data: CompHomeData }) {
  return <RegisteredListTable source="hrm_compensation_cycles" contained
    rows={data.cycles} rowKey={(row) => row.id}
    empty={<EmptyState title={data.cyclesEmpty} />}
    columns={[
      { key: 'name', header: data.cyclesColumns.name, search: (row) => row.name,
        cell: (row) => <Link className={recordLink} href={row.href as never}>{row.name}</Link> },
      { key: 'kind', header: data.kindLabel, search: (row) => row.kindLabel, cell: (row) => row.kindLabel },
      { key: 'status', header: data.cyclesColumns.status, search: (row) => row.statusLabel,
        cell: (row) => <Badge variant={row.statusVariant}>{row.statusLabel}</Badge> },
      { key: 'effective', header: data.cyclesColumns.effective, search: (row) => row.effectiveOn, cell: (row) => row.effectiveOn },
    ]} />
}

export function CompensationPlanRegister({ data }: { data: CompHomeData }) {
  return <RegisteredListTable source="hrm_compensation_plans" contained
    rows={data.plans} rowKey={(row) => row.id}
    empty={<EmptyState title={data.plansEmpty} />}
    columns={[
      { key: 'name', header: data.plansColumns.name, search: (row) => row.name,
        cell: (row) => <Link className={recordLink} href={row.href as never}>{row.name}</Link> },
      { key: 'period', header: data.periodLabel, search: (row) => row.period, cell: (row) => row.period },
      { key: 'status', header: data.plansColumns.status, search: (row) => row.statusLabel,
        cell: (row) => <Badge variant={row.statusVariant}>{row.statusLabel}</Badge> },
      { key: 'cost', header: data.plansColumns.cost, align: 'right', className: 'tabular-nums', cell: (row) => row.totalCost },
    ]} />
}
