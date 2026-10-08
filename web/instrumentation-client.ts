import { installHistoryTraversalTransitions } from './components/route-transitions'
import { installViewTransitionAbortFilter } from './components/view-transition-abort'
import { beginNavigationPending } from './lib/navigation-pending'

// Runs before the app hydrates, so browser back and forward reach the route
// transition ahead of the router's own `popstate` listener, and a skipped
// view transition is filtered before any error handler sees it.
installHistoryTraversalTransitions()
installViewTransitionAbortFilter()

export function onRouterTransitionStart(href: string) {
  beginNavigationPending(href)
}
