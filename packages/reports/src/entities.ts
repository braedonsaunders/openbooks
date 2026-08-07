// THE single source of truth for what a custom report can query. Each entity
// carries both the UI metadata (labels, kinds, descriptions — drives the
// report studio) and the SQL metadata (a server-defined FROM clause and
// column expressions — drives the executor), mapped to the OpenBooks ledger.
//
// Injection safety: every identifier the executor interpolates (`from`,
// `orgColumn`, column `expr`) is a compile-time constant in this file. User
// input only ever SELECTS catalog keys; values always bind as parameters.
//
// These are the same sources the insights/analytics workstream reads:
// the ledger_lines join, documents, parties, and accounts.

import type { ReportFilterOperator, ReportRuleGroup } from './types'

export type ReportColumnKind = 'text' | 'date' | 'timestamp' | 'enum' | 'uuid' | 'number' | 'money'

/** Every transaction kind the documents table holds — the source platform
 *  "Transaction Type" filter set. One source of truth for both the
 *  transactions and transaction_lines entities. */
export const TRANSACTION_KINDS = [
  'vendor_bill',
  'vendor_credit',
  'vendor_payment',
  'customer_invoice',
  'customer_credit',
  'customer_payment',
  'expense_report',
  'check',
  'card_charge',
  'card_refund',
  'transfer',
  'journal',
  'purchase_order',
  'sales_order',
  'quote',
  'project_charge',
] as const

