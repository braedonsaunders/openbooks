import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/db'
import { loadCustomFieldAccessDefs, redactHiddenCustomValues, type CustomFieldViewer } from '../../../lib/custom-fields'

/**
 * Item payload for the catalog flyout: the item row plus resolved display names
 * for the linked income/expense accounts and tax code (handy for a readonly
 * view where the pickers aren't loaded).
 */
export interface ItemPayload {
  item: Record<string, unknown>
  incomeAccountName: string | null
  expenseAccountName: string | null
  payrollCostingAccountName: string | null
  taxCodeName: string | null
}

const UNATTRIBUTED_CUSTOM_FIELD_VIEWER: CustomFieldViewer = { roleKeys: [], canManageCustomFields: false }

/**
 * Item payload with the custom bag redacted for the reader. Omitted viewer keeps
 * only fields open to every role.
 */
export async function loadItem(
  id: string,
  orgId: string,
  options: { customFieldViewer?: CustomFieldViewer } = {},
): Promise<ItemPayload | null> {
  const payload = await loadItemRecord(id, orgId)
  if (!payload || !('custom' in payload.item)) return payload
  const defs = await loadCustomFieldAccessDefs('items')
  return {
    ...payload,
    item: {
      ...payload.item,
      custom: redactHiddenCustomValues(defs, options.customFieldViewer ?? UNATTRIBUTED_CUSTOM_FIELD_VIEWER, payload.item.custom as Record<string, unknown> | null),
    },
  }
}

async function loadItemRecord(id: string, orgId: string): Promise<ItemPayload | null> {
  const item = (await db.execute<Record<string, unknown>>(sql`
    select * from items where id = ${id} and org_id = ${orgId}
  `))
  if (!item.rows[0]) return null
  const row = item.rows[0]

  const [income, expense, payrollCosting, tax] = (await Promise.all([
    row.income_account_id
      ? db.execute<Record<string, unknown>>(sql`select number, name from accounts where id = ${row.income_account_id} and org_id = ${orgId}`)
      : Promise.resolve({ rows: [] }),
    row.expense_account_id
      ? db.execute<Record<string, unknown>>(sql`select number, name from accounts where id = ${row.expense_account_id} and org_id = ${orgId}`)
      : Promise.resolve({ rows: [] }),
    row.payroll_expense_account_id
      ? db.execute<Record<string, unknown>>(sql`select number, name from accounts where id = ${row.payroll_expense_account_id} and org_id = ${orgId}`)
      : Promise.resolve({ rows: [] }),
    row.tax_code_id
      ? db.execute<Record<string, unknown>>(sql`select code, name from tax_codes where id = ${row.tax_code_id} and org_id = ${orgId}`)
      : Promise.resolve({ rows: [] }),
  ]))

  const acctName = (r?: Record<string, unknown>) =>
    r ? `${(r.number as string) ?? ''} ${(r.name as string) ?? ''}`.trim() || null : null

  return {
    item: row,
    incomeAccountName: acctName(income.rows[0]),
    expenseAccountName: acctName(expense.rows[0]),
    payrollCostingAccountName: acctName(payrollCosting.rows[0]),
    taxCodeName: tax.rows[0]
      ? `${(tax.rows[0].code as string) ?? ''} ${(tax.rows[0].name as string) ?? ''}`.trim() || null
      : null,
  }
}
