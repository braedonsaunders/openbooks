import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  column,
  field as item,
  page,
  pageHeader,
  panel,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { getAuthz } from '../../../../lib/authz'
import { loadMyCompensation } from '../../../../lib/hrm/compensation'

/**
 * My compensation — band placement, statements with PDFs, and the
 * pay-information request action with the open request's status.
 * Renders only when hrmCompensation is on and the person has a band or
 * a statement — the loader 404s otherwise.
 */

const f = item

export function myCompSpec(data: NonNullable<Awaited<ReturnType<typeof loadMyCompensation>>>): PageSpec {
  return page({
    route: '/me/compensation',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      panel({
        title: f('placementLabel'),
        blocks: [widgetBlock('hrm-placement-summary', { placement: f('placement'), compaRatio: f('compaRatio'), bandRange: f('bandRange') })],
      }),
      panel({
        title: f('statementsTitle'),
        bodyClassName: 'min-h-0 overflow-y-auto p-0',
        blocks: [
          table({
            variant: 'app',
            rows: f('statements'),
            rowKey: item('id'),
            empty: { title: f('statementsEmpty') },
            columns: [column('period', text(item('period'))), column('generated', text(item('generated')))],
          }),
        ],
      }),
      widgetBlock('hrm-pay-info-request', {
        employmentId: f('employmentId'),
        requestLabel: f('requestLabel'),
        requestStatus: f('requestStatus'),
        failed: f('requestFailed'),
        submit: f('requestSubmit'),
        cancel: f('requestCancel'),
      }),
    ],
  })
}

export async function myCompTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('myComp.title')
}

export async function loadMyCompPage(sp: Record<string, string | undefined>) {
  const authz = await getAuthz()
  if (!authz) notFound()
  const data = await loadMyCompensation(authz)
  if (!data || !data.hasContent) notFound()
  void sp
  return data
}
