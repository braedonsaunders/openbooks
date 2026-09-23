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
  statTile,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { compensationAuthz, loadCompensationHome } from '../../../../lib/hrm/compensation'

/**
 * Compensation home: statTiles (below-min on the live round, open-cycle
 * pacing, plans awaiting approval, joint-assessment flags), the bands
 * table by level with headcount per band, the open cycles and plans
 * registers, and the rehomed job-architecture setup sections. The
 * primary action is the shared 'link-button' FIRST in the header, then
 * the 'module-home-tabs' strip. Renders only when hrmCompensation is on
 * and the actor holds hrm.compensation.read — the loader 404s otherwise.
 */

const f = item

export function compensationSpec(data: NonNullable<Awaited<ReturnType<typeof loadCompensationHome>>>): PageSpec {
  return page({
    route: '/hrm/compensation',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget('link-button', { href: f('newCycleHref'), label: f('newCycleLabel'), iconKey: 'plus' }, f('canRunCycles')),
          widget('link-button', { href: f('newPlanHref'), label: f('newPlanLabel'), iconKey: 'plus', variant: 'outline' }, f('canManage')),
          widget('link-button', { href: f('equityHref'), label: f('equityLabel'), iconKey: 'scale', variant: 'outline' }),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock('module-home-tabs', { tabs: data.viewTabs }),
      // A refused gap-snapshot read renders with its remedy intact — never
      // a zero joint-flag tile pretending the read succeeded.
      widgetBlock('empty-state', { title: data.refusal?.title ?? '', description: data.refusal?.message }, f('refusal')),
      grid('grid grid-cols-2 gap-4 xl:grid-cols-4', [
        statTile({ iconKey: f('tiles.0.iconKey'), accent: f('tiles.0.accent'), label: f('tiles.0.label'), value: f('tiles.0.value'), tone: f('tiles.0.tone') }),
        statTile({ iconKey: f('tiles.1.iconKey'), accent: f('tiles.1.accent'), label: f('tiles.1.label'), value: f('tiles.1.value'), tone: f('tiles.1.tone') }),
        statTile({ iconKey: f('tiles.2.iconKey'), accent: f('tiles.2.accent'), label: f('tiles.2.label'), value: f('tiles.2.value'), tone: f('tiles.2.tone') }),
        statTile({ iconKey: f('tiles.3.iconKey'), accent: f('tiles.3.accent'), label: f('tiles.3.label'), value: f('tiles.3.value'), tone: f('tiles.3.tone') }),
      ]),
      panel({
        title: f('bandsTitle'),
        bodyClassName: 'min-h-0 overflow-y-auto p-0',
        blocks: [
          table({
            variant: 'app',
            rows: f('bands'),
            rowKey: item('id'),
            empty: { title: f('bandsEmpty') },
            columns: [
              column('level', text(item('levelCode'))),
              column('range', text(item('range'))),
              column('headcount', text(item('headcount')), { align: 'right', className: 'tabular-nums' }),
            ],
          }),
        ],
      }),
      panel({
        title: f('cyclesTitle'),
        bodyClassName: 'min-h-0 overflow-y-auto p-0',
        blocks: [
          table({
            variant: 'app',
            rows: f('cycles'),
            rowKey: item('id'),
            empty: { title: f('cyclesEmpty') },
            columns: [
              column('name', link(item('name'), item('href'))),
              column('status', badge(item('statusLabel'), { variant: item('statusVariant') })),
              column('effective', text(item('effectiveOn'))),
            ],
          }),
        ],
      }),
      panel({
        title: f('plansTitle'),
        bodyClassName: 'min-h-0 overflow-y-auto p-0',
        blocks: [
          table({
            variant: 'app',
            rows: f('plans'),
            rowKey: item('id'),
            empty: { title: f('plansEmpty') },
            columns: [
              column('name', link(item('name'), item('href'))),
              column('status', badge(item('statusLabel'), { variant: item('statusVariant') })),
              column('cost', text(item('totalCost')), { align: 'right', className: 'tabular-nums' }),
            ],
          }),
        ],
      }),
      widgetBlock('setup-section', { entityKey: 'hrm-job-families', sp: {}, basePath: '/hrm/compensation' }, f('canSetup')),
      widgetBlock('setup-section', { entityKey: 'hrm-job-levels', sp: {}, basePath: '/hrm/compensation' }, f('canSetup')),
      widgetBlock('setup-section', { entityKey: 'hrm-pay-bands', sp: {}, basePath: '/hrm/compensation' }, f('canSetup')),
      // The create dialogs (?cycle=new / ?plan=new), mirroring the
      // change-request queue's propose/detail trio — the loader owns the
      // open state and the return href, closing navigates the param away.
      // A requested dialog always resolves: the form, or a named refusal
      // with its remedy when a prerequisite is missing.
      widgetBlock('hrm-comp-cycle-dialog', { dialog: f('cycleDialog') }, f('cycleOpen')),
      widgetBlock('hrm-comp-plan-dialog', { dialog: f('planDialog') }, f('planOpen')),
    ],
  })
}

export async function compensationTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('compensation.title')
}

export async function loadCompensationPage(sp: Record<string, string | undefined>) {
  const authz = await compensationAuthz()
  if (!authz) notFound()
  const data = await loadCompensationHome(authz, sp)
  if (!data) notFound()
  return data
}
