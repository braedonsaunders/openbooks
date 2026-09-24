import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  column,
  field,
  grid,
  page,
  pageHeader,
  table,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { loadMeSurveysHome, meSurveysAuthz } from '../../../../lib/hrm/me-surveys'

/**
 * Me open surveys: unanswered invitations with the respond link.
 * Renders when hrm and hrmSurveys are on — the loader 404s otherwise.
 */

const f = field
const item = field

export type MeSurveysPageData = NonNullable<Awaited<ReturnType<typeof loadMeSurveysHome>>>

export function meSurveysSpec(data: MeSurveysPageData): PageSpec {
  return page({
    route: '/me/surveys',
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
      // (the shared mechanism, same as /me and the clock).
      widgetBlock(
        'empty-state',
        {
          title: data.refusal?.title ?? '',
          description: data.refusal?.message,
        },
        f('refusal'),
      ),
      grid('flex h-full min-h-0 flex-col gap-4', [
        table({
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          empty: { title: f('empty') },
          columns: [
            column(data.columns.name, text(item('name'))),
            column(data.columns.closes, text(item('closes'), { fallback: '—' })),
            column('', widgetCell('hrm-me-survey-respond', {
              invitationId: item('id'),
              respondLabel: data.respondLabel,
              actionFailed: data.actionFailed,
              reissueFailed: data.reissueFailed,
            })),
          ],
        }),
      ]),
    ],
  })
}

export async function meSurveysTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('meSurveys.title')
}

export async function loadMeSurveysPage() {
  const authz = await meSurveysAuthz()
  if (!authz) notFound()
  return loadMeSurveysHome(authz)
}
