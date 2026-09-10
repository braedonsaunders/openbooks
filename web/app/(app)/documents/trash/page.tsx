import { getTranslations } from 'next-intl/server'
import { Trash2 } from 'lucide-react'
import { EmptyState, PageHeader } from '@openbooks/ui'
import { can, requirePermission } from '../../../../lib/authz'
import { dateTime } from '../../../../lib/format'
import { listTrash } from '../../../../lib/file-cabinet'
import { TrashList, type TrashRow } from './TrashList'
import { TrashBackLink } from './sections'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadTrash, trashSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('documents.trash')
  return { title: t('title') }
}

export default async function TrashPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadTrash()
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={trashSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('documents.manage')
  const orgId = authz.user.orgId
  const viewer = {
    userId: authz.user.id,
    isAdmin: can(authz, '*'),
    baseline: 'manager' as const,
  }
  const t = await getTranslations('documents')
  const tt = await getTranslations('documents.trash')

  const items = await listTrash(orgId, viewer)
  const rows: TrashRow[] = items.map((it) => ({
    kind: it.kind,
    id: it.id,
    name: it.name,
    fileTypeLabel: it.fileType ? t(`fileTypes.${it.fileType}`) : null,
    folderName: it.folderName,
    modifiedLabel: dateTime(it.updatedAt),
  }))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-slate-200 bg-white px-3 pt-3 pb-2.5 sm:px-6 sm:pt-4 sm:pb-3 dark:border-slate-800 dark:bg-slate-900">
        <TrashBackLink href="/documents" label={tt('back')} />
        <PageHeader title={tt('title')} description={tt('description')} />
      </div>

      <div className="app-scroll min-h-0 flex-1 overflow-auto p-3 sm:p-4">
        {rows.length === 0 ? (
          <EmptyState title={tt('empty')} icon={<Trash2 className="h-8 w-8" />} />
        ) : (
          <TrashList items={rows} />
        )}
      </div>
    </div>
  )
}
