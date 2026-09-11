import 'server-only'

import { getTranslations } from 'next-intl/server'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import type { YearEndFilingSection } from '@openbooks/engine/src/payroll-yearend.ts'
import { notFound } from 'next/navigation'
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@openbooks/viewspec'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { pickString } from '../../../../lib/list-params'
import { scopedYearEndFilings } from '../../../../lib/payroll-scoped-views'
import type { YearEndView } from './YearEndView'

/**
 * Year-end cockpit, split into a loader and a spec.
 *
 * This page is a thin shell over the shared filing workspace
 * (`../_ui/filing-workspace.tsx`): a year picker, one selectable card per
 * pack-declared filing under two headed cadence groups (annual / quarterly),
 * the selected filing's population table, and a fetch-driven slip drawer.
 * Almost everything below is client state or bound fetch calls, not spec
 * vocabulary:
 *
 * - the selected filing (`useState`, defaults to the first section with
 *   rows) and the open drawer row;
 * - the issue declarations (the ROE's reason picker), the file download
 *   (fetch POST/GET with refusal callouts), and the amendment lifecycle
 *   (record-original POST, per-row correction review, correction forms);
 * - the slip drawer itself, which lazy-loads over fetch on open (there is
 *   no `?row=` flyout param — the drawer is not URL-addressable);
 * - every PagedTable cell: money formatted client-side through `useMoney`
 *   (browser locale), null cells as em-dashes, the lifecycle status badge,
 *   and the reason badge — conditional pairs a spec cannot express.
 *
 * So the spec places the workspace whole through one widget, the same call
 * the parallel-run page made: `YearEndView` moves nowhere and is shared by
 * the page and the widget registry. The loader below copies page.tsx verbatim — the
 * `payroll.read` gate, the `payroll` feature gate (404 when disabled), the
 * business-day year with its clamped `?year=` override, the scoped filings
 * read (a restricted caller whose scope excludes any row of the year's
 * population gets the route's not-found answer here too), the annual /
 * quarterly / separation cadence split with the `installed || rows > 0`
 * guard, and the module tabs. The sections travel through the loader result
 * untouched; money stays canonical numeric text because the component
 * formats client-side (browser locale).
 *
 * No sections.tsx: nothing is moved or duplicated — `YearEndView` stays
 * where it is and the page and the widget registry import the same component, exactly like
 * `ParallelRunView`.
 */

type WorkspaceProps = Parameters<typeof YearEndView>[0]

export interface YearEndData {
  title: string
  description: string
  viewTabs: Awaited<ReturnType<typeof groupTabs>>
  workspace: {
    year: WorkspaceProps['year']
    currentYear: WorkspaceProps['currentYear']
    sections: YearEndFilingSection[]
  }
}

export async function loadYearEnd(
  sp: Record<string, string | string[] | undefined>,
): Promise<YearEndData> {
  const authz = await requirePermission('payroll.read')
  await requireFeatureEnabled(authz.user.orgId, 'payroll')
  const t = await getTranslations('payroll.yearEnd')
  const currentYear = Number((await businessToday(authz.user.orgId)).slice(0, 4))
  const requested = Number(pickString(sp.year))
  const year = Number.isInteger(requested) && requested >= 2020 && requested <= 2100 ? requested : currentYear

  // Year-end shows ANNUAL and QUARTERLY returns only. Separation documents
  // (the ROE, a P45) are due per interruption of earnings — within days of
  // the employee event — and live on /payroll/separations, never here.
  // The same population guard the JSON route applies: a restricted caller
  // whose scope excludes any row of the year's population gets the route's
  // not-found answer here too, never a rendered slip.
  const filings = await scopedYearEndFilings(authz, year)
  if (!filings) notFound()
  const sections = filings.filter(
    (filing) => filing.cadence !== 'separation' && (filing.installed || filing.data.rows.length > 0),
  )

  const moduleTabs = await groupTabs('payroll', '/payroll/year-end', { orgId: authz.user.orgId })

  return {
    title: `${t('title')} ${year}`,
    description: t('description'),
    viewTabs: moduleTabs,
    workspace: { year, currentYear, sections },
  }
}

const f = ref<YearEndData>()

export function yearEndSpec(_data: YearEndData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('module-home-tabs', { tabs: _data.viewTabs })],
      }),
    ],
    body: [
      // The whole filing workspace — year picker, cadence groups, filing
      // cards, population table, slip drawer, issue declarations, file
      // download and the amendment lifecycle — placed through one widget.
      // The component owns selection state, fetch mutations and every
      // conditional pair; the spec only names where it lives. The empty
      // state (no declared filings) lives inside the component, not as a
      // negated conditional pair of blocks.
      widgetBlock('year-end-workspace', {
        year: f('workspace.year'),
        currentYear: f('workspace.currentYear'),
        sections: f('workspace.sections'),
      }),
    ],
  })
}
