import 'server-only'

import { page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { loadApiSchema, type ApiRecordTypeSchema } from '../../../lib/api/schema-registry'

/**
 * API docs + interactive REST console, split into a loader and a spec.
 *
 * This page is the degenerate case of the brief's vocabulary, the same as
 * /query: a fully client-side workbench (`'use client'` — record-type rail,
 * fields reference, request builder, response panel, every fetch) with zero
 * server-rendered content. The LOADER reproduces the native page's gates
 * verbatim (`api.keys.manage` permission, `apiAccess` feature flag) and binds
 * the live schema — the same plain-data prop the native page hands the
 * component ("The schema is plain data — safe to hand to the client"). Every
 * string the page shows is read by the component itself through
 * `useTranslations('apiDocs')`; every row of the reference arrives in that
 * prop. The spec places the whole console through the `api-console` widget,
 * exactly as a studio (CardStudio, ViewStudio) or the `query-console` is
 * placed: the spec composes pages, it does not reimplement domain components.
 *
 * The native component is NOT copied. It already lives in its own module
 * (`./ApiConsole`, not defined in `page.tsx`), so the page and the widget registry share one
 * implementation with no `sections.tsx` to move it into. Never write a second
 * copy.
 */

export interface ApiDocsData {
  schema: ApiRecordTypeSchema[]
}

export async function loadApiDocs(
  _sp: Record<string, string | string[] | undefined>,
): Promise<ApiDocsData> {
  // Native gates, verbatim: permission first, then feature flag.
  const authz = await requirePermission('api.keys.manage')
  await requireFeatureEnabled(authz.user.orgId, 'apiAccess')
  // The console owns the full-height workbench (record-type rail + reference +
  // interactive runner). The schema is plain data — safe to hand to the client.
  const schema = await loadApiSchema(authz.user.orgId)
  return { schema }
}

export function apiDocsSpec(data: ApiDocsData): PageSpec {
  return page({
    // Bare: the console owns its own full-height flex column (the native root
    // is `flex h-full min-h-0 flex-col` under the app shell's <main>), so no
    // ListPageLayout chrome may wrap it.
    layout: 'bare',
    header: [],
    body: [widgetBlock('api-console', { schema: data.schema })],
  })
}
