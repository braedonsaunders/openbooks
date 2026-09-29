import type { FormLayoutConfig } from '@openbooks/customization'

const EVERYDAY_RECORDS = new Set([
  'customer_invoice', 'vendor_bill', 'card_charge', 'check',
  'expense_report', 'customer_payment', 'vendor_payment',
])
const PRIMARY_FIELDS = new Set([
  'party_id', 'document_date', 'due_date', 'reference_number', 'memo',
  'bank_account_id', 'subsidiary_id', 'currency', 'currency_code', 'exchange_rate', 'project_id',
])
const SECONDARY_COLUMNS = new Set(['unit', 'department_id', 'location_id', 'class_id'])

/** Group optional fields without removing values, columns or financial controls. */
export function essentialsFormLayout(layout: FormLayoutConfig): FormLayoutConfig {
  if (!EVERYDAY_RECORDS.has(layout.recordType)) return layout
  const fields = layout.header.groups.flatMap((group) => group.fields)
  const payment = layout.recordType === 'customer_payment' || layout.recordType === 'vendor_payment'
  const primary = fields.filter((field) => field.required || (PRIMARY_FIELDS.has(field.key)
    && !(payment && (field.key === 'reference_number' || field.key === 'memo'))))
  const details = fields.filter((field) => !primary.includes(field))
  return {
    ...layout,
    header: { groups: [
      { id: 'primary', fields: primary },
      ...(details.length ? [{ id: 'details', collapsible: true, fields: details }] : []),
    ] },
    lines: { columns: layout.lines.columns.map((column) => ({
      ...column, ...(SECONDARY_COLUMNS.has(column.key) ? { secondary: true } : {}),
    })) },
  }
}
