import { existsSync } from 'node:fs'
import type { ResolveFnOutput, ResolveHookContext } from 'node:module'

/**
 * Resolve app modules the way the bundler does, for tests that import a page.
 *
 * Several integration tests import a real `page.tsx` and render it, which is
 * the only way to prove a page applies the caller's scope before it queries.
 * They each registered a small `resolve` hook to make `@/…` work under a plain
 * node process.
 *
 * The ViewSpec conversion changed what importing a page costs. A page is now
 * four lines that import `ModuleView`, and `ModuleView` reaches the widget
 * registry — every widget the app has, and with them a much wider graph than
 * any single page used to pull: `.tsx` components behind `@/` specifiers that
 * the hand-rolled hooks resolved as `.ts`, and stylesheets that node has no
 * loader for at all. The tests did not stop being right; they stopped being
 * able to load.
 *
 * So the resolution rules live here once. A bespoke hook per test was fine
 * while each page's graph was small and local; it is the wrong shape now that
 * every page shares one graph, because a component added to the registry would
 * otherwise break a different set of tests each time.
 *
 * Returns `null` when it has nothing to say, so a caller keeps its own stubs
 * (the session shim, the i18n shim) and delegates only the mechanical part.
 */
export function resolveAppModule(
  specifier: string,
  context: ResolveHookContext,
  next: (specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput,
  root: string,
): ResolveFnOutput | null {
  // Stylesheets and other assets are bundler concerns. A component that
  // imports one is asking for a side effect node cannot perform and the test
  // does not need — there is nothing to assert about CSS in a scope test.
  if (/\.(?:css|scss|sass|less|svg|png|jpe?g|gif|webp|woff2?)$/.test(specifier)) {
    return { shortCircuit: true, url: 'data:text/javascript,export default {}' }
  }
  if (!specifier.startsWith('@/')) return null

  // `@/x` is a path, not a file: the extension is the bundler's to find. Try
  // the same candidates it does, in the same order.
  const base = root + 'web/' + specifier.slice(2)
  for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (existsSync(new URL(base + suffix))) return next(base + suffix, context)
  }
  // Nothing matched — hand back the bare path so the failure names the module
  // the source actually asked for rather than a candidate this invented.
  return next(base, context)
}
