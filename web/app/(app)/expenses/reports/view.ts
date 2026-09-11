import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isUuid, pickString } from '../../../../lib/list-params'
import { loadExpenseReport } from '../../../../lib/expenses'
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { customSegmentOptions } from '../../../../lib/segments'
import { resolveFormLayout } from '../../../../lib/customization/resolve'
import { taxCodeOptions, taxGroupOptions } from '../../../../lib/documents'
import type { ExpenseDrawer } from '../ExpenseDrawer'

/**
 * Expense reports — the universal documents list scoped to `expense_report`,
 * split into a loader and a spec.
 *
 * The list itself (search, employee filter, status chips, saved views,
 * sortable typed table, pagination) stays one host component through the
 * shared `record-list-view` slot, which re-derives org id, user id and the
 * permission decision server-side — the ap/bills precedent. This page owns
 * only the header (title/description/new button) and the ?expense= flyout
 * with its picker + form-layout resolution, copied verbatim from page.tsx.
 *
 * Two page-specific widgets the registry does not have yet (see
 * Two page-specific widgets: `new-expense` (the instant-into-draft button — a
 * POST to /api/expenses/draft, not the NewDocumentButton shape) and
 * `expense-drawer`.
 *
 * The `_actions` column is a per-row WIDGET ref rather than a callback:
 * `renderRowActions` is a function and a spec can never carry one, so the
 * registry builds the callback from the ref and the widget assembles the open
 * href from the row id and the current URL — the same answer bills and
 * invoices use for their row actions.
 */

type ExpenseDrawerProps = Parameters<typeof ExpenseDrawer>[0]

export interface ExpenseReportsDrawer {
  remountKey: string
  report: unknown
  initialMode: 'edit' | 'view'
  employees: unknown
  accounts: unknown
  taxCodes: unknown
  taxGroups: unknown
  departments: unknown
  projects: unknown
  headerDefs: unknown
  lineDefs: unknown
  segments: unknown
  canSubmit: boolean
  canPost: boolean
  layout: unknown
  closeHref: string
}

export interface ExpenseReportsData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  canSubmit: boolean
  canPost: boolean
  newLabel: string
  newCreatingLabel: string
  drawerOpen: boolean
  drawer: ExpenseReportsDrawer | null
}

export async function loadExpenseReports(
  sp: Record<string, string | string[] | undefined>,
): Promise<ExpenseReportsData> {
  const t = await getTranslations('expenses')
  const tCommon = await getTranslations('common')
  const authz = await requirePermission('expenses.read')
  await requireFeatureEnabled(authz.user.orgId, 'expenses')
  const canSubmit = can(authz, 'expenses.create')
  const canPost = can(authz, 'ap.post')
  const expenseId = pickString(sp.expense)

  // Flyout + pickers + form layout resolve only when a report is open.
  // loadExpenseReport is already org-scoped (d.org_id = orgId), so a foreign
  // id yields null and the drawer stays shut — same guard as the native page.
  const openReport = expenseId && isUuid(expenseId) ? await loadExpenseReport(expenseId, authz.user.orgId) : null
  const pickers = openReport
    ? await Promise.all([
        db.execute(sql`
          select p.id, p.display_name from parties p
           where p.is_active and p.org_id = ${authz.user.orgId}
             and exists (select 1 from employee_roles er where er.org_id = p.org_id and er.party_id = p.id and er.is_active)
           order by p.display_name limit 2000`) as any,
        db.execute(sql`select id, number, name from accounts where type in ('expense','expense_other','cogs') and is_active and not is_summary and org_id = ${authz.user.orgId} order by number nulls last`) as any,
        taxCodeOptions(authz.user.orgId),
        taxGroupOptions(authz.user.orgId),
        db.execute(sql`select id, name from departments where is_active and org_id = ${authz.user.orgId} order by name`) as any,
        db.execute(sql`select id, name from projects where is_active and org_id = ${authz.user.orgId} order by name limit 2000`) as any,
        loadFieldDefs('documents', 'expense_report'),
        loadFieldDefs('document_lines', 'expense_report'),
        customSegmentOptions(authz.user.orgId),
      ])
    : null
  const resolvedForm =
    openReport && pickers
      ? await resolveFormLayout({
          orgId: authz.user.orgId,
          userId: authz.user.id,
          recordType: 'expense_report',
          userRoles: authz.user.roles.map(({ key }) => key),
          headerDefs: pickers[6],
          lineDefs: pickers[7],
          explicitLayoutId: pickString(sp.form),
        })
      : null

  const drawer: ExpenseReportsDrawer | null =
    openReport && pickers && resolvedForm
      ? {
          remountKey: String((openReport.doc as Record<string, unknown>).id),
          report: openReport as unknown as ExpenseDrawerProps['report'],
          initialMode: pickString(sp.mode) === 'edit' ? 'edit' : 'view',
          employees: (pickers[0] as { rows: unknown }).rows,
          accounts: (pickers[1] as { rows: unknown }).rows,
          taxCodes: pickers[2],
          taxGroups: pickers[3],
          departments: (pickers[4] as { rows: unknown }).rows,
          projects: (pickers[5] as { rows: unknown }).rows,
          headerDefs: pickers[6] as unknown as ExpenseDrawerProps['headerDefs'],
          lineDefs: pickers[7] as unknown as ExpenseDrawerProps['lineDefs'],
          segments: pickers[8] as unknown as ExpenseDrawerProps['segments'],
          canSubmit,
          canPost,
          layout: resolvedForm.layout,
          closeHref: '/expenses/reports',
        }
      : null

  return {
    title: t('list.title'),
    description: t('list.description'),
    currentParams: sp,
    canSubmit,
    canPost,
    newLabel: t('actions.newReport'),
    newCreatingLabel: tCommon('actions.creating'),
    drawerOpen: Boolean(drawer),
    drawer,
  }
}

const f = ref<ExpenseReportsData>()

export function expenseReportsSpec(data: ExpenseReportsData): PageSpec {
  const newExpense = {
    widget: 'new-expense',
    props: {
      label: data.newLabel,
      creatingLabel: data.newCreatingLabel,
    },
  }
  return page({
    route: '/expenses/reports',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget(newExpense.widget, newExpense.props, f('canSubmit'))],
      }),
    ],
    body: [
      // No `when`: the list always renders. `drawer`/`emptyAction` arrive as
      // null when closed/absent and their slots render nothing. The record
      // list renders the drawer itself (after the table, inside the slot) —
      // the page places nothing else here, the same arrangement the native
      // page has.
      widgetBlock('record-list-view', {
        recordType: 'expense_report',
        basePath: '/expenses/reports',
        sp: data.currentParams,
        drawer: data.drawer ? { widget: 'expense-drawer', props: { drawer: data.drawer } } : null,
        emptyAction: data.canSubmit ? newExpense : null,
        // The native page renders ExpenseActions per row. `renderRowActions`
        // is a function, which a spec can never carry, so the spec names a
        // per-row WIDGET and the slot builds the callback from it.
        rowActions: {
          widget: 'expense-row-actions',
          props: { canSubmit: data.canSubmit, canPost: data.canPost, sp: data.currentParams },
        },
      }),
    ],
  })
}
