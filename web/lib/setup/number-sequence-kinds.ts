import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { DOC_KIND_FEATURE } from '../document-kinds'
import { featureEnabled, orgFeatureState } from '../features'

export type NumberSequenceKindOption = { value: string; label: string }

/**
 * Built-in records that allocate from number_sequences. The stored token is
 * deliberately kept out of the UI; labels describe the record users know.
 */
const BUILT_IN_NUMBER_SEQUENCE_KINDS: NumberSequenceKindOption[] = [
  { value: 'customer_invoice', label: 'Customer invoice' },
  { value: 'customer_credit', label: 'Customer credit' },
  { value: 'sales_order', label: 'Sales order' },
  { value: 'quote', label: 'Quote' },
  { value: 'customer_payment', label: 'Customer payment' },
  { value: 'vendor_bill', label: 'Vendor bill' },
  { value: 'vendor_credit', label: 'Vendor credit' },
  { value: 'purchase_order', label: 'Purchase order' },
  { value: 'vendor_payment', label: 'Vendor payment' },
  { value: 'expense_report', label: 'Expense report' },
  { value: 'card_charge', label: 'Corporate card charge' },
  { value: 'card_refund', label: 'Corporate card refund' },
  { value: 'check', label: 'Check' },
  { value: 'deposit', label: 'Deposit' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'journal', label: 'Journal entry' },
  { value: 'field_ticket', label: 'Field ticket' },
  { value: 'project_charge', label: 'Project charge' },
  { value: 'payment_run', label: 'Payment run' },
  { value: 'pay_run', label: 'Pay run' },
  { value: 'payroll_cheque', label: 'Pay cheque' },
  { value: 'lien_waiver', label: 'Lien waiver' },
  { value: 'crm_opportunity', label: 'CRM opportunity' },
]

/** Sequence kinds that are not document kinds but still belong to a feature. */
const SEQUENCE_KIND_FEATURE: Partial<Record<string, string>> = {
  ...DOC_KIND_FEATURE,
  field_ticket: 'fieldTickets',
  payroll_cheque: 'payroll',
  lien_waiver: 'subcontractorCompliance',
  crm_opportunity: 'crm',
}

function friendlyUnknownKind(kind: string): string {
  if (kind.startsWith('custrec:')) return 'Unavailable custom record type'
  return kind
    .split('_')
    .filter(Boolean)
    .map((word, index) => index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)
    .join(' ')
}

/** Built-in kinds plus this organization's custom-record and extension kinds. */
export async function loadNumberSequenceKindOptions(orgId: string): Promise<NumberSequenceKindOption[]> {
  const [customTypes, configured, features] = await Promise.all([
    db.execute(sql`
      select key, name from custom_record_types
       where org_id = ${orgId} order by name`) as any,
    db.execute(sql`
      select distinct document_kind from number_sequences
       where org_id = ${orgId} order by document_kind`) as any,
    orgFeatureState(orgId),
  ])

  const options = new Map<string, NumberSequenceKindOption>()
  for (const option of BUILT_IN_NUMBER_SEQUENCE_KINDS) {
    const featureKey = SEQUENCE_KIND_FEATURE[option.value]
    if (featureKey && !featureEnabled(features, featureKey)) continue
    options.set(option.value, option)
  }
  for (const row of customTypes.rows as { key: string; name: string }[]) {
    const value = `custrec:${row.key}`
    options.set(value, { value, label: `Custom record — ${row.name}` })
  }
  for (const row of configured.rows as { document_kind: string }[]) {
    if (!options.has(row.document_kind)) {
      options.set(row.document_kind, {
        value: row.document_kind,
        label: friendlyUnknownKind(row.document_kind),
      })
    }
  }
  return [...options.values()]
}
