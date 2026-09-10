import type { PageSpec, ViewData } from '@openbooks/viewspec'
import { validateSpec } from '@openbooks/viewspec'
import { ListPageLayout, DetailPageLayout } from '../page-layout'
import { BlockList } from './blocks'

/**
 * ModuleView — the single entry point that turns a spec plus its loader data
 * into a rendered page.
 *
 * Native pages pass a spec built by the typed builders, which the compiler has
 * already checked; `trusted` skips revalidation for them so the hot path costs
 * nothing. A tenant- or agent-authored spec arrives as data and is validated
 * here before a single block renders — fail closed, with the errors surfaced
 * rather than swallowed, because a spec that silently renders half a page is
 * worse than one that visibly refuses.
 */
export function ModuleView({
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
