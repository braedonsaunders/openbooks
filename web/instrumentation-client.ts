import { installHistoryTraversalTransitions } from './components/route-transitions'

// Runs before the app hydrates, so browser back and forward reach the route
// transition ahead of the router's own `popstate` listener.
installHistoryTraversalTransitions()
