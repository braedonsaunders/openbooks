import { Fragment, type ComponentProps, type ReactNode } from 'react'
import { EmptyState } from '@openbooks/ui'
import { KeyRound, Building2, Users, Mail, Activity, Send, CheckCircle2, Gauge, Camera, ShieldCheck, ScrollText, Trash2, BellRing } from 'lucide-react'
import { OpportunityKanbanBoard } from '../../app/(app)/crm/OpportunityKanban'
import { RecordListSlot } from './record-list-slot'
import { EntityListSlot } from './entity-list-slot'
import { PAYROLL_WIDGETS } from './widgets-payroll'
import { BANKING_WIDGETS } from './widgets-banking'
import { REPORTING_WIDGETS } from './widgets-reporting'
import { ASSETS_TAX_WIDGETS } from './widgets-assets-tax'
import { COMMERCE_WIDGETS } from './widgets-commerce'
import { PLATFORM_WIDGETS } from './widgets-platform'
import { SETUP_WIDGETS } from './widgets-setup'
import { AGENTS_WIDGETS } from './widgets-agents'
import { HOME_WIDGETS } from './widgets-home'
import { HRM_WIDGETS } from './widgets-hrm'
// HR-17: continuous-performance widgets live in their own family file —
// the composition test caps a family at 500 lines.
import { HRM_CONTINUOUS_WIDGETS } from './widgets-hrm-continuous'
import { PERSONA_WIDGETS } from './widgets-home-persona'
import { OPERATIONS_WIDGETS } from './widgets-operations'
import { RECORDS_WIDGETS } from './widgets-records'
import { CONTROLS_WIDGETS } from './widgets-controls'
import { str, type WidgetRenderer } from './widget-props'

/**
 * Widget registry — the closed set of interactive components a spec may place
 * into a slot.
 *
 * Native pages pass arbitrary JSX into slots like the filter bar's `actions`.
 * A spec cannot express JSX, so it names a widget instead and the host
 * resolves the name here. Keeping the registry closed is a security property,
 * not a convenience: a spec that could name any component would be able to
 * mount anything the bundle contains, which is exactly the escape hatch the
 * block-vocabulary design exists to prevent.
 *
 * Placing a widget grants no capability. Each widget re-checks permission on
 * the host side exactly as it does when a native page renders it, so a spec
 * author who lacks a permission gets the same empty result a user would.
 */

