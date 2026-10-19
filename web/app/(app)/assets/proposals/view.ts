import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import type { ProposalsData } from './_data'

const f = ref<ProposalsData>()

export function proposalsSpec(data: ProposalsData): PageSpec {
  return page({
    route: '/assets/proposals',
    layout: 'list',
    header: [pageHeader({
      title: f('title'),
      description: f('description'),
      actions: [widget('module-home-tabs', { tabs: data.tabs })],
    })],
    body: [widgetBlock('asset-proposals-workspace', { data, currentParams: data.currentParams })],
  })
}
