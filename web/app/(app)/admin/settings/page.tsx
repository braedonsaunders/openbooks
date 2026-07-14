import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { PageContainer } from '../../../../components/page-layout'
import { requirePermission } from '../../../../lib/authz'
import { SettingsForm, type AccountOption } from './SettingsForm'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Company & Accounting' }

/**
 * Company & Accounting settings. The single admin.users.manage gate matches the
 * settings API. Loads the org's current values, the postable (non-summary)
 * accounts for the control-account pickers, the known currencies, and the
 * document-number sequences, then hands them to the client form.
 */
export default async function CompanySettingsPage() {
  const authz = await requirePermission('admin.users.manage')
  const { orgId } = authz.user

  const [org, accounts, currencies, sequences] = (await Promise.all([
    db.execute(sql`
      select name, legal_name, base_currency, country, settings
        from orgs where id = ${orgId}`),
    db.execute(sql`
      select id, number, name, type from accounts
       where org_id = ${orgId} and not is_summary and is_active
       order by number nulls last, name`),
    db.execute(sql`select code, name from currencies order by code`),
    db.execute(sql`
      select document_kind, prefix, next_number, padding, gapless
        from number_sequences where org_id = ${orgId} order by document_kind`),
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
    <PageContainer>
      <PageHeader
        title="Company & Accounting"
        description="Organization identity, base currency, fiscal calendar and the control accounts the ledger posts through."
        back={{ href: '/admin', label: 'Administration' }}
      />
      <div className="mt-6">
        <SettingsForm
          initial={{
            name: (row?.name as string) ?? '',
            legalName: (row?.legal_name as string | null) ?? '',
            country: (row?.country as string) ?? '',
            baseCurrency: (row?.base_currency as string) ?? '',
            fiscalYearStartMonth:
              typeof settings.fiscalYearStartMonth === 'number' ? settings.fiscalYearStartMonth : 1,
            controlAccounts: {
              ar: control.ar ?? '',
              ap: control.ap ?? '',
              bank: control.bank ?? '',
              taxCollected: control.taxCollected ?? '',
              taxPaid: control.taxPaid ?? '',
              employeePayable: control.employeePayable ?? '',
            },
          }}
          accounts={accountOptions}
          currencies={currencies.rows as { code: string; name: string }[]}
          numberSequences={
            sequences.rows as {
              document_kind: string
              prefix: string
              next_number: number
              padding: number
              gapless: boolean
            }[]
          }
        />
      </div>
    </PageContainer>
  )
}
