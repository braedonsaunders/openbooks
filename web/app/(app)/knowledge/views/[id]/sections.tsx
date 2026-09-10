import Link from 'next/link'
import { Download, FileText, Pencil } from 'lucide-react'
import { Badge, Button, DetailHeader } from '@openbooks/ui'

/**
 * Header and meta strip for a saved view's run page.
 *
 * The three export buttons are plain anchors to an API route, and the edit
 * button appears only with permission — a conditional inside one action
 * cluster, so the cluster is a component and the loader decides.
 */
export function SavedViewHeader({
  viewId,
  name,
  scope,
  scopeLabel,
  subtitle,
  backHref,
  backLabel,
  canEdit,
  labels,
}: {
  viewId: string
  name: string
  scope: string
  scopeLabel: string
  subtitle: string
  backHref: string
  backLabel: string
  canEdit: boolean
  labels: { exportPdf: string; exportXlsx: string; exportCsv: string; edit: string }
}) {
  return (
    <DetailHeader
      title={name}
      badge={<Badge variant={scope === 'shared' ? 'secondary' : 'outline'}>{scopeLabel}</Badge>}
      subtitle={subtitle}
      back={{ href: backHref, label: backLabel }}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href={`/api/views/${viewId}/export?format=pdf`}>
              <FileText size={15} /> {labels.exportPdf}
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={`/api/views/${viewId}/export?format=xlsx`}>
              <Download size={15} /> {labels.exportXlsx}
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={`/api/views/${viewId}/export?format=csv`}>
              <Download size={15} /> {labels.exportCsv}
            </a>
          </Button>
          {canEdit ? (
            <Button size="sm" asChild>
              <Link href={`/knowledge/views?view=${viewId}` as never}>
                <Pencil size={14} /> {labels.edit}
              </Link>
            </Button>
          ) : null}
        </div>
      }
    />
  )
}

/** The type / last-updated / row-range strip, whose last span is optional. */
export function SavedViewMeta({
  typeLabel,
  lastUpdated,
  rowsRange,
}: {
  typeLabel: string
  lastUpdated: string
  rowsRange: string | null
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
      <span>{typeLabel}</span>
      <span>{lastUpdated}</span>
      {rowsRange ? <span>{rowsRange}</span> : null}
    </div>
  )
}
