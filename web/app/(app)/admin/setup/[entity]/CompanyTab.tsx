import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { DEFAULT_LOCALE, isLocale } from '../../../../../i18n/config'
import { SettingsForm, type AccountOption } from '../../settings/SettingsForm'

/**
 * Company & Accounting settings, rendered as the Setup "Company" tab. This is
 * the former /admin/settings page (which now redirects here). Loads the org's
 * current values and the postable accounts for the control-account pickers,
 * then hands them to the existing client form (which PUTs to /api/admin/settings).
 */
export async function CompanyTab({ orgId }: { orgId: string }) {
  const t = await getTranslations('admin.setup')

  const [org, accounts, currencies] = (await Promise.all([
    db.execute(sql`
      select name, legal_name, base_currency, country, settings
        from orgs where id = ${orgId}`),
    db.execute(sql`
      select id, number, name, type from accounts
       where org_id = ${orgId} and not is_summary and is_active
       order by number nulls last, name`),
    db.execute(sql`select code, name from currencies order by code`),
  ])) as any[]

  const row = org.rows[0]
  const settings = (row?.settings ?? {}) as Record<string, unknown>
  const control = (settings.controlAccounts ?? {}) as Record<string, string>

  const accountOptions: AccountOption[] = accounts.rows.map((a: any) => ({
    id: a.id as string,
    label: `${a.number ? `${a.number} · ` : ''}${a.name}`,
    type: a.type as string,
  }))

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          {t('entities.company.title')}
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('entities.company.description')}</p>
      </div>
      <SettingsForm
        initial={{
          name: (row?.name as string) ?? '',
          legalName: (row?.legal_name as string | null) ?? '',
          country: (row?.country as string) ?? '',
          baseCurrency: (row?.base_currency as string) ?? '',
          fiscalYearStartMonth:
            typeof settings.fiscalYearStartMonth === 'number' ? settings.fiscalYearStartMonth : 1,
          defaultLocale: isLocale(settings.defaultLocale) ? settings.defaultLocale : DEFAULT_LOCALE,
          reportPdfStyle: settings.reportPdfStyle === 'formal' ? 'formal' : 'modern',
          fairValueRangePolicy:
            (settings.revenue as Record<string, unknown> | undefined)?.fairValueRangePolicy === 'off'
              ? 'off'
              : 'warn',
          controlAccounts: {
            ar: control.ar ?? '',
            ap: control.ap ?? '',
            bank: control.bank ?? '',
            taxCollected: control.taxCollected ?? '',
            taxPaid: control.taxPaid ?? '',
            employeePayable: control.employeePayable ?? '',
            fxUnrealizedGainLoss: control.fxUnrealizedGainLoss ?? '',
          },
        }}
        accounts={accountOptions}
        currencies={currencies.rows as { code: string; name: string }[]}
      />
    </div>
  )
}