export const TRANSACTION_STATUSES = ['draft', 'pending_approval', 'approved', 'posted', 'voided'] as const

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
  /**
   * Enum columns: the known value set. Drives option pickers in the filter
   * UI (source platform "type is any of Bill, Expense Report…"). Values are stored
   * raw; display labels resolve through i18n with a humanized fallback.
   */
  options?: readonly string[]
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
  /** Permission (beyond reports.read) required to see/run this entity —
   *  sensitive data like payroll wages. Enforced at run time and filtered
   *  from the builder catalog. */
  requiredPermission?: string
  /** Chronological ordering (SQL ORDER BY body, server-defined constant) that
   *  makes the 'latest' aggregate exact for this entity. Without it, 'latest'
   *  measures are rejected at compile time. */
  latestOrderExpr?: string
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
      LEFT JOIN equipment_units eq ON eq.id = jl.equipment_unit_id
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
      { key: 'equipment', label: 'Equipment', kind: 'text', expr: 'eq.name' },
      { key: 'location', label: 'Location', kind: 'text', expr: 'loc.name' },
      { key: 'class', label: 'Class', kind: 'text', expr: 'cls.name' },
      { key: 'memo', label: 'Memo', kind: 'text', expr: 'coalesce(jl.memo, je.memo)' },
      { key: 'amount', label: 'Amount (base)', kind: 'money', expr: 'jl.amount' },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'jl.currency' },
      { key: 'txn_amount', label: 'Amount (txn)', kind: 'money', expr: 'jl.txn_amount' },
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
    label: 'Transactions',
    category: 'transactions',
    description:
      'Every transaction — bills, invoices, credits, payments, expense reports, checks, card charges, journals, orders and quotes. Filter Type to focus on one or more kinds.',
    from: `documents d
      LEFT JOIN parties p ON p.id = d.party_id
      LEFT JOIN departments dep ON dep.id = d.department_id
      LEFT JOIN projects prj ON prj.id = d.project_id
      LEFT JOIN locations loc ON loc.id = d.location_id
      LEFT JOIN classes cls ON cls.id = d.class_id`,
    orgColumn: 'd.org_id',
    columns: [
      { key: 'kind', label: 'Type', kind: 'enum', expr: 'd.kind', options: TRANSACTION_KINDS },
      { key: 'document_number', label: 'Document #', kind: 'text', expr: 'd.document_number' },
      { key: 'party_name', label: 'Party', kind: 'text', expr: 'p.display_name' },
      { key: 'document_date', label: 'Document date', kind: 'date', expr: 'd.document_date' },
      { key: 'posting_date', label: 'Posting date', kind: 'date', expr: 'd.posting_date' },
      { key: 'due_date', label: 'Due date', kind: 'date', expr: 'd.due_date' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'd.status', options: TRANSACTION_STATUSES },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'd.currency' },
      { key: 'subtotal', label: 'Subtotal', kind: 'money', expr: 'd.subtotal' },
      { key: 'tax_total', label: 'Tax', kind: 'money', expr: 'd.tax_total' },
      { key: 'total', label: 'Total', kind: 'money', expr: 'd.total' },
      { key: 'reference_number', label: 'Reference #', kind: 'text', expr: 'd.reference_number' },
      { key: 'billing_method', label: 'Billing method', kind: 'enum', expr: 'd.billing_method', options: ['time_and_materials', 'fixed_price'] },
      { key: 'is_final_invoice', label: 'Final invoice', kind: 'enum', expr: 'd.is_final_invoice' },
      { key: 'payment_hold_reason', label: 'Payment hold', kind: 'text', expr: 'd.payment_hold_reason' },
      { key: 'expected_pay_date', label: 'Expected pay date', kind: 'date', expr: 'd.expected_pay_date' },
      { key: 'department', label: 'Department', kind: 'text', expr: 'dep.name' },
      { key: 'project', label: 'Project', kind: 'text', expr: 'prj.name' },
      { key: 'location', label: 'Location', kind: 'text', expr: 'loc.name' },
      { key: 'class', label: 'Class', kind: 'text', expr: 'cls.name' },
      { key: 'memo', label: 'Memo', kind: 'text', expr: 'd.memo' },
      { key: 'created_at', label: 'Created at', kind: 'timestamp', expr: 'd.created_at' },
      { key: 'id', label: 'Transaction (id)', kind: 'uuid', expr: 'd.id' },
      { key: 'party_id', label: 'Party (id)', kind: 'uuid', expr: 'd.party_id' },
    ],
    defaultSort: { column: 'document_date', direction: 'desc' },
  },
  {
    key: 'transaction_lines',
    label: 'Transaction lines',
    category: 'transactions',
    description:
      'Line-level transaction detail across every type — item, account, quantities, amounts, billing state and dimensions. The workhorse for job-costing and billing searches.',
    from: `document_lines dl
      JOIN documents d ON d.id = dl.document_id
      LEFT JOIN parties p ON p.id = d.party_id
      LEFT JOIN accounts a ON a.id = dl.account_id
      LEFT JOIN items it ON it.id = dl.item_id
      LEFT JOIN parties emp ON emp.id = dl.employee_id
      LEFT JOIN departments dep ON dep.id = coalesce(dl.department_id, d.department_id)
      LEFT JOIN projects prj ON prj.id = coalesce(dl.project_id, d.project_id)
      LEFT JOIN equipment_units eu ON eu.id = dl.equipment_unit_id
      LEFT JOIN locations loc ON loc.id = coalesce(dl.location_id, d.location_id)
      LEFT JOIN classes cls ON cls.id = coalesce(dl.class_id, d.class_id)`,
    orgColumn: 'dl.org_id',
    columns: [
      { key: 'kind', label: 'Type', kind: 'enum', expr: 'd.kind', options: TRANSACTION_KINDS },
      { key: 'document_number', label: 'Document #', kind: 'text', expr: 'd.document_number' },
      { key: 'document_date', label: 'Document date', kind: 'date', expr: 'd.document_date' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'd.status', options: TRANSACTION_STATUSES },
      { key: 'party_name', label: 'Party', kind: 'text', expr: 'p.display_name' },
      { key: 'line_number', label: 'Line #', kind: 'number', expr: 'dl.line_number' },
      { key: 'item_name', label: 'Item', kind: 'text', expr: 'it.name' },
      { key: 'account_number', label: 'Account #', kind: 'text', expr: 'a.number' },
      { key: 'account_name', label: 'Account', kind: 'text', expr: 'a.name' },
      { key: 'description', label: 'Description', kind: 'text', expr: 'dl.description' },
      { key: 'quantity', label: 'Quantity', kind: 'number', expr: 'dl.quantity' },
      { key: 'unit', label: 'Unit', kind: 'text', expr: 'dl.unit' },
      { key: 'unit_price', label: 'Unit price', kind: 'money', expr: 'dl.unit_price' },
      { key: 'amount', label: 'Amount', kind: 'money', expr: 'dl.amount' },
      { key: 'tax_amount', label: 'Tax amount', kind: 'money', expr: 'dl.tax_amount' },
      { key: 'is_billable', label: 'Billable', kind: 'enum', expr: 'dl.is_billable' },
      { key: 'quantity_fulfilled', label: 'Qty fulfilled', kind: 'number', expr: 'dl.quantity_fulfilled' },
      { key: 'quantity_billed', label: 'Qty billed', kind: 'number', expr: 'dl.quantity_billed' },
      { key: 'employee_name', label: 'Employee', kind: 'text', expr: 'emp.display_name' },
      { key: 'department', label: 'Department', kind: 'text', expr: 'dep.name' },
      { key: 'project', label: 'Project', kind: 'text', expr: 'prj.name' },
      { key: 'equipment', label: 'Equipment', kind: 'text', expr: 'eu.name' },
      { key: 'cost_rate', label: 'Cost rate', kind: 'money', expr: 'dl.cost_rate' },
      { key: 'bill_rate', label: 'Bill rate', kind: 'money', expr: 'dl.bill_rate' },
      { key: 'cost_amount', label: 'Cost amount', kind: 'money', expr: 'dl.cost_amount' },
      { key: 'bill_amount', label: 'Bill amount', kind: 'money', expr: 'dl.bill_amount' },
      { key: 'location', label: 'Location', kind: 'text', expr: 'loc.name' },
      { key: 'class', label: 'Class', kind: 'text', expr: 'cls.name' },
      { key: 'created_at', label: 'Created at', kind: 'timestamp', expr: 'dl.created_at' },
      { key: 'id', label: 'Line (id)', kind: 'uuid', expr: 'dl.id' },
      { key: 'document_id', label: 'Transaction (id)', kind: 'uuid', expr: 'dl.document_id' },
    ],
    defaultSort: { column: 'document_date', direction: 'desc' },
  },
  {
    key: 'journal_entries',
    label: 'Journal entries',
    category: 'general_ledger',
    description: 'Journal-entry headers — number, posting date, status, origin and memo. Use Ledger lines for line-level GL detail.',
    from: `journal_entries je`,
    orgColumn: 'je.org_id',
    columns: [
      { key: 'entry_number', label: 'Entry #', kind: 'text', expr: 'je.entry_number' },
      { key: 'posting_date', label: 'Posting date', kind: 'date', expr: 'je.posting_date' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'je.status', options: ['draft', 'posted', 'reversed'] },
      { key: 'origin', label: 'Origin', kind: 'enum', expr: 'je.origin' },
      { key: 'memo', label: 'Memo', kind: 'text', expr: 'je.memo' },
      { key: 'created_at', label: 'Created at', kind: 'timestamp', expr: 'je.created_at' },
      { key: 'id', label: 'Entry (id)', kind: 'uuid', expr: 'je.id' },
      { key: 'source_document_id', label: 'Source transaction (id)', kind: 'uuid', expr: 'je.source_document_id' },
    ],
    defaultSort: { column: 'posting_date', direction: 'desc' },
  },
  {
    key: 'items',
    label: 'Items',
    category: 'catalog',
    description: 'The item & service catalog — services, inventory, labor, charges and discounts with rates and accounts.',
    from: `items it
      LEFT JOIN accounts inc ON inc.id = it.income_account_id
      LEFT JOIN accounts exp ON exp.id = it.expense_account_id
      LEFT JOIN accounts rec ON rec.id = it.cost_recovery_account_id`,
    orgColumn: 'it.org_id',
    columns: [
      { key: 'code', label: 'Code', kind: 'text', expr: 'it.code' },
      { key: 'name', label: 'Name', kind: 'text', expr: 'it.name' },
      { key: 'description', label: 'Description', kind: 'text', expr: 'it.description' },
      { key: 'kind', label: 'Type', kind: 'enum', expr: 'it.kind', options: ['service', 'non_inventory', 'inventory', 'assembly', 'kit', 'other_charge', 'equipment_charge', 'labor', 'absence', 'discount'] },
      { key: 'category', label: 'Category', kind: 'text', expr: 'it.category' },
      { key: 'default_rate', label: 'Default rate', kind: 'money', expr: 'it.default_rate' },
      { key: 'default_cost', label: 'Default cost', kind: 'money', expr: 'it.default_cost' },
      { key: 'unit', label: 'Unit', kind: 'text', expr: 'it.unit' },
      { key: 'income_account', label: 'Income account', kind: 'text', expr: 'inc.name' },
      { key: 'expense_account', label: 'Expense account', kind: 'text', expr: 'exp.name' },
      { key: 'recovery_account', label: 'Cost recovery account', kind: 'text', expr: 'rec.name' },
      { key: 'show_on_timesheet', label: 'On timesheets', kind: 'enum', expr: 'it.show_on_timesheet' },
      { key: 'is_active', label: 'Active', kind: 'enum', expr: 'it.is_active' },
      { key: 'created_at', label: 'Created at', kind: 'timestamp', expr: 'it.created_at' },
      { key: 'id', label: 'Item (id)', kind: 'uuid', expr: 'it.id' },
    ],
    defaultSort: { column: 'name', direction: 'asc' },
  },
  {
    key: 'projects',
    label: 'Projects',
    category: 'catalog',
    description: 'Projects / jobs — status, customer, project type, schedule and PO number.',
    from: `projects prj
      LEFT JOIN parties cust ON cust.id = prj.customer_id
      LEFT JOIN parties mgr ON mgr.id = prj.manager_id`,
    orgColumn: 'prj.org_id',
    columns: [
      { key: 'code', label: 'Code', kind: 'text', expr: 'prj.code' },
      { key: 'name', label: 'Name', kind: 'text', expr: 'prj.name' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'prj.status', options: ['quoted', 'awarded', 'active', 'substantially_complete', 'closed', 'cancelled'] },
      { key: 'customer_name', label: 'Customer', kind: 'text', expr: 'cust.display_name' },
      { key: 'manager_name', label: 'Manager', kind: 'text', expr: 'mgr.display_name' },
      { key: 'project_type', label: 'Project type', kind: 'enum', expr: "COALESCE((SELECT pt.key FROM project_types pt WHERE pt.id = prj.project_type_id AND pt.org_id = prj.org_id), 'time_and_materials')", options: ['time_and_materials', 'fixed_price', 'cost_plus', 'not_to_exceed', 'schedule_of_values'] },
      { key: 'customer_po_number', label: 'Customer PO #', kind: 'text', expr: 'prj.customer_po_number' },
      { key: 'starts_on', label: 'Starts on', kind: 'date', expr: 'prj.starts_on' },
      { key: 'ends_on', label: 'Ends on', kind: 'date', expr: 'prj.ends_on' },
      { key: 'is_active', label: 'Active', kind: 'enum', expr: 'prj.is_active' },
      { key: 'created_at', label: 'Created at', kind: 'timestamp', expr: 'prj.created_at' },
      { key: 'id', label: 'Project (id)', kind: 'uuid', expr: 'prj.id' },
    ],
    defaultSort: { column: 'name', direction: 'asc' },
  },
  {
    key: 'timesheets',
    label: 'Time entries',
    category: 'time',
    description: 'Timesheet entries — employee, date, hours, billable state, project and approval status.',
    from: `time_entries te
      LEFT JOIN parties emp ON emp.id = te.employee_party_id
      LEFT JOIN projects prj ON prj.id = te.project_id
      LEFT JOIN items it ON it.id = te.item_id
      LEFT JOIN departments dep ON dep.id = te.department_id`,
    orgColumn: 'te.org_id',
    columns: [
      { key: 'employee_name', label: 'Employee', kind: 'text', expr: 'emp.display_name' },
      { key: 'worked_on', label: 'Worked on', kind: 'date', expr: 'te.worked_on' },
      { key: 'hours', label: 'Hours', kind: 'number', expr: 'te.hours' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'te.status', options: ['draft', 'submitted', 'approved', 'rejected'] },
      { key: 'is_billable', label: 'Billable', kind: 'enum', expr: 'te.is_billable' },
      { key: 'project', label: 'Project', kind: 'text', expr: 'prj.name' },
      { key: 'item_name', label: 'Service item', kind: 'text', expr: 'it.name' },
      { key: 'department', label: 'Department', kind: 'text', expr: 'dep.name' },
      // Private memos stay private — the search engine never surfaces them.
      { key: 'memo', label: 'Memo', kind: 'text', expr: "(case when te.memo_is_private then null else te.memo end)" },
      { key: 'created_at', label: 'Created at', kind: 'timestamp', expr: 'te.created_at' },
      { key: 'id', label: 'Time entry (id)', kind: 'uuid', expr: 'te.id' },
    ],
    defaultSort: { column: 'worked_on', direction: 'desc' },
  },
  {
    key: 'fixed_assets',
    label: 'Fixed assets',
    category: 'catalog',
    description: 'The fixed-asset register — status, acquisition, cost, custodian and dimensions.',
    from: `fixed_assets fa
      LEFT JOIN asset_categories ac ON ac.id = fa.category_id
      LEFT JOIN parties cust ON cust.id = fa.custodian_party_id
      LEFT JOIN projects prj ON prj.id = fa.project_id
      LEFT JOIN departments dep ON dep.id = fa.department_id`,
    orgColumn: 'fa.org_id',
    columns: [
      { key: 'asset_number', label: 'Asset #', kind: 'text', expr: 'fa.asset_number' },
      { key: 'name', label: 'Name', kind: 'text', expr: 'fa.name' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'fa.status', options: ['draft', 'in_service', 'fully_depreciated', 'disposed', 'written_off'] },
      { key: 'category', label: 'Category', kind: 'text', expr: 'ac.name' },
      { key: 'acquired_on', label: 'Acquired on', kind: 'date', expr: 'fa.acquired_on' },
      { key: 'in_service_on', label: 'In service on', kind: 'date', expr: 'fa.in_service_on' },
      { key: 'acquisition_cost', label: 'Acquisition cost', kind: 'money', expr: 'fa.acquisition_cost' },
      { key: 'salvage_value', label: 'Salvage value', kind: 'money', expr: 'fa.salvage_value' },
      { key: 'serial_number', label: 'Serial #', kind: 'text', expr: 'fa.serial_number' },
      { key: 'custodian_name', label: 'Custodian', kind: 'text', expr: 'cust.display_name' },
      { key: 'project', label: 'Project', kind: 'text', expr: 'prj.name' },
      { key: 'department', label: 'Department', kind: 'text', expr: 'dep.name' },
      { key: 'created_at', label: 'Created at', kind: 'timestamp', expr: 'fa.created_at' },
      { key: 'id', label: 'Asset (id)', kind: 'uuid', expr: 'fa.id' },
    ],
    defaultSort: { column: 'asset_number', direction: 'asc' },
  },
  {
    key: 'equipment',
    label: 'Equipment',
    category: 'catalog',
    description: 'Financial equipment register with shared charge items, purchase basis, utilization, cost recovery, billing and return.',
    from: `equipment_units eu
      LEFT JOIN subsidiaries sub ON sub.id = eu.subsidiary_id
      LEFT JOIN items it ON it.id = eu.charge_item_id
      LEFT JOIN fixed_assets fa ON fa.id = eu.fixed_asset_id
      LEFT JOIN item_rate_books rb ON rb.id = eu.rate_book_id`,
    orgColumn: 'eu.org_id',
    columns: [
      { key: 'unit_number', label: 'Equipment #', kind: 'text', expr: 'eu.unit_number' },
      { key: 'name', label: 'Name', kind: 'text', expr: 'eu.name' },
      { key: 'description', label: 'Description', kind: 'text', expr: 'eu.description' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'eu.status', options: ['draft', 'active', 'inactive', 'retired'] },
      { key: 'subsidiary', label: 'Subsidiary', kind: 'text', expr: 'sub.name' },
      { key: 'charge_item', label: 'Charge item', kind: 'text', expr: 'it.name' },
      { key: 'fixed_asset_number', label: 'Fixed asset #', kind: 'text', expr: 'fa.asset_number' },
      { key: 'rate_book', label: 'Rate book', kind: 'text', expr: 'rb.name' },
      { key: 'purchase_price', label: 'Purchase price', kind: 'money', expr: 'eu.purchase_price' },
      { key: 'acquired_on', label: 'Acquired on', kind: 'date', expr: 'eu.acquired_on' },
      { key: 'in_service_on', label: 'In service on', kind: 'date', expr: 'eu.in_service_on' },
      { key: 'serial_number', label: 'Serial #', kind: 'text', expr: 'eu.serial_number' },
      { key: 'capacity_quantity', label: 'Capacity', kind: 'number', expr: 'eu.capacity_quantity' },
      { key: 'capacity_unit', label: 'Capacity unit', kind: 'text', expr: 'eu.capacity_unit' },
      { key: 'usage', label: 'Charged usage', kind: 'number', expr: `(select coalesce(sum(dl.base_quantity),0) from document_lines dl join documents d on d.id=dl.document_id where dl.equipment_unit_id=eu.id and d.kind='project_charge' and d.status in ('approved','posted'))` },
      { key: 'cost_recovery', label: 'Cost recovery', kind: 'money', expr: `(select coalesce(sum(dl.cost_amount),0) from document_lines dl join documents d on d.id=dl.document_id where dl.equipment_unit_id=eu.id and d.kind='project_charge' and d.status in ('approved','posted'))` },
      { key: 'billable_value', label: 'Billable value', kind: 'money', expr: `(select coalesce(sum(dl.bill_amount),0) from document_lines dl join documents d on d.id=dl.document_id where dl.equipment_unit_id=eu.id and d.kind='project_charge' and d.status in ('approved','posted'))` },
      { key: 'billed_revenue', label: 'Billed revenue', kind: 'money', expr: `(select coalesce(sum(dl.amount),0) from document_lines dl join documents d on d.id=dl.document_id where dl.equipment_unit_id=eu.id and d.kind='customer_invoice' and d.status='posted')` },
      { key: 'depreciation', label: 'Posted depreciation', kind: 'money', expr: `(select coalesce(sum(dsl.posted_amount),0) from depreciation_schedules ds join depreciation_schedule_lines dsl on dsl.schedule_id=ds.id where ds.asset_id=eu.fixed_asset_id and dsl.posted_amount is not null)` },
      { key: 'created_at', label: 'Created at', kind: 'timestamp', expr: 'eu.created_at' },
      { key: 'id', label: 'Equipment (id)', kind: 'uuid', expr: 'eu.id' },
    ],
    defaultSort: { column: 'unit_number', direction: 'asc' },
  },
  {
    key: 'tax_codes',
    label: 'Tax codes',
    category: 'catalog',
    description: 'Tax codes — jurisdiction, scope and recoverability.',
    from: `tax_codes tc`,
    orgColumn: 'tc.org_id',
    columns: [
      { key: 'code', label: 'Code', kind: 'text', expr: 'tc.code' },
      { key: 'name', label: 'Name', kind: 'text', expr: 'tc.name' },
      { key: 'country', label: 'Country', kind: 'text', expr: 'tc.country' },
      { key: 'region', label: 'Region', kind: 'text', expr: 'tc.region' },
      { key: 'applies_to', label: 'Applies to', kind: 'enum', expr: 'tc.applies_to', options: ['sales', 'purchases', 'both'] },
      { key: 'recoverable_percent', label: 'Recoverable %', kind: 'number', expr: 'tc.recoverable_percent' },
      { key: 'is_active', label: 'Active', kind: 'enum', expr: 'tc.is_active' },
      { key: 'id', label: 'Tax code (id)', kind: 'uuid', expr: 'tc.id' },
    ],
    defaultSort: { column: 'code', direction: 'asc' },
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
  {
    key: 'pay_stubs',
    label: 'Pay stubs',
    category: 'payroll',
    description:
      'One row per employee per pay run — gross, statutory withholdings, net, and employer cost, with run/schedule context. Wage data: requires the payroll permission.',
    from: `pay_stubs s
      JOIN pay_runs r ON r.document_id = s.pay_run_document_id
      JOIN documents d ON d.id = r.document_id
      JOIN parties p ON p.id = s.employee_party_id AND p.org_id = s.org_id
      LEFT JOIN pay_schedules ps ON ps.id = r.pay_schedule_id`,
    orgColumn: 's.org_id',
    requiredPermission: 'payroll.read',
    columns: [
      { key: 'employee', label: 'Employee', kind: 'text', expr: 'p.display_name' },
      { key: 'run_number', label: 'Pay run #', kind: 'text', expr: 'd.document_number' },
      { key: 'schedule', label: 'Schedule', kind: 'text', expr: 'ps.name' },
      { key: 'pay_date', label: 'Pay date', kind: 'date', expr: 's.pay_date' },
      { key: 'period_start', label: 'Period start', kind: 'date', expr: 'r.period_start' },
      { key: 'period_end', label: 'Period end', kind: 'date', expr: 'r.period_end' },
      { key: 'tax_year', label: 'Tax year', kind: 'number', expr: 's.tax_year' },
      { key: 'province', label: 'Province / state', kind: 'text', expr: 's.province' },
      {
        key: 'run_status', label: 'Run status', kind: 'enum', expr: 'r.run_status',
        options: ['draft', 'calculated', 'committed'],
      },
      {
        key: 'paid', label: 'Paid', kind: 'enum',
        expr: "case when r.paid_at is not null then 'paid' else 'unpaid' end",
        options: ['paid', 'unpaid'],
      },
      { key: 'gross', label: 'Gross pay', kind: 'money', expr: 's.gross' },
      {
        key: 'cpp_fica', label: 'CPP / FICA (employee)', kind: 'money',
        expr: `(coalesce((s.factors->>'C')::numeric, 0) + coalesce((s.factors->>'C2')::numeric, 0)
          + coalesce((s.factors->>'SS')::numeric, 0) + coalesce((s.factors->>'MED')::numeric, 0)
          + coalesce((s.factors->>'MED2')::numeric, 0))`,
      },
      { key: 'ei', label: 'EI (employee)', kind: 'money', expr: `coalesce((s.factors->>'EI')::numeric, 0)` },
      {
        key: 'income_tax', label: 'Income tax', kind: 'money',
        expr: `(coalesce((s.factors->>'T')::numeric, 0) + coalesce((s.factors->>'TB')::numeric, 0)
          + coalesce((s.factors->>'FIT')::numeric, 0))`,
      },
      { key: 'net_pay', label: 'Net pay', kind: 'money', expr: 's.net_pay' },
      { key: 'employer_cost', label: 'Employer cost', kind: 'money', expr: 's.employer_cost' },
      { key: 'vacation_accrued', label: 'Vacation accrued', kind: 'money', expr: 's.vacation_accrued' },
      { key: 'pensionable', label: 'Pensionable earnings', kind: 'money', expr: 's.pensionable_earnings' },
      { key: 'insurable', label: 'Insurable earnings', kind: 'money', expr: 's.insurable_earnings' },
    ],
    defaultSort: { column: 'pay_date', direction: 'desc' },
  },
  {
    key: 'pay_stub_lines',
    label: 'Pay stub lines',
    category: 'payroll',
    description:
      'Component-level payroll detail — one row per earning, deduction, or employer contribution on a stub, with hours, rate, amount, and running year-to-date. The payroll journal source. Wage data: requires the payroll permission.',
    from: `pay_stub_lines l
      JOIN pay_stubs s ON s.id = l.stub_id
      JOIN pay_runs r ON r.document_id = s.pay_run_document_id
      JOIN documents d ON d.id = r.document_id
      JOIN parties p ON p.id = s.employee_party_id AND p.org_id = s.org_id
      LEFT JOIN pay_components c ON c.id = l.component_id
      LEFT JOIN pay_schedules ps ON ps.id = r.pay_schedule_id
      LEFT JOIN projects prj ON prj.id = l.project_id
      LEFT JOIN departments dep ON dep.id = l.department_id`,
    orgColumn: 'l.org_id',
    requiredPermission: 'payroll.read',
    latestOrderExpr: 's.pay_date DESC, s.id DESC, l.id DESC',
    columns: [
      { key: 'employee', label: 'Employee', kind: 'text', expr: 'p.display_name' },
      { key: 'run_number', label: 'Pay run #', kind: 'text', expr: 'd.document_number' },
      { key: 'schedule', label: 'Schedule', kind: 'text', expr: 'ps.name' },
      { key: 'pay_date', label: 'Pay date', kind: 'date', expr: 's.pay_date' },
      { key: 'period_start', label: 'Period start', kind: 'date', expr: 'r.period_start' },
      { key: 'period_end', label: 'Period end', kind: 'date', expr: 'r.period_end' },
      {
        key: 'run_status', label: 'Run status', kind: 'enum', expr: 'r.run_status',
        options: ['draft', 'calculated', 'committed'],
      },
      { key: 'component', label: 'Component', kind: 'text', expr: 'coalesce(c.name, l.description)' },
      { key: 'component_code', label: 'Component code', kind: 'text', expr: 'c.code' },
      { key: 'line_description', label: 'Line description', kind: 'text', expr: 'l.description' },
      {
        key: 'line_kind', label: 'Kind', kind: 'enum', expr: 'l.kind',
        options: ['earning', 'deduction', 'employer_contribution'],
      },
      { key: 'hours', label: 'Hours', kind: 'number', expr: 'l.hours' },
      { key: 'rate', label: 'Rate', kind: 'number', expr: 'l.rate' },
      { key: 'amount', label: 'Amount', kind: 'money', expr: 'l.amount' },
      {
        key: 'ytd_amount', label: 'YTD amount', kind: 'money',
        expr: `(select coalesce(sum(l2.amount), 0)
        from pay_stub_lines l2
        join pay_stubs s2 on s2.id = l2.stub_id
        join pay_runs r2 on r2.document_id = s2.pay_run_document_id
       where l2.org_id = l.org_id
         and s2.employee_party_id = s.employee_party_id
         and coalesce(l2.component_id::text, l2.description) = coalesce(l.component_id::text, l.description)
         and s2.tax_year = s.tax_year
         and (s2.pay_date < s.pay_date or (s2.pay_date = s.pay_date and s2.id <= s.id))
         and (r2.run_status = 'committed' or s2.pay_run_document_id = s.pay_run_document_id))`,
      },
      { key: 'project', label: 'Project', kind: 'text', expr: 'prj.name' },
      { key: 'department', label: 'Department', kind: 'text', expr: 'dep.name' },
      { key: 'tax_year', label: 'Tax year', kind: 'number', expr: 's.tax_year' },
      { key: 'province', label: 'Province / state', kind: 'text', expr: 's.province' },
      { key: 'stub_id', label: 'Stub (id)', kind: 'uuid', expr: 's.id' },
      { key: 'component_id', label: 'Component (id)', kind: 'uuid', expr: 'l.component_id' },
    ],
    defaultSort: { column: 'pay_date', direction: 'desc' },
  },
  {
    key: 'entitlement_balances',
    label: 'Entitlement balances',
    category: 'payroll',
    description:
      'One row per employee per pay bank — banked time, vacation, benefit recoup — with the resolved limit for that person and over/near-limit flags. The balance is SUM(entitlement_ledger); nothing else is ever the balance. Wage data: requires the payroll permission.',
    // The balance is the ledger sum. The limit is resolved per employee with
    // the SAME most-specific-wins precedence the wage resolver uses
    // (employee > job title > trade > department > subsidiary > plan default,
    // latest effective_from within a scope) — see engine/src/payroll-entitlements.ts.
    from: `(select l.org_id, l.plan_id, l.employee_party_id,
                   sum(l.amount) as balance,
                   max(l.movement_date) as last_movement_date,
                   count(*) as movement_count
              from entitlement_ledger l
             group by l.org_id, l.plan_id, l.employee_party_id) bal
      JOIN entitlement_plans pln ON pln.id = bal.plan_id AND pln.org_id = bal.org_id
      JOIN parties p ON p.id = bal.employee_party_id AND p.org_id = bal.org_id
      LEFT JOIN employee_roles er ON er.party_id = p.id AND er.org_id = p.org_id
      LEFT JOIN trades trd ON trd.id = er.trade_id
      LEFT JOIN departments dep ON dep.id = er.department_id
      LEFT JOIN accounts acc ON acc.id = pln.liability_account_id
      LEFT JOIN LATERAL (
        SELECT lim.max_balance, lim.notify_balance,
               CASE WHEN lim.employee_party_id IS NOT NULL THEN 'employee'
                    WHEN lim.job_title IS NOT NULL THEN 'job title'
                    WHEN lim.trade_id IS NOT NULL THEN 'trade'
                    WHEN lim.department_id IS NOT NULL THEN 'department'
                    WHEN lim.subsidiary_id IS NOT NULL THEN 'subsidiary'
                    ELSE 'plan default' END AS scope
          FROM entitlement_plan_limits lim
         WHERE lim.org_id = bal.org_id AND lim.plan_id = bal.plan_id AND lim.is_active
           AND lim.effective_from <= CURRENT_DATE
           AND (lim.effective_to IS NULL OR lim.effective_to >= CURRENT_DATE)
           AND (lim.employee_party_id = bal.employee_party_id
                OR (lim.job_title IS NOT NULL AND lower(lim.job_title) = lower(er.job_title))
                OR (lim.trade_id IS NOT NULL AND lim.trade_id = er.trade_id)
                OR (lim.department_id IS NOT NULL AND lim.department_id = er.department_id)
                OR (lim.subsidiary_id IS NOT NULL AND lim.subsidiary_id = p.subsidiary_id)
                OR num_nonnulls(lim.employee_party_id, lim.job_title, lim.trade_id,
                                lim.department_id, lim.subsidiary_id) = 0)
         ORDER BY CASE WHEN lim.employee_party_id IS NOT NULL THEN 0
                       WHEN lim.job_title IS NOT NULL THEN 1
                       WHEN lim.trade_id IS NOT NULL THEN 2
                       WHEN lim.department_id IS NOT NULL THEN 3
                       WHEN lim.subsidiary_id IS NOT NULL THEN 4 ELSE 5 END,
                  lim.effective_from DESC
         LIMIT 1
      ) lim ON TRUE`,
    orgColumn: 'bal.org_id',
    requiredPermission: 'payroll.read',
    columns: [
      { key: 'employee', label: 'Employee', kind: 'text', expr: 'p.display_name' },
      { key: 'plan', label: 'Plan', kind: 'text', expr: 'pln.name' },
      { key: 'plan_code', label: 'Plan code', kind: 'text', expr: 'pln.code' },
      {
        key: 'unit', label: 'Unit', kind: 'enum', expr: 'pln.unit',
        options: ['money', 'hours'],
      },
      {
        key: 'direction', label: 'Direction', kind: 'enum', expr: 'pln.direction',
        options: ['accrue', 'owe'],
      },
      { key: 'balance', label: 'Balance', kind: 'money', expr: 'bal.balance' },
      { key: 'job_title', label: 'Job title', kind: 'text', expr: 'er.job_title' },
      { key: 'trade', label: 'Trade', kind: 'text', expr: 'trd.name' },
      { key: 'department', label: 'Department', kind: 'text', expr: 'dep.name' },
      { key: 'max_balance', label: 'Limit', kind: 'money', expr: 'lim.max_balance' },
      { key: 'notify_balance', label: 'Notify at', kind: 'money', expr: 'lim.notify_balance' },
      { key: 'limit_scope', label: 'Limit set by', kind: 'text', expr: 'lim.scope' },
      {
        key: 'headroom', label: 'Headroom', kind: 'money',
        expr: 'CASE WHEN lim.max_balance IS NULL THEN NULL ELSE lim.max_balance - bal.balance END',
      },
      {
        key: 'limit_state', label: 'Limit state', kind: 'enum',
        expr: `CASE WHEN lim.max_balance IS NOT NULL AND bal.balance > lim.max_balance THEN 'over'
                    WHEN lim.notify_balance IS NOT NULL AND bal.balance >= lim.notify_balance THEN 'near'
                    WHEN lim.max_balance IS NULL AND lim.notify_balance IS NULL THEN 'unlimited'
                    ELSE 'ok' END`,
        options: ['over', 'near', 'ok', 'unlimited'],
      },
      {
        key: 'owed_to_employer', label: 'Owed to employer', kind: 'money',
        expr: 'CASE WHEN bal.balance < 0 THEN -bal.balance ELSE 0 END',
      },
      { key: 'liability_account', label: 'Liability account', kind: 'text', expr: 'acc.name' },
      { key: 'last_movement_date', label: 'Last movement', kind: 'date', expr: 'bal.last_movement_date' },
      { key: 'movement_count', label: 'Movements', kind: 'number', expr: 'bal.movement_count' },
      { key: 'plan_id', label: 'Plan (id)', kind: 'uuid', expr: 'bal.plan_id' },
      { key: 'employee_id', label: 'Employee (id)', kind: 'uuid', expr: 'bal.employee_party_id' },
    ],
    defaultSort: { column: 'plan', direction: 'asc' },
  },
  {
    key: 'entitlement_service_milestones',
    label: 'Service milestones',
    category: 'payroll',
    description:
      'Every service anniversary an entitlement tier acts on — benefits at 3 months, RRSP at a year, the vacation ladder at 5/10/15 years — with the date each employee reaches it. The source for the milestone letters. Requires the payroll permission.',
    // The anniversary is computed in PostgreSQL so the report and
    // milestonesReachedInPeriod can never disagree about a month-end hire.
    from: `entitlement_service_tiers t
      JOIN employee_roles er ON er.org_id = t.org_id AND er.hired_on IS NOT NULL AND er.is_active
      JOIN parties p ON p.id = er.party_id AND p.org_id = er.org_id
      LEFT JOIN entitlement_plans pln ON pln.id = t.plan_id
      LEFT JOIN pay_components c ON c.id = t.component_id
      LEFT JOIN departments dep ON dep.id = er.department_id`,
    orgColumn: 't.org_id',
    requiredPermission: 'payroll.read',
    baseFilter: {
      combinator: 'and',
      rules: [{ field: 'tier_active', op: 'is_true' }],
    },
    columns: [
      { key: 'employee', label: 'Employee', kind: 'text', expr: 'p.display_name' },
      {
        key: 'milestone_date', label: 'Milestone date', kind: 'date',
        expr: '(er.hired_on + make_interval(months => t.after_months))::date',
      },
      { key: 'hired_on', label: 'Hired on', kind: 'date', expr: 'er.hired_on' },
      { key: 'after_months', label: 'Service (months)', kind: 'number', expr: 't.after_months' },
      {
        key: 'after_years', label: 'Service (years)', kind: 'number',
        expr: 'round(t.after_months / 12.0, 1)',
      },
      {
        key: 'milestone', label: 'Milestone', kind: 'text',
        expr: `coalesce(pln.name, c.name)`,
      },
      {
        key: 'milestone_kind', label: 'Grants', kind: 'enum',
        expr: `CASE WHEN t.plan_id IS NOT NULL THEN 'accrual rate' ELSE 'eligibility' END`,
        options: ['accrual rate', 'eligibility'],
      },
      { key: 'accrual_value', label: 'New accrual value', kind: 'number', expr: 't.accrual_value' },
      { key: 'eligible', label: 'Eligible', kind: 'enum', expr: 't.eligible' },
      { key: 'job_title', label: 'Job title', kind: 'text', expr: 'er.job_title' },
      { key: 'department', label: 'Department', kind: 'text', expr: 'dep.name' },
      { key: 'terminated_on', label: 'Terminated on', kind: 'date', expr: 'er.terminated_on' },
      { key: 'tier_active', label: 'Tier active', kind: 'enum', expr: 't.is_active' },
      { key: 'employee_id', label: 'Employee (id)', kind: 'uuid', expr: 'er.party_id' },
      { key: 'plan_id', label: 'Plan (id)', kind: 'uuid', expr: 't.plan_id' },
      { key: 'component_id', label: 'Component (id)', kind: 'uuid', expr: 't.component_id' },
    ],
    defaultSort: { column: 'milestone_date', direction: 'asc' },
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
    applicableKinds: ['date', 'timestamp', 'number', 'money'],
  },
  {
    key: 'lte',
    label: 'on or before / ≤',
    needsValue: 'one',
    applicableKinds: ['date', 'timestamp', 'number', 'money'],
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
  {
    // Fiscal-aware relative period (value = a PERIOD_PRESETS id). The web
    // executor resolves it to gte/lte bounds before compiling.
    key: 'period_preset',
    label: 'in fiscal period',
    needsValue: 'one',
    applicableKinds: ['date', 'timestamp'],
  },

]

export function operatorsForKind(kind: ReportColumnKind): ReportOperatorMeta[] {
  return REPORT_OPERATORS.filter((o) => !o.applicableKinds || o.applicableKinds.includes(kind))
}
