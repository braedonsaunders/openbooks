import 'server-only'

import { getTranslations } from 'next-intl/server'
import { groupTabs } from '../../../components/module-home/group-tabs'
import { requirePermission, can } from '../../../lib/authz'
import { analyticsConfig } from '../../../lib/analytics/config'
import { normalizeMoneyValue, withoutWeekEntries } from '../../../lib/cash/core'
import { arPosition } from '../../../lib/cash/ar-position'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'

/**
 * The AR cockpit, split into a loader and a spec.
 *
 * The body is one client cockpit — schedule bars, a collections worklist and
 * a week drill that fetches on demand. It stays whole; the spec places it and
 * binds the position the loader already projected.
 *
 * The header actions are a create menu beside the module tabs inside one
 * flex wrapper, which is `actionsClassName` plus two widgets.
 */

export interface ArCockpitData {
  title: string
  description: string
  canCreate: boolean
  canCollect: boolean
  newItems: { kind: string; label: string }[]
  newBasePath: string
  newTriggerLabel: string
  newCreatingLabel: string
  newFailedLabel: string
  tabs: unknown
  data: unknown
}

export async function loadArCockpit(): Promise<ArCockpitData> {
  const authz = await requirePermission('ar.read')
  const canCreate = can(authz, 'ar.create')
  const t = await getTranslations('ar')
  const tCommon = await getTranslations('common')


  const cfg = await analyticsConfig(authz.user.orgId, 'cashflow')
  const apSettings = { weeklyCap: normalizeMoneyValue(String(cfg.weeklyApCap ?? 0)), restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1 }
  const position = await arPosition(authz.user.orgId, 4, apSettings, undefined, authz.allowedSubsidiaryIds)
  // The schedule bars need each week's label and amount; the week drill
  // fetches the week a reader actually opens from /api/cash/week-entries.
  // Shipping every week's transactions as well repeated the whole open-item
  // book across the horizon.
  const data = {
    ...position,
    weeks: position.weeks.map((w) => ({ ...w, entries: [] })),
    timeline: withoutWeekEntries(position.timeline),
    // Project to the columns the worklist renders. The cockpit is a client
    // component, so mapping there still sent every field across the wire —
    // including five the list never shows.
    worklist: position.worklist.map((e) => ({
      id: e.id,
      docId: e.docId,
      docKind: e.docKind,
      partyName: e.partyName,
      amount: e.amount,
      dueDate: e.dueDate,
      predictedDate: e.predictedDate,
      daysOverdue: e.daysOverdue,
      method: e.method,
    })),
  }


  return {
    title: t('cockpit.title'),
    description: t('cockpit.description'),
    canCreate,
    canCollect: can(authz, 'ar.pay'),
    newItems: [
      { kind: 'customer_invoice', label: t('actions.newInvoice') },
      { kind: 'customer_credit', label: t('actions.newCredit') },
    ],
    newBasePath: '/ar/invoices',
    newTriggerLabel: t('actions.new'),
    newCreatingLabel: tCommon('actions.creating'),
    newFailedLabel: t('toasts.createDraftFailed'),
    tabs: await groupTabs('customers', '/ar', { orgId: authz.user.orgId }),
    data,
  }
}

const f = ref<ArCockpitData>()

export function arCockpitSpec(data: ArCockpitData): PageSpec {
  return page({
    route: '/ar',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-3',
        actions: [
          widget(
            'new-document',
            {
              items: data.newItems,
              basePath: data.newBasePath,
              triggerLabel: data.newTriggerLabel,
              creatingLabel: data.newCreatingLabel,
              failedLabel: data.newFailedLabel,
            },
            f('canCreate'),
          ),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock('ar-cockpit', { data: data.data, canCollect: data.canCollect }),
    ],
  })
}
