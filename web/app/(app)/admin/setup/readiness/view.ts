import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { field, grid, page, ref, repeat, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { getTranslations } from 'next-intl/server'
import { requirePermission } from '../../../../../lib/authz'
import { JOURNAL_ENTRY_TABLE, journalScopeWhere } from '../../../../../lib/customization/entity-list-query/journal-entries'
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
  progressOf: string
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
  const t = await getTranslations('admin')
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
      (select count(*)::int from ${sql.raw(`${JOURNAL_ENTRY_TABLE} e`)} where ${journalScopeWhere(user.orgId)}) as posted_entries,
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
  const closeName = t(`setup.guide.closeName.${closeCadence}`)
  const closeTitle = t(`setup.guide.close.${closeCadence === 'annual' ? 'titleAnnual' : closeCadence === 'quarterly' ? 'titleQuarterly' : 'titleMonthly'}`)
  const activityLabel = workspaceProfile.monthlyActivity === 'high'
    ? t('setup.guide.activity.high')
    : workspaceProfile.monthlyActivity === 'steady'
      ? t('setup.guide.activity.steady')
      : t('setup.guide.activity.light')
  const control = (settings.controlAccounts ?? {}) as Record<string, unknown>
  const foundationReady = org?.currencies > 0 && org?.roots === 1 && org?.accounts > 0
    && org?.books > 0 && org?.periods > 0 && Boolean(control.ar && control.ap && control.bank)
  const profileReady = onboardingStatus(settings) === 'complete' && Boolean(settings.workspaceProfile)

  const checks: Omit<SetupReadinessCheck, 'indexLabel' | 'stateLabel'>[] = [
    {
      title: t('setup.guide.profile.title'),
      description: profileReady
        ? t('setup.guide.profile.descReady', { activity: activityLabel, close: closeName })
        : t('setup.guide.profile.descWaiting'),
      href: '/admin/setup/wizard', action: profileReady ? t('setup.guide.profile.actionReady') : t('setup.guide.profile.actionWaiting'),
      state: profileReady ? 'complete' : 'waiting',
    },
    {
      title: t('setup.guide.foundation.title'),
      description: foundationReady
        ? t('setup.guide.foundation.descReady', { count: org?.accounts ?? 0 })
        : t('setup.guide.foundation.descWaiting'),
      href: '/admin/setup/company', action: t('setup.guide.foundation.action'), state: foundationReady ? 'complete' : 'waiting',
    },
    {
      title: t('setup.guide.invoicing.title'),
      description: org?.payment_terms > 0
        ? t('setup.guide.invoicing.descReady', { count: org!.payment_terms })
        : t('setup.guide.invoicing.descWaiting'),
      href: '/admin/setup/invoicing', action: t('setup.guide.invoicing.action'), state: org?.payment_terms > 0 ? 'complete' : 'review',
    },
    {
      title: t('setup.guide.tax.title'),
      description: org?.tax_codes > 0
        ? t('setup.guide.tax.descReady', { count: org!.tax_codes })
        : taxPosition === 'not_registered'
          ? t('setup.guide.tax.descNotRegistered')
          : taxPosition === 'registered'
            ? t('setup.guide.tax.descRegistered')
            : t('setup.guide.tax.descUndecided'),
      href: '/admin/setup/tax-setup', action: t('setup.guide.tax.action'),
      state: org?.tax_codes > 0 || taxPosition === 'not_registered' ? 'complete' : 'review',
    },
    {
      title: t('setup.guide.bank.title'),
      description: org?.bank_accounts > 0
        ? t('setup.guide.bank.descReady', { count: org!.bank_accounts })
        : t('setup.guide.bank.descWaiting'),
      href: '/accounts', action: t('setup.guide.bank.action'), state: org?.bank_accounts > 0 ? 'complete' : 'review',
    },
    {
      title: t('setup.guide.opening.title'),
      description: bookStart === 'fresh'
        ? org?.posted_entries > 0
          ? t('setup.guide.opening.descFreshPosted', { count: org!.posted_entries })
          : t('setup.guide.opening.descFreshEmpty')
        : org?.posted_entries > 0
          ? t('setup.guide.opening.descMigratePosted', { count: org!.posted_entries })
          : t('setup.guide.opening.descMigrateEmpty'),
      href: '/journal',
      action: bookStart === 'fresh' ? t('setup.guide.opening.actionFreshLedger') : org?.posted_entries > 0 ? t('setup.guide.opening.actionMigrateJournal') : t('setup.guide.opening.actionMigrateEnter'),
      state: bookStart === 'fresh' ? 'complete' : org?.posted_entries > 0 ? 'review' : 'waiting',
    },
    {
      title: closeTitle,
      description: org?.completed_closes > 0
        ? t('setup.guide.close.descDone', { count: org!.completed_closes })
        : org?.posted_entries > 0
          ? t('setup.guide.close.descReview', { close: closeName })
          : t('setup.guide.close.descWaiting', { close: closeName }),
      href: '/close', action: org?.completed_closes > 0 ? t('setup.guide.close.actionDone') : t('setup.guide.close.actionReview'),
      state: org?.completed_closes > 0 ? 'complete' : org?.posted_entries > 0 ? 'review' : 'waiting',
    },
  ]
  const complete = checks.filter((item) => item.state === 'complete').length
  const hardReady = profileReady && foundationReady

  return {
    hero: {
      kicker: t('setup.guide.hero.kicker'),
      title: t('setup.guide.hero.title'),
      description: t('setup.guide.hero.description'),
      badgeLabel: hardReady ? t('setup.guide.hero.badgeReady') : t('setup.guide.hero.badgeNeeds'),
      badgeReady: hardReady,
      progressLabel: t('setup.guide.hero.progressLabel'),
      progressOf: t('setup.guide.hero.progressOf', { done: complete, total: checks.length }),
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
      stateLabel: t(`setup.guide.state.${item.state}`),
    })),
  }
}

const f = ref<SetupReadinessData>()
const item = field

export function setupReadinessSpec(): PageSpec {
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
          progressOf: f('hero.progressOf'),
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
