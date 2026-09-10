import { getTranslations } from 'next-intl/server'
import { EmptyState, PageHeader } from '@openbooks/ui'
import { SearchInput } from '../../../components/search-input'
import { Pagination } from '../../../components/pagination'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, parseListParams, pickString } from '../../../lib/list-params'
import { dateTime } from '../../../lib/format'
import {
  accessAtLeast,
  fileAccessLevel,
  folderAccessLevel,
  getFile,
  getFolderPath,
  getFolderTree,
  listFolderContents,
  type AccessLevel,
} from '../../../lib/file-cabinet'
import { FolderTree } from './FolderTree'
import { UploadButton } from './UploadButton'
import { NewFolderButton } from './NewFolderButton'
import { FileDrawer } from './FileDrawer'
import { FolderDrawer } from './FolderDrawer'
import { FileList } from './FileList'
import { DocumentsActions, DocumentsBreadcrumb } from './sections'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadDocuments, documentsSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('documents')
  return { title: t('list.metaTitle') }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Build a /documents href that navigates to a folder, preserving sort/search. */
function folderHref(
  sp: Record<string, string | string[] | undefined>,
  folderId: string | null,
): string {
  const params = new URLSearchParams()
  for (const key of ['q', 'sort', 'dir', 'perPage'] as const) {
    const v = sp[key]
    if (typeof v === 'string' && v) params.set(key, v)
  }
  if (folderId) params.set('fid', folderId)
  const qs = params.toString()
  return qs ? `/documents?${qs}` : '/documents'
}

