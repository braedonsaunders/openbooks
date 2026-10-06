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

/** Which way a view switch moves along its tab strip, so the incoming view
 *  can arrive from the side the reader moved toward. */
export const VIEW_FORWARD_TRANSITION = 'view-forward'
export const VIEW_BACK_TRANSITION = 'view-back'

/** The transition types for moving from tab `from` to tab `to` in a strip. */
export function viewSwitchTypes(from: number, to: number): string[] {
  return [VIEW_SWITCH_TRANSITION, to < from ? VIEW_BACK_TRANSITION : VIEW_FORWARD_TRANSITION]
}

/**
 * Applies a view selection (the state change or navigation a tab click
 * makes) as an animated view switch. A navigation started inside `update`
 * joins the same transition and carries the same type.
 */
export function switchView(update: () => void, types: string[] = [VIEW_SWITCH_TRANSITION]) {
  React.startTransition(() => {
    for (const type of types) canary.addTransitionType?.(type)
    update()
  })
}
