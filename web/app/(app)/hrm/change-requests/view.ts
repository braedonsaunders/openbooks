import 'server-only'

import { registeredListTable } from '../../../../lib/list/prepared-spec'
import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  field as item,
  link,
  page,
  pageHeader,
  ref,
  rootRef,
  text,
  textBlock,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import {
  loadChangeRequestQueue,
  type ChangeRequestQueueData,
} from '../../../../lib/hrm/change-requests'

/**
 * Employment change requests use the shared list-page layout and registered
 * table. Status filters share the table's search toolbar, matching the
 * employee list, and the shared page layout owns the sibling view tabs.
 * The domain reader retains authorization, bounded reads and refusal data.
 */

const f = ref<ChangeRequestQueueData>()
const rootF = rootRef<ChangeRequestQueueData>()

export function changeRequestQueueSpec(data: ChangeRequestQueueData): PageSpec {
  const columns = [
    column(
      f('columns.employee'),
      link(item('employeeLabel'), item('employeeHref')),
    ),
    column(f('columns.kind'), text(item('kindLabel'))),
    column(
      f('columns.effective'),
      text(item('effectiveWindow'), { className: 'tabular-nums' }),
    ),
    column(f('columns.requester'), text(item('requesterLabel'))),
    column(
      f('columns.submitted'),
      text(item('submittedLabel'), { className: 'tabular-nums' }),
    ),
    column(
      f('statusHeader'),
      badge(item('statusLabel'), { variant: item('statusVariant') }),
    ),
    // Classification is absent for unclassified requests; only non-apply
    // events carry a verb chip.
    column(f('actionHeader'), text(item('actionDisplay'))),
    // Verb chips render through a conditional cell (null = no chip), the
    // same conditional-pair pattern as the flows last-run cell.
    column(
      f('verbHeader'),
      widgetCell('hrm-verb-chip', { label: item('verbLabel') }),
    ),
    // Every row opens its request-detail drawer (?request=<id>),
    // using a keyboard-accessible link to its shareable URL.
    column('', link(item('openLabel'), item('requestHref'))),
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
          // This column only renders inside the gated branch, so
          // the grant travels explicitly rather than by implication.
          canManage: rootF('canManage'),
          // Verb buttons need their own approve permission,
          // which the manage grant alone does not imply.
          canVerb: rootF('canVerb'),
        }),
      ),
    )
  }
  return page({
    route: '/hrm/change-requests',
    layout: 'list',
    bodyClassName: 'space-y-3',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget(
            'link-button',
            {
              href: f('proposeHref'),
              label: f('proposeButton'),
              iconKey: 'plus',
            },
            f('canManage'),
          ),
          // Reason-code setup belongs beside the queue.
          widget(
            'link-button',
            {
              href: f('reasonsHref'),
              label: f('reasonsLabel'),
              iconKey: 'tag',
              variant: 'outline',
            },
            f('canEditReasons'),
          ),
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
        ...registeredListTable(
          'hrm_change_requests',
          {
            variant: 'app',
            rows: f('rows'),
            rowKey: item('id'),
            columns,
            empty: {
              title: f('emptyTitle'),
              description: f('emptyDescription'),
            },
          },
          [
            widget('list-toolbar', {
              basePath: '/hrm/change-requests',
              currentParams: data.currentParams,
              filters: [
                {
                  paramKey: 'status',
                  label: data.segmentsLabel,
                  allLabel: data.allLabel,
                  options: data.segments,
                },
              ],
            }),
          ],
        ),
        when: f('hasContent'),
      },
      // Keep the bounded-read notice visible even when search matches no rows.
      textBlock(f('truncatedNote'), {
        size: 'xs',
        tone: 'muted',
        className: 'mt-3',
        when: f('truncated'),
      }),
      ...(data.hasContent
        ? [
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
            // The drawer reuses the same lifecycle actions and explicit grants.
            widgetBlock(
              'hrm-change-request-dialog',
              {
                requestId: f('dialogRequestId'),
                closeHref: f('dialogCloseHref'),
                subject: f('dialogSubject'),
                departmentOptions: f('departmentOptions'),
                canManage: f('canManage'),
                canVerb: f('canVerb'),
              },
              f('dialogOpen'),
            ),
          ]
        : []),
      // Reason-code setup is rehomed on this route (?reasons=1).
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
