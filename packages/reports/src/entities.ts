// THE single source of truth for what a custom report can query. Each entity
// carries both the UI metadata (labels, kinds, descriptions — drives the
// report studio) and the SQL metadata (a server-defined FROM clause and
// column expressions — drives the executor). Ported from beaconhs
// packages/reports/src/entities.ts, re-pointed at the openbooks ledger.
//
// Injection safety: every identifier the executor interpolates (`from`,
// `orgColumn`, column `expr`) is a compile-time constant in this file. User
// input only ever SELECTS catalog keys; values always bind as parameters.
//
// These are the same sources the insights/analytics workstream reads:
// the ledger_lines join, documents, parties, and accounts.

import type { ReportFilterOperator, ReportRuleGroup } from './types'

export type ReportColumnKind = 'text' | 'date' | 'timestamp' | 'enum' | 'uuid' | 'number'

export type ReportEntityColumn = {
  /** Public key used in stored query plans (snake_case). */
  key: string
  label: string
  kind: ReportColumnKind
  /**
   * Table-qualified SQL expression used VERBATIM as the column reference
   * (e.g. `jl.amount`, `coalesce(jl.memo, je.memo)`). Server-defined only —
   * never derived from user input.
   */
  expr: string
}

export type ReportEntity = {
  /** Entity key stored in query plans. */
  key: string
  label: string
  category: string
  /** A line of helpful text shown under the entity name in the picker. */
  description: string
  /**
   * Raw FROM clause (without the FROM keyword) — the base table plus any
   * label joins. Server-defined constant.
   */
  from: string
  /** Qualified org-scoping column (e.g. `jl.org_id`). The executor ALWAYS
   *  ANDs `orgColumn = $org` into the WHERE — no query escapes the org. */
  orgColumn: string
  /** Columns selectable for output AND filterable. Order is preserved. */
  columns: ReportEntityColumn[]
  defaultSort?: { column: string; direction: 'asc' | 'desc' }
  /** Implicit predicate ALWAYS AND-ed into every query against this entity.
   *  Server-generated only, never from user input. */
  baseFilter?: ReportRuleGroup
}

