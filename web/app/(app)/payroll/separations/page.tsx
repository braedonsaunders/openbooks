import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { orgYearEndFilings } from '@openbooks/engine/src/payroll-yearend.ts'
import { ListPageLayout } from '../../../../components/page-layout'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import { ModuleHomeTabs } from '../../../../components/module-home/ui'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { pickString } from '../../../../lib/list-params'
import { SeparationsView } from './SeparationsView'

export const dynamic = 'force-dynamic'

/**
 * Separations cockpit — the home of SEPARATION filings (cadence
 * "separation" in the payroll filing registry): documents due per
 * interruption of earnings, within days of the employee event (the CA
 * pack's Record of Employment; a UK pack's P45 would attach the same way).
 * These are event documents, not year-end returns, which is why they are
 * not on /payroll/year-end.
 *
 * The page iterates the same registry declaration as year-end — every
 * employee with an interruption of earnings (the pack's declared
 * population), each row opening the shared slip drawer with the
 * form-faithful facsimile and the pack's reason-for-issue flow.
 */
export default async function PayrollSeparationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('payroll.read')
  await requireFeatureEnabled(authz.user.orgId, 'payroll')
  const t = await getTranslations('payroll.separations')
  const sp = await searchParams
  const currentYear = Number((await businessToday(authz.user.orgId)).slice(0, 4))
  const requested = Number(pickString(sp.year))
  const year = Number.isInteger(requested) && requested >= 2020 && requested <= 2100 ? requested : currentYear

  const filings = await orgYearEndFilings(authz.user.orgId, year)
  const sections = filings.filter(
    (filing) => filing.cadence === 'separation' && (filing.installed || filing.data.rows.length > 0),
  )

  const moduleTabs = await groupTabs('payroll', '/payroll/separations')

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('title')}
          description={t('description')}
          actions={<ModuleHomeTabs tabs={moduleTabs} />}
        />
      }
    >
      <SeparationsView year={year} currentYear={currentYear} sections={sections} />
    </ListPageLayout>
  )
}
