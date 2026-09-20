import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  grid,
  field as item,
  page,
  pageHeader,
  panel,
  ref,
  rootRef,
  table,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { loadMeChecklists, type MeChecklistsData } from '../../../../lib/hrm/self-service'

/**
 * Me checklists — my process steps in the shared `table` block with the
 * complete action in a row-action island. Completion rides the existing
 * step endpoint (the evidence rules are unchanged); the island renders
 * the service refusal inline with its remedy intact.
 */

const f = ref<MeChecklistsData>()
const rootF = rootRef<MeChecklistsData>()

export function meChecklistsSpec(data: MeChecklistsData): PageSpec {
  return page({
    route: '/me/checklists',
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
      widgetBlock(
        'empty-state',
        {
          title: data.refusal?.title ?? '',
          description: data.refusal?.message,
        },
        f('refusal'),
      ),
      {
        ...grid('flex h-full min-h-0 flex-col gap-4', [
          panel({
            title: f('listTitle'),
            iconKey: 'list-checks',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            className: 'min-h-0 flex-1',
            blocks: [
              table({
                variant: 'app',
                rows: f('rows'),
                rowKey: item('id'),
                columns: [
                  column(f('columns.title'), text(item('title'))),
                  column(f('columns.process'), text(item('processKind'))),
                  column(
                    f('columns.due'),
                    text(item('dueOn'), { className: 'tabular-nums' }),
                  ),
                  column(f('columns.required'), text(item('requiredLabel'))),
                  column(f('columns.evidence'), text(item('evidenceLabel'))),
                  column(
                    f('columns.status'),
                    badge(item('statusLabel'), { variant: item('statusVariant') }),
                  ),
                  column(
                    '',
                    widgetCell('hrm-step-complete', {
                      stepId: item('id'),
                      label: item('completeLabel'),
                      failedLabel: rootF('completeFailed'),
                    }),
                  ),
                ],
                empty: { title: f('emptyTitle'), description: f('emptyDescription') },
              }),
            ],
          }),
        ]),
        when: f('hasContent'),
      },
    ],
  })
}

export async function loadMeChecklistsPage(): Promise<MeChecklistsData> {
  const authz = await requirePermission('hrm.self.read')
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  return loadMeChecklists(authz)
}

export async function meChecklistsTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('me.checklists.title')
}
