import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

/**
 * Full party payload for the directory flyout: the party row plus its role
 * rows (customer/vendor/employee), related lists, and activity summary.
 */
export interface PartyPayload {
  party: Record<string, unknown>
  customer: Record<string, unknown> | null
  vendor: Record<string, unknown> | null
  employee: Record<string, unknown> | null
  addresses: Record<string, unknown>[]
  contacts: Record<string, unknown>[]
  bankAccounts: Record<string, unknown>[]
  transactionSummary: {
    count: number
    openCount: number
    lastDate: string | null
    currencies: Array<{ currency: string; total: string; openBalance: string }>
  }
  /** ADDITIONAL subsidiaries the party transacts with (party_subsidiaries),
   *  beyond its primary (parties.subsidiary_id). */
  additionalSubsidiaryIds: string[]
}

/**
 * Keep payroll-confidential and sealed identity fields out of the directory
 * payload even if a database driver returns more columns than requested.
 * The SQL projections below are the primary boundary; this copy-and-omit is
 * defense in depth for legacy views, mocks, and driver-level surprises.
 */
function withoutPartyRoleSecrets(
  row: Record<string, unknown>,
  omitted: readonly string[],
): Record<string, unknown> {
  const safe = { ...row }
  for (const key of omitted) delete safe[key]
  return safe
}

export async function loadParty(id: string, orgId: string): Promise<PartyPayload | null> {
  const party = (await db.execute<Record<string, unknown>>(sql`
    select * from parties where id = ${id} and org_id = ${orgId}
  `))
  if (!party.rows[0]) return null

  const [customer, vendor, employee, addresses, contacts, bankAccounts, partySubs, txnSummary, currencySummary] = (await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select r.id, r.org_id, r.party_id, r.ar_account_id, r.payment_terms_id,
             r.credit_limit, r.currency, r.sales_rep_id, r.tax_code_id,
             r.is_on_hold, r.hold_reason, r.held_at, r.held_by, r.is_active,
             r.custom, r.created_at, r.created_by, r.updated_at, r.updated_by,
             a.name as ar_account_name, a.number as ar_account_number,
             tc.code as tax_code, sp.display_name as sales_rep_name
        from customer_roles r
        left join accounts a on a.id = r.ar_account_id and a.org_id = r.org_id
        left join tax_codes tc on tc.id = r.tax_code_id and tc.org_id = r.org_id
        left join parties sp on sp.id = r.sales_rep_id and sp.org_id = r.org_id
       where r.party_id = ${id} and r.org_id = ${orgId}`),
    db.execute<Record<string, unknown>>(sql`
      select r.id, r.org_id, r.party_id, r.ap_account_id, r.payment_terms_id,
             r.default_expense_account_id, r.payment_method,
             r.eft_notification_email, r.currency, r.tax_code_id, r.is_t4a,
             r.is_active, r.custom, r.created_at, r.created_by, r.updated_at,
             r.updated_by, r.compliance_class_id, r.information_return_form,
             r.information_return_box, r.tax_classification, r.tin_last4,
             r.tin_type, r.backup_withholding, r.is_on_hold, r.hold_reason,
             r.held_at, r.held_by,
             ap.name as ap_account_name, ap.number as ap_account_number,
             ex.name as expense_account_name, ex.number as expense_account_number,
             tc.code as tax_code
        from vendor_roles r
        left join accounts ap on ap.id = r.ap_account_id and ap.org_id = r.org_id
        left join accounts ex on ex.id = r.default_expense_account_id and ex.org_id = r.org_id
        left join tax_codes tc on tc.id = r.tax_code_id and tc.org_id = r.org_id
       where r.party_id = ${id} and r.org_id = ${orgId}`),
    db.execute<Record<string, unknown>>(sql`
      select id, org_id, party_id, employee_number, department_id,
             supervisor_id, trade_id, worker_comp_group_id, hired_on,
             terminated_on, has_benefits, vacation_days_per_year,
             billable_utilization_target, expense_account_id,
             external_payroll_id, is_active, custom, created_at, created_by,
             updated_at, updated_by, job_title
        from employee_roles where party_id = ${id} and org_id = ${orgId}`),
    db.execute<Record<string, unknown>>(sql`
      select id, label, line1, line2, city, region, postal_code, country,
             is_default_billing, is_default_shipping
        from addresses where party_id = ${id} and org_id = ${orgId} order by created_at
    `),
    db.execute<Record<string, unknown>>(sql`
      select id, first_name, last_name, name, title, role, email, phone,
             mobile_phone, fax, is_primary, is_active
        from contacts where party_id = ${id} and org_id = ${orgId}
       order by is_primary desc, name
    `),
    db.execute<Record<string, unknown>>(sql`
      select id, bank_name, country, currency, routing, account_last_four,
             approval_status, approved_at, approved_by, submitted_by,
             submitted_at, retired_at, retired_by, retirement_reason,
             is_active, updated_at
        from party_bank_accounts where party_id = ${id} and org_id = ${orgId} order by created_at
    `),
    db.execute<Record<string, unknown>>(sql`
      select subsidiary_id from party_subsidiaries where party_id = ${id} and org_id = ${orgId} order by created_at
    `),
    db.execute<Record<string, unknown>>(sql`
      select count(*)::int as count,
             count(*) filter (where coalesce(open_balance, 0) <> 0)::int as open_count,
             max(document_date)::text as last_date
        from documents where party_id = ${id} and org_id = ${orgId}`),
    db.execute<Record<string, unknown>>(sql`
      select currency, coalesce(sum(abs(total)), 0)::text as total,
             coalesce(sum(abs(open_balance)), 0)::text as open_balance
        from documents where party_id = ${id} and org_id = ${orgId}
       group by currency order by currency`),
  ]))

  const summary = txnSummary.rows[0] ?? {}

  return {
    party: party.rows[0],
    customer: customer.rows[0] ?? null,
    vendor: vendor.rows[0]
      ? withoutPartyRoleSecrets(vendor.rows[0], ['tin_encrypted'])
      : null,
    employee: employee.rows[0]
      ? withoutPartyRoleSecrets(employee.rows[0], ['birth_date'])
      : null,
    addresses: addresses.rows,
    contacts: contacts.rows,
    bankAccounts: bankAccounts.rows,
    transactionSummary: {
      count: Number(summary.count ?? 0),
      openCount: Number(summary.open_count ?? 0),
      lastDate: summary.last_date ? String(summary.last_date) : null,
      currencies: currencySummary.rows.map((row) => ({
        currency: String(row.currency),
        total: String(row.total),
        openBalance: String(row.open_balance),
      })),
    },
    additionalSubsidiaryIds: partySubs.rows.map((r) => String(r.subsidiary_id)),
  }
}
