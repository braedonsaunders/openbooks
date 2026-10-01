import 'server-only'

import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'

/** File import permissions are checked server-side; the wizard loads its resources client-side. */
export type DataImportData = Record<string, never>

export async function loadDataImport(): Promise<DataImportData> {
  await requirePermission('data.import')
  return {}
}

export function dataImportSpec(): PageSpec {
  return page({
    route: '/data/import',
    // The wizard owns its header, progress, scroll region, and footer.
    layout: 'bare',
    body: [
      // The wizard takes no props: step state, file bytes, mapping and both
      // fetch flows all live inside the shared client component.
      widgetBlock('import-wizard', {}),
    ],
  })
}
