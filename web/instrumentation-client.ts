import { installHistoryTraversalTransitions } from './components/route-transitions'
import { installViewTransitionAbortFilter } from './components/view-transition-abort'

// Runs before the app hydrates, so browser back and forward reach the route
// transition ahead of the router's own `popstate` listener, and a skipped
// view transition is filtered before any error handler sees it.
installHistoryTraversalTransitions()
installViewTransitionAbortFilter()
