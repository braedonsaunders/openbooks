import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { isValidEmailAddress } from '@openbooks/emails'
import { functionalReportReader } from './reports/currency-basis'
import { dimWhere } from './reports/filters'
import { statementBookExpr } from './gl-summary'
import { decimalCmp } from './statement-format'

/**
 * Batched customer statements ("send statements to customers with a
 * balance"): recipient resolution shared by the preview and the run
 * creation. Balances come from the same open-item source as the Customer
 * statements picker, so a preview row and the sent statement always agree
 * on who owes what.
 */

export interface StatementBatchFilters {
  /** Statement end date (as-of when `from` is absent). */
  to: string
  from?: string | null
  overdueOnly?: boolean
  subsidiaryId?: string | null
  currency?: string | null
}

export interface StatementPartyContact {
  role: string | null
  email: string | null
  isPrimary: boolean
  isActive: boolean
}

export interface StatementPartyInfo {
  displayName: string
  email: string | null
  subsidiaryId: string | null
  currency: string | null
  contacts: StatementPartyContact[]
}

export interface StatementBalanceRow {
  id: string | null
  display_name: string | null
  balance: string
}

export interface BatchRecipient {
  partyId: string
  displayName: string
  balance: string
  overdue: string
  currency: string | null
  toEmail: string
}

export interface BatchExclusion {
  partyId: string
  displayName: string
  balance: string
  overdue: string
  reason: 'no-email'
  /** Party record URL where the operator adds the missing address. */
  fixHref: string
}

/**
 * Statement mailbox for one customer: an active billing/statement contact
 * first (the native party contacts), then the active primary contact, then
 * the party email on file. Anything else is a missing address, never a
 * guess — the preview lists the customer as excluded instead.
 */
export function pickStatementEmail(
  contacts: readonly StatementPartyContact[],
  partyEmail: string | null,
): string | null {
  const valid = (value: string | null): string | null => {
    const trimmed = value?.trim() ?? ''
    return trimmed && isValidEmailAddress(trimmed) ? trimmed : null
  }
  const active = contacts.filter((c) => c.isActive)
  const billing = active.filter((c) =>
    ['billing', 'statement'].includes((c.role ?? '').trim().toLowerCase()),
  )
  for (const candidate of [...billing.filter((c) => c.isPrimary), ...billing.filter((c) => !c.isPrimary)]) {
    const email = valid(candidate.email)
    if (email) return email
  }
  const primary = active.find((c) => c.isPrimary)
  const primaryEmail = valid(primary?.email ?? null)
  if (primaryEmail) return primaryEmail
  return valid(partyEmail)
}

/** Party record, customer currency, and contacts for the balanced parties. */
export async function loadStatementBatchParties(
  orgId: string,
  partyIds: readonly string[],
): Promise<Map<string, StatementPartyInfo>> {
  const out = new Map<string, StatementPartyInfo>()
  if (partyIds.length === 0) return out
  const parties = (await db.execute<{
    id: string
    display_name: string
    email: string | null
    subsidiary_id: string | null
    currency: string | null
  }>(sql`
    select p.id, p.display_name, p.email, p.subsidiary_id, cr.currency
      from parties p
      left join customer_roles cr on cr.party_id = p.id and cr.org_id = p.org_id
     where p.org_id = ${orgId} and p.id in ${sql`(${sql.join(partyIds.map((id) => sql`${id}`), sql`, `)})`}
  `)).rows
  const contacts = (await db.execute<{
    party_id: string
    role: string | null
    email: string | null
    is_primary: boolean
    is_active: boolean
  }>(sql`
    select party_id, role, email, is_primary, is_active from contacts
     where org_id = ${orgId} and party_id in ${sql`(${sql.join(partyIds.map((id) => sql`${id}`), sql`, `)})`}
  `)).rows
  const byParty = new Map<string, StatementPartyContact[]>()
  for (const row of contacts) {
    const list = byParty.get(row.party_id) ?? []
    list.push({ role: row.role, email: row.email, isPrimary: row.is_primary, isActive: row.is_active })
    byParty.set(row.party_id, list)
  }
  for (const row of parties) {
    out.set(row.id, {
      displayName: row.display_name,
      email: row.email,
      subsidiaryId: row.subsidiary_id,
      currency: row.currency,
      contacts: byParty.get(row.id) ?? [],
    })
  }
  return out
}

