import { LogoLoader } from '../../components/brand-logo'

// In-shell route fallback: the sidebar/header stay put; the content pane shows
// the mark writing itself in while the page streams.
//
// Deliberately NOT <SplashHold />. This file is the Suspense fallback for the
// whole authenticated group, so it mounts on every in-app navigation that
// suspends; holding the full-screen brand splash here replayed the draw-in on
// each one. The splash is the first-load reveal only — see the `played` latch
// in components/brand-splash.tsx, which also guards this from regressing.
export default function AppLoading() {
  return <LogoLoader />
}
