import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { payrollSettings } from '@openbooks/engine/src/payroll-run.ts'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { PayrollSetupWorkspace } from './PayrollSetupWorkspace'

export const dynamic = 'force-dynamic'

/**
 * Payroll setup — the control accounts the commit projection posts to, the
 * wages destination (expense vs. labor clearing), the CRA remittance vendor,
 * and the statutory component seeder. Schedules and components have their own
 * registry-driven tabs; this page owns only orgs.settings.payroll.
 */
export default async function PayrollSetupPage() {
  const authz = await requirePermission('payroll.manage')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')
  const t = await getTranslations('payroll.settingsPage')

  const [settings, accountsRes, vendorsRes, componentsRes] = (await Promise.all([
    payrollSettings(orgId),
    db.execute(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and not is_summary and is_active
       order by number nulls last, name`),
    db.execute(sql`
      select p.id, p.display_name as name from parties p
       join vendor_roles v on v.party_id = p.id and v.org_id = p.org_id and v.is_active
       where p.org_id = ${orgId} and p.is_active order by p.display_name`),
    db.execute(sql`
      select count(*)::int as n from pay_components
       where org_id = ${orgId} and system_key is not null`),
  ])) as unknown as [
    Awaited<ReturnType<typeof payrollSettings>>,
    { rows: { id: string; number: string | null; name: string }[] },
    { rows: { id: string; name: string }[] },
    { rows: { n: number }[] },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h2>
          <p className="max-w-4xl text-sm text-slate-500 dark:text-slate-400">{t('description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/admin/setup/pay-schedules" className="px-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">
            {t('schedulesLink')} →
          </Link>
          <Link href="/admin/setup/pay-components" className="px-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">
            {t('componentsLink')} →
          </Link>
        </div>
      </div>
      <PayrollSetupWorkspace
        settings={settings}
        accounts={accountsRes.rows.map((account) => ({
          id: account.id,
          label: account.number ? `${account.number} · ${account.name}` : account.name,
        }))}
        vendors={vendorsRes.rows.map((vendor) => ({ id: vendor.id, label: vendor.name }))}
        systemComponentCount={Number(componentsRes.rows[0]?.n ?? 0)}
      />
    </div>
  )
}
