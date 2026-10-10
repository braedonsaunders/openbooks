import { listDrawerRoute, type NativeListDrawerData } from '../../lib/list/drawer-routes'
import { isUuid, pickString } from '../../lib/list-params'
import { Fragment, type ComponentProps, type ReactNode } from 'react'
import { EmptyState } from '@openbooks/ui'
import {
  KeyRound,
  Building2,
  Users,
  Mail,
  Activity,
  Send,
  CheckCircle2,
  Gauge,
  Camera,
  ShieldCheck,
  ScrollText,
  Trash2,
  BellRing,
} from 'lucide-react'
import { OpportunityKanbanBoard } from './native-widgets.client'
import { RecordListSlot } from './record-list-slot'
import { EntityListSlot } from './entity-list-slot'
import { RegisteredListBlockView } from './registered-list'
import type { PreparedListSourceKey } from '../../lib/list/prepared-sources'
import type { TableBlock, WidgetRef } from '@braedonsaunders/appkit-viewspec'
import { findWidget, loadWidget } from './widget-loader'
import { str, type WidgetRenderer } from './widget-props'

type NestedWidgetRef = { widget?: string; props?: Record<string, unknown> }

/**
 * Render a slot that names one widget or several — a project list's drawer
 * slot holds a create-redirect, the record flyout and a transaction flyout,
 * the same fragment the native page passed. An unknown name refuses.
 */
async function nestedSlot(value: unknown): Promise<ReactNode | undefined> {
  const one = async (item: unknown, key: number) => {
    if (!item || typeof item !== 'object') return null
    const ref = item as NestedWidgetRef
    const renderer = ref.widget ? await loadWidget(ref.widget) : undefined
    return renderer ? <Fragment key={key}>{renderer(ref.props ?? {})}</Fragment> : null
  }
  if (Array.isArray(value)) {
    const rendered = (await Promise.all(value.map(one))).filter(Boolean)
    return rendered.length > 0 ? <>{rendered}</> : undefined
  }
  return (await one(value, 0)) ?? undefined
}

/**
 * Renderers that compose other widgets by name. They resolve nested widgets
 * through the loader, so naming one loads only the families it places.
 */
