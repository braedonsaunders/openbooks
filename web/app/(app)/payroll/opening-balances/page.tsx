import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { openingBalancesForYear, OPENING_BALANCE_FIELDS } from '@openbooks/engine/src/payroll-opening-balances.ts'
import { entitlementOpenings } from '@openbooks/engine/src/payroll-entitlements.ts'
import { ListPageLayout } from '../../../../components/page-layout'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import { ModuleHomeTabs } from '../../../../components/module-home/ui'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { pickString } from '../../../../lib/list-params'
import { EntitlementOpeningsView } from './EntitlementOpeningsView'
import { OpeningBalancesView } from './OpeningBalancesView'

export const dynamic = 'force-dynamic'

/**
 * Mid-year adoption: the statutory year-to-date each employee brings in from
 * the employer's previous payroll system.
 *
 * This lives in the PAYROLL module rather than on the /admin/setup rail on
 * purpose. It is not org configuration — it is per-employee compensation data
 * with its own lifecycle (immutable once a run commits for that employee and
 * year), gated on payroll's own permissions, and loaded as a whole workforce
 * at adoption. The Setup registry expresses none of those three things: its
 * generic API is gated on `admin.setup.manage`, its drawer edits one record at
 * a time, and it has no per-row immutability hook. See
 * .local/handoff-openings.md.
 */
export default async function PayrollOpeningBalancesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('payroll.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')

  const t = await getTranslations('payroll')
  const sp = await searchParams
  const currentYear = Number((await businessToday(orgId)).slice(0, 4))
  const requested = Number(pickString(sp.year))
  const year = Number.isInteger(requested) && requested >= 2000 && requested <= 2100
    ? requested
    : currentYear

  const data = await openingBalancesForYear(orgId, year)
  // Bank carry-ins are NOT year-scoped (a bank has one lifetime balance), so
  // this load deliberately ignores `year`. See EntitlementOpeningsView.
  const banks = await entitlementOpenings(orgId)
  const tabs = await groupTabs('payroll', '/payroll/opening-balances', { orgId })
  const text = (key: string, fallback: string) =>
    t.has(key as never) ? t(key as never) : fallback

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={text('openingBalances.title', 'Opening balances')}
          description={text(
            'openingBalances.description',
            'Everything each employee carries in from your previous payroll system: statutory year-to-date, the annual caps they have partly used, and their vacation and banked-time balances. Nothing else supplies these, so every ceiling and every bank restarts at zero without them.',
          )}
          actions={<ModuleHomeTabs tabs={tabs} />}
        />
      }
    >
      <div className="space-y-8">
        <OpeningBalancesView
          year={year}
          currentYear={currentYear}
          initial={data}
          fields={OPENING_BALANCE_FIELDS.map((field) => ({
            key: field.key, label: field.label, help: field.help, packs: [...field.packs],
          }))}
          components={data.components}
          canManage={can(authz, 'payroll.manage')}
        />
        <EntitlementOpeningsView initial={banks} canManage={can(authz, 'payroll.manage')} />
      </div>
    </ListPageLayout>
  )
}
