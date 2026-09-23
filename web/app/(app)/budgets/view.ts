import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { isUuid, mergeHref, parsePrefixedListParams, pickString } from '../../../lib/list-params'
import { loadBudgetBooksAndYears, loadBudgetWorkspace, loadUnsavedBudgetWorkspace, type BudgetDimensions, type BudgetWorkspace } from '../../../lib/budgets'
import type { BudgetDrawer } from './BudgetDrawer'

/**
 * Budgets, split into a loader and a spec.
 *
 * The list itself is the universal EntityListView (`budget_scenario`), so the
 * list arrives through the slot that re-derives org/user/permissions from the
 * session — the spec carries only the record type, the current params, and
 * widget refs for the drawer and the empty-state action.
 *
 * Everything else here is loader work copied verbatim from page.tsx: the
 * permission gates, the budgets feature gate, the prefixed `budget*` list
 * params for the drawer's account worksheet, the dimension filters, the
 * ?budget= workspace resolution (org guard inside `loadBudgetWorkspace` via
 * `loadBudgetScenario`), the books/years pickers, the sources query, and the
 * close-href fallback. The drawer payload, the remount key, and the
 * New-button visibility are data, so they travel through the loader result
 * and the widgets render them.
 */

type BudgetDrawerProps = Parameters<typeof BudgetDrawer>[0]

export interface BudgetsData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  canManage: boolean
  canCreate: boolean
  drawer: (Record<string, unknown> & { remountKey: string }) | null
}

export async function loadBudgets(
  sp: Record<string, string | string[] | undefined>,
): Promise<BudgetsData> {
  const t = await getTranslations('budgets')
  const authz = await requirePermission('budgets.read')
  await requireFeatureEnabled(authz.user.orgId, 'budgets')

  const orgId = authz.user.orgId
  const canManage = can(authz, 'budgets.manage')
  const budgetId = pickString(sp.budget)
  const budgetList = parsePrefixedListParams(sp, 'budget', { sort: 'account', dir: 'asc', perPage: 50, allowedSorts: ['account'] as const })
  const dimension = (key: string) => {
    const value = pickString(sp[key])
    return value && isUuid(value) ? value : null
  }
  const dims: BudgetDimensions = {
    subsidiaryId: dimension('budgetSubsidiary'),
    departmentId: dimension('budgetDepartment'),
    projectId: dimension('budgetProject'),
    locationId: dimension('budgetLocation'),
    classId: dimension('budgetClass'),
  }
  const { books, years } = await loadBudgetBooksAndYears(orgId)
  // Unsaved-create (?budgetNew=1): the drawer opens over an in-memory
  // workspace — zero writes on open, zero on Cancel, one explicit Save. The
  // button and the drawer share this flag, so neither is ever offered
  // without the other. A book and at least one fiscal year must exist to
  // start a budget; the workspace loader and the Save endpoint re-validate
  // the resolved book/year with named refusals.
  const canCreate = canManage && books.length > 0 && years.length > 0
  const creating = pickString(sp.budgetNew) === '1' && canCreate && !budgetId
  const [sources, workspace, unsaved] = await Promise.all([
    ((budgetId && isUuid(budgetId)) || creating) ? db.execute(sql`
      select id, name, fiscal_year from budget_scenarios
       where org_id = ${orgId} and status <> 'archived' order by updated_at desc limit 50
    `) as Promise<{ rows: { id: string; name: string; fiscal_year: number }[] }> : Promise.resolve({ rows: [] }),
    budgetId && isUuid(budgetId) ? loadBudgetWorkspace(budgetId, orgId, {
      q: budgetList.q,
      page: budgetList.page,
      perPage: budgetList.perPage,
      dims,
    }) : Promise.resolve(null),
    creating ? loadUnsavedBudgetWorkspace(orgId, {
      q: budgetList.q,
      page: budgetList.page,
      perPage: budgetList.perPage,
      dims,
    }) : Promise.resolve(null),
  ])
  const requestedReturn = pickString(sp.drawerReturn)
  const closeHref = requestedReturn?.startsWith('/budgets') ? requestedReturn : mergeHref('/budgets', sp, {
    budget: null,
    budgetNew: null,
    budgetQ: null,
    budgetPage: null,
    budgetSubsidiary: null,
    budgetDepartment: null,
    budgetProject: null,
    budgetLocation: null,
    budgetClass: null,
    budgetImport: null,
    budgetView: null,
    drawerReturn: null,
  })

  // Remount key: switching scenarios, revisions, or dimensional slices must
  // reset the drawer's client state, and a widget at a fixed position would
  // otherwise be reused.
  const openWorkspace = workspace ?? unsaved
  const drawerPayload: BudgetDrawerProps | null = openWorkspace
    ? {
        initial: openWorkspace as BudgetWorkspace,
        currentParams: sp,
        dims,
        closeHref,
        books,
        years,
        sources: sources.rows,
        newlyCreated: unsaved ? true : pickString(sp.budgetNew) === '1',
        createMode: unsaved ? true : undefined,
        canManage,
        canApprove: unsaved ? false : can(authz, 'budgets.approve'),
        canExport: unsaved ? false : can(authz, 'data.export'),
      }
    : null
  const persistedKey = workspace
    ? `${workspace.scenario.id}-${workspace.scenario.revision}-${dims.subsidiaryId}-${dims.departmentId}-${dims.projectId}-${dims.locationId}-${dims.classId}`
    : ''
  const drawer: BudgetsData['drawer'] = openWorkspace && drawerPayload
    ? {
        remountKey: unsaved
          ? `new-${dims.subsidiaryId}-${dims.departmentId}-${dims.projectId}-${dims.locationId}-${dims.classId}`
          : persistedKey,
        ...drawerPayload,
      }
    : null

  return {
    title: t('list.title'),
    description: t('list.description'),
    currentParams: sp,
    canManage,
    canCreate,
    drawer,
  }
}

const f = ref<BudgetsData>()

export function budgetsSpec(data: BudgetsData): PageSpec {
  const newBudget = {
    widget: 'new-budget',
    props: { currentParams: data.currentParams },
  }
  return page({
    route: '/budgets',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        // The New affordance needs the creation grant plus a book and a
        // fiscal year to start from — the same flag the ?budgetNew=1 drawer
        // shares, so neither is ever offered without the other.
        actions: [widget(newBudget.widget, newBudget.props, f('canCreate'))],
      }),
    ],
    body: [
      // The universal entity list, placed through a slot: it needs an org id,
      // a user id and a permission decision, none of which may travel through
      // a spec. The drawer's own `?budgetQ`/`?budgetPage`/dimension params
      // ride inside `sp`, so the workspace worksheet keeps working.
      widgetBlock('entity-list-view', {
        recordType: 'budget_scenario',
        sp: data.currentParams,
        drawer: data.drawer ? { widget: 'budget-drawer', props: { drawer: data.drawer } } : null,
        emptyAction: data.canCreate ? newBudget : null,
      }),
    ],
  })
}
