import 'server-only'

import { page, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { getTranslations } from 'next-intl/server'
import { dataWorkspaceNavigation } from '../../../../lib/setup/data-workspace'

/** File import permissions are checked server-side; the wizard loads its resources client-side. */
export interface DataImportData {
  backHref: string
  backLabel: string
}

export async function loadDataImport(): Promise<DataImportData> {
  const authz = await requirePermission('data.import')
  const t = await getTranslations()
  const navigation = dataWorkspaceNavigation(authz.permissions)
  return { backHref: navigation.backHref, backLabel: t(navigation.backLabelKey) }
}

const f = ref<DataImportData>()

export function dataImportSpec(): PageSpec {
  return page({
    route: '/data/import',
    // The wizard owns its header, progress, scroll region, and footer.
    layout: 'bare',
    body: [
      widgetBlock('import-wizard', { backHref: f('backHref'), backLabel: f('backLabel') }),
    ],
  })
}
