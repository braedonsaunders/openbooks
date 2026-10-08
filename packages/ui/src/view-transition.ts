import * as React from 'react'

/** A view-transition class, or a class per transition type. */
export type ViewTransitionClass = string | Record<string, string>

export type ViewTransitionProps = {
  children?: React.ReactNode
  name?: string
  default?: ViewTransitionClass
  enter?: ViewTransitionClass
  exit?: ViewTransitionClass
  update?: ViewTransitionClass
  share?: ViewTransitionClass
}

// React's `<ViewTransition>` and `addTransitionType` ship in the canary
// channel, which the App Router renders with. Outside the App Router — unit
// tests render with the stable package — the boundary renders its children
// unchanged and a transition carries no type, which is exactly what a
// browser without the View Transitions API shows.
const canary = React as unknown as {
  ViewTransition?: React.ComponentType<ViewTransitionProps>
  addTransitionType?: (type: string) => void
}

/** React's `<ViewTransition>`, or a pass-through where React lacks it. */
export const ViewTransition: React.ComponentType<ViewTransitionProps> =
  canary.ViewTransition ?? (({ children }: ViewTransitionProps) => children)

/**
 * Transition type carried by a switch between views of the same page or
 * record — a tab, subtab or view selection. The page pane and the drawer
 * body animate an update of this type the way a page change animates; a
 * search, filter or sort update carries no type and stays still.
 */
export const VIEW_SWITCH_TRANSITION = 'view-switch'

/**
 * Transition type carried by every view switch made inside a drawer. A
 * drawer is portalled above the page but sits inside the page pane's React
 * tree, so the pane — and any drawer beneath this one — would otherwise be
 * captured as its own layer and painted over the drawer while it animates.
 * The pane and outer drawers resolve this type to no animation; only the
 * drawer that owns the switch animates its body, through its own type.
 */
export const DRAWER_VIEW_SWITCH_TRANSITION = 'drawer-view-switch'

/** The transition type of the nearest enclosing drawer's own view switches. */
export const DrawerViewSwitchContext = React.createContext<string | null>(null)

/** The type a drawer's body animates on: unique to that drawer instance. */
export function drawerViewSwitchType(drawerId: string): string {
  return `${DRAWER_VIEW_SWITCH_TRANSITION}:${drawerId}`
}

function startViewSwitch(types: readonly string[], update: () => void) {
  React.startTransition(() => {
    for (const type of types) canary.addTransitionType?.(type)
    update()
  })
}

/**
 * Applies a view selection (the state change or navigation a tab click
 * makes) as an animated view switch. A navigation started inside `update`
 * joins the same transition and carries the same type.
 */
export function switchView(update: () => void) {
  startViewSwitch([VIEW_SWITCH_TRANSITION], update)
}

/**
 * `switchView` for a component that may render inside a drawer. Inside a
 * drawer the switch animates only that drawer's body; elsewhere it animates
 * the page pane like `switchView`.
 */
export function useSwitchView(): (update: () => void) => void {
  const drawerType = React.useContext(DrawerViewSwitchContext)
  return React.useCallback(
    (update: () => void) =>
      startViewSwitch(drawerType ? [DRAWER_VIEW_SWITCH_TRANSITION, drawerType] : [VIEW_SWITCH_TRANSITION], update),
    [drawerType],
  )
}
