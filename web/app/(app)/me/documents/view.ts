import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  field,
  grid,
  page,
  pageHeader,
  panel,
  table,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { loadMeDocumentsHome, meDocumentsAuthz } from '../../../../lib/hrm/me-documents'

/**
 * Me documents: the person's own documents with inline sign and
 * acknowledge plus their subject-access exports with an
 * export-my-data request (while hrmDataSubjectExport is on). Renders
 * when hrm and hrmDocuments are on — the loader 404s otherwise.
 */

const f = field
const item = field

export type MeDocumentsPageData = NonNullable<Awaited<ReturnType<typeof loadMeDocumentsHome>>>

export function meDocumentsSpec(data: MeDocumentsPageData): PageSpec {
  return page({
    route: '/me/documents',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget('link-button', { href: '/me/documents?export=1', label: f('requestExportLabel') }, f('canRequestExport')),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      grid('flex h-full min-h-0 flex-col gap-4', [
        table({
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          empty: { title: f('empty') },
          columns: [
            column(data.columns.title, text(item('title'))),
            column(data.columns.sent, text(item('sent'), { fallback: '—' })),
            column(data.columns.status, badge(item('statusLabel'), { variant: 'secondary' })),
            column('', widgetCell('hrm-me-document-actions', {
              documentId: item('id'),
              signable: item('signable'),
              acknowledgeable: item('acknowledgeable'),
              signLabel: data.signLabel,
              signNameLabel: data.signNameLabel,
              acknowledgeLabel: data.acknowledgeLabel,
              actionFailed: data.actionFailed,
            })),
          ],
        }),
        panel({
          title: f('exportsTitle'),
          bodyClassName: 'min-h-0 overflow-y-auto p-0',
          blocks: [
            table({
              variant: 'app',
              rows: f('exportRows'),
              rowKey: item('id'),
              empty: { title: f('exportsEmpty') },
              columns: [
                column(data.exportColumns.requested, text(item('requested'))),
                column(data.exportColumns.status, text(item('statusLabel'))),
                column(data.exportColumns.detail, text(item('incompleteDetail'), { fallback: '—' })),
                column('', widgetCell('hrm-me-export-download', {
                  downloadable: item('downloadable'),
                  href: item('downloadHref'),
                  label: data.downloadLabel,
                })),
              ],
            }),
          ],
        }),
      ]),
      {
        ...widgetBlock('hrm-me-export-dialog', { partyId: data.partyId, requestExportLabel: data.requestExportLabel, requestExportDone: data.requestExportDone, actionFailed: data.actionFailed }),
        when: f('exportOpen'),
      },
    ],
  })
}

export async function meDocumentsTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('meDocuments.title')
}

export async function loadMeDocumentsPage(sp: Record<string, string | undefined>) {
  const authz = await meDocumentsAuthz()
  if (!authz) notFound()
  return loadMeDocumentsHome(authz, sp)
}
