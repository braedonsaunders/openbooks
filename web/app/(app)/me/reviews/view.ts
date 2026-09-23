import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  grid,
  field as item,
  link,
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
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { loadMeReviews, type MeReviewsData } from '../../../../lib/hrm/self-service'

/**
 * Me reviews — the person's own review cycles: owed self-assessments
 * (answering rides the existing performance drawer through row links),
 * manager reviews shared with them with the acknowledge action, and
 * their own goals with progress. No calibration ever renders here: the
 * loader strips it before the spec is built. Renders only when the hrm
 * feature gate is on and the actor holds hrm.self.read.
 */

const f = ref<MeReviewsData>()
const rootF = rootRef<MeReviewsData>()

export function meReviewsSpec(data: MeReviewsData): PageSpec {
  return page({
    route: '/me/reviews',
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
            title: f('selfTitle'),
            iconKey: 'star',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [
              table({
                variant: 'app',
                rows: f('selfRows'),
                rowKey: item('reviewId'),
                columns: [
                  column(f('selfColumns.cycle'), text(item('cycleName'))),
                  column(f('selfColumns.period'), text(item('periodLabel'), { className: 'tabular-nums' })),
                  column(
                    f('selfColumns.due'),
                    text(item('dueOn'), { className: 'tabular-nums' }),
                  ),
                  column(
                    f('selfColumns.status'),
                    badge(item('statusLabel'), { variant: item('statusVariant') }),
                  ),
                  column('', link(item('openLabel'), item('openHref'))),
                ],
                empty: { title: f('selfEmpty'), description: f('selfEmptyDescription') },
              }),
            ],
          }),
          panel({
            title: f('sharedTitle'),
            iconKey: 'message-square',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [
              table({
                variant: 'app',
                rows: f('sharedRows'),
                rowKey: item('reviewId'),
                columns: [
                  column(f('sharedColumns.cycle'), text(item('cycleName'))),
                  column(
                    f('sharedColumns.status'),
                    badge(item('statusLabel'), { variant: item('statusVariant') }),
                  ),
                  column(f('sharedColumns.rating'), text(item('ratingLabel'), { className: 'tabular-nums' })),
                  column(
                    f('sharedColumns.shared'),
                    text(item('sharedOn'), { className: 'tabular-nums' }),
                  ),
                  column(
                    '',
                    widgetCell('hrm-review-acknowledge', {
                      reviewId: item('reviewId'),
                      label: item('acknowledgeLabel'),
                      canAcknowledge: item('canAcknowledge'),
                      failedLabel: rootF('acknowledgeFailed'),
                    }),
                  ),
                ],
                empty: { title: f('sharedEmpty'), description: f('sharedEmptyDescription') },
              }),
            ],
          }),
          panel({
            title: f('goalsTitle'),
            iconKey: 'target',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [
              table({
                variant: 'app',
                rows: f('goalRows'),
                rowKey: item('id'),
                columns: [
                  column(f('goalsColumns.title'), text(item('title'))),
                  column(
                    f('goalsColumns.due'),
                    text(item('dueOn'), { className: 'tabular-nums' }),
                  ),
                  column(
                    f('goalsColumns.status'),
                    badge(item('statusLabel'), { variant: item('statusVariant') }),
                  ),
                  column(f('goalsColumns.progress'), text(item('progressLabel'), { className: 'tabular-nums' })),
                  column('', link(item('updateLabel'), item('updateHref'))),
                ],
                empty: { title: f('goalsEmpty'), description: f('goalsEmptyDescription') },
              }),
            ],
          }),
          widgetBlock(
            'hrm-goal-dialog',
            {
              dialog: data.goalDialog,
              closeHref: data.goalDialogCloseHref,
            },
            f('goalDialogOpen'),
          ),
        ]),
        when: f('hasContent'),
      },
    ],
  })
}

export async function loadMeReviewsPage(
  sp: Record<string, string | undefined> = {},
): Promise<MeReviewsData> {
  const authz = await requirePermission('hrm.self.read')
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  return loadMeReviews(authz, sp)
}

export async function meReviewsTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('me.reviews.title')
}
