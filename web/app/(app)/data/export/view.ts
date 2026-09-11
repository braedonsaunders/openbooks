import 'server-only'

import { frame, page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'

/**
 * The data export workbench, split into a loader and a spec.
 *
 * This page is the degenerate case of the brief's vocabulary: a fully
 * client-side workbench (`'use client'` — resource Select, column
 * checkboxes, format buttons, every fetch) with zero server-rendered
 * content. The LOADER reproduces the page.tsx gate verbatim
 * (`data.export` permission) and returns no presentation data, because
 * there is none: every string the page shows is read by the component
 * itself through `useTranslations('data')`, the resource list and columns
 * arrive over `/api/data/resources` after mount, and the download runs
 * through `fetch` + `URL.createObjectURL` in the click handler. The spec
 * places the whole workbench through the `data-export` widget, exactly as
 * the SQL console (`query-console`) and the reports hub (`reports-hub`)
 * are placed: the spec composes pages, it does not reimplement domain
 * components.
 *
 * The native component is NOT copied. It stays in `./ExportClient` (a
 * sibling module, not inline in page.tsx, so there is nothing to move
 * into a `sections.tsx` — the backups precedent), and the page and the widget registry
 * share that one implementation. Never write a second copy.
 */

/** No server-rendered content: the loader runs the gate and binds nothing. */
export type DataExportData = Record<string, unknown>

export async function loadDataExport(
  _sp: Record<string, string | string[] | undefined>,
): Promise<DataExportData> {
  // page.tsx gate, verbatim.
  await requirePermission('data.export')
  return {}
}

export function dataExportSpec(_data: DataExportData): PageSpec {
  return page({
    route: '/data/export',
    // Bare with the `page-container` frame: the native page wraps the
    // workbench in `<PageContainer>` (scroll wrapper + centered container
    // + fade-in), which the grid vocabulary cannot name. `list`/`detail`
    // would nest a second ListPageLayout (sticky header chrome + padded
    // body) around it and break parity — the same arrangement as the
    // reports hub.
    layout: 'bare',
    header: [],
    body: [frame('page-container', [widgetBlock('data-export')])],
  })
}
