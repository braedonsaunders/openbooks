import Link from 'next/link'
import { Badge, EmptyState } from '@openbooks/ui'
import { RegisteredListTable } from '../../../../components/registered-list-table'
import { getTranslations } from 'next-intl/server'
import { FilterChips } from '../../../../components/filter-bar'
import { pickString } from '../../../../lib/list-params'
import type { CompHomeData } from '../../../../lib/hrm/compensation'

const recordLink = 'font-medium text-teal-700 hover:underline dark:text-teal-300'

export async function CompensationCycleRegister({ data }: { data: CompHomeData }) {
  const t = await getTranslations('hrm.compensation')
  const options = ['draft', 'open', 'in_review', 'approved', 'pushed', 'closed', 'cancelled'].map((value) => ({ value, label: t(`cycleStatus.${value}`) }))
  const selected = pickString(data.currentParams.cycleStatus)
  const rows = options.some((option) => option.value === selected) ? data.cycles.filter((row) => row.status === selected) : data.cycles
  return <RegisteredListTable source="hrm_compensation_cycles" contained
    basePath="/hrm/compensation" currentParams={data.currentParams}
    sort={pickString(data.currentParams.cycleSort) ?? 'name'} dir={pickString(data.currentParams.cycleDir) === 'desc' ? 'desc' : 'asc'}
    sortParamKey="cycleSort" dirParamKey="cycleDir" pageParamKey="cyclePage"
    toolbarAfter={<FilterChips label={data.cyclesColumns.status} options={options} basePath="/hrm/compensation"
      currentParams={data.currentParams} paramKey="cycleStatus" pageParamKey="cyclePage" />}
    resetPageKey={selected ?? ''}
    rows={rows} rowKey={(row) => row.id}
    empty={<EmptyState title={data.cyclesEmpty} />}
    columns={[
      { key: 'name', sortKey: 'name', sortValue: (row) => row.name, header: data.cyclesColumns.name, search: (row) => row.name,
        cell: (row) => <Link className={recordLink} href={row.href as never}>{row.name}</Link> },
      { key: 'kind', sortKey: 'kind', sortValue: (row) => row.kindLabel, header: data.kindLabel, search: (row) => row.kindLabel, cell: (row) => row.kindLabel },
      { key: 'status', sortKey: 'status', sortValue: (row) => row.statusLabel, header: data.cyclesColumns.status, search: (row) => row.statusLabel,
        cell: (row) => <Badge variant={row.statusVariant}>{row.statusLabel}</Badge> },
      { key: 'effective', sortKey: 'effective', sortValue: (row) => row.effectiveOn, header: data.cyclesColumns.effective, search: (row) => row.effectiveOn, cell: (row) => row.effectiveOn },
    ]} />
}

export async function CompensationPlanRegister({ data }: { data: CompHomeData }) {
  const t = await getTranslations('hrm.compensation')
  const options = ['draft', 'submitted', 'approved', 'closed'].map((value) => ({ value, label: t(`planStatus.${value}`) }))
  const selected = pickString(data.currentParams.planStatus)
  const rows = options.some((option) => option.value === selected) ? data.plans.filter((row) => row.status === selected) : data.plans
  return <RegisteredListTable source="hrm_compensation_plans" contained
    basePath="/hrm/compensation" currentParams={data.currentParams}
    sort={pickString(data.currentParams.planSort) ?? 'name'} dir={pickString(data.currentParams.planDir) === 'desc' ? 'desc' : 'asc'}
    sortParamKey="planSort" dirParamKey="planDir" pageParamKey="planPage"
    toolbarAfter={<FilterChips label={data.plansColumns.status} options={options} basePath="/hrm/compensation"
      currentParams={data.currentParams} paramKey="planStatus" pageParamKey="planPage" />}
    resetPageKey={selected ?? ''}
    rows={rows} rowKey={(row) => row.id}
    empty={<EmptyState title={data.plansEmpty} />}
    columns={[
      { key: 'name', sortKey: 'name', sortValue: (row) => row.name, header: data.plansColumns.name, search: (row) => row.name,
        cell: (row) => <Link className={recordLink} href={row.href as never}>{row.name}</Link> },
      { key: 'period', sortKey: 'period', sortValue: (row) => row.period, header: data.periodLabel, search: (row) => row.period, cell: (row) => row.period },
      { key: 'status', sortKey: 'status', sortValue: (row) => row.statusLabel, header: data.plansColumns.status, search: (row) => row.statusLabel,
        cell: (row) => <Badge variant={row.statusVariant}>{row.statusLabel}</Badge> },
      { key: 'cost', sortKey: 'cost', sortValue: (row) => row.totalCost, sortType: 'decimal', header: data.plansColumns.cost, align: 'right', className: 'tabular-nums', cell: (row) => row.totalCost },
    ]} />
}
