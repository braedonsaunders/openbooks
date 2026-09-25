import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { subsidiaryVisibleFilter } from '@openbooks/engine/src/organization/subsidiary-scope.ts'

export interface ScopedAccountOption extends Record<string, unknown> {
  id: string
  number: string | null
  name: string
  type: string
  subsidiaryId: string | null
  is_summary: boolean
}

export interface ScopedPartyOption extends Record<string, unknown> {
  id: string
  display_name: string
  subsidiary_id: string | null
}


/** Account references visible to one reader, using the same scope as direct account reads. */
export async function listScopedAccountOptions(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  options: {
    activeOnly?: boolean
    postingOnly?: boolean
    summaryOnly?: boolean
    reconcilableOnly?: boolean
    types?: readonly string[]
  } = {},
): Promise<ScopedAccountOption[]> {
  const typeFilter = options.types?.length
    ? sql`and a.type in (${sql.join(options.types.map((type) => sql`${type}`), sql`, `)})`
    : sql``
  const rows = await db.execute<ScopedAccountOption>(sql`
    select a.id, a.number, a.name, a.type, a.subsidiary_id as "subsidiaryId", a.is_summary
      from accounts a
     where a.org_id = ${orgId}
       ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
       ${options.activeOnly ? sql`and a.is_active` : sql``}
       ${options.postingOnly ? sql`and not a.is_summary` : sql``}
       ${options.summaryOnly ? sql`and a.is_summary` : sql``}
       ${options.reconcilableOnly ? sql`and a.reconcilable` : sql``}
       ${typeFilter}
     order by a.number nulls last, a.name, a.id
  `)
  return rows.rows
}

/** Party references visible to one caller, including intentionally shared parties with a null subsidiary. */
export async function listScopedPartyOptions(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  options: { role?: 'vendor' | 'customer' | 'employee'; activeOnly?: boolean } = {},
): Promise<ScopedPartyOption[]> {
  const roleFilter = options.role === 'vendor'
    ? sql`and exists (select 1 from vendor_roles r where r.org_id = p.org_id and r.party_id = p.id and r.is_active)`
    : options.role === 'customer'
      ? sql`and exists (select 1 from customer_roles r where r.org_id = p.org_id and r.party_id = p.id and r.is_active)`
      : options.role === 'employee'
        ? sql`and exists (select 1 from employee_roles r where r.org_id = p.org_id and r.party_id = p.id and r.is_active)`
        : sql``
  const result = await db.execute<ScopedPartyOption>(sql`
    select p.id, p.display_name, p.subsidiary_id
      from parties p
     where p.org_id = ${orgId}
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
       ${options.activeOnly ? sql`and p.is_active` : sql``}
       ${roleFilter}
     order by p.display_name, p.id
     limit 2000
  `)
  return result.rows
}

export async function listScopedCardOptions(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
) {
  const result = await db.execute<{
    id: string; label: string; last_four: string | null; network: string | null;
    liability_account_id: string; holder: string | null;
  }>(sql`
    select pc.id, pc.label, pc.last_four, pc.network, pc.liability_account_id,
           p.display_name as holder
      from payment_cards pc
      join parties p on p.id = pc.holder_party_id and p.org_id = pc.org_id
      join accounts a on a.id = pc.liability_account_id and a.org_id = pc.org_id
     where pc.org_id = ${orgId} and pc.is_active
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
       ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
     order by pc.label
  `)
  return result.rows.map((card) => ({
    id: card.id,
    label: card.label,
    display_name: card.last_four ? `${card.network ?? ''} •••• ${card.last_four} — ${card.holder ?? ''}`.trim() : card.label,
    last_four: card.last_four,
    network: card.network,
    liability_account_id: card.liability_account_id,
  }))
}
