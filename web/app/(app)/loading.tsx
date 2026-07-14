import { LogoLoader } from '../../components/brand-logo'

// In-shell route fallback: the sidebar/header stay put; the content pane
// shows the mark writing itself in while the page streams.
export default function Loading() {
  return <LogoLoader />
}
