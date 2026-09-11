import type { PageSpec, ViewData } from '@openbooks/viewspec'
import { validateSpec } from '@openbooks/viewspec'
import { getAuthz } from '../../lib/authz'
import { loadPageSpec } from '../../lib/page-specs'
import { ListPageLayout, DetailPageLayout } from '../page-layout'
import { BlockList } from './blocks'
import { FRAME_NAMES, WIDGET_NAMES } from './registry-names'
import { SpecBoundary } from './spec-boundary'

/**
 * ModuleView — the single entry point that turns a spec plus its loader data
 * into a rendered page.
 *
 * The spec a page passes is its BUILT-IN one, compiled and type-checked;
 * `trusted` skips revalidation for it so the hot path costs nothing. If the
 * spec declares a `route`, a tenant may have stored their own layout for that
 * route, and that one renders instead — validated against the closed schema
 * and the host registries before a single block renders.
 *
 * The substitution is safe because of what a spec is, not because of anything
 * checked here. A spec names blocks and binds fields the page's LOADER already
 * resolved; it carries no conditionals, no arithmetic, no function values, no
 * component references and no capability objects. Swapping one changes the
 * arrangement of data the reader was already entitled to see. It cannot reach
 * further, because there is no further to reach: the loader ran first, under
 * the caller's own permissions, and the spec only ever reads its output.
 *
 * A tenant spec that fails to validate is IGNORED and the built-in renders.
 * That is the one place this file does not fail closed, and it is deliberate:
 * the fallback is a correct, complete page, and refusing to render would
 * punish a reader for an author's mistake. The reason is logged. An invalid
 * spec passed directly — by a test, or an agent calling this component —
 * still surfaces its errors, because there is no built-in to fall back to.
 *
 * The same bargain covers a layout that validates and then THROWS. Widget
 * props are `Record<string, unknown>` by design, so a tenant can bind the
 * wrong shape to a widget that expects a particular one; validation cannot
 * see that, and the component fails at render. `SpecBoundary` catches it and
 * renders the built-in page instead of the app error screen.
 */
export async function ModuleView({
  spec,
  data,
  searchParams,
  trusted = false,
}: {
  spec: PageSpec
  data: ViewData
  searchParams: Record<string, string | string[] | undefined>
  /** Set for compiler-checked native specs to skip runtime revalidation. */
  trusted?: boolean
}) {
  if (!trusted) {
    const result = validateSpec(spec)
    if (!result.ok) {
      return (
        <div className="m-4 rounded-md border border-red-300 bg-red-50 p-4 text-sm dark:border-red-800 dark:bg-red-950/40">
          <p className="font-semibold text-red-700 dark:text-red-300">This view could not be rendered.</p>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-red-600 dark:text-red-400">
            {result.errors.slice(0, 10).map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        </div>
      )
    }
  }

  const effective = await resolveSpec(spec)
  if (effective === spec) return render(spec, data, searchParams)
  // A tenant layout is rendered inside a boundary whose fallback is the page
  // the app shipped. Both subtrees are built here: the fallback has to exist
  // before the boundary can use it.
  return (
    <SpecBoundary fallback={render(spec, data, searchParams)}>
      {render(effective, data, searchParams)}
    </SpecBoundary>
  )
}

function render(
  spec: PageSpec,
  data: ViewData,
  searchParams: Record<string, string | string[] | undefined>,
) {
  const header = <BlockList blocks={spec.header} scope={data} searchParams={searchParams} />
  const body = <BlockList blocks={spec.body} scope={data} searchParams={searchParams} />
  // `bare` exists for pages that already sit INSIDE a shell — the setup
  // workspace renders its own sticky header and container, and wrapping its
  // pages in a second ListPageLayout would nest the chrome. A bare spec owns
  // its own outer element, so `header` and `body` are simply concatenated.
  if (spec.layout === 'bare') {
    return (
      <>
        {header}
        {body}
      </>
    )
  }
  const Layout = spec.layout === 'detail' ? DetailPageLayout : ListPageLayout
  return (
    <Layout header={header} className={spec.bodyClassName}>
      {body}
    </Layout>
  )
}

/**
 * The tenant's spec for this route, or the built-in one.
 *
 * The org comes from the SESSION, never from the spec or the request. A spec
 * that could name an org id is a cross-tenant read, which is the same rule
 * that puts the entity lists behind slots.
 */
async function resolveSpec(builtIn: PageSpec): Promise<PageSpec> {
  if (!builtIn.route) return builtIn
  const authz = await getAuthz()
  if (!authz) return builtIn
  const stored = await loadPageSpec(authz.user.orgId, builtIn.route, {
    widgets: WIDGET_NAMES,
    frames: FRAME_NAMES,
  })
  return stored?.spec ?? builtIn
}
