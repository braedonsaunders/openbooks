import 'server-only'

import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'

/**
 * The client console owns ListPageLayout and PageHeader because connection
 * management permissions arrive with the API payload. The spec delegates to
 * that shared shell without nesting a second scroll container. Connection
 * writes and sync actions remain guarded by their API permissions.
 */

export type SyncData = Record<string, never>

export async function loadSync(): Promise<SyncData> {
  return {}
}

export function syncSpec(): PageSpec {
  return page({
    route: '/sync',
    layout: 'bare',
    header: [],
    body: [widgetBlock('sync-console')],
  })
}
