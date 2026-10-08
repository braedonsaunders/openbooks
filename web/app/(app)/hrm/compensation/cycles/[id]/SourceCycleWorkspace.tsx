import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { Badge, Button, EmptyState, PageHeader } from '@openbooks/ui'
import { ArrowLeft } from 'lucide-react'
import { CompensationError, sourceCompensationCycleEvidence, type CompCycleDTO } from '@openbooks/engine/hrm/compensation'
import { ListPageLayout } from '../../../../../../components/page-layout'
import { RegisteredListTable } from '../../../../../../components/registered-list-table'
import { FilterChips } from '../../../../../../components/filter-bar'
import { formatDecimal } from '../../../../../../lib/money-format'
import { pickString } from '../../../../../../lib/list-params'
import type { Authz } from '../../../../../../lib/authz'
import type { PayRateBasis } from '@openbooks/engine/projects/pay-rate-basis'

const SOURCE_BASIS_LABEL_KEYS: Record<PayRateBasis, string> = {
  hour: 'hourly',
  week: 'weekly',
  biweekly: 'biweekly',
  semimonth: 'semimonthly',
  month: 'monthly',
  year: 'annual',
}

/** Original employee review evidence is immutable and independent of native payroll actions. */
export async function SourceCycleWorkspace({ cycle, authz, searchParams }: {
  cycle: CompCycleDTO; authz: Authz; searchParams: Record<string, string | undefined>
}) {
  const t = await getTranslations('hrm.compensation.sourceCycle')
  const locale = await getLocale()
  let evidence
  let refusal: string | null = null
  try { evidence = await sourceCompensationCycleEvidence({ orgId: authz.user.orgId, actorId: authz.user.id, cycleId: cycle.id }) }
  catch (error) { if (error instanceof CompensationError && error.code === 'REFUSED') refusal = error.message; else throw error }
  const basePath = `/hrm/compensation/cycles/${cycle.id}`
  const divisions = [...new Set(evidence?.rows.map((row) => row.division).filter((value): value is string => Boolean(value)))].sort()
  const division = pickString(searchParams.division)
  const rows = evidence?.rows.filter((row) => !division || row.division === division) ?? []
  const amount = (value: string | null) => value === null ? '—' : formatDecimal(locale, value, { maximumFractionDigits: 4 })
  return <ListPageLayout contained className="gap-4" header={<PageHeader title={cycle.name} description={t('description')}
    actions={<Button variant="outline" asChild><Link href="/hrm/compensation?view=cycles"><ArrowLeft size={15} />{t('back')}</Link></Button>} />}>
    <div className="shrink-0 space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-3"><Badge variant="outline">{t('status')}</Badge>
        <span>{t('effectiveDate')}: {cycle.effectiveOn ?? t('unknownDate')}</span>
        {evidence?.recordedOn ? <span>{t('recordedDate')}: {evidence.recordedOn}</span> : null}
        {evidence ? <span>{evidence.currency} · {t(SOURCE_BASIS_LABEL_KEYS[evidence.basis])}</span> : null}
      </div>
      {evidence ? <p className="text-xs text-slate-500 break-words">{evidence.sourcePath.split('/').at(-1)} · {evidence.sheet} · SHA-256 {evidence.sha256}</p> : null}
    </div>
    <div className="min-h-0 flex-1 overflow-hidden">
      <RegisteredListTable source="hrm_compensation_source_lines" contained basePath={basePath} currentParams={searchParams}
        sort={pickString(searchParams.sort) ?? 'employee'} dir={pickString(searchParams.dir) === 'desc' ? 'desc' : 'asc'}
        resetPageKey={division ?? ''} rows={rows} rowKey={(row) => row.id}
        empty={<EmptyState title={refusal ?? t('empty')} />}
        toolbarAfter={<FilterChips label={t('division')} options={divisions.map((value) => ({ value, label: value }))}
          basePath={basePath} currentParams={searchParams} paramKey="division" />}
        columns={[
          { key: 'employee', sortKey: 'employee', sortValue: (row) => row.employeeName, header: t('employee'), search: (row) => `${row.employeeName} ${row.employeeKey}`, cell: (row) => row.employeeName },
          { key: 'sourceKey', sortKey: 'sourceKey', sortValue: (row) => row.employeeKey, header: t('sourceKey'), search: (row) => row.employeeKey, cell: (row) => row.employeeKey },
          { key: 'division', sortKey: 'division', sortValue: (row) => row.division, header: t('division'), search: (row) => row.division ?? '', cell: (row) => row.division ?? '—' },
          { key: 'role', sortKey: 'role', sortValue: (row) => row.jobTitle, header: t('role'), search: (row) => row.jobTitle ?? '', cell: (row) => row.jobTitle ?? '—' },
          { key: 'current', sortKey: 'current', sortValue: (row) => row.currentRate, sortType: 'decimal', header: t('current'), align: 'right', cell: (row) => amount(row.currentRate) },
          { key: 'proposed', sortKey: 'proposed', sortValue: (row) => row.proposedRate, sortType: 'decimal', header: t('proposed'), align: 'right', cell: (row) => amount(row.proposedRate) },
          { key: 'notes', header: t('notes'), search: (row) => row.notes ?? '', cell: (row) => <span className="whitespace-normal">{row.notes ?? '—'}</span> },
        ]} />
    </div>
  </ListPageLayout>
}
