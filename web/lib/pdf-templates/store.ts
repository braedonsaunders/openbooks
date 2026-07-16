import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { compileTemplateHtml } from '@openbooks/pdf'
import { PDF_RECORD_TYPE_BY_KEY } from './catalog'
import { starterTemplate } from './starters'

/** A pdf_templates row shaped for the editor + renderer. */
export type PdfTemplateRow = {
  id: string
  recordType: string
  name: string
  description: string | null
  paperSize: 'letter' | 'a4' | 'legal'
  orientation: 'portrait' | 'landscape'
  marginMm: number
  headerHtml: string | null
  footerHtml: string | null
  sourceHtml: string
  compiledHtml: string
  isDefault: boolean
  isActive: boolean
  updatedAt: string
}

const COLS = sql`
  id, record_type as "recordType", name, description,
  paper_size as "paperSize", orientation, margin_mm as "marginMm",
  header_html as "headerHtml", footer_html as "footerHtml",
  source_html as "sourceHtml", compiled_html as "compiledHtml",
  is_default as "isDefault", is_active as "isActive", updated_at as "updatedAt"
`

export async function listPdfTemplates(orgId: string, recordType?: string): Promise<PdfTemplateRow[]> {
  const filter = recordType ? sql` and record_type = ${recordType}` : sql``
  const r = (await db.execute(sql`
    select ${COLS} from pdf_templates
     where org_id = ${orgId}${filter}
     order by record_type, is_default desc, name
  `)) as unknown as { rows: PdfTemplateRow[] }
  return r.rows
}

export async function getPdfTemplate(orgId: string, id: string): Promise<PdfTemplateRow | null> {
  const r = (await db.execute(sql`
    select ${COLS} from pdf_templates where org_id = ${orgId} and id = ${id}
  `)) as unknown as { rows: PdfTemplateRow[] }
  return r.rows[0] ?? null
}

/** What the render route prints with: a saved template or the built-in starter. */
export type ResolvedPdfTemplate = {
  compiledHtml: string
  paperSize: 'letter' | 'a4' | 'legal'
  orientation: 'portrait' | 'landscape'
  marginMm: number
  headerHtml: string | null
  footerHtml: string | null
}

/**
 * Resolve the template to print a record with: an explicit template id, else
 * the org default for the record type, else the built-in starter design (so
 * every record prints beautifully with zero setup).
 */
export async function resolvePdfTemplate(
  orgId: string,
  recordType: string,
  templateId?: string | null,
): Promise<ResolvedPdfTemplate | null> {
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType]
  if (!meta) return null

  if (templateId) {
    const tpl = await getPdfTemplate(orgId, templateId)
    if (tpl && tpl.recordType === recordType && tpl.isActive) return tpl
    return null
  }

  const r = (await db.execute(sql`
    select ${COLS} from pdf_templates
     where org_id = ${orgId} and record_type = ${recordType} and is_active
     order by is_default desc, name limit 1
  `)) as unknown as { rows: PdfTemplateRow[] }
  const found = r.rows.find((t) => t.isDefault) ?? r.rows[0]
  if (found) return found

  // Built-in fallback: compile the starter on the fly with the org accent.
  const org = (await db.execute(sql`
    select settings ->> 'brandPrimary' as brand_primary from orgs where id = ${orgId}
  `)) as unknown as { rows: { brand_primary: string | null }[] }
  const starter = starterTemplate(meta, org.rows[0]?.brand_primary)
  const { compiledHtml } = compileTemplateHtml(starter.sourceHtml)
  return {
    compiledHtml,
    paperSize: 'letter',
    orientation: 'portrait',
    marginMm: 14,
    headerHtml: starter.headerHtml || null,
    footerHtml: starter.footerHtml || null,
  }
}
