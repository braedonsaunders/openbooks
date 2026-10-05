import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { field as f, page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { compensationAuthz, loadCompensationHome } from '../../../../lib/hrm/compensation'

export function compensationSpec(data: NonNullable<Awaited<ReturnType<typeof loadCompensationHome>>>): PageSpec {
  return page({
    route: '/hrm/compensation',
    layout: 'bare',
    body: [
      widgetBlock('hrm-comp-workspace', { data }),
      widgetBlock('hrm-comp-cycle-dialog', { dialog: f('cycleDialog') }, f('cycleOpen')),
      widgetBlock('hrm-comp-plan-dialog', { dialog: f('planDialog') }, f('planOpen')),
    ],
  })
}

export async function compensationTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('compensation.title')
}

export async function loadCompensationPage(sp: Record<string, string | string[] | undefined>) {
  const authz = await compensationAuthz()
  if (!authz) notFound()
  const data = await loadCompensationHome(authz, sp)
  if (!data) notFound()
  return data
}
