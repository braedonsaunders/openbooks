import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { RecordListView } from '../../../../components/record-list-view'
import { buildListDrawerHref, isUuid, pickString } from '../../../../lib/list-params'
import { can, requirePermission } from '../../../../lib/authz'
import { ExpenseActions } from '../ExpenseActions'
import { ExpenseDrawer } from '../ExpenseDrawer'
import { NewExpenseButton } from '../NewExpenseButton'
import { loadExpenseReport } from '../../../../lib/expenses'
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { customSegmentOptions } from '../../../../lib/segments'
import { resolveFormLayout } from '../../../../lib/customization/resolve'
import { taxCodeOptions, taxGroupOptions } from '../../../../lib/documents'

export const dynamic = 'force-dynamic'

/** Expense reports use the universal documents list; this route owns the
 * create action and the expense-specific editor payload only. */
export default async function Expenses({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('expenses')
  const authz = await requirePermission('expenses.read')
  const canSubmit = can(authz, 'expenses.create')
  const canPost = can(authz, 'ap.post')
  const sp = await searchParams
  const expenseId = pickString(sp.expense)
  const button = canSubmit ? <NewExpenseButton /> : undefined

  let drawer: React.ReactNode = null
  if (expenseId && isUuid(expenseId)) {
    const [openReport, pickers] = await Promise.all([
      loadExpenseReport(expenseId, authz.user.orgId),
      Promise.all([
        db.execute(sql`
          select p.id, p.display_name from parties p
           where p.is_active and p.org_id = ${authz.user.orgId}
             and exists (select 1 from employee_roles er where er.party_id = p.id and er.is_active)
           order by p.display_name limit 2000`) as any,
        db.execute(sql`select id, number, name from accounts where type in ('expense','expense_other','cogs') and is_active and not is_summary and org_id = ${authz.user.orgId} order by number nulls last`) as any,
        taxCodeOptions(authz.user.orgId),
        taxGroupOptions(authz.user.orgId),
        db.execute(sql`select id, name from departments where is_active and org_id = ${authz.user.orgId} order by name`) as any,
        db.execute(sql`select id, name from projects where is_active and org_id = ${authz.user.orgId} order by name limit 2000`) as any,
        loadFieldDefs('documents', 'expense_report'),
        loadFieldDefs('document_lines', 'expense_report'),
        customSegmentOptions(authz.user.orgId),
      ]),
    ])
    if (openReport) {
      const resolvedForm = await resolveFormLayout({
        orgId: authz.user.orgId,
        userId: authz.user.id,
        recordType: 'expense_report',
        userRoles: authz.user.roles.map(({ key }) => key),
        headerDefs: pickers[6] as any,
        lineDefs: pickers[7] as any,
        explicitLayoutId: pickString(sp.form),
      })
      drawer = (
        <ExpenseDrawer
          report={openReport as any}
          initialMode={pickString(sp.mode) === 'edit' ? 'edit' : 'view'}
          employees={pickers[0].rows}
          accounts={pickers[1].rows}
          taxCodes={pickers[2] as any}
          taxGroups={pickers[3] as any}
          departments={pickers[4].rows}
          projects={pickers[5].rows}
          headerDefs={pickers[6] as any}
          lineDefs={pickers[7] as any}
          segments={pickers[8] as any}
          canSubmit={canSubmit}
          canPost={canPost}
          layout={resolvedForm.layout}
          closeHref="/expenses/reports"
        />
      )
    }
  }

  return (
    <ListPageLayout
      header={<PageHeader title={t('list.title')} description={t('list.description')} actions={button} />}
    >
      <RecordListView
        recordType="expense_report"
        basePath="/expenses/reports"
        orgId={authz.user.orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        drawer={drawer}
        emptyAction={button}
        renderRowActions={(row) => (
          <ExpenseActions
            id={row.id}
            status={row.status}
            canSubmit={canSubmit}
            canPost={canPost}
            openHref={buildListDrawerHref('/expenses/reports', sp, 'expense', String(row.id))}
          />
        )}
      />
    </ListPageLayout>
  )
}
