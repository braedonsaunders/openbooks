import 'server-only'

import { getTranslations } from 'next-intl/server'
import { grid, page, pageHeader, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { dateTime } from '../../../../lib/format'
import { listTrash } from '../../../../lib/file-cabinet'
import type { TrashRow } from './TrashList'

/**
 * Deleted files and folders, split into a loader and a spec.
 *
 * Everything below the header is one interactive island — a table whose rows
 * carry restore buttons, per-row delete-forever buttons behind a confirm
 * dialog, and busy-state spinners, all client state the spec cannot name —
 * so the spec places the whole `TrashList` through a widget rather than
 * decomposing it into blocks. What the spec DOES own is the page's real
 * structure: the full-height shell (flex column with its own header strip
 * and fill-viewport body, opaque to ListPageLayout, hence `bare`), the back
 * link above the header, and the empty/non-empty pair behind presence flags.
 *
 * Loader work copied verbatim from page.tsx: the documents.manage gate, the
 * manager-baseline viewer, `listTrash` (whose visibility filtering covers the
 * rows AND any count derived from them — a count is a disclosure), and the
 * `documents` + `documents.trash` message namespaces (`fileTypes.*` labels
 * for badge text, `inLocation` interpolated eagerly).
 */

export interface TrashData {
  backHref: string
  backLabel: string
  title: string
  description: string
  rows: TrashRow[]
  isEmpty: boolean
  hasRows: boolean
  emptyTitle: string
}

export async function loadTrash(): Promise<TrashData> {
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

  return {
    backHref: '/documents',
    backLabel: tt('back'),
    title: tt('title'),
    description: tt('description'),
    rows,
    isEmpty: rows.length === 0,
    hasRows: rows.length > 0,
    emptyTitle: tt('empty'),
  }
}

const f = ref<TrashData>()

export function trashSpec(data: TrashData): PageSpec {
  return page({
    route: '/documents/trash',
    // The trash owns its own full-height shell — ListPageLayout's centered
    // container would nest the chrome, so header and body concatenate.
    layout: 'bare',
    header: [],
    body: [
      grid('flex h-full min-h-0 flex-col', [
        // Header — full width, not centered.
        grid(
          'border-b border-slate-200 bg-white px-3 pt-3 pb-2.5 sm:px-6 sm:pt-4 sm:pb-3 dark:border-slate-800 dark:bg-slate-900',
          [
            widgetBlock('trash-back-link', {
              href: data.backHref,
              label: data.backLabel,
            }),
            pageHeader({ title: f('title'), description: f('description') }),
          ],
        ),
        // Body — the listing fills the viewport.
        grid('app-scroll min-h-0 flex-1 overflow-auto p-3 sm:p-4', [
          {
            ...widgetBlock('empty-state', { title: data.emptyTitle, icon: 'trash' }),
            when: f('isEmpty'),
          },
          {
            ...widgetBlock('trash-list', { rows: data.rows }),
            when: f('hasRows'),
          },
        ]),
      ]),
    ],
  })
}
