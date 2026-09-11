import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { businessToday, parseIsoDate } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { requirePermission } from '../../../../../lib/authz'
import { trueCostData, type TrueCostData } from '../../../../../lib/analytics/true-cost-data'
import { requireProjectsFeature } from '../../../../../lib/projects-gate'
import { grid, page, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'

/**
 * Overhead Model — the rate-engine BUILDER, lifted out of the True Cost
 * analytics dashboard (which is now a read-only consumer). Split into a
 * loader and a spec.
 *
 * Four mutually exclusive bodies behind `?view=` (`model`, `rates`,
 * `lifecycle`, `application`), chosen by four presence flags the LOADER
 * computes — the accounts-page precedent (`onList`/`onSearch`/`onHierarchy`)
 * one step wider. The spec never branches; it places blocks and all but one
 * vanish.
 *
 * The model body is static authored regions (the guided steps, the policy
 * pills) plus the engine itself (`TrueCostView mode="setup"`) arriving whole
 * through one widget — it owns `useState` (tab, flyouts, drills) the way
 * LaborCostingWorkspace does. The header row (docs/analytics/labor links
 * plus the client-only OverheadActions island) and the tab strip are shared
 * chrome in `./sections`, used by the page and the widget registry: the strip's
 * active-vs-plain link PAIR and the actions' modal state are conditional
 * pairs and client state a spec cannot name. The rates, lifecycle and
 * application bodies need an org id (a capability), so each renders through
 * a SLOT below that re-derives it from the session. Nothing carrying a
 * capability crosses the spec: the spec names the tab key and the URL, the
 * slots re-query.
 *
 * Loader work copied verbatim from page.tsx: the setup.manage gate, the
 * projects feature gate, the TTM window, the types/card queries, the method
 * labels, the auto-open derivation, the guided-step derivations.
 */

const VIEWS = ['model', 'rates', 'lifecycle', 'application'] as const
export type OverheadView = (typeof VIEWS)[number]

export interface OverheadStep {
  n: number
  /** '✓' when done, else the step number — the loader makes the decision. */
  badge: string
  badgeDone: boolean
  title: string
  desc: string
}

export interface OverheadPolicy {
  id: string
  name: string
  methodLabel: string
}

export interface OverheadData {
  title: string
  description: string
  docsHref: string
  docsLabel: string
  analyticsHref: string
  analyticsLabel: string
  laborHref: string
  laborLabel: string
  actions: {
    departments: { id: string; name: string; composite: number }[]
    projectTypes: { id: string; name: string }[]
    autoOpen: boolean
  }
  tabs: { href: string; label: string; active: boolean }[]
  view: OverheadView
  currentParams: Record<string, string | string[] | undefined>
  onModel: boolean
  onRates: boolean
  onLifecycle: boolean
  onApplication: boolean
  steps: OverheadStep[]
  policies: OverheadPolicy[]
  trueCost: TrueCostData
}

export async function loadOverhead(
  sp: Record<string, string | string[] | undefined>,
): Promise<OverheadData> {
  const authz = await requirePermission('admin.setup.manage')
  await requireProjectsFeature(authz.user.orgId)
  const t = await getTranslations('admin')
  const rawView = typeof sp.view === 'string' ? sp.view : ''
  const view: OverheadView = (VIEWS as readonly string[]).includes(rawView) ? (rawView as OverheadView) : 'model'

  const today = await businessToday(authz.user.orgId)
  const fromDate = parseIsoDate(today)
  fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 1)
  const from = fromDate.toISOString().slice(0, 10)
  const data = await trueCostData(authz.user.orgId, { from, to: today, label: 'TTM' }, authz.allowedSubsidiaryIds)
  const typesRes = (await db.execute<{ id: string; name: string; overhead: { method?: string; ratePercent?: string | number; ratePerHour?: string | number } | null }>(sql`
    select pt.id, pt.name,
           version.financial_profile->'overhead' as overhead
      from project_types pt
      left join lateral (
        select v.financial_profile
          from project_financial_profile_versions v
         where v.org_id = pt.org_id
           and v.project_type_id = pt.id
           and v.effective_from <= ${today}
           and (v.effective_to is null or v.effective_to >= ${today})
         order by v.effective_from desc
         limit 1
      ) version on true
     where pt.org_id = ${authz.user.orgId} and pt.is_active
     order by pt.sort_order, pt.name`))
  const cardRes = (await db.execute<{ n: number; from_date: string | null }>(sql`
    select count(*)::int as n, min(effective_from)::text as from_date
      from overhead_rates where org_id = ${authz.user.orgId}
       and (effective_to is null or effective_to >= ${today})`))
  const card = cardRes.rows[0] ?? { n: 0, from_date: null }

  const methodLabel = (oh: { method?: string; ratePercent?: string | number; ratePerHour?: string | number } | null) => {
    switch (oh?.method) {
      case 'rate_engine': return t('setup.entities.overhead-model.methodCard')
      case 'percent_of_labor': return t('setup.entities.overhead-model.methodPct', { rate: oh.ratePercent ?? 0 })
      case 'per_labor_hour': return t('setup.entities.overhead-model.methodHr', { rate: Number(oh.ratePerHour ?? 0).toFixed(2) })
      case 'posted_gl_account_group': return t('setup.entities.overhead-model.methodGl')
      default: return t('setup.entities.overhead-model.methodNone')
    }
  }

  const stepDefs = [
    {
      n: 1,
      title: t('setup.entities.overhead-model.step1t'),
      desc: t('setup.entities.overhead-model.step1d', { count: data.categories.length, unassigned: data.unassigned.length }),
      done: data.categories.length > 0 && data.unassigned.length === 0,
    },
    {
      n: 2,
      title: t('setup.entities.overhead-model.step2t'),
      desc: t('setup.entities.overhead-model.step2d', { rate: data.kpis.compositeRate.toFixed(2) }),
      done: data.kpis.compositeRate > 0,
    },
    {
      n: 3,
      title: t('setup.entities.overhead-model.step3t'),
      desc:
        card.n > 0 && card.from_date
          ? t('setup.entities.overhead-model.ratesActive', { count: card.n, date: card.from_date })
          : t('setup.entities.overhead-model.noRates'),
      done: card.n > 0 && typesRes.rows.some((r) => r.overhead?.method && r.overhead.method !== 'none'),
    },
  ]

  return {
    title: t('setup.entities.overhead-model.title'),
    description: t('setup.entities.overhead-model.description'),
    // Fixed docs/analytics/labor links — the same hrefs page.tsx hardcodes.
    docsHref: '/docs/overhead-costing',
    docsLabel: t('setup.entities.overhead-model.docs'),
    analyticsHref: '/analytics/true-cost',
    analyticsLabel: t('setup.entities.overhead-model.viewAnalytics'),
    laborHref: '/admin/setup/labor-costing',
    laborLabel: t('setup.entities.overhead-model.laborCostingLink'),
    // OverheadActions owns client state (modals, useMoney, useBusinessToday),
    // so it arrives whole: the loader resolves only its inputs.
    actions: {
      departments: data.departments.map((d) => ({ id: d.id, name: d.name, composite: d.composite })),
      projectTypes: typesRes.rows.map((r) => ({ id: r.id, name: r.name })),
      autoOpen: card.n === 0 && !typesRes.rows.some((r) => r.overhead?.method && r.overhead.method !== 'none'),
    },
    tabs: VIEWS.map((item) => ({
      href: `/admin/setup/overhead?view=${item}`,
      label: t(`setup.entities.overhead-model.tabs.${item}`),
      active: view === item,
    })),
    view,
    currentParams: sp,
    onModel: view === 'model',
    onRates: view === 'rates',
    onLifecycle: view === 'lifecycle',
    onApplication: view === 'application',
    steps: stepDefs.map((s) => ({
      n: s.n,
      badge: s.done ? '✓' : String(s.n),
      badgeDone: s.done,
      title: s.title,
      desc: s.desc,
    })),
    policies: typesRes.rows.map((r) => ({
      id: r.id,
      name: r.name,
      methodLabel: methodLabel(r.overhead),
    })),
    trueCost: data,
  }
}

