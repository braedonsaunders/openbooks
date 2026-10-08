import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { JOURNAL_ENTRY_TABLE, journalScopeWhere } from '../customization/entity-list-query/journal-entries'
import { onboardingStatus } from '../onboarding'

/** The setup-readiness org snapshot: profile columns plus `::int` counts. */
export type ReadinessOrgRow = {
  name: string
  legal_name: string | null
  base_currency: string
  country: string
  settings: unknown
  currencies: number
  roots: number
  accounts: number
  books: number
  periods: number
  payment_terms: number
  tax_codes: number
  bank_accounts: number
  posted_entries: number
  completed_closes: number
}

export interface ReadinessSnapshot {
  org: ReadinessOrgRow
  settings: Record<string, unknown>
  workspaceProfile: Record<string, unknown>
  bookStart: 'fresh' | 'migrate'
  /** Company identity, chart, books, periods and AR/AP/bank control accounts. */
  foundationReady: boolean
  /** The setup wizard was completed and recorded a workspace profile. */
  profileReady: boolean
}

/**
 * One measured read of the company's setup state, shared by the Go-live
 * guide and the migration workspace so both judge readiness identically.
 */
export async function loadReadinessSnapshot(orgId: string): Promise<ReadinessSnapshot> {
  const result = (await db.execute<ReadinessOrgRow>(sql`
    select o.name, o.legal_name, o.base_currency, o.country, o.settings,
      (select count(*)::int from currencies) as currencies,
      (select count(*)::int from subsidiaries s where s.org_id=o.id and s.parent_id is null) as roots,
      (select count(*)::int from accounts a where a.org_id=o.id and a.is_active and not a.is_summary) as accounts,
      (select count(*)::int from accounting_books b where b.org_id=o.id and b.is_active) as books,
      (select count(*)::int from accounting_periods p where p.org_id=o.id) as periods,
      (select count(*)::int from payment_terms pt where pt.org_id=o.id and pt.is_active) as payment_terms,
      (select count(*)::int from tax_codes tc where tc.org_id=o.id and tc.is_active) as tax_codes,
      (select count(*)::int from accounts a where a.org_id=o.id and a.is_active and a.reconcilable) as bank_accounts,
      (select count(*)::int from ${sql.raw(`${JOURNAL_ENTRY_TABLE} e`)} where ${journalScopeWhere(orgId)}) as posted_entries,
      (select count(*)::int from close_runs cr where cr.org_id=o.id and cr.status in ('closed','published')) as completed_closes
    from orgs o where o.id=${orgId}
  `))
  // The authed org always exists; the zeroed fallback only keeps the guide
  // rendering degraded (rather than crashing) if it ever does not.
  const org: ReadinessOrgRow = result.rows[0] ?? {
    name: '',
    legal_name: null,
    base_currency: '',
    country: '',
    settings: {},
    currencies: 0,
    roots: 0,
    accounts: 0,
    books: 0,
    periods: 0,
    payment_terms: 0,
    tax_codes: 0,
    bank_accounts: 0,
    posted_entries: 0,
    completed_closes: 0,
  }
  const settings = (org.settings ?? {}) as Record<string, unknown>
  const workspaceProfile = (settings.workspaceProfile ?? {}) as Record<string, unknown>
  const control = (settings.controlAccounts ?? {}) as Record<string, unknown>
  return {
    org,
    settings,
    workspaceProfile,
    bookStart: workspaceProfile.bookStart === 'migrate' ? 'migrate' : 'fresh',
    foundationReady: org.currencies > 0 && org.roots === 1 && org.accounts > 0
      && org.books > 0 && org.periods > 0 && Boolean(control.ar && control.ap && control.bank),
    profileReady: onboardingStatus(settings) === 'complete' && Boolean(settings.workspaceProfile),
  }
}
