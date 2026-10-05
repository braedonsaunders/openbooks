import 'server-only'

import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { getTranslations } from 'next-intl/server'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'

export interface OssData {
  setupHref: string
}

/**
 * One-Stop-Shop returns: quarterly Union/non-Union and monthly IOSS returns
 * from posted cross-border supplies. Gated page (reports read plus the
 * crossBorderTax feature); the console prepares, reviews and exports.
 */
export async function loadOss(): Promise<OssData> {
  const authz = await requirePermission('reports.read')
  await requireFeatureEnabled(authz.user.orgId, 'crossBorderTax')
  await getTranslations('tax')
  return { setupHref: '/admin/setup/tax-oss-registrations' }
}

export function ossSpec(data: OssData): PageSpec {
  return page({
    route: '/tax/oss',
    layout: 'bare',
    header: [],
    body: [widgetBlock('oss-console', { setupHref: data.setupHref })],
  })
}
