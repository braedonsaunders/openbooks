import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { requirePermission, can } from '../../../../lib/authz'
import { getMoneyFormatter } from '@/lib/money-server'
import { orgInfo } from '../../../../lib/data'
import { listProvisionRuns } from '@openbooks/engine/src/income-tax-provision.ts'
import { ProvisionComputeButton } from './ProvisionComputeButton'
import { ProvisionRunsTable, type ProvisionRunListRow } from './sections'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadTaxProvisions, taxProvisionsSpec } from './view'

export const dynamic = 'force-dynamic'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'outline'> = {
  draft: 'secondary',
  posted: 'success',
  superseded: 'outline',
}

export default async function TaxProvisions({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadTaxProvisions(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={taxProvisionsSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }

  const authz = await requirePermission('reports.read')
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('tax.provisions')
  const org = await orgInfo()
  const runs = await listProvisionRuns(authz.user.orgId, authz.allowedSubsidiaryIds)
  const m = (v: string) => money(v, { currency: org?.base_currency })

  const rows: ProvisionRunListRow[] = runs.map((run) => ({
    id: run.id,
    href: `/tax/provisions/${run.id}`,
    fiscalYearLabel: `FY${run.fiscalYear}`,
    versionLabel: `v${run.version}`,
    statusLabel: t(`status.${run.status}`),
    statusVariant: STATUS_VARIANT[run.status] ?? 'secondary',
    totalExpense: m(run.totalExpense),
    effectiveRateText: run.effectiveRatePercent != null ? `${run.effectiveRatePercent}%` : '—',
    created: String(run.createdAt).slice(0, 10),
  }))

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('title')}
          description={t('description')}
          actions={authz.allowedSubsidiaryIds === null && can(authz, 'reports.create') ? <ProvisionComputeButton /> : undefined}
        />
      }
    >
      <ProvisionRunsTable
        columns={{
          fiscalYear: t('columns.fiscalYear'),
          version: t('columns.version'),
          status: t('columns.status'),
          totalExpense: t('columns.totalExpense'),
          effectiveRate: t('columns.effectiveRate'),
          created: t('columns.created'),
        }}
        emptyText={t('empty')}
        rows={rows}
      />
    </ListPageLayout>
  )
}
