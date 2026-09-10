import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@openbooks/viewspec'
import { requirePermission, can } from '../../../../lib/authz'
import { getMoneyFormatter } from '@/lib/money-server'
import { orgInfo } from '../../../../lib/data'
import { listProvisionRuns } from '@openbooks/engine/src/income-tax-provision.ts'
import type { ProvisionRunListColumns, ProvisionRunListRow } from './sections'

/**
 * The income-tax provision run list, split into a loader and a spec.
 *
 * The loader copies the native query, permission and formatting logic
 * verbatim: the `reports.read` gate, the entity-projected `listProvisionRuns`
 * read (restricted callers see projected aggregates; an empty scope sees no
 * rows at all), the money formatting, and the compute-button rule
 * (`reports.create` plus an unrestricted subsidiary scope — a restricted
 * caller must not reach the org-wide compute dialog).
 *
 * The table stays a widget, not a `table` block — the same call the detail
 * conversion made for its two tables. The native markup is a hand-rolled
 * `<table>` in a `rounded-xl` card with its own cell padding; the spec's
 * table block offers only the two real table variants the app has, so the
 * shared `ProvisionRunsTable` component carries the markup and the spec
 * places it. The empty state lives inside that component because the native
 * empty path keeps the card + table chrome and renders the note as a
 * `colSpan={6}` row.
 */

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'outline'> = {
  draft: 'secondary',
  posted: 'success',
  superseded: 'outline',
}

export interface TaxProvisionsData {
  title: string
  description: string
  canCompute: boolean
  emptyText: string
  columns: ProvisionRunListColumns
  rows: ProvisionRunListRow[]
}

export async function loadTaxProvisions(
  _sp: Record<string, string | string[] | undefined>,
): Promise<TaxProvisionsData> {
  const authz = await requirePermission('reports.read')
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('tax.provisions')
  const org = await orgInfo()
  const runs = await listProvisionRuns(authz.user.orgId, authz.allowedSubsidiaryIds)
  const m = (v: string) => money(v, { currency: org?.base_currency })

  return {
    title: t('title'),
    description: t('description'),
    // The compute dialog posts an org-wide run, so restricted callers never
    // see the button — mirrors the native header gate exactly.
    canCompute: authz.allowedSubsidiaryIds === null && can(authz, 'reports.create'),
    emptyText: t('empty'),
    columns: {
      fiscalYear: t('columns.fiscalYear'),
      version: t('columns.version'),
      status: t('columns.status'),
      totalExpense: t('columns.totalExpense'),
      effectiveRate: t('columns.effectiveRate'),
      created: t('columns.created'),
    },
    rows: runs.map((run) => ({
      id: run.id,
      href: `/tax/provisions/${run.id}`,
      fiscalYearLabel: `FY${run.fiscalYear}`,
      versionLabel: `v${run.version}`,
      statusLabel: t(`status.${run.status}`),
      statusVariant: STATUS_VARIANT[run.status] ?? 'secondary',
      totalExpense: m(run.totalExpense),
      // The engine emits no effectiveRatePercent for the seeded runs (null
      // projects to null for restricted callers too); the native page renders
      // an em-dash there, so the loader carries the finished text.
      effectiveRateText: run.effectiveRatePercent != null ? `${run.effectiveRatePercent}%` : '—',
      created: String(run.createdAt).slice(0, 10),
    })),
  }
}

const f = ref<TaxProvisionsData>()

export function taxProvisionsSpec(data: TaxProvisionsData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        // Builder-level omission, not `when`: the native header passes
        // `actions={… : undefined}` when gated off, so the spec must also
        // produce *no* actions — a `when`-gated widget would still leave the
        // PageHeader actions wrapper div standing with nothing inside it.
        actions: data.canCompute ? [widget('provision-compute-button', {})] : undefined,
      }),
    ],
    body: [
      widgetBlock('provision-runs-table', {
        columns: data.columns,
        emptyText: data.emptyText,
        rows: data.rows,
      }),
    ],
  })
}
