import { requirePermission } from '../../../../lib/authz'
import { db } from '@openbooks/engine/src/db.ts'
import { sql } from 'drizzle-orm'
import { ImportWizard } from './ImportWizard'

export default async function DataImportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user } = await requirePermission('data.import')
  const sp = await searchParams
  const resource = typeof sp.resource === 'string' ? sp.resource : ''
  const templateId = typeof sp.template === 'string' ? sp.template : ''
  let payrollTemplate: Record<string, string> | undefined
  if (templateId) {
    const row = (await db.execute(sql`
      select external_line_id_column, employee_code_column, component_column, amount_column,
             pay_code_column, hours_column, memo_column
        from external_payroll_import_templates
       where id = ${templateId} and org_id = ${user.orgId} and is_active`)) as any
    const t = row.rows[0]
    if (t) payrollTemplate = {
      externalLineId: t.external_line_id_column,
      employeePartyId: t.employee_code_column,
      component: t.component_column,
      amount: t.amount_column,
      ...(t.pay_code_column ? { payCode: t.pay_code_column } : {}),
      ...(t.hours_column ? { hours: t.hours_column } : {}),
      ...(t.memo_column ? { memo: t.memo_column } : {}),
    }
  }
  return <ImportWizard initialResource={resource} payrollTemplate={payrollTemplate} />
}
