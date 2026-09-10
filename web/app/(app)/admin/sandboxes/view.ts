import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { listSandboxes } from '@openbooks/engine/src/sandbox/index.ts'
import { page, pageHeader, ref, textBlock, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../lib/authz'
import type { PeriodOption, SandboxRow } from './SandboxManager'

/**
 * The sandbox (environments) admin page, split into a loader and a spec.
 *
 * The whole body is one widget, not spec blocks — the same arrangement as
 * `admin backups`. The native page renders a single client component that
 * owns the create form (local useState per field, including the tier-gated
 * as-of period select), per-row mutations through bound server actions
 * (create/refresh/reset/delete/schedule/promote) plus confirm/prompt
 * dialogs, and org switching. Form state, dialogs and capabilities are not
 * spec vocabulary, so the component stays whole and the spec places it.
 *
 * The loader copies the native page's query, permission and derivation
 * logic verbatim: the `admin.sandboxes.manage` gate, the home-production-org
 * scoping of both queries, and the hardcoded header strings. The
 * production-vs-inside-a-sandbox branch becomes two presence flags the
 * loader computes; the spec never asks which environment is active.
 */

export interface SandboxesData {
  title: string
  description: string
  backHref: string
  backLabel: string
  insideSandbox: boolean
  showManager: boolean
  insideSandboxNotice: string
  sandboxes: SandboxRow[]
  periods: PeriodOption[]
}

export async function loadSandboxes(): Promise<SandboxesData> {
  const authz = await requirePermission('admin.sandboxes.manage')
  const tHub = await getTranslations('admin.hub')
  // Always manage sandboxes against the home production org.
  const rows = (await listSandboxes(authz.user.productionOrgId)) as unknown as SandboxRow[]

  // Accounting periods for the as-of clone cutoff (most recent first).
  const periodsRes = (await db.execute<PeriodOption>(sql`
    select id, name from accounting_periods
     where org_id = ${authz.user.productionOrgId}
     order by fiscal_year desc, period_number desc
     limit 240`))

  return {
    title: 'Environments',
    description:
      'Create and manage sandbox copies of your production books — instant to clone, isolated, refreshable, and promotable back to production.',
    backHref: '/admin',
    backLabel: tHub('title'),
    insideSandbox: authz.user.envKind !== 'production',
    showManager: authz.user.envKind === 'production',
    insideSandboxNotice:
      'You are currently inside a sandbox. Exit to production to manage environments.',
    // The native path passes driver Dates through RSC serialization, which
    // emits ISO strings; normalize here so the spec path binds the same
    // presentation-ready strings.
    sandboxes: rows.map((s) => ({
      ...s,
      lastRefreshAt: s.lastRefreshAt == null ? null : new Date(s.lastRefreshAt).toISOString(),
      createdAt: new Date(s.createdAt).toISOString(),
    })),
    periods: periodsRes.rows,
  }
}

const f = ref<SandboxesData>()

export function sandboxesSpec(data: SandboxesData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        back: { href: f('backHref'), label: f('backLabel') },
      }),
    ],
    body: [
      // Class string transcribed from the native notice paragraph: the
      // `sm` size supplies `text-sm` and the tone ramp has no amber-700
      // step, so the amber classes ride along as a literal.
      {
        ...textBlock(f('insideSandboxNotice'), {
          size: 'sm',
          className: 'text-amber-700 dark:text-amber-400',
        }),
        when: f('insideSandbox'),
      },
      {
        ...widgetBlock('sandbox-manager', {
          sandboxes: data.sandboxes,
          periods: data.periods,
        }),
        when: f('showManager'),
      },
    ],
  })
}
