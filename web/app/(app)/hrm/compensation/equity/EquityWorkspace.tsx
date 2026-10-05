import Link from 'next/link'
import { Badge, Button, EmptyState, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../../components/page-layout'
import { KpiStrip } from '../../../../../components/kpi-strip'
import { RegisteredListTable } from '../../../../../components/registered-list-table'
import type { EquityData } from '../../../../../lib/hrm/compensation'
import { Plus } from 'lucide-react'

/** Frozen snapshot review stays in the module. Historical analysis, period
 * filters, saved views and exports use the catalog-owned native report. */
export function EquityWorkspace({ data }: { data: EquityData }) {
  const c = data.categoriesColumns
  return (
    <ListPageLayout contained className="gap-4" header={
      <PageHeader title={data.title} description={data.description}
        actions={data.canManage ? <Button asChild><Link href={data.generateHref as never}><Plus size={15} />{data.generateLabel}</Link></Button> : null} />
    }>
      {data.refusal ? (
        <div className="app-scroll min-h-0 flex-1 overflow-auto">
          <EmptyState title={data.refusal.title} description={data.refusal.message} />
        </div>
      ) : !data.hasSnapshot ? (
        <div className="app-scroll min-h-0 flex-1 overflow-auto">
          <EmptyState title={data.emptyTitle} description={data.emptyDescription} />
        </div>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 text-sm">
            <div className="flex items-center gap-2 font-medium">
              {data.snapshotLabel} <Badge variant="outline">{data.asOf}</Badge>
            </div>
            {data.reportHref ? <Link href={data.reportHref as never} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{data.reportLabel}</Link> : null}
          </div>
          <div className="shrink-0">
            <KpiStrip items={data.tiles.map((tile) => ({ label: tile.label, value: tile.value, tone: tile.tone === 'warning' ? 'bad' : undefined }))} />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <RegisteredListTable source="hrm_compensation_equity" contained
              rows={data.categories} rowKey={(row) => row.id}
              empty={<EmptyState title={data.categoriesEmpty} />}
              columns={[
                { key: 'category', header: c.category, search: (row) => row.level, cell: (row) => row.level },
                { key: 'counts', header: c.counts, align: 'right', className: 'tabular-nums', cell: (row) => row.counts },
                { key: 'mean', header: c.mean, align: 'right', className: 'tabular-nums', cell: (row) => row.mean },
                { key: 'median', header: c.median, align: 'right', className: 'tabular-nums', cell: (row) => row.median },
                { key: 'unexplained', header: c.unexplained, align: 'right', className: 'tabular-nums', cell: (row) => row.unexplained },
                { key: 'flag', header: c.flag, search: (row) => row.flag, cell: (row) => <Badge variant={row.flagTone}>{row.flag}</Badge> },
              ]} />
          </div>
        </>
      )}
    </ListPageLayout>
  )
}
