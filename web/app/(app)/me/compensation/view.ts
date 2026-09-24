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
import { loadMyCompensation, myCompRefusal } from '../../../../lib/hrm/compensation'

/**
 * My compensation — band placement, statements with PDFs, and the
 * pay-information request action with the open request's status.
 * Renders when hrmCompensation is on: a linked person with no band and
 * no statement reads the explicit empty state (the request below is the
 * next step), and a login with no employment reads the named no-link
 * refusal — neither is an ambiguous 404.
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
      // Unlinked login: the loader carries the refusal with its remedy
      // (the shared mechanism, same as /me, documents, surveys and the
      // clock).
      widgetBlock(
        'empty-state',
        {
          title: data.refusal?.title ?? '',
          description: data.refusal?.message,
        },
        f('refusal'),
      ),
      // Linked but no band and no statement: the explicit empty state —
      // the pay-information request below is the next step.
      widgetBlock(
        'empty-state',
        {
          title: data.emptyTitle,
          description: data.emptyDescription,
        },
        f('showEmpty'),
      ),
      {
        ...panel({
          title: f('placementLabel'),
          blocks: [widgetBlock('hrm-placement-summary', { placement: f('placement'), compaRatio: f('compaRatio'), bandRange: f('bandRange') })],
        }),
        when: f('hasContent'),
      },
      {
        ...panel({
          title: f('statementsTitle'),
          bodyClassName: 'min-h-0 overflow-y-auto p-0',
          blocks: [
            table({
              variant: 'app',
              rows: f('statements'),
              rowKey: item('id'),
              empty: { title: f('statementsEmpty') },
              columns: [
                column(f('statementsColumns.period'), text(item('period'))),
                column(f('statementsColumns.generated'), text(item('generated'))),
              ],
            }),
          ],
        }),
        when: f('hasContent'),
      },
      widgetBlock('hrm-pay-info-request', {
        employmentId: f('employmentId'),
        requestLabel: f('requestLabel'),
        requestStatus: f('requestStatus'),
        failed: f('requestFailed'),
        submit: f('requestSubmit'),
        cancel: f('requestCancel'),
      }, f('canRequest')),
    ],
  })
}

export async function myCompTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('myComp.title')
}

export async function loadMyCompPage(sp: Record<string, string | undefined>) {
  // The grant decides the route: without a session the route genuinely
  // does not exist for this caller (the same split as the sibling /me
  // documents and surveys loaders). The loader's null means no employment
  // resolves for this login (not linked): the page carries the named
  // no-link refusal with its remedy instead of an ambiguous 404. A linked
  // person with no band and no statement returns its row with hasContent
  // false, and the spec renders the empty state.
  const authz = await getAuthz()
  if (!authz) notFound()
  const data = await loadMyCompensation(authz)
  if (!data) return myCompRefusal(authz)
  void sp
  return data
}