const f = ref<OverheadData>()

export function overheadSpec(data: OverheadData): PageSpec {
  return page({
    route: '/admin/setup/overhead',
    // The setup workspace renders its own shell around every entity page;
    // wrapping it in a second page layout would nest the chrome — the
    // [entity] precedent. The native page owns its outer
    // `<div className="space-y-4">`, so the spec places the same element.
    layout: 'bare',
    header: [],
    body: [
      grid('space-y-4', [
        // Header row (title, description, links, actions island) plus the
        // tab strip: shared chrome, one widget. The active-vs-plain link
        // PAIR lives in the shared component.
        widgetBlock('overhead-model-header', {
          title: data.title,
          description: data.description,
          docsHref: data.docsHref,
          docsLabel: data.docsLabel,
          analyticsHref: data.analyticsHref,
          analyticsLabel: data.analyticsLabel,
          laborHref: data.laborHref,
          laborLabel: data.laborLabel,
          actions: data.actions,
          tabs: data.tabs,
        }),
        // Model body. Exactly one of the four bodies renders per request.
        {
          ...widgetBlock('overhead-model-body', {
            steps: data.steps,
            policies: data.policies,
            trueCost: data.trueCost,
          }),
          when: f('onModel'),
        },
        // Rates tab: drawer-capable rate card. The `?row=` drawer state and
        // the org id stay server-side in the slot.
        {
          ...widgetBlock('overhead-rates-tab', { sp: data.currentParams }),
          when: f('onRates'),
        },
        // Lifecycle tab: mode/cadence switch plus the live-vs-published drift
        // table. Drift money formatting happens in the slot (it owns the
        // money hooks the spec cannot name). No props: all state is
        // org-derived — the payroll tab-slot precedent.
        {
          ...widgetBlock('overhead-lifecycle-tab', {}),
          when: f('onLifecycle'),
        },
        // Application tab: mode switch, account picker, backfill prompt and
        // the applied-postings ledger. Same shape: the slot re-derives and
        // formats.
        {
          ...widgetBlock('overhead-application-tab', {}),
          when: f('onApplication'),
        },
      ]),
    ],
  })
}
