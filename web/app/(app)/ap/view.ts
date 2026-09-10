import 'server-only'

import { getTranslations } from 'next-intl/server'
import { groupTabs } from '../../../components/module-home/group-tabs'
import { requirePermission, can } from '../../../lib/authz'
import { analyticsConfig } from '../../../lib/analytics/config'
import { normalizeMoneyValue, withoutWeekEntries } from '../../../lib/cash/core'
import { apPosition } from '../../../lib/cash/ap-position'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'

/**
 * The AP cockpit, split into a loader and a spec.
 *
 * The body is one client cockpit — vitals tiles, the pay-run planner, aging
 * bars, the cash-out schedule, a by-vendor table, and three flyouts that
 * fetch on demand. It stays whole; the spec places it and binds the position
 * the loader already projected.
 *
 * The header actions are a capture link + create menu beside the module tabs
 * inside one flex wrapper, which is `actionsClassName` plus three widgets.
 */

export interface ApCockpitData {
  title: string
  description: string
  canCreate: boolean
  canConfigure: boolean
  canPay: boolean
  captureHref: string
  captureLabel: string
  newItems: { kind: string; label: string }[]
  newBasePath: string
  newTriggerLabel: string
  newCreatingLabel: string
  newFailedLabel: string
  tabs: unknown
  data: unknown
}

export async function loadApCockpit(): Promise<ApCockpitData> {
  const authz = await requirePermission('ap.read')
  const canCreate = can(authz, 'ap.create')
  const t = await getTranslations('ap')
  const tCommon = await getTranslations('common')

  const cfg = await analyticsConfig(authz.user.orgId, 'cashflow')
  const apSettings = { weeklyCap: normalizeMoneyValue(String(cfg.weeklyApCap ?? 0)), restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1 }
  const position = await apPosition(authz.user.orgId, 4, apSettings, undefined, authz.allowedSubsidiaryIds)
  // The schedule bars need each week's label and amount; the week drill
  // fetches the week a reader actually opens from /api/cash/week-entries.
  // Shipping every week's transactions as well repeated the whole open-item
  // book across the horizon.
  const data = {
    ...position,
    weeks: position.weeks.map((w) => ({ ...w, entries: [] })),
    timeline: withoutWeekEntries(position.timeline),
  }

  return {
    title: t('cockpit.title'),
    description: t('cockpit.description'),
    canCreate,
    canConfigure: can(authz, 'admin.setup.manage'),
    canPay: can(authz, 'ap.pay'),
    captureHref: '/ap/capture',
    captureLabel: t('actions.capture'),
    newItems: [
      { kind: 'vendor_bill', label: t('actions.newBill') },
      { kind: 'vendor_credit', label: t('actions.newCredit') ?? t('actions.newBill') },
    ],
    newBasePath: '/ap/bills',
    newTriggerLabel: t('actions.newBill'),
    newCreatingLabel: tCommon('actions.creating'),
    newFailedLabel: t('toasts.createDraftFailed'),
    tabs: await groupTabs('purchasing', '/ap', { orgId: authz.user.orgId }),
    data,
  }
}

const f = ref<ApCockpitData>()

export function apCockpitSpec(data: ApCockpitData): PageSpec {
  return page({
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-3',
        actions: [
          // ONE widget, not two side by side: the native header nests the
          // capture link and the create menu in their own `gap-2` row inside
          // this `gap-3` wrapper. Three flat widgets render one wrapper where
          // the native page renders two, and space the pair differently.
          widget('ap-header-actions', {
            captureHref: data.captureHref,
            captureLabel: data.captureLabel,
            canCreate: data.canCreate,
            newItems: data.newItems,
            newBasePath: data.newBasePath,
            newTriggerLabel: data.newTriggerLabel,
            newCreatingLabel: data.newCreatingLabel,
            newFailedLabel: data.newFailedLabel,
          }),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock('ap-cockpit', {
        data: data.data,
        canConfigure: data.canConfigure,
        canPay: data.canPay,
      }),
    ],
  })
}