export const CORE_WIDGETS: Record<string, WidgetRenderer> = {
  'empty-state': async (props) => {
    // `action` names a widget rather than carrying JSX, so an empty state can
    // offer its create button without the spec expressing a component.
    const action = str(props, 'action')
    const renderer = action ? await findWidget(action) : undefined
    // Icons are components, so the spec names one from a closed map rather
    // than carrying it — same rule as every other component reference.
    const icons: Record<string, ReactNode> = {
      'key-round': <KeyRound />,
      building: <Building2 />,
      users: <Users />,
      mail: <Mail />,
      activity: <Activity />,
      send: <Send />,
      'check-circle': <CheckCircle2 />,
      gauge: <Gauge />,
      camera: <Camera />,
      'shield-check': <ShieldCheck />,
      'scroll-text': <ScrollText />,
      trash: <Trash2 />,
      bell: <BellRing />,
    }
    const iconKey = str(props, 'icon')
    return (
      <EmptyState
        icon={iconKey ? icons[iconKey] : undefined}
        title={str(props, 'title') ?? ''}
        description={str(props, 'description')}
        action={
          renderer
            ? renderer((props.actionProps as Record<string, unknown>) ?? {})
            : undefined
        }
      />
    )
  },
  'registered-record-list': (props, scope, searchParams) => (
    <RegisteredListBlockView
      source={str(props, 'source') as PreparedListSourceKey}
      spec={props.table as TableBlock}
      toolbar={props.toolbar as WidgetRef[] | undefined}
      scope={scope}
      searchParams={searchParams ?? {}}
    />
  ),
  'opportunity-kanban-board': async (props) => {
    const statuses =
      (props.statuses as ComponentProps<
        typeof OpportunityKanbanBoard
      >['statuses']) ?? []
    const opportunities =
      (props.opportunities as ComponentProps<
        typeof OpportunityKanbanBoard
      >['opportunities']) ?? []
    const canManage = Boolean(props.canManage)
    const drawerRefs = (props.drawer as unknown[])?.length
      ? (props.drawer as NestedWidgetRef[])
      : null
    const drawerSlot = drawerRefs ? (
      <Fragment>
        {await Promise.all(
          drawerRefs.map(async (d, i) => {
            const r = d.widget ? await findWidget(d.widget) : undefined
            return r ? <Fragment key={i}>{r(d.props ?? {})}</Fragment> : null
          }),
        )}
      </Fragment>
    ) : undefined
    return (
      <OpportunityKanbanBoard
        statuses={statuses}
        opportunities={opportunities}
        canManage={canManage}
        drawerSlot={drawerSlot}
        undatedOnly={props.undatedOnly === true}
        undatedLabel={str(props, 'undatedLabel') ?? ''}
        showAllLabel={str(props, 'showAllLabel') ?? ''}
      />
    )
  },
  /**
   * The universal record list. `drawer` and `emptyAction` name widgets, one or
   * several, exactly as `entity-list-view` does. `rowActions` names ONE widget
   * rendered per row: `renderRowActions` is a function, and a spec can never
   * carry a function, so the registry builds it from the ref here.
   */
  'record-list-view': async (props) => {
    const source = str(props, 'recordType') ?? ''
    const route = listDrawerRoute(source)
    const sp = (props.sp as Record<string, string | string[] | undefined>) ?? {}
    const selected = route ? pickString(sp[route.param]) : undefined
    const candidates = Array.isArray(props.drawer) ? props.drawer : [props.drawer]
    const native = route && selected && isUuid(selected) ? candidates.find((item) => item?.widget === route.widget) : null
    const nativeDrawer: NativeListDrawerData | null = native ? { widget: route!.widget, drawer: native.props?.drawer } : null

    const rowActionsRef =
      props.rowActions && typeof props.rowActions === 'object'
        ? (props.rowActions as NestedWidgetRef)
        : undefined
    const [drawer, emptyAction, rowActionsRenderer] = await Promise.all([
      nativeDrawer ? undefined : nestedSlot(props.drawer),
      nestedSlot(props.emptyAction),
      rowActionsRef?.widget ? loadWidget(rowActionsRef.widget) : undefined,
    ])
    return (
      <RecordListSlot
        recordType={str(props, 'recordType') ?? ''}
        basePath={str(props, 'basePath') ?? ''}
        sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
        drawer={drawer}
        nativeDrawer={nativeDrawer}
        emptyTitle={str(props, 'emptyTitle')}
        emptyDescription={str(props, 'emptyDescription')}
        emptyAction={emptyAction}
        renderRowActions={
          rowActionsRenderer
            ? (row) =>
                rowActionsRenderer({
                  ...(rowActionsRef?.props ?? {}),
                  id: row.id,
                  status: row.status,
                  kind: row.kind,
                  openHref: row.openHref,
                })
            : undefined
        }
      />
    )
  },
  /**
   * The universal entity list. `drawer` and `emptyAction` name widgets rather
   * than carrying components — a spec cannot express JSX, so the indirection is
   * the same one the empty state already uses for its action.
   */
  'entity-list-view': async (props) => {
    const [drawer, emptyAction] = await Promise.all([
      nestedSlot(props.drawer),
      nestedSlot(props.emptyAction),
    ])
    return (
      <EntityListSlot
        recordType={str(props, 'recordType') ?? ''}
        timeWorkFamily={str(props, 'timeWorkFamily')}
        defaultPresentation={str(props, 'defaultPresentation')}
        sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
        drawer={drawer}
        emptyAction={emptyAction}
        emptyTitle={str(props, 'emptyTitle')}
        emptyDescription={str(props, 'emptyDescription')}
      />
    )
  },
}
