import 'server-only'

import { getTranslations } from 'next-intl/server'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import type { YearEndFilingSection } from '@openbooks/engine/src/payroll-yearend.ts'
import { notFound } from 'next/navigation'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { pickString } from '../../../../lib/list-params'
import { scopedYearEndFilings } from '../../../../lib/payroll-scoped-views'

/**
 * The separations cockpit, split into a loader and a spec.
 *
 * This page is a fully client-interactive workspace wearing one filing's
 * clothes: the year picker is router state, the filing cards are selection
 * state, the population table is client-searched + paginated, the
 * reason-for-issue declaration is per-row component state, the electronic
 * file is a fetch download with error callouts, and the slip drawer
 * lazy-loads over fetch on open (there is no `?row=` flyout param — the
 * drawer is not URL-addressable). Decomposing the cards or the table into
 * spec blocks would split one component's state across two render paths and
 * reimplement its conditional pairs (link-when-published style download
 * button, headline-total line, not-installed badge, reason badge vs
 * not-included fallback, refusal alert vs table) as spec constructs that do
 * not exist.
 *
 * So the spec places the workspace whole through one widget — the same call
 * the parallel-run page made (`parallel-run-workspace` places
 * `ParallelRunView` whole, and the pay-run wizard places `RunWizard`
 * whole). `SeparationsView` moves nowhere and the page and the widget registry import the
 * same component; the widget entry renders it with the exact props the
 * native page passes. No `sections.tsx`: nothing is moved or duplicated.
 *
 * Everything below the spec is loader work copied verbatim from page.tsx:
 * the `payroll.read` gate, the `payroll` feature gate (404 when disabled),
 * the org business year, the clamped `?year=` param, the scoped filings
 * read (null when the caller's subsidiary scope excludes any row of the
 * year's population — a count is a disclosure, so the loader reproduces
 * the guard exactly and answers not-found here too), the
 * separation-cadence filter with the installed-or-has-rows convention, and
 * the module tabs.
 *
 * The sections are serializable as returned: `orgYearEndFilings` already
 * strips every function off the declaration (no `population`, no
 * `slip.build`, no `download.build` — the download block carries only
 * `label` and `note`), so the loader hands them to the widget untouched.
 * Money is NOT formatted here: the workspace formats client-side
 * (`useMoney` is browser-locale) exactly as the native path does.
 */

export interface SeparationsData {
  title: string
  description: string
  viewTabs: Awaited<ReturnType<typeof groupTabs>>
  year: number
  currentYear: number
  sections: YearEndFilingSection[]
}

export async function loadSeparations(
  sp: Record<string, string | string[] | undefined>,
): Promise<SeparationsData> {
  const authz = await requirePermission('payroll.read')
  await requireFeatureEnabled(authz.user.orgId, 'payroll')
  const t = await getTranslations('payroll.separations')
  const currentYear = Number((await businessToday(authz.user.orgId)).slice(0, 4))
  const requested = Number(pickString(sp.year))
  const year = Number.isInteger(requested) && requested >= 2020 && requested <= 2100 ? requested : currentYear

  const filings = await scopedYearEndFilings(authz, year)
  if (!filings) notFound()
  const sections = filings.filter(
    (filing) => filing.cadence === 'separation' && (filing.installed || filing.data.rows.length > 0),
  )

  const viewTabs = await groupTabs('payroll', '/payroll/separations', { orgId: authz.user.orgId })

  return {
    title: t('title'),
    description: t('description'),
    viewTabs,
    year,
    currentYear,
    sections,
  }
}

const f = ref<SeparationsData>()

export function separationsSpec(data: SeparationsData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('module-home-tabs', { tabs: data.viewTabs })],
      }),
    ],
    body: [
      // The whole filing workspace — year picker, filing cards, population
      // table with the issue-reason column, download callouts, and the slip
      // drawer — placed through one widget. The component owns selection
      // state, fetch mutations and every conditional pair; the spec only
      // names where it lives. Props are flat and exactly the component's
      // destructured signature `{ year, currentYear, sections }`.
      widgetBlock('separations-workspace', {
        year: f('year'),
        currentYear: f('currentYear'),
        sections: f('sections'),
      }),
    ],
  })
}
