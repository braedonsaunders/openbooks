import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { organizationCurrencyOptions, organizationCurrencyAvailable } from '@openbooks/engine/organization/currencies'
import { resolveOrgEmailTransport } from '@openbooks/engine/delivery/email-config'

export const SETUP_PROVIDERS = ['stripe', 'adyen', 'gocardless'] as const
export type SetupProvider = (typeof SETUP_PROVIDERS)[number]

export interface SetupRecipient {
  email: string
  name: string
  source: 'party' | 'contact'
}

export interface SetupLinkOptions {
  /** Currencies this customer's legal entity may collect in. */
  currencies: Array<{ value: string; label: string }>
  /** The customer's own currency when it is available, else the entity base. */
  defaultCurrency: string | null
  /** Providers enabled for online payments. */
  providers: SetupProvider[]
  /** Email addresses on file for this customer. */
  recipients: SetupRecipient[]
  /** Whether the organization can send email at all. */
  emailConfigured: boolean
}

interface PartyRow {
  display_name: string
  email: string | null
  subsidiary_id: string | null
  customer_currency: string | null
}

async function loadParty(orgId: string, partyId: string): Promise<PartyRow | null> {
  return (await db.execute<PartyRow>(sql`
    select p.display_name, p.email, p.subsidiary_id, c.currency as customer_currency
      from parties p
      left join customer_roles c on c.org_id = p.org_id and c.party_id = p.id
     where p.org_id = ${orgId} and p.id = ${partyId}
     limit 1
  `)).rows[0] ?? null
}

/** The customer's email plus every active contact email, deduplicated. */
export async function setupRecipients(orgId: string, partyId: string, party?: PartyRow | null): Promise<SetupRecipient[]> {
  const owner = party === undefined ? await loadParty(orgId, partyId) : party
  if (!owner) return []
  const contacts = (await db.execute<{ name: string; email: string }>(sql`
    select name, email from contacts
     where org_id = ${orgId} and party_id = ${partyId} and is_active and nullif(trim(email), '') is not null
     order by is_primary desc, name
  `)).rows
  const seen = new Set<string>()
  const recipients: SetupRecipient[] = []
  const add = (email: string | null, name: string, source: SetupRecipient['source']) => {
    const trimmed = email?.trim() ?? ''
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) return
    seen.add(key)
    recipients.push({ email: trimmed, name, source })
  }
  add(owner.email, owner.display_name, 'party')
  for (const contact of contacts) add(contact.email, contact.name, 'contact')
  return recipients
}

export async function loadSetupLinkOptions(orgId: string, partyId: string): Promise<SetupLinkOptions | null> {
  const party = await loadParty(orgId, partyId)
  if (!party) return null
  const scope = party.subsidiary_id ?? ''
  const [currencyRows, providerRows, recipients, transport] = await Promise.all([
    organizationCurrencyOptions(db, orgId, null),
    db.execute<{ provider: SetupProvider }>(sql`
      select provider from psp_provider_configs
       where org_id = ${orgId} and is_enabled and acceptance_enabled
         and provider in ('stripe', 'adyen', 'gocardless')
       order by provider
    `),
    setupRecipients(orgId, partyId, party),
    resolveOrgEmailTransport(orgId),
  ])
  const seen = new Set<string>()
  const currencies = currencyRows
    .filter((row) => row.scopeValue === null || row.scopeValue === scope)
    .filter((row) => (seen.has(row.value) ? false : (seen.add(row.value), true)))
    .map(({ value, label }) => ({ value, label }))
  const preferred = party.customer_currency && seen.has(party.customer_currency) ? party.customer_currency : null
  return {
    currencies,
    defaultCurrency: preferred ?? currencies[0]?.value ?? null,
    providers: providerRows.rows.map((row) => row.provider),
    recipients,
    emailConfigured: transport !== null,
  }
}

/** The legal entity whose currency policy governs this customer's setup. */
export async function setupCurrencyAvailable(orgId: string, partyId: string, currency: string): Promise<boolean> {
  const party = await loadParty(orgId, partyId)
  if (!party) return false
  return organizationCurrencyAvailable(db, orgId, currency, party.subsidiary_id)
}

export async function setupCustomerName(orgId: string, partyId: string): Promise<string | null> {
  return (await loadParty(orgId, partyId))?.display_name ?? null
}