/**
 * Overdue portion per party through the as-of date: open receivable lines
 * past due. Same entry set, book, account type, and currency reader as
 * partnerBalances, so the overdue figure is always in the same money as
 * the balance beside it.
 */
export async function partyOverdueMap(
  orgId: string,
  asOf: string,
  opts: { bookId?: string | null; subsidiaryIds?: string[] } = {},
): Promise<Map<string, string>> {
  const reportDb = functionalReportReader(
    orgId,
    sql`e.posting_date <= ${asOf} and a.type = 'asset_receivable' and e.book_id = ${statementBookExpr(orgId, opts.bookId ?? null)} and ${dimWhere({ subsidiaryIds: opts.subsidiaryIds })}`,
  )
  const rows = (await reportDb.execute<{ id: string; overdue: string }>(sql`
    with e as materialized (
      select id from journal_entries
       where org_id = ${orgId} and status in ('posted', 'reversed')
         and posting_date <= ${asOf}
         and book_id = ${statementBookExpr(orgId, opts.bookId ?? null)}
    )
    select ${reportDb.censusColumn}, l.party_id as id, sum(l.amount) as overdue
      from journal_lines l
      join e on e.id = l.entry_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = ${orgId} and a.org_id = ${orgId}
       and a.type = 'asset_receivable' and ${dimWhere({ subsidiaryIds: opts.subsidiaryIds })}
       and l.party_id is not null and l.due_date is not null and l.due_date < ${asOf}
     group by l.party_id
  `)).rows
  return new Map(rows.map((row) => [row.id, row.overdue]))
}

/**
 * Split balanced customers into recipients and no-email exclusions. Zero
 * balances never reach either list; parties outside the caller's
 * subsidiary scope are dropped silently (the same boundary as the single
 * send, which answers out-of-scope parties as missing).
 */
export function assembleBatchList(args: {
  balances: readonly StatementBalanceRow[]
  parties: ReadonlyMap<string, StatementPartyInfo>
  overdueByParty: ReadonlyMap<string, string>
  filters: StatementBatchFilters
  allowedSubsidiaryIds: Set<string> | null
}): { recipients: BatchRecipient[]; excluded: BatchExclusion[] } {
  const recipients: BatchRecipient[] = []
  const excluded: BatchExclusion[] = []
  const currencyFilter = args.filters.currency?.trim().toUpperCase() || null
  for (const row of args.balances) {
    if (!row.id || decimalCmp(row.balance, '0') === 0) continue
    const party = args.parties.get(row.id)
    if (!party) continue
    if (args.allowedSubsidiaryIds !== null && party.subsidiaryId !== null && !args.allowedSubsidiaryIds.has(party.subsidiaryId)) {
      continue
    }
    if (args.filters.subsidiaryId && party.subsidiaryId !== null && party.subsidiaryId !== args.filters.subsidiaryId) {
      continue
    }
    if (currencyFilter && (party.currency ?? '').toUpperCase() !== currencyFilter) continue
    const overdue = args.overdueByParty.get(row.id) ?? '0'
    if (args.filters.overdueOnly && decimalCmp(overdue, '0') <= 0) continue
    const displayName = party.displayName || row.display_name || ''
    const toEmail = pickStatementEmail(party.contacts, party.email)
    if (!toEmail) {
      excluded.push({
        partyId: row.id,
        displayName,
        balance: row.balance,
        overdue,
        reason: 'no-email',
        fixHref: `/parties?party=${row.id}`,
      })
      continue
    }
    recipients.push({
      partyId: row.id,
      displayName,
      balance: row.balance,
      overdue,
      currency: party.currency,
      toEmail,
    })
  }
  return { recipients, excluded }
}
