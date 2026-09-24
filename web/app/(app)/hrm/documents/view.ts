import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  grid,
  field,
  link,
  page,
  pageHeader,
  statTile,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { notFound } from 'next/navigation'
import { documentsAuthz, loadDocumentsHome } from '../../../../lib/hrm/documents-home'

/**
 * Documents tab: statTiles (awaiting signature, expiring, retention
 * due, exports pending), the register as a shared `table` block with
 * `filter-chips` status segments, the header link-button opening the
 * generate dialog through the URL, and row links opening the document
 * drawer (signers timeline, events, versions, send/remind/void/hold)
 * through the URL. Templates, categories, and retention schedules
 * configure as rehomed Setup sections on this page. Renders only when
 * hrm and hrmDocuments are on and the actor holds hrm.documents.read —
 * the loader 404s otherwise.
 */

const f = field
const item = field

export type DocumentsPageData = NonNullable<Awaited<ReturnType<typeof loadDocumentsHome>>>

export function documentsSpec(data: DocumentsPageData): PageSpec {
  return page({
    route: '/hrm/documents',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget('link-button', { href: f('addHref'), label: f('addLabel'), iconKey: 'plus' }, f('canManage')),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock('module-home-tabs', { tabs: data.viewTabs }),
      grid('grid shrink-0 grid-cols-2 gap-3 xl:grid-cols-4', [
        statTile({ iconKey: f('tiles.0.iconKey'), accent: f('tiles.0.accent'), label: f('tiles.0.label'), value: f('tiles.0.value'), tone: f('tiles.0.tone') }),
        statTile({ iconKey: f('tiles.1.iconKey'), accent: f('tiles.1.accent'), label: f('tiles.1.label'), value: f('tiles.1.value'), tone: f('tiles.1.tone') }),
        statTile({ iconKey: f('tiles.2.iconKey'), accent: f('tiles.2.accent'), label: f('tiles.2.label'), value: f('tiles.2.value'), tone: f('tiles.2.tone') }),
        statTile({ iconKey: f('tiles.3.iconKey'), accent: f('tiles.3.accent'), label: f('tiles.3.label'), value: f('tiles.3.value'), tone: f('tiles.3.tone') }),
      ]),
      // The register sizes to its content: a viewport-height clamp here
      // would box the table while its rows overflow visibly, and the
      // setup sections below would paint over the overflowed rows and
      // intercept their clicks (CK-32). The page scrolls as a whole.
      grid('flex min-h-0 flex-col gap-4', [
        widgetBlock('filter-chips', {
          basePath: '/hrm/documents',
          currentParams: data.currentParams,
          paramKey: 'status',
          label: data.segmentsLabel,
          allLabel: data.allLabel,
          options: data.segmentOptions,
        }),
        table({
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          empty: { title: f('empty') },
          columns: [
            column(data.columns.title, link(item('title'), item('href'))),
            column(data.columns.person, text(item('person'), { fallback: '—' })),
            column(data.columns.category, text(item('category'))),
            column(data.columns.sent, text(item('sent'), { fallback: '—' })),
            column(data.columns.expires, text(item('expires'), { fallback: '—' })),
            column(data.columns.status, badge(item('statusLabel'), { variant: item('statusVariant') })),
          ],
        }),
      ]),
      {
        ...widgetBlock('hrm-documents-drawer', { drawer: data.drawer }),
        when: f('drawerOpen'),
      },
      {
        ...widgetBlock('hrm-documents-generate-dialog', { generate: data.generate }),
        when: f('generateOpen'),
      },
      widgetBlock('setup-section', { entityKey: 'hrm-document-templates', sp: data.currentParams, basePath: '/hrm/documents', rowParam: 'template' }, f('canManage')),
      widgetBlock('setup-section', { entityKey: 'hrm-document-categories', sp: data.currentParams, basePath: '/hrm/documents', rowParam: 'category' }, f('canManage')),
      widgetBlock('setup-section', { entityKey: 'hrm-retention-schedules', sp: data.currentParams, basePath: '/hrm/documents', rowParam: 'retention' }, f('canManage')),
    ],
  })
}

export async function documentsTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('documents.title')
}

export async function loadDocumentsPage(sp: Record<string, string | undefined>) {
  const authz = await documentsAuthz()
  if (!authz) notFound()
  return loadDocumentsHome(authz, sp)
}
