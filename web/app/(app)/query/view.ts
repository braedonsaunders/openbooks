import 'server-only'

import { notFound } from 'next/navigation'
import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'

/**
 * The SQL console, split into a loader and a spec.
 *
 * This page is the degenerate case of the brief's vocabulary: a fully
 * client-side workbench (`'use client'` — editor, rail, results grid, every
 * fetch) with zero server-rendered content. The LOADER reproduces the
 * `layout.tsx` gates verbatim (`sql.execute` permission, `queryConsole`
 * feature flag — both verified against the page's GATES in the registry entry
 * §2, because the harness tenant 404s here today) and returns no
 * presentation data, because there is none: every string the page shows is
 * read by the component itself through `useTranslations`, every row arrives
 * over `/api/query` after mount. The spec places the whole console through
 * the `query-console` widget, exactly as a studio (CardStudio, ViewStudio)
 * is placed: the spec composes pages, it does not reimplement domain
 * components.
 *
 * The native component is NOT copied. It lives in `sections.tsx` (moved
 * there from `page.tsx` so there is one implementation), and
 * the registry entry renders it directly with no props.
 */

/** No server-rendered content: the loader runs the gates and binds nothing. */
export type QueryData = Record<string, unknown>

export async function loadQuery(
  _sp: Record<string, string | string[] | undefined>,
): Promise<QueryData> {
  // layout.tsx gates, verbatim: permission first, then feature flag.
  const authz = await requirePermission('sql.execute')
  if (!(await isFeatureEnabled(authz.user.orgId, 'queryConsole'))) notFound()
  return {}
}

export function querySpec(_data: QueryData): PageSpec {
  return page({
    route: '/query',
    // Bare: the console owns its own full-height flex column (the native root
    // is `flex h-full min-h-0 flex-col` under the app shell's <main>), so no
    // ListPageLayout chrome may wrap it.
    layout: 'bare',
    header: [],
    body: [widgetBlock('query-console')],
  })
}
