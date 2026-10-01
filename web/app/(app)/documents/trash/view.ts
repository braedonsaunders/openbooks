import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  page,
  pageHeader,
  ref,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { dateTime } from '../../../../lib/format'
import { listTrash } from '../../../../lib/file-cabinet'
import type { TrashRow } from './TrashList'

/** Trash uses the shared list page shell. Its authorized reader scopes files
 * and folders together; restore and purge remain controlled record actions. */

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
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
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
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        back: { href: data.backHref, label: data.backLabel },
      }),
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          title: data.emptyTitle,
          icon: 'trash',
        }),
        when: f('isEmpty'),
      },
      { ...widgetBlock('trash-list', { rows: data.rows }), when: f('hasRows') },
    ],
  })
}
