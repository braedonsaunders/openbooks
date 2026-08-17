import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { orgYearEndFilings } from '@openbooks/engine/src/payroll-yearend.ts'
import { ListPageLayout } from '../../../../components/page-layout'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import { ModuleHomeTabs } from '../../../../components/module-home/ui'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { pickString } from '../../../../lib/list-params'
import { YearEndView } from './YearEndView'

export const dynamic = 'force-dynamic'

/**
 * Year-end cockpit. The sections are NOT hardcoded forms: every payroll
 * country pack declares its year-end filings (label, population, electronic
 * file, slip render, issue workflow) in the payroll filing registry, and this
 * page iterates that declaration. A pack that registers a new slip — the
 * Quebec RL-1, a UK P60 — appears here with no change to this file. Each
 * population row opens in the house Drawer as a form-faithful facsimile via
 * the shared tax-form facsimile pathway, with its PDF one click away.
 *
 * A filing is shown when its pack is installed for the org, or when its
 * population has rows (imported history from a pack that was never formally
 * installed still surfaces — hiding real wage data would be worse than an
 * extra section).
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

  // Year-end shows ANNUAL and QUARTERLY returns only. Separation documents
  // (the ROE, a P45) are due per interruption of earnings — within days of
  // the employee event — and live on /payroll/separations, never here.
  const filings = await orgYearEndFilings(authz.user.orgId, year)
  const sections = filings.filter(
    (filing) => filing.cadence !== 'separation' && (filing.installed || filing.data.rows.length > 0),
  )

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
      <YearEndView year={year} sections={sections} />
    </ListPageLayout>
  )
}
