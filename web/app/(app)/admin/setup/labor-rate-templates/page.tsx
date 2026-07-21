import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { requirePermission } from '../../../../../lib/authz'
import { LABOR_RATE_TEMPLATES } from '../../../../../lib/labor-rate-templates'
import { LaborRateTemplateLibrary } from './LaborRateTemplateLibrary'

export const dynamic = 'force-dynamic'

export default async function LaborRateTemplatesPage() {
  const { user } = await requirePermission('admin.setup.manage')
  const t = await getTranslations('admin.setup')
  const [org, currencies] = await Promise.all([
    db.execute(sql`select base_currency from orgs where id = ${user.orgId}`) as any,
    db.execute(sql`select code, name from currencies where is_active order by code`) as any,
  ])
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('templates.title')}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t('templates.description')}{' '}
          <Link href="/docs/labor-rates" className="font-medium text-teal-700 hover:underline dark:text-teal-300">
            {t('learnMore')}
          </Link>
        </p>
      </div>
      <LaborRateTemplateLibrary
        templates={LABOR_RATE_TEMPLATES}
        currencies={currencies.rows}
        defaultCurrency={String(org.rows[0]?.base_currency ?? 'CAD')}
      />
    </div>
  )
}
