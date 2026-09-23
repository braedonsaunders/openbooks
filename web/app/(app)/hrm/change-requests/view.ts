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
  spanRow,
  table,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { loadChangeRequestQueue, type ChangeRequestQueueData } from '../../../../lib/hrm/change-requests'

/**
 * The org-wide employment change-request queue, split into a loader and a
 * spec.
 *
 * Follows the close-list archetype: the rows render through the shared
 * `table` block (variant 'app') over loader-resolved display cells, status
 * segments ride the shared `filter-chips` widget on the `status` search
 * param, and "Propose change" is the page-header primary action opening a
 * URL-param dialog. The list itself is loader-resolved through the existing
 * change-request service, newest first, with subsidiary scope enforced
 * inside it.
 */

const f = ref<ChangeRequestQueueData>()
const rootF = rootRef<ChangeRequestQueueData>()

export function changeRequestQueueSpec(data: ChangeRequestQueueData): PageSpec {
  const columns = [
    column(f('columns.employee'), link(item('employeeLabel'), item('employeeHref'))),
    column(f('columns.kind'), text(item('kindLabel'))),
    column(f('columns.effective'), text(item('effectiveWindow'), { className: 'tabular-nums' })),
    column(f('columns.requester'), text(item('requesterLabel'))),
    column(f('columns.submitted'), text(item('submittedLabel'), { className: 'tabular-nums' })),
    column(f('statusHeader'), badge(item('statusLabel'), { variant: item('statusVariant') })),
    // HR-16 begin: classification + verb chips (0227). actionDisplay is null
    // when unclassified (feature off); verbLabel only when not a plain apply.
    column(f('actionHeader'), text(item('actionDisplay'))),
    // Verb chips render through a conditional cell (null = no chip), the
    // same conditional-pair pattern as the flows last-run cell.
    column(
      f('verbHeader'),
      widgetCell('hrm-verb-chip', { label: item('verbLabel') }),
    ),
    // HR-16 end
  ]
  if (data.canManage) {
    columns.push(
      column(
        f('actionsHeader'),
        widgetCell('hrm-change-request-actions', {
          requestId: item('id'),
          requestStatus: item('status'),
          employmentId: item('employmentId'),
          appliedChangeId: item('appliedChangeId'),
          departmentOptions: rootF('departmentOptions'),
        }),
      ),
    )
  }
  return page({
    route: '/hrm/change-requests',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget(
            'link-button',
            { href: f('proposeHref'), label: f('proposeButton'), iconKey: 'plus' },
            f('canManage'),
          ),
          // HR-16 begin: rehomed reason-code setup beside the queue.
          widget(
            'link-button',
            { href: f('reasonsHref'), label: f('reasonsLabel'), iconKey: 'tag' },
            f('canEditReasons'),
          ),
          // HR-16 end
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      // A computed refusal (unknown segment, scope denial) renders with its
      // message intact — never a success, never an empty table.
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
          widgetBlock('filter-chips', {
            basePath: '/hrm/change-requests',
            currentParams: data.currentParams,
            paramKey: 'status',
            label: data.segmentsLabel,
            allLabel: data.allLabel,
            options: data.segments,
          }),
          panel({
            title: f('listTitle'),
            iconKey: 'clipboard-check',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            className: 'min-h-0 flex-1',
            blocks: [
              table({
                variant: 'app',
                rows: f('rows'),
                rowKey: item('id'),
                columns,
                empty: { title: f('emptyTitle'), description: f('emptyDescription') },
                ...(data.truncated
                  ? {
                      trailing: [
                        spanRow({
                          label: f('truncatedNote'),
                          labelColSpan: data.canManage ? 9 : 8,
                          labelClassName:
                            'text-center text-xs text-slate-400 dark:text-slate-500',
                          cells: [],
                        }),
                      ],
                    }
                  : {}),
              }),
              widgetBlock(
                'hrm-propose-change-dialog',
                {
                  departmentOptions: f('departmentOptions'),
                  employmentLabel: f('proposeEmploymentLabel'),
                  employmentPlaceholder: f('proposeEmploymentPlaceholder'),
                  emptyLabel: f('proposeEmpty'),
                  requestFailed: f('proposeFailed'),
                  closeHref: f('dialogCloseHref'),
                },
                f('proposeOpen'),
              ),
            ],
          }),
        ]),
        when: f('hasContent'),
      },
      // HR-16 begin: the rehomed reason-code setup section (?reasons=1).
      // Rendered by the generic setup surface over the hrm-action-reasons
      // registry entity; hidden while the feature is off or the viewer
      // cannot manage.
      {
        ...widgetBlock('setup-section', {
          entityKey: 'hrm-action-reasons',
          basePath: '/hrm/change-requests',
          sp: data.currentParams,
        }),
        when: f('showReasons'),
      },
      // HR-16 end
    ],
  })
}

export async function loadChangeRequestQueuePage(
  sp: Record<string, string | undefined>,
): Promise<ChangeRequestQueueData> {
  // The page gate lives here — where the route-gate scanner reads — and the
  // loader enforces nothing twice: it takes the authorized session as input.
  const authz = await requirePermission('hrm.employment.read')
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  return loadChangeRequestQueue(authz, sp)
}

export async function changeRequestQueueTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('queue.title')
}