// Only renderers that resolve another widget remain beside the registry.
// Families compose in deterministic domain order; consumers use keyed lookup.
export const WIDGET_REGISTRY: Record<string, WidgetRenderer> = {
  'empty-state': (props) => {
    // `action` names a widget rather than carrying JSX, so an empty state can
    // offer its create button without the spec expressing a component.
    const action = str(props, 'action')
    const renderer = action ? WIDGET_REGISTRY[action] : undefined
    // Icons are components, so the spec names one from a closed map rather
    // than carrying it — same rule as every other component reference.
    const icons: Record<string, ReactNode> = { 'key-round': <KeyRound />, building: <Building2 />, users: <Users />, mail: <Mail />, activity: <Activity />, send: <Send />, 'check-circle': <CheckCircle2 />, gauge: <Gauge />, camera: <Camera />, 'shield-check': <ShieldCheck />, 'scroll-text': <ScrollText />, trash: <Trash2 />, bell: <BellRing /> }
    const iconKey = str(props, 'icon')
    return (
      <EmptyState
        icon={iconKey ? icons[iconKey] : undefined}
        title={str(props, 'title') ?? ''}
        description={str(props, 'description')}
        action={renderer ? renderer((props.actionProps as Record<string, unknown>) ?? {}) : undefined}
      />
    )
  },
  'opportunity-kanban-board': (props) => {
    const statuses = (props.statuses as ComponentProps<typeof OpportunityKanbanBoard>['statuses']) ?? []
    const opportunities = (props.opportunities as ComponentProps<typeof OpportunityKanbanBoard>['opportunities']) ?? []
    const canManage = Boolean(props.canManage)
    const drawerSlot = (props.drawer as unknown[])?.length
      ? <Fragment>{(props.drawer as { widget?: string; props?: Record<string, unknown> }[]).map((d, i) => {
          const r = d.widget ? WIDGET_REGISTRY[d.widget] : undefined
          return r ? <Fragment key={i}>{r(d.props ?? {})}</Fragment> : null
        })}</Fragment>
      : undefined
    return (
      <OpportunityKanbanBoard
        statuses={statuses}
        opportunities={opportunities}
        canManage={canManage}
        drawerSlot={drawerSlot}
      />
    )
  },
  /**
   * The universal record list. `drawer` and `emptyAction` name widgets, one or
   * several, exactly as `entity-list-view` does. `rowActions` names ONE widget
   * rendered per row: `renderRowActions` is a function, and a spec can never
   * carry a function, so the registry builds it from the ref here.
   */
  'record-list-view': (props) => {
    const one = (value: unknown, key: number) => {
      if (!value || typeof value !== 'object') return null
      const ref = value as { widget?: string; props?: Record<string, unknown> }
      const renderer = ref.widget ? WIDGET_REGISTRY[ref.widget] : undefined
      if (ref.widget && !renderer) throw new UnknownWidgetError(ref.widget)
      return renderer ? <Fragment key={key}>{renderer(ref.props ?? {})}</Fragment> : null
    }
    const slot = (value: unknown) => {
      if (Array.isArray(value)) {
        const rendered = value.map(one).filter(Boolean)
        return rendered.length > 0 ? <>{rendered}</> : undefined
      }
      return one(value, 0) ?? undefined
    }
    const rowActionsRef =
      props.rowActions && typeof props.rowActions === 'object'
        ? (props.rowActions as { widget?: string; props?: Record<string, unknown> })
        : undefined
    const rowActionsRenderer = rowActionsRef?.widget ? WIDGET_REGISTRY[rowActionsRef.widget] : undefined
    if (rowActionsRef?.widget && !rowActionsRenderer) throw new UnknownWidgetError(rowActionsRef.widget)
    return (
      <RecordListSlot
        recordType={str(props, 'recordType') ?? ''}
        basePath={str(props, 'basePath') ?? ''}
        sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
        drawer={slot(props.drawer)}
        emptyAction={slot(props.emptyAction)}
        renderRowActions={
          rowActionsRenderer
            ? (row) =>
                rowActionsRenderer({
                  ...(rowActionsRef?.props ?? {}),
                  id: row.id,
                  status: row.status,
                  kind: row.kind,
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
  'entity-list-view': (props) => {
    const one = (value: unknown, key: number) => {
      if (!value || typeof value !== 'object') return null
      const ref = value as { widget?: string; props?: Record<string, unknown> }
      const renderer = ref.widget ? WIDGET_REGISTRY[ref.widget] : undefined
      if (ref.widget && !renderer) throw new UnknownWidgetError(ref.widget)
      return renderer ? <Fragment key={key}>{renderer(ref.props ?? {})}</Fragment> : null
    }
    // A slot may name one widget or several — a project list's drawer slot
    // holds a create-redirect, the record flyout and a transaction flyout, the
    // same fragment the page passed.
    const slot = (value: unknown) => {
      if (Array.isArray(value)) {
        const rendered = value.map(one).filter(Boolean)
        return rendered.length > 0 ? <>{rendered}</> : undefined
      }
      return one(value, 0) ?? undefined
    }
    return (
      <EntityListSlot
        recordType={str(props, 'recordType') ?? ''}
        sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
        drawer={slot(props.drawer)}
        emptyAction={slot(props.emptyAction)}
      />
    )
  },
  ...PAYROLL_WIDGETS,
  ...BANKING_WIDGETS,
  ...REPORTING_WIDGETS,
  ...ASSETS_TAX_WIDGETS,
  ...COMMERCE_WIDGETS,
  ...PLATFORM_WIDGETS,
  ...SETUP_WIDGETS,
  ...AGENTS_WIDGETS,
  ...HOME_WIDGETS,
  ...HRM_WIDGETS,
  // HR-17: continuous-performance family (1:1s, feedback, calibration,
  // talent, succession) composes beside its parent family.
  ...HRM_CONTINUOUS_WIDGETS,
  // HR-15: persona-home widgets (inbox task list, dashboard persona tiles).
  ...PERSONA_WIDGETS,
  ...OPERATIONS_WIDGETS,
  ...RECORDS_WIDGETS,
  ...CONTROLS_WIDGETS,
}

export class UnknownWidgetError extends Error {
  readonly name = 'UnknownWidgetError'
}
