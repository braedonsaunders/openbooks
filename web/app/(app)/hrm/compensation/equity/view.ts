import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { field as f, page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { compensationAuthz, loadEquity } from '../../../../../lib/hrm/compensation'

export function equitySpec(data: NonNullable<Awaited<ReturnType<typeof loadEquity>>>): PageSpec {
  return page({
    route: '/hrm/compensation/equity',
    layout: 'bare',
    body: [
      widgetBlock('hrm-comp-equity-workspace', { data }),
      widgetBlock('hrm-comp-equity-dialog', { dialog: f('generateDialog') }, f('generateOpen')),
    ],
  })
}

export async function equityTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('equity.title')
}

export async function loadEquityPage(sp: Record<string, string | string[] | undefined>) {
  const authz = await compensationAuthz()
  if (!authz) notFound()
  const data = await loadEquity(authz, sp)
  if (!data) notFound()
  return data
}
