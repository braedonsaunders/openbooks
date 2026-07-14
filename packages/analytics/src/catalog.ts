// THE single source of truth for what an insight card can query. Each source is
// a server-authored FROM subquery with typed, whitelisted fields. Ported from
// @openbooks/reports entities and re-shaped for the insights query model:
// semantic types (date|number|currency|category) drive whether a field can be a
// dimension (group/filter) or a measure (aggregate).
//
// Injection safety: every identifier the compiler interpolates (`from`,
// `orgColumn`, field `expr`) is a compile-time constant in this file. User
// input only ever names catalog KEYS; values always bind as parameters.

import { buildSource, type AnalyticsSource, type CatalogSource } from './semantic'

const SOURCES: CatalogSource[] = [
  {
    key: 'ledger_lines',
    label: 'Ledger lines',
    category: 'General ledger',
    description:
      'Journal-line detail joined to entry, account, party and dimensions — the raw GL. One row per journal line.',
    from: `journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      JOIN accounts a ON a.id = jl.account_id
      LEFT JOIN parties p ON p.id = jl.party_id
      LEFT JOIN departments dep ON dep.id = jl.department_id
      LEFT JOIN projects prj ON prj.id = jl.project_id
      LEFT JOIN locations loc ON loc.id = jl.location_id
      LEFT JOIN classes cls ON cls.id = jl.class_id`,
    orgColumn: 'jl.org_id',
    fields: [
      { key: 'posting_date', label: 'Posting date', expr: 'je.posting_date', semanticType: 'date' },
      { key: 'entry_number', label: 'Entry #', expr: 'je.entry_number', semanticType: 'category' },
      { key: 'entry_status', label: 'Entry status', expr: 'je.status', semanticType: 'category' },
      { key: 'entry_origin', label: 'Origin', expr: 'je.origin', semanticType: 'category' },
      { key: 'account_number', label: 'Account #', expr: 'a.number', semanticType: 'category' },
      { key: 'account_name', label: 'Account', expr: 'a.name', semanticType: 'category' },
      { key: 'account_type', label: 'Account type', expr: 'a.type', semanticType: 'category' },
      { key: 'party', label: 'Party', expr: 'p.display_name', semanticType: 'category' },
      { key: 'department', label: 'Department', expr: 'dep.name', semanticType: 'category' },
      { key: 'project', label: 'Project', expr: 'prj.name', semanticType: 'category' },
      { key: 'location', label: 'Location', expr: 'loc.name', semanticType: 'category' },
      { key: 'class', label: 'Class', expr: 'cls.name', semanticType: 'category' },
      { key: 'memo', label: 'Memo', expr: 'coalesce(jl.memo, je.memo)', semanticType: 'category' },
      { key: 'amount', label: 'Amount (base)', expr: 'jl.amount', semanticType: 'currency' },
      { key: 'debit', label: 'Debit', expr: 'greatest(jl.amount, 0)', semanticType: 'currency' },
      { key: 'credit', label: 'Credit', expr: 'greatest(-jl.amount, 0)', semanticType: 'currency' },
      { key: 'quantity', label: 'Quantity', expr: 'jl.quantity', semanticType: 'number' },
      { key: 'currency', label: 'Currency', expr: 'jl.currency', semanticType: 'category' },
    ],
    detailColumns: [
      'posting_date',
      'entry_number',
      'account_number',
      'account_name',
      'party',
      'department',
      'project',
      'amount',
    ],
    defaultSort: { field: 'posting_date', dir: 'desc' },
  },
  {
    key: 'documents',
    label: 'Documents',
    category: 'Documents',
    description: 'Business documents — bills, invoices, payments, orders — with party and dimension labels.',
    from: `documents d
      LEFT JOIN parties p ON p.id = d.party_id
      LEFT JOIN departments dep ON dep.id = d.department_id
      LEFT JOIN projects prj ON prj.id = d.project_id`,
    orgColumn: 'd.org_id',
    fields: [
      { key: 'kind', label: 'Kind', expr: 'd.kind', semanticType: 'category' },
      { key: 'document_number', label: 'Document #', expr: 'd.document_number', semanticType: 'category' },
      { key: 'party', label: 'Party', expr: 'p.display_name', semanticType: 'category' },
      { key: 'status', label: 'Status', expr: 'd.status', semanticType: 'category' },
      { key: 'document_date', label: 'Document date', expr: 'd.document_date', semanticType: 'date' },
      { key: 'due_date', label: 'Due date', expr: 'd.due_date', semanticType: 'date' },
      { key: 'department', label: 'Department', expr: 'dep.name', semanticType: 'category' },
      { key: 'project', label: 'Project', expr: 'prj.name', semanticType: 'category' },
      { key: 'currency', label: 'Currency', expr: 'd.currency', semanticType: 'category' },
      { key: 'subtotal', label: 'Subtotal', expr: 'd.subtotal', semanticType: 'currency' },
      { key: 'tax_total', label: 'Tax', expr: 'd.tax_total', semanticType: 'currency' },
      { key: 'total', label: 'Total', expr: 'd.total', semanticType: 'currency' },
      { key: 'document_count', label: 'Document', expr: 'd.id', semanticType: 'category' },
    ],
    detailColumns: ['document_date', 'kind', 'document_number', 'party', 'status', 'total'],
    defaultSort: { field: 'document_date', dir: 'desc' },
  },
  {
    key: 'parties',
    label: 'Parties',
    category: 'Parties',
    description: 'Customers, vendors and employees — one row per party with its role flags.',
    from: `parties pt
      LEFT JOIN customer_roles cr ON cr.party_id = pt.id
      LEFT JOIN vendor_roles vr ON vr.party_id = pt.id
      LEFT JOIN employee_roles er ON er.party_id = pt.id`,
    orgColumn: 'pt.org_id',
    fields: [
      { key: 'display_name', label: 'Name', expr: 'pt.display_name', semanticType: 'category' },
      { key: 'kind', label: 'Kind', expr: 'pt.kind', semanticType: 'category' },
      { key: 'is_active', label: 'Active', expr: "case when pt.is_active then 'Active' else 'Inactive' end", semanticType: 'category' },
      { key: 'is_customer', label: 'Customer', expr: "case when cr.id is not null then 'Yes' else 'No' end", semanticType: 'category' },
      { key: 'is_vendor', label: 'Vendor', expr: "case when vr.id is not null then 'Yes' else 'No' end", semanticType: 'category' },
      { key: 'is_employee', label: 'Employee', expr: "case when er.id is not null then 'Yes' else 'No' end", semanticType: 'category' },
      { key: 'hired_on', label: 'Hired on', expr: 'er.hired_on', semanticType: 'date' },
      { key: 'created_at', label: 'Created at', expr: 'pt.created_at::date', semanticType: 'date' },
    ],
    detailColumns: ['display_name', 'kind', 'is_customer', 'is_vendor', 'is_employee', 'is_active'],
    defaultSort: { field: 'display_name', dir: 'asc' },
  },
  {
    key: 'accounts',
    label: 'Accounts',
    category: 'General ledger',
    description: 'The chart of accounts — number, name, type and posting flags.',
    from: `accounts a`,
    orgColumn: 'a.org_id',
    fields: [
      { key: 'number', label: 'Account #', expr: 'a.number', semanticType: 'category' },
      { key: 'name', label: 'Name', expr: 'a.name', semanticType: 'category' },
      { key: 'type', label: 'Type', expr: 'a.type', semanticType: 'category' },
      { key: 'is_summary', label: 'Summary', expr: "case when a.is_summary then 'Yes' else 'No' end", semanticType: 'category' },
      { key: 'is_active', label: 'Active', expr: "case when a.is_active then 'Active' else 'Inactive' end", semanticType: 'category' },
      { key: 'account_count', label: 'Account', expr: 'a.id', semanticType: 'category' },
    ],
    detailColumns: ['number', 'name', 'type', 'is_summary', 'is_active'],
    defaultSort: { field: 'number', dir: 'asc' },
  },
]

export const INSIGHT_SOURCES: AnalyticsSource[] = SOURCES.map(buildSource)

export const INSIGHT_SOURCE_MAP: Record<string, AnalyticsSource> = Object.fromEntries(
  INSIGHT_SOURCES.map((s) => [s.key, s]),
)

export function getSource(key: string): AnalyticsSource | null {
  return INSIGHT_SOURCE_MAP[key] ?? null
}
