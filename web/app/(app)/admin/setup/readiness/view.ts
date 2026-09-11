import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { field, grid, page, ref, repeat, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { onboardingStatus } from '../../../../../lib/onboarding'
import type { SetupReadinessCheck } from './sections'

/**
 * The setup readiness guide, split into a loader and a spec.
 *
 * The page has no search params, no table, and no drawer: everything the
 * spec needs is loader-resolved data. The seven checks are a `repeat` over
 * `widgetBlock('setup-readiness-check-card', …)` with per-item field refs —
 * the same per-item prop threading the admin hub cards use.
 *
 * The conditional PAIRS (which icon per state, which description per branch)
 * are components in `sections.tsx`, not spec constructs: the loader computes
 * the state string, description text and action label verbatim from the
 * native page, and the component renders the decision it is given. The
 * `Badge` variant and the `sr-only` state label likewise travel as data.
 *
 * `layout: 'bare'` because the setup workspace shell (SetupLayout) already
 * draws the header chrome and content container — wrapping this in a second
 * ListPageLayout would nest the chrome. The outer `space-y-6` div is a
 * `grid` with no wrapper of its own, matching the native markup exactly.
 */

export interface SetupReadinessHero {
  kicker: string
  title: string
  description: string
  badgeLabel: string
  badgeReady: boolean
  progressLabel: string
  progressCount: number
  progressTotal: number
  progressPercent: number
  progressMin: number
  progressMax: number
  progressNow: number
}

export interface SetupReadinessData {
  hero: SetupReadinessHero
  checks: SetupReadinessCheck[]
}

export async function loadSetupReadiness(): Promise<SetupReadinessData> {
  const { user } = await requirePermission('admin.setup.manage')
  const result = (await db.execute<Record<string, any>>(sql`
    select o.name, o.legal_name, o.base_currency, o.country, o.settings,
      (select count(*)::int from currencies) as currencies,
      (select count(*)::int from subsidiaries s where s.org_id=o.id and s.parent_id is null) as roots,
      (select count(*)::int from accounts a where a.org_id=o.id and a.is_active and not a.is_summary) as accounts,
      (select count(*)::int from accounting_books b where b.org_id=o.id and b.is_active) as books,
      (select count(*)::int from accounting_periods p where p.org_id=o.id) as periods,
      (select count(*)::int from payment_terms pt where pt.org_id=o.id and pt.is_active) as payment_terms,
      (select count(*)::int from tax_codes tc where tc.org_id=o.id and tc.is_active) as tax_codes,
      (select count(*)::int from accounts a where a.org_id=o.id and a.is_active and a.reconcilable) as bank_accounts,
      (select count(*)::int from journal_entries je where je.org_id=o.id and je.status in ('posted','reversed')) as posted_entries,
      (select count(*)::int from close_runs cr where cr.org_id=o.id and cr.status in ('closed','published')) as completed_closes
    from orgs o where o.id=${user.orgId}
  `))
  const org = result.rows[0]
  const settings = ((org?.settings ?? {}))
  const workspaceProfile = (settings.workspaceProfile ?? {}) as Record<string, unknown>
  const bookStart = workspaceProfile.bookStart === 'migrate' ? 'migrate' : 'fresh'
  const taxPosition = ['registered', 'not_registered', 'unsure'].includes(String(workspaceProfile.taxPosition))
    ? String(workspaceProfile.taxPosition)
    : 'unsure'
  const closeCadence = ['monthly', 'quarterly', 'annual'].includes(String(workspaceProfile.closeCadence))
    ? String(workspaceProfile.closeCadence)
    : 'monthly'
  const closeLabel = closeCadence === 'quarterly' ? 'quarterly' : closeCadence === 'annual' ? 'year-end' : 'monthly'
  const activityLabel = workspaceProfile.monthlyActivity === 'high'
    ? 'more than 1,000 monthly activities'
    : workspaceProfile.monthlyActivity === 'steady'
      ? '100–1,000 monthly activities'
      : 'under 100 monthly activities'
  const control = (settings.controlAccounts ?? {}) as Record<string, unknown>
  const foundationReady = org?.currencies > 0 && org?.roots === 1 && org?.accounts > 0
    && org?.books > 0 && org?.periods > 0 && Boolean(control.ar && control.ap && control.bank)
  const profileReady = onboardingStatus(settings) === 'complete' && Boolean(settings.workspaceProfile)

  const checks: Omit<SetupReadinessCheck, 'indexLabel' | 'stateLabel'>[] = [
    {
      title: 'Company and workspace profile',
      description: profileReady
        ? `Industry, team responsibilities, ${activityLabel}, ${closeLabel} close cadence, and feature recommendations have been reviewed.`
        : 'Tell OpenBooks how your company operates so the workspace starts at the right level.',
      href: '/admin/setup/wizard', action: profileReady ? 'Review profile' : 'Run walkthrough',
      state: profileReady ? 'complete' : 'waiting',
    },
    {
      title: 'Accounting foundation',
      description: foundationReady
        ? `${org.accounts} active accounts, a primary book, fiscal periods, control accounts, and one root entity are ready.`
        : 'Finish the chart of accounts, book, periods, root entity, currency, and control-account mapping before posting.',
      href: '/admin/setup/company', action: 'Review foundation', state: foundationReady ? 'complete' : 'waiting',
    },
    {
      title: 'Invoices, bills, and payment terms',
      description: org?.payment_terms > 0
        ? `${org!.payment_terms} active payment term${org!.payment_terms === 1 ? '' : 's'} available. Review numbering and document defaults.`
        : 'Choose at least one payment term so due dates do not have to be calculated by hand.',
      href: '/admin/setup/invoicing', action: 'Review invoicing', state: org?.payment_terms > 0 ? 'complete' : 'review',
    },
    {
      title: 'Tax treatment',
      description: org?.tax_codes > 0
        ? `${org!.tax_codes} active tax code${org!.tax_codes === 1 ? '' : 's'} configured. Confirm registrations and filing obligations.`
        : taxPosition === 'not_registered'
          ? 'You confirmed this company is not currently required to collect sales tax, GST/HST, or VAT. Revisit this before obligations change.'
          : taxPosition === 'registered'
            ? 'You confirmed the company is registered. Add its jurisdiction, registration, tax codes, and filing cadence before issuing live documents.'
            : 'Tax registration is still undecided. Resolve it before issuing live invoices or recording recoverable tax.',
      href: '/admin/setup/tax-setup', action: 'Review tax',
      state: org?.tax_codes > 0 || taxPosition === 'not_registered' ? 'complete' : 'review',
    },
    {
      title: 'Bank and card accounts',
      description: org?.bank_accounts > 0
        ? `${org!.bank_accounts} reconcilable account${org!.bank_accounts === 1 ? '' : 's'} will appear in Banking. Keep only real accounts reconcilable.`
        : 'Mark each real bank or card GL account as reconcilable before importing statements.',
      href: '/admin/setup/accounts', action: 'Review bank accounts', state: org?.bank_accounts > 0 ? 'complete' : 'review',
    },
    {
      title: 'Opening balances and cutover',
      description: bookStart === 'fresh'
        ? org?.posted_entries > 0
          ? `Books began from zero; ${org!.posted_entries} posted entr${org!.posted_entries === 1 ? 'y records' : 'ies record'} live activity rather than a migrated opening balance.`
          : 'You confirmed the books start from zero, so no migration journal is expected.'
        : org?.posted_entries > 0
          ? `${org!.posted_entries} posted entr${org!.posted_entries === 1 ? 'y exists' : 'ies exist'}. Reconcile the opening journal to the source trial balance and open-item detail before declaring cutover complete.`
          : 'You are moving existing books. Enter a balanced opening journal and verify customer, vendor, bank, tax, and retained-earnings detail.',
      href: '/journal',
      action: bookStart === 'fresh' ? 'Review ledger' : org?.posted_entries > 0 ? 'Review journal' : 'Enter opening balances',
      state: bookStart === 'fresh' ? 'complete' : org?.posted_entries > 0 ? 'review' : 'waiting',
    },
    {
      title: `First ${closeLabel} close`,
      description: org?.completed_closes > 0
        ? `${org!.completed_closes} period close${org!.completed_closes === 1 ? '' : 's'} completed with a preserved checklist, sign-off, locks, and close package.`
        : org?.posted_entries > 0
          ? `Live activity exists. Reconcile the period, review financial statements, complete the ${closeLabel} checklist, attest or approve, lock, and publish.`
          : `After live activity begins, OpenBooks will guide the first ${closeLabel} close from reconciliation through locked books and a preserved close package.`,
      href: '/close', action: org?.completed_closes > 0 ? 'Review closes' : 'Open close workspace',
      state: org?.completed_closes > 0 ? 'complete' : org?.posted_entries > 0 ? 'review' : 'waiting',
    },
  ]
  const complete = checks.filter((item) => item.state === 'complete').length
  const hardReady = profileReady && foundationReady

  return {
    hero: {
      kicker: 'Go-live guide',
      title: 'Make the first posting boring—in the best way.',
      description:
        'OpenBooks has shaped the workspace around your company. This guide verifies the decisions that make invoices, bills, banking, and period close reliable from day one.',
      badgeLabel: hardReady ? 'Accounting foundation ready' : 'Foundation needs attention',
      badgeReady: hardReady,
      progressLabel: 'Setup progress',
      progressCount: complete,
      progressTotal: checks.length,
      progressPercent: Math.round((complete / checks.length) * 100),
      progressMin: 0,
      progressMax: checks.length,
      progressNow: complete,
    },
    checks: checks.map((item, index) => ({
      ...item,
      indexLabel: String(index + 1),
      stateLabel: item.state,
    })),
  }
}

const f = ref<SetupReadinessData>()
const item = field

export function setupReadinessSpec(data: SetupReadinessData): PageSpec {
  return page({
    route: '/admin/setup/readiness',
    layout: 'bare',
    body: [
      grid('space-y-6', [
        widgetBlock('setup-readiness-hero', {
          kicker: f('hero.kicker'),
          title: f('hero.title'),
          description: f('hero.description'),
          badgeLabel: f('hero.badgeLabel'),
          badgeReady: f('hero.badgeReady'),
          progressLabel: f('hero.progressLabel'),
          progressCount: f('hero.progressCount'),
          progressTotal: f('hero.progressTotal'),
          progressPercent: f('hero.progressPercent'),
          progressMin: f('hero.progressMin'),
          progressMax: f('hero.progressMax'),
          progressNow: f('hero.progressNow'),
        }),
        // The seven checks: per-item field refs thread each check's fields
        // straight into the widget — the same threading the admin hub cards
        // use. The item IS the check; there is no nested object.
        repeat({
          items: f('checks'),
          itemKey: item('title'),
          className: 'space-y-3',
          unwrapped: true,
          blocks: [
            widgetBlock('setup-readiness-check-card', {
              indexLabel: item('indexLabel'),
              title: item('title'),
              description: item('description'),
              href: item('href'),
              action: item('action'),
              state: item('state'),
              stateLabel: item('stateLabel'),
            }),
          ],
        }),
      ]),
    ],
  })
}
