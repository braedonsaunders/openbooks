import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { supportedTaxCountries } from '@openbooks/engine/src/tax-pack-provisioning.ts'
import { requirePermission } from '../../../../../lib/authz'
import { TaxSetupGuide } from './TaxSetupGuide'

export const dynamic = 'force-dynamic'

/**
 * Tax Setup — the top-level guided workspace for standing up indirect-tax
 * compliance, promoted out of the buried Tax Returns library drawer to sit
 * beside Overhead Model and Labor Costing. Install a country pack and it creates
 * that jurisdiction, its return form and boxes; the guide then walks the user
 * on to declaring nexus (where they're registered) and reviewing tax codes.
 */
export default async function TaxSetupPage() {
  const authz = await requirePermission('admin.setup.manage')
  const t = await getTranslations('admin.setup.taxSetup')
  const orgId = authz.user.orgId

  const [installed, jurisdictions, registrations] = await Promise.all([
    db.execute(sql`select distinct code from tax_return_forms where org_id = ${orgId} and is_active`) as unknown as Promise<{ rows: { code: string }[] }>,
    db.execute(sql`select count(*)::int as n from tax_jurisdictions where org_id = ${orgId} and is_active`) as unknown as Promise<{ rows: { n: number }[] }>,
    db.execute(sql`select count(*)::int as n from tax_registrations where org_id = ${orgId} and is_active`) as unknown as Promise<{ rows: { n: number }[] }>,
  ])

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-1">
      <header>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">{t('subtitle')}</p>
      </header>
      <TaxSetupGuide
        countries={supportedTaxCountries()}
        installedCodes={installed.rows.map((r) => r.code)}
        jurisdictionCount={jurisdictions.rows[0]?.n ?? 0}
        registrationCount={registrations.rows[0]?.n ?? 0}
      />
    </div>
  )
}