export const REPORT_ENTITIES: ReportEntity[] = [
  {
    key: 'ledger_lines',
    label: 'Ledger lines',
    category: 'general_ledger',
    description:
      'Journal-line detail joined to entry, account, party and dimensions — the raw GL. One row per posted (or draft) journal line.',
    from: `journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      JOIN accounts a ON a.id = jl.account_id
      LEFT JOIN parties p ON p.id = jl.party_id
      LEFT JOIN departments dep ON dep.id = jl.department_id
      LEFT JOIN projects prj ON prj.id = jl.project_id
      LEFT JOIN locations loc ON loc.id = jl.location_id
      LEFT JOIN classes cls ON cls.id = jl.class_id`,
    orgColumn: 'jl.org_id',
    columns: [
      { key: 'posting_date', label: 'Posting date', kind: 'date', expr: 'je.posting_date' },
      { key: 'entry_number', label: 'Entry #', kind: 'text', expr: 'je.entry_number' },
      { key: 'entry_status', label: 'Entry status', kind: 'enum', expr: 'je.status' },
      { key: 'origin', label: 'Origin', kind: 'enum', expr: 'je.origin' },
      { key: 'account_number', label: 'Account #', kind: 'text', expr: 'a.number' },
      { key: 'account_name', label: 'Account', kind: 'text', expr: 'a.name' },
      { key: 'account_type', label: 'Account type', kind: 'enum', expr: 'a.type' },
      { key: 'party_name', label: 'Party', kind: 'text', expr: 'p.display_name' },
      { key: 'department', label: 'Department', kind: 'text', expr: 'dep.name' },
      { key: 'project', label: 'Project', kind: 'text', expr: 'prj.name' },
      { key: 'location', label: 'Location', kind: 'text', expr: 'loc.name' },
      { key: 'class', label: 'Class', kind: 'text', expr: 'cls.name' },
      { key: 'memo', label: 'Memo', kind: 'text', expr: 'coalesce(jl.memo, je.memo)' },
      { key: 'amount', label: 'Amount (base)', kind: 'number', expr: 'jl.amount' },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'jl.currency' },
      { key: 'txn_amount', label: 'Amount (txn)', kind: 'number', expr: 'jl.txn_amount' },
      { key: 'quantity', label: 'Quantity', kind: 'number', expr: 'jl.quantity' },
      { key: 'unit', label: 'Unit', kind: 'text', expr: 'jl.unit' },
      { key: 'due_date', label: 'Due date', kind: 'date', expr: 'jl.due_date' },
      { key: 'is_open_item', label: 'Open item', kind: 'enum', expr: 'jl.is_open_item' },
      { key: 'reconciled_at', label: 'Reconciled at', kind: 'timestamp', expr: 'jl.reconciled_at' },
      { key: 'entry_id', label: 'Entry (id)', kind: 'uuid', expr: 'je.id' },
      { key: 'account_id', label: 'Account (id)', kind: 'uuid', expr: 'jl.account_id' },
      { key: 'party_id', label: 'Party (id)', kind: 'uuid', expr: 'jl.party_id' },
    ],
    defaultSort: { column: 'posting_date', direction: 'desc' },
  },
  {
    key: 'documents',
    label: 'Documents',
    category: 'documents',
    description:
      'Business documents — bills, invoices, payments, orders — with party and dimension labels.',
    from: `documents d
      LEFT JOIN parties p ON p.id = d.party_id
      LEFT JOIN departments dep ON dep.id = d.department_id
      LEFT JOIN projects prj ON prj.id = d.project_id`,
    orgColumn: 'd.org_id',
    columns: [
      { key: 'kind', label: 'Kind', kind: 'enum', expr: 'd.kind' },
      { key: 'document_number', label: 'Document #', kind: 'text', expr: 'd.document_number' },
      { key: 'party_name', label: 'Party', kind: 'text', expr: 'p.display_name' },
      { key: 'document_date', label: 'Document date', kind: 'date', expr: 'd.document_date' },
      { key: 'posting_date', label: 'Posting date', kind: 'date', expr: 'd.posting_date' },
      { key: 'due_date', label: 'Due date', kind: 'date', expr: 'd.due_date' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'd.status' },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'd.currency' },
      { key: 'subtotal', label: 'Subtotal', kind: 'number', expr: 'd.subtotal' },
      { key: 'tax_total', label: 'Tax', kind: 'number', expr: 'd.tax_total' },
      { key: 'total', label: 'Total', kind: 'number', expr: 'd.total' },
      { key: 'reference_number', label: 'Reference #', kind: 'text', expr: 'd.reference_number' },
      { key: 'billing_method', label: 'Billing method', kind: 'enum', expr: 'd.billing_method' },
      { key: 'payment_hold_reason', label: 'Payment hold', kind: 'text', expr: 'd.payment_hold_reason' },
      { key: 'expected_pay_date', label: 'Expected pay date', kind: 'date', expr: 'd.expected_pay_date' },
      { key: 'department', label: 'Department', kind: 'text', expr: 'dep.name' },
      { key: 'project', label: 'Project', kind: 'text', expr: 'prj.name' },
      { key: 'memo', label: 'Memo', kind: 'text', expr: 'd.memo' },
      { key: 'created_at', label: 'Created at', kind: 'timestamp', expr: 'd.created_at' },
      { key: 'id', label: 'Document (id)', kind: 'uuid', expr: 'd.id' },
      { key: 'party_id', label: 'Party (id)', kind: 'uuid', expr: 'd.party_id' },
    ],
    defaultSort: { column: 'document_date', direction: 'desc' },
  },
  {
    key: 'parties',
    label: 'Parties',
    category: 'parties',
    description:
      'Customers, vendors and employees — one row per party with its role flags and employee detail.',
    from: `parties pt
      LEFT JOIN customer_roles cr ON cr.party_id = pt.id
      LEFT JOIN vendor_roles vr ON vr.party_id = pt.id
      LEFT JOIN employee_roles er ON er.party_id = pt.id`,
    orgColumn: 'pt.org_id',
    columns: [
      { key: 'display_name', label: 'Name', kind: 'text', expr: 'pt.display_name' },
      { key: 'legal_name', label: 'Legal name', kind: 'text', expr: 'pt.legal_name' },
      { key: 'kind', label: 'Kind', kind: 'enum', expr: 'pt.kind' },
      { key: 'short_code', label: 'Short code', kind: 'text', expr: 'pt.short_code' },
      { key: 'email', label: 'Email', kind: 'text', expr: 'pt.email' },
      { key: 'phone', label: 'Phone', kind: 'text', expr: 'pt.phone' },
      { key: 'is_active', label: 'Active', kind: 'enum', expr: 'pt.is_active' },
      { key: 'is_customer', label: 'Customer', kind: 'enum', expr: '(cr.id IS NOT NULL)' },
      { key: 'is_vendor', label: 'Vendor', kind: 'enum', expr: '(vr.id IS NOT NULL)' },
      { key: 'is_employee', label: 'Employee', kind: 'enum', expr: '(er.id IS NOT NULL)' },
      { key: 'employee_number', label: 'Employee #', kind: 'text', expr: 'er.employee_number' },
      { key: 'hired_on', label: 'Hired on', kind: 'date', expr: 'er.hired_on' },
      { key: 'terminated_on', label: 'Terminated on', kind: 'date', expr: 'er.terminated_on' },
      { key: 'created_at', label: 'Created at', kind: 'timestamp', expr: 'pt.created_at' },
      { key: 'id', label: 'Party (id)', kind: 'uuid', expr: 'pt.id' },
    ],
    defaultSort: { column: 'display_name', direction: 'asc' },
  },
  {
    key: 'accounts',
    label: 'Accounts',
    category: 'general_ledger',
    description: 'The chart of accounts — number, name, type and posting flags.',
    from: `accounts a`,
    orgColumn: 'a.org_id',
    columns: [
      { key: 'number', label: 'Account #', kind: 'text', expr: 'a.number' },
      { key: 'name', label: 'Name', kind: 'text', expr: 'a.name' },
      { key: 'type', label: 'Type', kind: 'enum', expr: 'a.type' },
      { key: 'description', label: 'Description', kind: 'text', expr: 'a.description' },
      { key: 'is_summary', label: 'Summary', kind: 'enum', expr: 'a.is_summary' },
      { key: 'is_active', label: 'Active', kind: 'enum', expr: 'a.is_active' },
      { key: 'reconcilable', label: 'Reconcilable', kind: 'enum', expr: 'a.reconcilable' },
      { key: 'currency_restriction', label: 'Currency restriction', kind: 'text', expr: 'a.currency_restriction' },
      { key: 'created_at', label: 'Created at', kind: 'timestamp', expr: 'a.created_at' },
      { key: 'id', label: 'Account (id)', kind: 'uuid', expr: 'a.id' },
      { key: 'parent_id', label: 'Parent (id)', kind: 'uuid', expr: 'a.parent_id' },
    ],
    defaultSort: { column: 'number', direction: 'asc' },
  },
]

