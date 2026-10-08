import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { isUuid, mergeHref, pickString } from '../../../lib/list-params'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { loadInternalBillingDrawerData, type InternalBillingDrawerData } from '../../../lib/internal-billing'

/**
 * Internal billing: the universal RecordListView placed through its slot,
 * one New action, and the internal billing flyout on `?doc=`. `?doc=new`
 * opens an unsaved form — nothing is written until Save or Post. Reading
 * takes gl.read; writing and posting take gl.post. The page 404s through
 * the Features gate when Internal billing is off.
 */

const BASE = '/internal-billing'

export interface InternalBillingPageData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  canPost: boolean
  newHref: string
  newLabel: string
  emptyTitle: string
  emptyDescription: string
  drawer: (InternalBillingDrawerData & { initialMode: 'view' | 'edit' }) | null
}

export async function loadInternalBillingPage(
  sp: Record<string, string | string[] | undefined>,
): Promise<InternalBillingPageData> {
  const authz = await requirePermission('gl.read')
  await requireFeatureEnabled(authz.user.orgId, 'internalBilling')
  const t = await getTranslations('internalBilling')
  const canPost = can(authz, 'gl.post')
  const docParam = pickString(sp.doc)
  const closeHref = mergeHref(BASE, sp, { doc: undefined, mode: undefined, form: undefined, transactionTab: undefined, txn: undefined })
  const opening = docParam === 'new' ? (canPost ? 'new' : null) : docParam && isUuid(docParam) ? docParam : null
  const drawerData = opening ? await loadInternalBillingDrawerData({ authz, id: opening, closeHref }) : null
  return {
    title: t('title'),
    description: t('description'),
    currentParams: sp,
    canPost,
    newHref: mergeHref(BASE, sp, { doc: 'new', mode: 'edit' }),
    newLabel: t('list.new'),
    emptyTitle: t('list.emptyTitle'),
    emptyDescription: t('list.emptyDescription'),
    drawer: drawerData ? { ...drawerData, initialMode: pickString(sp.mode) === 'edit' ? 'edit' : 'view' } : null,
  }
}

const f = ref<InternalBillingPageData>()

export function internalBillingSpec(data: InternalBillingPageData): PageSpec {
  const newButton = { widget: 'link-button', props: { href: data.newHref, label: data.newLabel, iconKey: 'plus' } }
  return page({
    route: '/internal-billing',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget(newButton.widget, newButton.props, f('canPost'))],
      }),
    ],
    body: [
      widgetBlock('record-list-view', {
        recordType: 'internal_billing',
        basePath: BASE,
        sp: data.currentParams,
        drawer: data.drawer ? { widget: 'internal-billing-drawer', props: { drawer: data.drawer } } : null,
        emptyTitle: data.emptyTitle,
        emptyDescription: data.emptyDescription,
        emptyAction: data.canPost ? newButton : null,
      }),
    ],
  })
}
