import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { pickString } from '../../../lib/list-params'
import { can, requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { loadFieldTicketDrawerData } from '../../../lib/field-ticket-drawer-data'
import type { FieldTicketDrawer } from './FieldTicketDrawer'
import type { DrawerMode } from '../../../lib/drawer-mode'

/**
 * Field tickets, split into a loader and a spec.
 *
 * The list itself is the universal RecordListView, so the spec places the
 * `record-list-view` slot instead of a table: the slot re-derives
 * org/user/permissions from the session. A spec that could name an org id is
 * a cross-tenant read — the same rule that puts EntityListView behind
 * `entity-list-view`.
 *
 * Everything else here is loader work copied verbatim from page.tsx: the
 * `time.read` gate, the `fieldTickets` feature gate (404 when disabled), the
 * `?ticket=` flyout resolution through the shared `loadFieldTicketDrawerData`
 * helper (one call — pickers, form layout and subsidiary scoping all live
 * inside it), and the New-button labels. Unlike the order pages there is no
 * `?<param>=new` redirect: the New button POSTs `/api/field-tickets/draft`
 * directly and navigates to the real id.
 *
 * The drawer payload travels through the loader result and the widget renders
 * it keyless — the native page renders `<FieldTicketDrawer>` with no `key`,
 * and the widget must be the byte-identical render (same precedent as
 * `journal-drawer`).
 */

const BASE = '/field-tickets'
const PARAM = 'ticket'
const API = '/api/field-tickets'

type FieldTicketDrawerProps = Parameters<typeof FieldTicketDrawer>[0]

export interface FieldTicketsData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  canManage: boolean
  newButton: {
    apiPath: string
    base: string
    param: string
    label: string
    createFailedMessage: string
  }
  drawer: (FieldTicketDrawerProps & { initialMode: DrawerMode }) | null
}

export async function loadFieldTickets(
  sp: Record<string, string | string[] | undefined>,
): Promise<FieldTicketsData> {
  const authz = await requirePermission('time.read')
  const orgId = authz.user.orgId
  if (!(await isFeatureEnabled(orgId, 'fieldTickets'))) notFound()
  const canManage = can(authz, 'time.manage')
  const t = await getTranslations('fieldTickets')
  const openId = pickString(sp[PARAM])
  const drawerData = openId
    ? await loadFieldTicketDrawerData({ authz, ticketId: openId, formLayoutId: pickString(sp.form) })
    : null

  return {
    title: t('title'),
    description: t('description'),
    currentParams: sp,
    canManage,
    newButton: {
      apiPath: API,
      base: BASE,
      param: PARAM,
      label: t('list.new'),
      createFailedMessage: t('list.createFailed'),
    },
    drawer: drawerData
      ? { ...drawerData, initialMode: pickString(sp.mode) === 'edit' ? 'edit' : 'view' }
      : null,
  }
}

const f = ref<FieldTicketsData>()

export function fieldTicketsSpec(data: FieldTicketsData): PageSpec {
  const newOrder = {
    widget: 'new-order',
    props: {
      apiPath: data.newButton.apiPath,
      base: data.newButton.base,
      param: data.newButton.param,
      label: data.newButton.label,
      createFailedMessage: data.newButton.createFailedMessage,
    },
  }
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget(newOrder.widget, newOrder.props, f('canManage'))],
      }),
    ],
    body: [
      // The universal record list, placed through a slot: it needs an org id,
      // a user id and a permission decision, none of which may travel through
      // a spec. The native page passes no `renderRowActions`, so the slot's
      // built-in eye-link fallback is the byte-identical render.
      widgetBlock('record-list-view', {
        recordType: 'field_ticket',
        basePath: '/field-tickets',
        sp: data.currentParams,
        drawer: data.drawer ? { widget: 'field-ticket-drawer', props: { drawer: data.drawer } } : null,
        emptyAction: data.canManage ? newOrder : null,
      }),
    ],
  })
}
