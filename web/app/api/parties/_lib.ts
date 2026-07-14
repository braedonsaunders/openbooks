import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

/**
 * Full party payload for the directory flyout: the party row plus its role
 * rows (customer/vendor/employee), addresses, and bank accounts (read-only in
 * the directory — add/approve flows live in the Payments module).
 */
export interface PartyPayload {
  party: Record<string, unknown>
  customer: Record<string, unknown> | null
  vendor: Record<string, unknown> | null
  employee: Record<string, unknown> | null
  addresses: Record<string, unknown>[]
  bankAccounts: Record<string, unknown>[]
}

export async function loadParty(id: string, orgId: string): Promise<PartyPayload | null> {
  const party = (await db.execute(sql`
    select * from parties where id = ${id} and org_id = ${orgId}
  `)) as unknown as { rows: Record<string, unknown>[] }
  if (!party.rows[0]) return null

  const [customer, vendor, employee, addresses, bankAccounts] = (await Promise.all([
    db.execute(sql`select * from customer_roles where party_id = ${id}`),
    db.execute(sql`select * from vendor_roles where party_id = ${id}`),
    db.execute(sql`select * from employee_roles where party_id = ${id}`),
    db.execute(sql`
      select id, label, line1, line2, city, region, postal_code, country,
             is_default_billing, is_default_shipping
        from addresses where party_id = ${id} order by created_at
    `),
    db.execute(sql`
      select id, bank_name, country, currency, routing, account_last_four,
             approved_at, approved_by, is_active
        from party_bank_accounts where party_id = ${id} order by created_at
    `),
  ])) as unknown as { rows: Record<string, unknown>[] }[]

  return {
    party: party.rows[0],
    customer: customer.rows[0] ?? null,
    vendor: vendor.rows[0] ?? null,
    employee: employee.rows[0] ?? null,
    addresses: addresses.rows,
    bankAccounts: bankAccounts.rows,
  }
}
