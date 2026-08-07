import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import {
  form941Worksheet, roeCandidates, t4Slips, t4Summary, w2Slips,
} from '@openbooks/engine/src/payroll-yearend.ts'
import { ListPageLayout } from '../../../../components/page-layout'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import { ModuleHomeTabs } from '../../../../components/module-home/ui'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { pickString } from '../../../../lib/list-params'
import { YearEndView } from './YearEndView'

export const dynamic = 'force-dynamic'

/**
 * Year-end cockpit: T4 slips + T4 Summary (Canada), the ROE Web issue list,
 * and 941/W-2 worksheets (US) for a tax year, straight off the committed-stub
 * subledger so every box reconciles to stub traces. Print-friendly by design.
 */
export default async function PayrollYearEndPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('payroll.read')
  await requireFeatureEnabled(authz.user.orgId, 'payroll')
  const t = await getTranslations('payroll.yearEnd')
  const sp = await searchParams
  const currentYear = new Date().getUTCFullYear()
  const requested = Number(pickString(sp.year))
  const year = Number.isInteger(requested) && requested >= 2020 && requested <= 2100 ? requested : currentYear

  const orgId = authz.user.orgId
  const [slips, summary, form941, w2, roe] = await Promise.all([
    t4Slips(orgId, year),
    t4Summary(orgId, year),
    form941Worksheet(orgId, year),
    w2Slips(orgId, year),
    roeCandidates(orgId, year),
  ])

  const moduleTabs = await groupTabs('payroll', '/payroll/year-end')

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={`${t('title')} ${year}`}
          description={t('description')}
          actions={<ModuleHomeTabs tabs={moduleTabs} />}
        />
      }
    >
      <YearEndView year={year} t4={slips} summary={summary} form941={form941} w2={w2} roe={roe} />
    </ListPageLayout>
  )
}
