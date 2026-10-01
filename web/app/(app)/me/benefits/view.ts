import 'server-only'

import { registeredListTable } from '../../../../lib/list/prepared-spec'
import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  grid,
  field as item,
  heading,
  link,
  page,
  pageHeader,
  ref,
  table,
  text,
  textBlock,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
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
          // Elections and windows render as direct lists under house
          // headings — no panel repeats the section name. The monthly
          // hint rides above the elections list it explains.
          heading(2, f('electionsTitle'), 'text-sm font-semibold text-slate-900 dark:text-slate-100'),
          textBlock(f('monthlyHint')),
          registeredListTable('me_benefits_elections', {
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
          heading(2, f('windowsTitle'), 'text-sm font-semibold text-slate-900 dark:text-slate-100'),
          registeredListTable('me_benefits_windows', {
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
          // Dependents stay a facts table under the same house heading:
          // rows carry no stable identity (name plus relationship only),
          // so they cannot join the registered list, which requires
          // unique stable row ids.
          heading(2, f('dependentsTitle'), 'text-sm font-semibold text-slate-900 dark:text-slate-100'),
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
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  return loadMeBenefits(authz, sp)
}

export async function meBenefitsTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('me.benefits.title')
}