export default async function Documents({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadDocuments(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={documentsSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('documents.read')
  const canManage = can(authz, 'documents.manage')
  const orgId = authz.user.orgId
  // Access control: '*' admins get Manager everywhere; otherwise the org-role
  // baseline (Manager for documents.manage, else Viewer) plus resource_grants.
  const baseline: AccessLevel = canManage ? 'manager' : 'viewer'
  const viewer = { userId: authz.user.id, isAdmin: can(authz, '*'), baseline }
  const t = await getTranslations('documents')

  const sp = await searchParams
  const fileId = typeof sp.file === 'string' ? sp.file : undefined
  const folderParam = typeof sp.folder === 'string' ? sp.folder : undefined
  const folderId = pickString(sp.fid)
  const activeFolderId = folderId && isUuid(folderId) ? folderId : undefined
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 50,
    allowedSorts: ['name', 'size', 'created'] as const,
  })

  const localizeName = (name: string, systemKind: string | null) =>
    systemKind === 'ap_capture' ? t('systemFolders.apCapture') : name

  // Sidebar tree (navigable folders only — the leaf per-record attachment
  // folders are excluded) and the current folder's contents (its immediate
  // sub-folders + files, one paginated window) are fetched in parallel.
  const [tree, contents, pathNodes] = await Promise.all([
    getFolderTree(orgId, viewer),
    listFolderContents(orgId, viewer, {
      parentId: activeFolderId,
      q: params.q,
      sort: params.sort,
      dir: params.dir,
      limit: params.perPage,
      offset: (params.page - 1) * params.perPage,
    }),
    activeFolderId ? getFolderPath(orgId, viewer, activeFolderId) : Promise.resolve([]),
  ])
  const { folders: childFolderNodes, files, total } = contents
  const localizedTree = tree.map((folder) => ({
    ...folder,
    name: localizeName(folder.name, folder.systemKind),
  }))

  const [openFile, openFolder] = await Promise.all([
    fileId && isUuid(fileId) ? getFile(orgId, fileId, viewer) : null,
    folderParam && folderParam !== 'new' && isUuid(folderParam)
      ? localizedTree.find((f) => f.id === folderParam) ?? null
      : null,
  ])

  // Effective access tiers for UI affordances (the server re-checks every
  // mutation). The current folder's tier is inherited by the items it contains;
  // at the virtual root / in search, fall back to the org-role baseline.
  const [currentAccess, openFileAccess, openFolderAccess] = await Promise.all([
    activeFolderId ? folderAccessLevel(orgId, viewer, activeFolderId) : Promise.resolve(baseline),
    openFile ? fileAccessLevel(orgId, viewer, openFile.id) : Promise.resolve<AccessLevel>('none'),
    openFolder ? folderAccessLevel(orgId, viewer, openFolder.id) : Promise.resolve<AccessLevel>('none'),
  ])

  // Sub-folders of the current location, shown as rows above the files — a real
  // file browser. Empty while searching (search spans the whole cabinet).
  const childFolders = childFolderNodes.map((f) => ({
    ...f,
    name: localizeName(f.name, f.systemKind),
  }))

  // Breadcrumb path — resolved from the folder itself (works for leaf record
  // folders that never appear in the sidebar tree).
  const crumbs = pathNodes.map((c) => ({ id: c.id, name: localizeName(c.name, c.systemKind) }))
  const isEmpty = files.length === 0 && childFolders.length === 0
  const newFolderParent = activeFolderId

  const actions = canManage ? (
    <DocumentsActions
      trashHref="/documents/trash"
      trashLabel={t('trash.link')}
      newFolder={<NewFolderButton parentId={newFolderParent} />}
      upload={<UploadButton folderId={newFolderParent} />}
    />
  ) : undefined

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header — full width, not centered */}
      <div className="border-b border-slate-200 bg-white px-3 pt-3 pb-2.5 sm:px-6 sm:pt-4 sm:pb-3 dark:border-slate-800 dark:bg-slate-900">
        <PageHeader title={t('list.title')} description={t('list.description')} actions={actions} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <SearchInput placeholder={t('list.searchPlaceholder')} />
        </div>
      </div>

      {/* Body — folder tree + file listing fill the viewport */}
      <div className="flex min-h-0 flex-1">
        <FolderTree folders={localizedTree} activeFolderId={activeFolderId} />
        <div className="app-scroll flex min-w-0 flex-1 flex-col overflow-auto">
          {/* Breadcrumb path */}
          <DocumentsBreadcrumb
            homeHref={folderHref(sp, null)}
            homeLabel={t('list.allFiles')}
            crumbs={crumbs.map((c, i) => ({
              id: c.id,
              name: c.name,
              href: folderHref(sp, c.id),
              isLast: i === crumbs.length - 1,
            }))}
          />

          <div className="min-w-0 flex-1 p-3 sm:p-4">
            {isEmpty ? (
              <EmptyState
                title={t('list.empty.title')}
                description={t('list.empty.description')}
                action={actions}
              />
            ) : (
              <>
                <FileList
                  folders={childFolders.map((fo) => ({
                    id: fo.id,
                    name: fo.name,
                    fileCount: fo.fileCount,
                    isSystem: fo.isSystem,
                  }))}
                  files={files.map((f) => ({
                    id: f.id,
                    name: f.name,
                    fileType: f.fileType,
                    sizeLabel: formatSize(f.sizeBytes),
                    modifiedLabel: dateTime(f.updatedAt),
                    versionCount: f.versionCount,
                    folderName: localizedTree.find((folder) => folder.id === f.folderId)?.name ?? f.folderName,
                  }))}
                  activeFolderId={activeFolderId}
                  showLocation={!activeFolderId}
                  canEdit={accessAtLeast(currentAccess, 'editor')}
                  canDelete={accessAtLeast(currentAccess, 'manager')}
                  currentParams={sp}
                  sort={params.sort}
                  dir={params.dir}
                />
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
      </div>

      {openFile ? (
        <FileDrawer
          file={(openFile)}
          canEdit={accessAtLeast(openFileAccess, 'editor')}
          canManage={accessAtLeast(openFileAccess, 'manager')}
        />
      ) : null}
      {folderParam === 'new' && canManage ? (
        <FolderDrawer mode="create" folders={localizedTree} parentId={newFolderParent} />
      ) : null}
      {openFolder ? (
        <FolderDrawer
          mode="edit"
          folder={(openFolder)}
          folders={localizedTree}
          canManage={accessAtLeast(openFolderAccess, 'manager')}
        />
      ) : null}
    </div>
  )
}
