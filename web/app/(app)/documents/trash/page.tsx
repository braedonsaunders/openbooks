import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { ChevronLeft, Trash2 } from 'lucide-react'
import { EmptyState, PageHeader } from '@openbooks/ui'
import { can, requirePermission } from '../../../../lib/authz'
import { dateTime } from '../../../../lib/format'
import { listTrash } from '../../../../lib/file-cabinet'
import { TrashList, type TrashRow } from './TrashList'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('documents.trash')
  return { title: t('title') }
}

export default async function TrashPage() {
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
        <Link
          href="/documents"
          className="mb-1 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          {tt('back')}
        </Link>
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
