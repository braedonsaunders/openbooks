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
 * Applies a view selection (the state change or navigation a tab click
 * makes) as an animated view switch. A navigation started inside `update`
 * joins the same transition and carries the same type.
 */
export function switchView(update: () => void) {
  React.startTransition(() => {
    canary.addTransitionType?.(VIEW_SWITCH_TRANSITION)
    update()
  })
}
