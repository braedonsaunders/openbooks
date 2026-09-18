/**
 * The account drawer's data contract, shared by the (client) drawer and the
 * (server) loaders that feed it — so neither side needs `any` to cross the
 * boundary. Plain module (no `"use client"`): both sides import it freely.
 */

/** The party identity the drawer edits. Column types per the `parties`
 *  table; `updated_at` carries the revision token the save echoes back. */
export interface AccountDrawerParty {
  id: string
  display_name: string
  email: string | null
  phone: string | null
  website: string | null
  is_active: boolean
  updated_at: string
}

/** The CRM profile the drawer edits, per `crm_account_profiles`: numerics
 *  arrive as strings, integers as numbers, the next-action stamp as a Date. */
export interface AccountDrawerProfile {
  lifecycle_stage: string
  status_id: string | null
  owner_user_id: string | null
  territory_id: string | null
  lead_source_id: string | null
  industry: string | null
  category: string | null
  annual_revenue: string | null
  employee_count: number | null
  qualification_score: number | null
  next_action_at: Date | string | null
}

export interface AccountActivityRow { id: string; subject: string }
export interface AccountOpportunityRow { id: string; opportunity_number: string; title: string }

/** Everything the account drawer renders: identity + profile + related rows. */
export interface AccountDrawerData {
  party: AccountDrawerParty
  crm: {
    profile: AccountDrawerProfile
    activities: AccountActivityRow[]
    opportunities: AccountOpportunityRow[]
  }
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const textOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null)

/**
 * Narrow loader rows into the drawer's contract. The loaders hand back
 * `Record<string, unknown>` rows (plus the driver's Dates/numerics), so each
 * column is read with the shape the schema establishes — never asserted.
 */
export function toAccountDrawerData(
  party: Record<string, unknown>,
  account: {
    profile: Record<string, unknown>
    activities: Record<string, unknown>[]
    opportunities: Record<string, unknown>[]
  },
): AccountDrawerData {
  const profile = account.profile
  const nextActionAt = profile.next_action_at
  return {
    party: {
      id: text(party.id),
      display_name: text(party.display_name),
      email: textOrNull(party.email),
      phone: textOrNull(party.phone),
      website: textOrNull(party.website),
      is_active: party.is_active === true,
      updated_at: text(party.updated_at),
    },
    crm: {
      profile: {
        lifecycle_stage: text(profile.lifecycle_stage),
        status_id: textOrNull(profile.status_id),
        owner_user_id: textOrNull(profile.owner_user_id),
        territory_id: textOrNull(profile.territory_id),
        lead_source_id: textOrNull(profile.lead_source_id),
        industry: textOrNull(profile.industry),
        category: textOrNull(profile.category),
        annual_revenue: textOrNull(profile.annual_revenue),
        employee_count: numOrNull(profile.employee_count),
        qualification_score: numOrNull(profile.qualification_score),
        next_action_at: nextActionAt instanceof Date || typeof nextActionAt === 'string' ? nextActionAt : null,
      },
      activities: account.activities.map((a) => ({ id: text(a.id), subject: text(a.subject) })),
      opportunities: account.opportunities.map((o) => ({
        id: text(o.id),
        opportunity_number: text(o.opportunity_number),
        title: text(o.title),
      })),
    },
  }
}
