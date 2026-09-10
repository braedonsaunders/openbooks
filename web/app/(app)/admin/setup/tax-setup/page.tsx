import { BadgeCheck, MapPin } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { supportedTaxCountries } from '@openbooks/engine/src/tax-pack-provisioning.ts'
import { requirePermission } from '../../../../../lib/authz'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { StepLink, TaxSetupHeader } from './sections'
import { TaxSetupGuide } from './TaxSetupGuide'
import { loadTaxSetup, taxSetupSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Tax Setup — the top-level guided workspace for standing up indirect-tax
 * compliance, promoted out of the buried Tax Returns library drawer to sit
 * beside Overhead Model and Labor Costing. Install a country pack and it creates
 * that jurisdiction, its return form and boxes; the guide then walks the user
 * on to declaring nexus (where they're registered) and reviewing tax codes.
 */
export default async function TaxSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadTaxSetup(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={taxSetupSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('admin.setup.manage')
  const t = await getTranslations('admin.setup.taxSetup')
  const orgId = authz.user.orgId

  const [installed, installedJurisdictions, jurisdictions, registrations] = await Promise.all([
    db.execute<{ code: string }>(sql`select distinct code from tax_return_forms where org_id = ${orgId} and is_active`),
    db.execute<{ code: string }>(sql`
      select code from tax_jurisdictions
       where org_id = ${orgId} and is_active and level = 'state'
    `),
    db.execute<{ n: number }>(sql`select count(*)::int as n from tax_jurisdictions where org_id = ${orgId} and is_active`),
    db.execute<{ n: number }>(sql`select count(*)::int as n from tax_registrations where org_id = ${orgId} and is_active`),
  ])

  const jurisdictionCount = jurisdictions.rows[0]?.n ?? 0
  const registrationCount = registrations.rows[0]?.n ?? 0

  // The native branch renders the same step links the spec path passes via
  // the guide slot — one `StepLink` implementation in `./sections`.
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-1">
      <TaxSetupHeader title={t('title')} subtitle={t('subtitle')} />
      <TaxSetupGuide
        countries={supportedTaxCountries()}
        installedCodes={[
          ...installed.rows.map((r) => r.code),
          ...installedJurisdictions.rows.map((r) => `JURISDICTION:${r.code}`),
        ]}
        step2={
          <StepLink
            n={2}
            icon={<MapPin size={18} />}
            title={t('step2.title')}
            description={t('step2.description')}
            stat={t('step2.stat', { count: jurisdictionCount })}
            href="/admin/setup/tax-jurisdictions"
            cta={t('step2.cta')}
          />
        }
        step3={
          <StepLink
            n={3}
            icon={<BadgeCheck size={18} />}
            title={t('step3.title')}
            description={t('step3.description')}
            stat={t('step3.stat', { count: registrationCount })}
            href="/admin/setup/tax-registrations"
            cta={t('step3.cta')}
          />
        }
      />
    </div>
  )
}
