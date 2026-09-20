import 'server-only'

import { notFound } from 'next/navigation'
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
  table,
  text,
  textBlock,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { loadMeBenefits, type MeBenefitsData } from '../../../../lib/hrm/self-service'

/**
 * Me benefits — the person's current elections with the stored payroll
 * amounts, the open enrollment windows covering their employer,
 * dependents on file, and the elect/change dialogs. Amounts render the
 * stored per-period figures — never a recomputed number. Renders only
 * when the hrm feature gate is on and the actor holds hrm.self.read.
 */

const f = ref<MeBenefitsData>()

export function meBenefitsSpec(data: MeBenefitsData): PageSpec {
  return page({
    route: '/me/benefits',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget('link-button', { href: f('electHref'), label: f('electLabel') }),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
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
            title: f('electionsTitle'),
            iconKey: 'heart',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [
              textBlock(f('monthlyHint')),
              table({
                variant: 'app',
                rows: f('elections'),
                rowKey: item('id'),
                columns: [
                  column(f('electionsColumns.plan'), text(item('planName'))),
                  column(f('electionsColumns.coverage'), text(item('coverageLabel'))),
                  column(
                    f('electionsColumns.status'),
                    badge(item('statusLabel'), { variant: item('statusVariant') }),
                  ),
                  column(
                    f('electionsColumns.effective'),
                    text(item('effectiveLabel'), { className: 'tabular-nums' }),
                  ),
                  column(
                    f('electionsColumns.monthly'),
                    text(item('employeeAmount'), { className: 'tabular-nums' }),
                    { align: 'right', className: 'tabular-nums' },
                  ),
                  column('', link(item('changeLabel'), item('changeHref'))),
                ],
                empty: { title: f('electionsEmpty'), description: f('electionsEmptyDescription') },
              }),
            ],
          }),
          panel({
            title: f('windowsTitle'),
            iconKey: 'calendar-clock',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [
              table({
                variant: 'app',
                rows: f('windows'),
                rowKey: item('id'),
                columns: [
                  column(f('windowsColumns.name'), text(item('name'))),
                  column(f('windowsColumns.kind'), text(item('kindLabel'))),
                  column(
                    f('windowsColumns.range'),
                    text(item('rangeLabel'), { className: 'tabular-nums' }),
                  ),
                ],
                empty: { title: f('windowsEmpty'), description: f('windowsEmptyDescription') },
              }),
            ],
          }),
          panel({
            title: f('dependentsTitle'),
            iconKey: 'users',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [
              table({
                variant: 'app',
                rows: f('dependents'),
                rowKey: item('displayName'),
                columns: [
                  column(f('dependentsColumns.name'), text(item('displayName'))),
                  column(f('dependentsColumns.relationship'), text(item('relationship'))),
                ],
                empty: { title: f('dependentsEmpty') },
              }),
            ],
          }),
          widgetBlock(
            'hrm-benefit-dialog',
            {
              dialog: data.dialog,
              closeHref: data.dialogCloseHref,
            },
            f('dialogOpen'),
          ),
          widgetBlock(
            'hrm-benefit-change-dialog',
            {
              dialog: data.changeDialog,
              closeHref: data.dialogCloseHref,
            },
            f('changeDialogOpen'),
          ),
        ]),
        when: f('hasContent'),
      },
    ],
  })
}

export async function loadMeBenefitsPage(
  sp: Record<string, string | undefined> = {},
): Promise<MeBenefitsData> {
  const authz = await requirePermission('hrm.self.read')
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  return loadMeBenefits(authz, sp)
}

export async function meBenefitsTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('me.benefits.title')
}
