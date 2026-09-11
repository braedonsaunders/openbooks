import 'server-only'

import type { ComponentProps } from 'react'
import { getTranslations } from 'next-intl/server'
import {
  grid,
  page,
  pageHeader,
  pagination,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
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
import type { FileDrawer } from './FileDrawer'
import type { FolderDrawer } from './FolderDrawer'
import type { FolderRow, FileRow } from './FileList'
import type { TreeFolder } from './FolderTree'
import type { DocumentCrumb } from './sections'

/**
 * The file cabinet, split into a loader and a spec.
 *
 * Everything below the header is interactive islands — a collapsible sidebar
 * tree, a table with checkboxes, a context menu and a bulk-action bar, and
 * three URL-backed drawers — so the spec places them through widgets rather
 * than decomposing them into blocks. What the spec DOES own is the page's
 * real structure: the full-height shell (flex column with its own header
 * strip and fill-viewport body, opaque to ListPageLayout, hence `bare`), the
 * sticky breadcrumb, the empty/non-empty pair, and the pager.
 *
 * Loader work copied verbatim from page.tsx: the documents.read gate, the
 * org-role baseline plus resource_grants viewer, the parallel tree/contents/
 * path fetch, the ?file= / ?folder= flyout resolution, and the three access
 * tiers behind separate presence flags.
 *
 * The empty-state action reuses the header actions widget by name, exactly as
 * the page passed the same `actions` node to both PageHeader and
 * EmptyState.
 */

type FileDrawerPayload = ComponentProps<typeof FileDrawer> & { remountKey: string }
type FolderDrawerPayload = ComponentProps<typeof FolderDrawer> & { remountKey: string }

export interface DocumentsData {
  title: string
  description: string
  searchPlaceholder: string
  currentParams: Record<string, string | string[] | undefined>
  canManage: boolean
  trashHref: string
  trashLabel: string
  allFilesHref: string
  allFilesLabel: string
  crumbs: DocumentCrumb[]
  treeFolders: TreeFolder[]
  activeFolderId?: string
  folders: FolderRow[]
  files: FileRow[]
  showLocation: boolean
  canEdit: boolean
  canDelete: boolean
  sort: string
  dir: 'asc' | 'desc'
  total: number
  currentPage: number
  perPage: number
  isEmpty: boolean
  hasRows: boolean
  emptyTitle: string
  emptyDescription: string
  fileDrawerOpen: boolean
  fileDrawer: FileDrawerPayload | null
  folderDrawerCreateOpen: boolean
  folderDrawerCreate: FolderDrawerPayload | null
  folderDrawerEditOpen: boolean
  folderDrawerEdit: FolderDrawerPayload | null
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

export async function loadDocuments(
  sp: Record<string, string | string[] | undefined>,
): Promise<DocumentsData> {
  const authz = await requirePermission('documents.read')
  const canManage = can(authz, 'documents.manage')
  const orgId = authz.user.orgId
  // Access control: '*' admins get Manager everywhere; otherwise the org-role
  // baseline (Manager for documents.manage, else Viewer) plus resource_grants.
  const baseline: AccessLevel = canManage ? 'manager' : 'viewer'
  const viewer = { userId: authz.user.id, isAdmin: can(authz, '*'), baseline }
  const t = await getTranslations('documents')

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
  const pathCrumbs = pathNodes.map((c) => ({
    id: c.id,
    name: localizeName(c.name, c.systemKind),
  }))
  const crumbs: DocumentCrumb[] = pathCrumbs.map((c, i) => ({
    id: c.id,
    name: c.name,
    href: folderHref(sp, c.id),
    isLast: i === pathCrumbs.length - 1,
  }))

  const newFolderParent = activeFolderId
  const isEmpty = files.length === 0 && childFolders.length === 0

  return {
    title: t('list.title'),
    description: t('list.description'),
    searchPlaceholder: t('list.searchPlaceholder'),
    currentParams: sp,
    canManage,
    trashHref: '/documents/trash',
    trashLabel: t('trash.link'),
    allFilesHref: folderHref(sp, null),
    allFilesLabel: t('list.allFiles'),
    crumbs,
    treeFolders: localizedTree,
    activeFolderId,
    folders: childFolders.map((fo) => ({
      id: fo.id,
      name: fo.name,
      fileCount: fo.fileCount,
      isSystem: fo.isSystem,
    })),
    files: files.map((f) => ({
      id: f.id,
      name: f.name,
      fileType: f.fileType,
      sizeLabel: formatSize(f.sizeBytes),
      modifiedLabel: dateTime(f.updatedAt),
      versionCount: f.versionCount,
      folderName: localizedTree.find((folder) => folder.id === f.folderId)?.name ?? f.folderName,
    })),
    showLocation: !activeFolderId,
    canEdit: accessAtLeast(currentAccess, 'editor'),
    canDelete: accessAtLeast(currentAccess, 'manager'),
    sort: params.sort,
    dir: params.dir,
    total,
    currentPage: params.page,
    perPage: params.perPage,
    isEmpty,
    hasRows: !isEmpty,
    emptyTitle: t('list.empty.title'),
    emptyDescription: t('list.empty.description'),
    fileDrawerOpen: Boolean(openFile),
    fileDrawer: openFile
      ? {
          remountKey: String(openFile.id),
          file: openFile,
          canEdit: accessAtLeast(openFileAccess, 'editor'),
          canManage: accessAtLeast(openFileAccess, 'manager'),
        }
      : null,
    folderDrawerCreateOpen: folderParam === 'new' && canManage,
    folderDrawerCreate:
      folderParam === 'new' && canManage
        ? {
            remountKey: 'new-folder',
            mode: 'create',
            folders: localizedTree,
            parentId: newFolderParent,
          }
        : null,
    folderDrawerEditOpen: Boolean(openFolder),
    folderDrawerEdit: openFolder
      ? {
          remountKey: String(openFolder.id),
          mode: 'edit',
          folder: openFolder,
          folders: localizedTree,
          canManage: accessAtLeast(openFolderAccess, 'manager'),
        }
      : null,
  }
}

const f = ref<DocumentsData>()

export function documentsSpec(data: DocumentsData): PageSpec {
  const actionsProps = {
    trashHref: data.trashHref,
    trashLabel: data.trashLabel,
    currentParams: data.currentParams,
    newFolderParentId: data.activeFolderId ?? null,
  }
  return page({
    route: '/documents',
    // The cabinet owns its own full-height shell — ListPageLayout's centered
    // container would nest the chrome, so header and body concatenate.
    layout: 'bare',
    header: [],
    body: [
      grid('flex h-full min-h-0 flex-col', [
        // Header — full width, not centered.
        grid(
          'border-b border-slate-200 bg-white px-3 pt-3 pb-2.5 sm:px-6 sm:pt-4 sm:pb-3 dark:border-slate-800 dark:bg-slate-900',
          [
            pageHeader({
              title: f('title'),
              description: f('description'),
              actions: [widget('documents-actions', actionsProps, f('canManage'))],
            }),
            grid('mt-2 flex flex-wrap items-center gap-2', [
              widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
            ]),
          ],
        ),
        // Body — folder tree + file listing fill the viewport.
        grid('flex min-h-0 flex-1', [
          widgetBlock('folder-tree', {
            folders: data.treeFolders,
            activeFolderId: data.activeFolderId ?? null,
          }),
          grid('app-scroll flex min-w-0 flex-1 flex-col overflow-auto', [
            widgetBlock('documents-breadcrumb', {
              homeHref: data.allFilesHref,
              homeLabel: data.allFilesLabel,
              crumbs: data.crumbs,
            }),
            grid('min-w-0 flex-1 p-3 sm:p-4', [
              {
                ...widgetBlock('empty-state', {
                  title: data.emptyTitle,
                  description: data.emptyDescription,
                  action: data.canManage ? 'documents-actions' : null,
                  actionProps: data.canManage ? actionsProps : null,
                }),
                when: f('isEmpty'),
              },
              {
                ...widgetBlock('file-list', {
                  folders: data.folders,
                  files: data.files,
                  activeFolderId: data.activeFolderId ?? null,
                  showLocation: data.showLocation,
                  canEdit: data.canEdit,
                  canDelete: data.canDelete,
                  currentParams: data.currentParams,
                  sort: data.sort,
                  dir: data.dir,
                }),
                when: f('hasRows'),
              },
              {
                ...pagination({
                  basePath: '/documents',
                  total: f('total'),
                  page: f('currentPage'),
                  perPage: f('perPage'),
                  // The native pager DOES carry the `mt-3` wrapper here.
                }),
                when: f('hasRows'),
              },
            ]),
          ]),
        ]),
      ]),
      // URL-backed drawers, portaled to <body> wherever it renders.
      {
        ...widgetBlock('file-drawer', { drawer: data.fileDrawer }),
        when: f('fileDrawerOpen'),
      },
      {
        ...widgetBlock('folder-drawer', { drawer: data.folderDrawerCreate }),
        when: f('folderDrawerCreateOpen'),
      },
      {
        ...widgetBlock('folder-drawer', { drawer: data.folderDrawerEdit }),
        when: f('folderDrawerEditOpen'),
      },
    ],
  })
}
