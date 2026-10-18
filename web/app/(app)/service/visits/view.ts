import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requireServiceArea } from '../../../../lib/service/pages'

/**
 * Service visits: the universal entity list for `service_visit` with the
 * service record host as its drawer. The host reads `?visit=` (and the other
 * service record parameters) and loads the record client-side, so opening a
 * row keeps the list mounted.
 */
export interface ServiceVisitsData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  canCreate: boolean
  newLabel: string
}

export async function loadServiceVisits(sp: Record<string, string | string[] | undefined>): Promise<ServiceVisitsData> {
  await requireServiceArea()
  const t = await getTranslations('service')
  return {
    title: t('pages.visits.title'),
    description: t('pages.visits.description'),
    currentParams: sp,
    canCreate: false,
    newLabel: t('pages.visits.new'),
  }
}

const f = ref<ServiceVisitsData>()

export function serviceVisitsSpec(data: ServiceVisitsData): PageSpec {
  return page({
    route: '/service/visits',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('service-new-button', { kind: '', label: data.newLabel }, f('canCreate'))],
      }),
    ],
    body: [
      widgetBlock('entity-list-view', {
        recordType: 'service_visit',
        sp: data.currentParams,
        drawer: { widget: 'service-record-host', props: {} },
      }),
    ],
  })
}