export const REPORT_ENTITY_MAP: Record<string, ReportEntity> = Object.fromEntries(
  REPORT_ENTITIES.map((e) => [e.key, e]),
)

export function entityColumn(entity: ReportEntity, key: string): ReportEntityColumn | null {
  return entity.columns.find((c) => c.key === key) ?? null
}

/**
 * The full SQL reference for a whitelisted column key — the single place every
 * executor builds a column reference. Returns null for unknown keys so
 * half-built plans degrade gracefully.
 */
export function columnRef(entity: ReportEntity, key: string): string | null {
  return entityColumn(entity, key)?.expr ?? null
}

// --- Operators --------------------------------------------------------------

export type ReportOperatorMeta = {
  key: ReportFilterOperator
  label: string
  /** Whether this op needs a value field next to it. */
  needsValue: 'none' | 'one' | 'list'
  /** Restrict to specific column kinds (undefined = applies to all). */
  applicableKinds?: ReportColumnKind[]
}

export const REPORT_OPERATORS: ReportOperatorMeta[] = [
  { key: 'eq', label: 'equals', needsValue: 'one' },
  { key: 'neq', label: 'not equals', needsValue: 'one' },
  { key: 'in', label: 'is any of', needsValue: 'list' },
  { key: 'not_in', label: 'is none of', needsValue: 'list' },
  {
    key: 'gte',
    label: 'on or after / ≥',
    needsValue: 'one',
    applicableKinds: ['date', 'timestamp', 'number'],
  },
  {
    key: 'lte',
    label: 'on or before / ≤',
    needsValue: 'one',
    applicableKinds: ['date', 'timestamp', 'number'],
  },
  { key: 'is_null', label: 'is empty', needsValue: 'none' },
  { key: 'is_not_null', label: 'is set', needsValue: 'none' },
  { key: 'is_true', label: 'is yes', needsValue: 'none', applicableKinds: ['enum'] },
  { key: 'is_false', label: 'is no', needsValue: 'none', applicableKinds: ['enum'] },
  { key: 'contains', label: 'contains', needsValue: 'one', applicableKinds: ['text'] },
  {
    key: 'between_days_ago',
    label: 'within last N days',
    needsValue: 'one',
    applicableKinds: ['date', 'timestamp'],
  },
  {
    key: 'due_within_days',
    label: 'due within next N days',
    needsValue: 'one',
    applicableKinds: ['date', 'timestamp'],
  },
  { key: 'since_today', label: 'is today', needsValue: 'none', applicableKinds: ['date', 'timestamp'] },
  { key: 'this_week', label: 'is this week', needsValue: 'none', applicableKinds: ['date', 'timestamp'] },
  { key: 'this_month', label: 'is this month', needsValue: 'none', applicableKinds: ['date', 'timestamp'] },
  { key: 'this_year', label: 'is this year', needsValue: 'none', applicableKinds: ['date', 'timestamp'] },
  {
    key: 'before_now',
    label: 'is in the past (overdue)',
    needsValue: 'none',
    applicableKinds: ['date', 'timestamp'],
  },
]

export function operatorsForKind(kind: ReportColumnKind): ReportOperatorMeta[] {
  return REPORT_OPERATORS.filter((o) => !o.applicableKinds || o.applicableKinds.includes(kind))
}
