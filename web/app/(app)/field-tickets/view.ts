import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { pickString } from '../../../lib/list-params'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { loadFieldTicketCreateData, loadFieldTicketDrawerData } from '../../../lib/field-ticket-drawer-data'
import type { FieldTicketDrawer } from './FieldTicketDrawer'
import type { FieldTicketCreateDrawerProps } from './FieldTicketCreateDrawer'
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
 * inside it), and the New-button labels. New is an unsaved create: it opens
 * `?ticketNew=1`, a drawer that writes nothing until its Save POSTs the
 * collection once and opens the persisted ticket.
 *
 * The drawer payload travels through the loader result and the widget renders
 * it keyless — the native page renders `<FieldTicketDrawer>` with no `key`,
 * and the widget must be the byte-identical render (same precedent as
 * `journal-drawer`).
 */

const BASE = '/field-tickets'
const PARAM = 'ticket'
const CREATE_PARAM = 'ticketNew'

type FieldTicketDrawerProps = Parameters<typeof FieldTicketDrawer>[0]

export interface FieldTicketsData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  canManage: boolean
  newButton: {
    base: string
    param: string
    createParam: string
    label: string
  }
  drawer: (FieldTicketDrawerProps & { initialMode: DrawerMode }) | FieldTicketCreateDrawerProps | null
}

export async function loadFieldTickets(
  sp: Record<string, string | string[] | undefined>,
): Promise<FieldTicketsData> {
  const authz = await requirePermission('time.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'fieldTickets')
  const canManage = can(authz, 'time.manage')
  const t = await getTranslations('fieldTickets')
  const openId = pickString(sp[PARAM])
  const drawerData = openId
    ? await loadFieldTicketDrawerData({ authz, ticketId: openId, formLayoutId: pickString(sp.form) })
    : null
  // Unsaved create: only for callers who may create, and never over an
  // open ticket. Loading it reads pickers and allocates nothing.
  const createData = !openId && pickString(sp[CREATE_PARAM]) === '1' && canManage
    ? await loadFieldTicketCreateData({ authz })
    : null

  return {
    title: t('title'),
    description: t('description'),
    currentParams: sp,
    canManage,
    newButton: {
      base: BASE,
      param: PARAM,
      createParam: CREATE_PARAM,
      label: t('list.new'),
    },
    drawer: drawerData
      ? { ...drawerData, initialMode: pickString(sp.mode) === 'edit' ? 'edit' : 'view' }
      : createData,
  }
}

const f = ref<FieldTicketsData>()

export function fieldTicketsSpec(data: FieldTicketsData): PageSpec {
  const newOrder = {
    widget: 'new-order',
    props: {
      base: data.newButton.base,
      param: data.newButton.param,
      createParam: data.newButton.createParam,
      label: data.newButton.label,
    },
  }
  return page({
    route: '/field-tickets',
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
