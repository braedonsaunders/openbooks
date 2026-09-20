import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  grid,
  page,
  pageHeader,
  panel,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { loadChangeRequestQueue, type ChangeRequestQueueData } from '../../../lib/hrm/change-requests'

/**
 * The org-wide employment change-request queue, split into a loader and a
 * spec.
 *
 * Follows the purchasing-cockpit archetype: ViewSpec composes the grid and
 * the panels; the queue body stays a component shared by the page and the
 * widget registry via ./QueueClient so they cannot drift. Status segments
 * ride the shared `filter-chips` widget on the `status` search param; the
 * list itself is loader-resolved through the existing change-request
 * service, newest first, with subsidiary scope enforced inside it.
 */

const f = ref<ChangeRequestQueueData>()

export function changeRequestQueueSpec(data: ChangeRequestQueueData): PageSpec {
  return page({
    route: '/hrm/change-requests',
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
              widgetBlock('hrm-change-request-queue', {
                rows: data.rows,
                columns: data.columns,
                canManage: data.canManage,
                departmentOptions: data.departmentOptions,
                proposeTitle: data.proposeTitle,
                proposeButton: data.proposeButton,
                proposeEmploymentLabel: data.proposeEmploymentLabel,
                proposeEmploymentPlaceholder: data.proposeEmploymentPlaceholder,
                proposeEmpty: data.proposeEmpty,
                proposeFailed: data.proposeFailed,
                draftBadge: data.queue.draftBadge,
                openEmployee: data.queue.openEmployee,
                notAvailable: data.queue.notAvailable,
                emptyTitle: data.emptyTitle,
                emptyDescription: data.emptyDescription,
                truncated: data.truncated,
                truncatedNote: data.truncatedNote,
              }),
            ],
          }),
        ]),
        when: f('hasContent'),
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
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  return loadChangeRequestQueue(authz, sp)
}

export async function changeRequestQueueTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('queue.title')
}
