import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import {
  form941Worksheet, t4Slips, t4Summary, w2Slips,
} from '@openbooks/engine/src/payroll-yearend.ts'
import { ListPageLayout } from '../../../../components/page-layout'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { pickString } from '../../../../lib/list-params'
import { YearEndView } from './YearEndView'

export const dynamic = 'force-dynamic'

/**
 * Year-end cockpit: T4 slips + T4 Summary (Canada) and 941/W-2 worksheets
 * (US) for a tax year, straight off the committed-stub subledger so every
 * box reconciles to stub traces. Print-friendly by design.
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
  const [slips, summary, form941, w2] = await Promise.all([
    t4Slips(orgId, year),
    t4Summary(orgId, year),
    form941Worksheet(orgId, year),
    w2Slips(orgId, year),
  ])

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={`${t('title')} ${year}`}
          description={t('description')}
          back={{ href: '/payroll', label: t('back') }}
        />
      }
    >
      <YearEndView year={year} t4={slips} summary={summary} form941={form941} w2={w2} />
    </ListPageLayout>
  )
}
