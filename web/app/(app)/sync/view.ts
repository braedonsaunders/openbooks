import 'server-only'

import { page, widgetBlock, frame, type PageSpec } from '@openbooks/viewspec'

/**
 * Platform → Migrations & Mirror, split into a loader and a spec.
 *
 * This is the degenerate case, and the loader is honest about it: the native
 * page is `<PageContainer><PlatformClient /></PageContainer>` and nothing
 * else. There is no server-rendered header, no query, no gate in the page
 * itself (the `admin.setup.manage` gate lives in the API handlers both paths
 * hit identically). So the loader resolves nothing and the spec places one
 * widget inside the exact native shell.
 *
 * A first pass added a `pageHeader` here, on the reasonable-looking
 * assumption that a page like this has one. It does not — the console renders
 * its own header — and the conformance harness caught the extra block at node
 * 2. Worth stating plainly: the spec must reproduce what the page RENDERS,
 * not what a page of this kind usually looks like.
 *
 * The console carries no props. It fetches its own payload over
 * /api/platform/connections and reads its own `sync.*` keys through
 * `useTranslations`, exactly as the native branch does; a loader-resolved
 * string here would be a second copy that drifts from the catalog.
 */

export type SyncData = Record<string, never>

export async function loadSync(): Promise<SyncData> {
  return {}
}

export function syncSpec(_data: SyncData): PageSpec {
  return page({
    // Bare + `page-container`: the native page renders <PageContainer>, not
    // the sticky ListPageLayout chrome, so a `list` layout would nest a shell
    // the page never had.
    layout: 'bare',
    header: [],
    body: [frame('page-container', [widgetBlock('sync-console')])],
  })
}
