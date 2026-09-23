import 'server-only'

import { notFound } from 'next/navigation'
import { frame, page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { DOC_KIND_FEATURE } from '../../../../../lib/document-kinds'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { PDF_RECORD_TYPE_BY_KEY } from '../../../../../lib/pdf-templates/catalog'
import { getPdfTemplate } from '../../../../../lib/pdf-templates/store'
import { customMergeFields } from '../../../../../lib/pdf-templates/values'
import type PdfTemplateEditor from './PdfTemplateEditor'

/**
 * The PDF template editor, split into a loader and a spec.
 *
 * One whole client island: a GrapesJS canvas with its own document model,
 * drag-and-drop, a merge-field palette and save/preview mutations. Nothing
 * here is decomposable into blocks, so the spec places one widget.
 *
 * The loader keeps separate refusals because they mean different things: the
 * template does not exist in this org (404), its record type is not in the
 * catalog (404), or that document kind is switched off for this tenant (the
 * feature-required remedy naming the switch — the template exists, so a bare
 * 404 would strand the author with no path to enable it).
 *
 * `customMergeFields` is org-scoped, so the palette a template author sees is
 * fenced to their own tenant's custom fields. That happens in the loader; the
 * spec carries only the resolved key/label pairs.
 */

type EditorProps = Parameters<typeof PdfTemplateEditor>[0]

export interface PdfTemplateEditorData {
  template: EditorProps['template']
  mergeFields: EditorProps['mergeFields']
  collections: EditorProps['collections']
}

export async function loadPdfTemplateEditor(id: string): Promise<PdfTemplateEditorData> {
  const authz = await requirePermission('admin.customization.manage')
  const row = await getPdfTemplate(authz.user.orgId, id)
  if (!row) notFound()
  const meta = PDF_RECORD_TYPE_BY_KEY[row.recordType]
  if (!meta) notFound()
  // A kind whose Features switch is off names the switch: the template
  // exists, so "not found" would strand the author with no remedy.
  const kindFeature = DOC_KIND_FEATURE[row.recordType]
  if (kindFeature) await requireFeatureEnabled(authz.user.orgId, kindFeature)

  const custom = await customMergeFields(row.recordType, authz.user.orgId)
  const mergeFields = [...meta.fields, ...custom].map((f) => ({ key: f.key, label: f.label }))
  const collections = meta.collections.map((c) => ({
    key: c.key,
    label: c.label,
    fields: c.fields.map((f) => ({ key: f.key, label: f.label })),
  }))

  return {
    template: {
      id: row.id,
      recordType: row.recordType,
      recordTypeLabel: meta.label,
      name: row.name,
      description: row.description,
      paperSize: row.paperSize,
      orientation: row.orientation,
      marginMm: row.marginMm,
      headerHtml: row.headerHtml,
      footerHtml: row.footerHtml,
      sourceHtml: row.sourceHtml,
      isDefault: row.isDefault,
      isActive: row.isActive,
    },
    mergeFields,
    collections,
  }
}

export function pdfTemplateEditorSpec(data: PdfTemplateEditorData): PageSpec {
  return page({
    route: '/admin/pdf-templates/[id]',
    // Exact native wrapper: <div className="p-4">, and nothing else. A page
    // layout would add chrome this route does not have.
    layout: 'bare',
    header: [],
    body: [
      frame('padded', [
        widgetBlock('pdf-template-editor', {
          template: data.template,
          mergeFields: data.mergeFields,
          collections: data.collections,
        }),
      ]),
    ],
  })
}
