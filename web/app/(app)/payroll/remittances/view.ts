import 'server-only'

import { getTranslations } from 'next-intl/server'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { pickString } from '../../../../lib/list-params'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import { scopedRemittanceSummary } from '../../../../lib/payroll-scoped-views'
import type { RemittanceGroup } from '@openbooks/engine/src/payroll-remittance.ts'

/**
 * Payroll remittances, split into a loader and a spec.
 *
 * The native page is a per-destination cockpit: one card per (remittance
 * party, filing account) with the period's accrued components, the gross /
 * headcount context, already-raised bills, and a one-click draft-bill
 * action — behind a from/to date form and the module tab strip.
 *
 * Like the AP cockpit, the body stays whole: every card carries conditional
 * pairs a spec cannot express — the filing-account badge (optional number
 * plus optional name join), the existing-bill link list, the create-bill
 * button vs the assign-vendor link, the withheld/employer kind label, the
 * accountLabel-or-fallback pair — so the spec places the cockpit through
 * one widget and the page and the widget registry share the implementation in
 * ./sections (re-exported from RemittancesView). The widget receives the
 * engine groups verbatim plus from/to/canCreate; money and messages
 * resolve inside the client component via useMoney/useTranslations,
 * identically wherever it renders.
 *
 * Loader work is copied verbatim from page.tsx: the `payroll.read` gate,
 * the `payroll` feature gate (404 when disabled), the PD7A previous-month
 * defaults on the org's business day, the DATE-validated from/to params,
 * and the scoped summary (null → notFound, exactly as the JSON route
 * answers 404 — a count is a disclosure, so the guard lives in the loader).
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Default period: the previous calendar month on the org's business day (the PD7A rhythm). */
function previousMonth(today: string): { from: string; to: string } {
  const [year, month] = today.split("-").map(Number)
  const prevMonth = month === 1 ? 12 : month! - 1
  const prevYear = month === 1 ? year! - 1 : year!
  const first = new Date(Date.UTC(prevYear, prevMonth - 1, 1))
  const last = new Date(Date.UTC(prevYear, prevMonth, 0))
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) }
}

export interface RemittancesData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof groupTabs>>
  groups: RemittanceGroup[]
  from: string
  to: string
  canCreate: boolean
  apNote: string
  apLinkLabel: string
}

export async function loadRemittances(
  sp: Record<string, string | string[] | undefined>,
): Promise<RemittancesData> {
  const authz = await requirePermission('payroll.read')
  await requireFeatureEnabled(authz.user.orgId, 'payroll')
  const t = await getTranslations('payroll.remittances')
  const defaults = previousMonth(await businessToday(authz.user.orgId))
  const from = DATE.test(pickString(sp.from) ?? '') ? (pickString(sp.from) as string) : defaults.from
  const to = DATE.test(pickString(sp.to) ?? '') ? (pickString(sp.to) as string) : defaults.to

  // Employer-level aggregate: refused outright for a caller whose scope
  // excludes any stub in the period, exactly as the JSON route answers.
  const groups = await scopedRemittanceSummary(authz, { from, to })
  if (!groups) {
    const { notFound } = await import('next/navigation')
    notFound()
    throw new Error('unreachable')
  }

  const moduleTabs = await groupTabs('payroll', '/payroll/remittances', { orgId: authz.user.orgId })

  return {
    title: t('title'),
    description: t('description'),
    tabs: moduleTabs,
    groups,
    from,
    to,
    canCreate: can(authz, 'payroll.run'),
    apNote: t('apNote'),
    apLinkLabel: t('apLink'),
  }
}

const f = ref<RemittancesData>()

export function remittancesSpec(data: RemittancesData): PageSpec {
  return page({
    route: '/payroll/remittances',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      // One client cockpit — the period form, the per-destination cards and
      // the empty state. The groups travel verbatim; money and messages
      // resolve inside via useMoney/useTranslations, identically on both
      // paths, so no loader formatting can drift between the renders.
      widgetBlock('remittance-cockpit', {
        groups: data.groups,
        from: data.from,
        to: data.to,
        canCreate: data.canCreate,
      }),
      widgetBlock('remittance-ap-note', {
        note: data.apNote,
        linkLabel: data.apLinkLabel,
      }),
    ],
  })
}
