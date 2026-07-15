import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, parseListParams, pickString } from '../../../lib/list-params'
import { dateTime } from '../../../lib/format'
import { getFile, getFolderTree, listFiles } from '../../../lib/file-cabinet'
import { FolderTree } from './FolderTree'
import { UploadButton } from './UploadButton'
import { NewFolderButton } from './NewFolderButton'
import { FileDrawer } from './FileDrawer'
import { FolderDrawer } from './FolderDrawer'

export const dynamic = 'force-dynamic'

const SORT_COLUMNS = {
  name: sql`fi.name`,
  size: sql`fi.size_bytes`,
  created: sql`fi.created_at`,
} as const

export async function generateMetadata() {
  const t = await getTranslations('documents')
  return { title: t('list.metaTitle') }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default async function Documents({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('documents.read')
  const canManage = can(authz, 'documents.manage')
  const orgId = authz.user.orgId
  // Private-folder visibility: only global admins bypass is_private.
  const viewer = { userId: authz.user.id, isAdmin: can(authz, '*') }
  const t = await getTranslations('documents')
  const tc = await getTranslations('common')

  const sp = await searchParams
  const fileId = typeof sp.file === 'string' ? sp.file : undefined
  const folderParam = typeof sp.folder === 'string' ? sp.folder : undefined
  const folderId = pickString(sp.fid)
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 50,
    allowedSorts: ['name', 'size', 'created'] as const,
  })

  const [tree, { files, total }] = await Promise.all([
    getFolderTree(orgId, viewer),
    listFiles(orgId, viewer, {
      folderId: folderId && isUuid(folderId) ? folderId : undefined,
      q: params.q,
      sort: params.sort,
      dir: params.dir,
      limit: params.perPage,
      offset: (params.page - 1) * params.perPage,
    }),
  ])

  const [openFile, openFolder] = await Promise.all([
    fileId && isUuid(fileId) ? getFile(orgId, fileId, viewer) : null,
    folderParam && folderParam !== 'new' && isUuid(folderParam)
      ? tree.find((f) => f.id === folderParam) ?? null
      : null,
  ])

  const activeFolder = folderId && isUuid(folderId) ? tree.find((f) => f.id === folderId) : null

  return (
    <ListPageLayout
      className="flex h-full min-h-0 gap-0 p-0 sm:p-0"
      header={
        <>
          <PageHeader
            title={t('list.title')}
            description={t('list.description')}
            actions={
              canManage ? (
                <div className="flex items-center gap-2">
                  <NewFolderButton parentId={folderId && isUuid(folderId) ? folderId : undefined} />
                  <UploadButton folderId={folderId && isUuid(folderId) ? folderId : undefined} />
                </div>
              ) : undefined
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('list.searchPlaceholder')} />
          </div>
        </>
      }
    >
      <div className="flex h-full min-h-0">
        <FolderTree folders={tree} activeFolderId={folderId} />
        <div className="app-scroll min-w-0 flex-1 overflow-auto p-3 sm:p-6">
          {files.length === 0 ? (
            <EmptyState
              title={t('list.empty.title')}
              description={t('list.empty.description')}
              action={
                canManage ? (
                  <div className="flex items-center gap-2">
                    <NewFolderButton parentId={folderId && isUuid(folderId) ? folderId : undefined} />
                    <UploadButton folderId={folderId && isUuid(folderId) ? folderId : undefined} />
                  </div>
                ) : undefined
              }
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortTh basePath="/documents" currentParams={sp} column="name" sort={params.sort} dir={params.dir}>
                      {t('columns.name')}
                    </SortTh>
                    <TableHead>{t('columns.type')}</TableHead>
                    <SortTh basePath="/documents" currentParams={sp} column="size" sort={params.sort} dir={params.dir} align="right">
                      {t('columns.size')}
                    </SortTh>
                    <SortTh basePath="/documents" currentParams={sp} column="created" sort={params.sort} dir={params.dir}>
                      {t('columns.modified')}
                    </SortTh>
                    <TableHead>{t('columns.createdBy')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {files.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell className="font-medium">
                        <Link
                          href={`/documents?file=${f.id}${folderId ? `&fid=${folderId}` : ''}`}
                          className="text-teal-700 hover:underline dark:text-teal-300"
                        >
                          {f.name}
                        </Link>
                        {f.versionCount > 1 ? (
                          <span className="ml-2 text-xs text-slate-400">v{f.versionCount}</span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{t(`fileTypes.${f.fileType}`)}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-slate-500 dark:text-slate-400">
                        {formatSize(f.sizeBytes)}
                      </TableCell>
                      <TableCell className="text-slate-500 dark:text-slate-400">
                        {dateTime(f.updatedAt)}
                      </TableCell>
                      <TableCell className="text-slate-500 dark:text-slate-400">
                        {f.folderName ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="mt-3">
                <Pagination
                  basePath="/documents"
                  currentParams={sp}
                  total={total}
                  page={params.page}
                  perPage={params.perPage}
                />
              </div>
            </>
          )}
        </div>
      </div>
      {openFile ? <FileDrawer file={openFile as any} canManage={canManage} /> : null}
      {folderParam === 'new' && canManage ? (
        <FolderDrawer mode="create" folders={tree} parentId={folderId && isUuid(folderId) ? folderId : undefined} />
      ) : null}
      {openFolder ? (
        <FolderDrawer mode="edit" folder={openFolder as any} folders={tree} canManage={canManage} />
      ) : null}
    </ListPageLayout>
  )
}
