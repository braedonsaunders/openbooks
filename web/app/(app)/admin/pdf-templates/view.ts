import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../lib/authz'
import { disabledDocKinds } from '../../../../lib/documents'
import { PDF_RECORD_TYPES } from '../../../../lib/pdf-templates/catalog'
import { starterTemplate } from '../../../../lib/pdf-templates/starters'
import { listPdfTemplates } from '../../../../lib/pdf-templates/store'
import type { StarterRow, TemplateRow } from './TemplatesList'

/**
 * PDF templates, split into a loader and a spec.
 *
 * The whole body is one widget, not spec blocks — the same doctrine as
 * `admin/backups`: the native page renders a single client component
 * (`TemplatesList`) that owns client search + type filter + pagination
 * (`PagedTable` state), a preview drawer fed by a POST fetch effect, and
 * prompt-then-fetch mutations (new / duplicate). Search/filter state,
 * effects and capabilities are not spec vocabulary, so the component stays
 * whole and the spec places it. What the spec CAN carry is everything
 * around it: the back-linked header and the server-resolved inputs become
 * loader data.
 *
 * The loader copies the native page's permission, visibility and
 * derivation logic verbatim: the `admin.customization.manage` gate, the
 * feature-gated `disabledDocKinds` filter applied to BOTH the catalog and
 * the stored templates (a type whose feature is off shows neither its
 * starter nor its org templates), and the effective-default derivation
 * (a starter prints when no org template is the type default).
 */

export interface PdfTemplatesData {
  title: string
  description: string
  backHref: string
  backLabel: string
  list: {
    templates: TemplateRow[]
    starters: StarterRow[]
    recordTypes: { key: string; label: string }[]
  }
}

export async function loadPdfTemplates(): Promise<PdfTemplatesData> {
  const authz = await requirePermission('admin.customization.manage')
  const t = await getTranslations('pdfTemplates')
  const tHub = await getTranslations('admin.hub')

  const hiddenKinds = new Set(await disabledDocKinds(authz.user.orgId))
  const catalog = PDF_RECORD_TYPES.filter((meta) => !hiddenKinds.has(meta.key))
  const all = (await listPdfTemplates(authz.user.orgId)).filter((tp) => !hiddenKinds.has(tp.recordType))
  const templates: TemplateRow[] = all.map((tp) => ({
    id: tp.id,
    name: tp.name,
    description: tp.description,
    recordType: tp.recordType,
    paperSize: tp.paperSize,
    orientation: tp.orientation,
    isActive: tp.isActive,
    isDefault: tp.isDefault,
  }))
  const defaultedTypes = new Set(all.filter((tp) => tp.isDefault).map((tp) => tp.recordType))
  const starters: StarterRow[] = catalog.map((meta) => {
    const starter = starterTemplate(meta)
    return {
      recordType: meta.key,
      label: meta.label,
      sourceHtml: starter.sourceHtml,
      headerHtml: starter.headerHtml,
      footerHtml: starter.footerHtml,
      isEffectiveDefault: !defaultedTypes.has(meta.key),
    }
  })

  return {
    title: t('title'),
    description: t('description'),
    backHref: '/admin',
    backLabel: tHub('title'),
    list: {
      templates,
      starters,
      recordTypes: catalog.map((meta) => ({ key: meta.key, label: meta.label })),
    },
  }
}

const f = ref<PdfTemplatesData>()

export function pdfTemplatesSpec(data: PdfTemplatesData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        back: { href: f('backHref'), label: f('backLabel') },
        title: f('title'),
        description: f('description'),
      }),
    ],
    body: [
      // Client search, the type dropdown, pagination, the preview drawer and
      // the new/duplicate mutations are client state, effects and
      // capabilities — the spec places the component whole and the loader
      // hands over the server inputs as flat data. Authz never crosses the
      // boundary; the component owns its mutations through fetch calls to
      // `/api/pdf-templates*`, exactly as on the native path.
      widgetBlock('pdf-templates-list', {
        templates: data.list.templates,
        starters: data.list.starters,
        recordTypes: data.list.recordTypes,
      }),
    ],
  })
}
