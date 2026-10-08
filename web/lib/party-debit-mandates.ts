import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { subsidiaryVisibleFilter } from './subsidiaries'

export type PartyDebitMandateRow = {
  id: string
  mandateReference: string
  scheme: 'nacha' | 'sepa_core' | 'sepa_b2b' | 'custom'
  status: 'pending' | 'active' | 'suspended' | 'revoked' | 'expired'
  partyBankAccountId: string
  bankAccountLabel: string
  signedOn: string | null
  validFrom: string | null
  expiresOn: string | null
}

export type PartyDebitMandateBankAccount = {
  id: string
  label: string
}

/**
 * One counterparty's debit mandates and the bank accounts a new mandate may
 * reference, or null when the party is outside the organization or the
 * reader's subsidiary scope (parties without a subsidiary are org-wide).
 * Only active, approved bank accounts are offered, matching the mandate write
 * route's refusal for any other account.
 */
export async function loadPartyDebitMandates(
  orgId: string,
  partyId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ mandates: PartyDebitMandateRow[]; bankAccounts: PartyDebitMandateBankAccount[] } | null> {
  const party = (await db.execute(sql`
    select p.id from parties p
     where p.id = ${partyId} and p.org_id = ${orgId}
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
  `)).rows[0]
  if (!party) return null

  const [mandates, bankAccounts] = await Promise.all([
    db.execute<PartyDebitMandateRow>(sql`
      select m.id,
             m.mandate_reference as "mandateReference",
             m.scheme,
             m.status,
             m.party_bank_account_id as "partyBankAccountId",
             concat_ws(' · ', nullif(b.bank_name, ''),
               case when b.account_last_four is not null then '••••' || b.account_last_four end) as "bankAccountLabel",
             m.signed_on::text as "signedOn",
             m.valid_from::text as "validFrom",
             m.expires_on::text as "expiresOn"
        from payment_mandates m
        join party_bank_accounts b on b.id = m.party_bank_account_id and b.org_id = m.org_id
       where m.org_id = ${orgId} and m.party_id = ${partyId}
       order by m.created_at desc, m.id
    `),
    db.execute<PartyDebitMandateBankAccount>(sql`
      select b.id,
             concat_ws(' · ', nullif(b.bank_name, ''),
               case when b.account_last_four is not null then '••••' || b.account_last_four end) as label
        from party_bank_accounts b
       where b.org_id = ${orgId} and b.party_id = ${partyId}
         and b.is_active and b.approved_at is not null
       order by b.created_at desc, b.id
    `),
  ])
  return { mandates: mandates.rows, bankAccounts: bankAccounts.rows }
}
