import 'server-only'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { compileTemplateHtml } from '@openbooks/pdf'
import { isUuid } from '../list-params'
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
  /** Design version: bumped by every PATCH, cited by every issued PDF. */
  revision: number
  updatedAt: string
}

const COLS = sql`
  id, record_type as "recordType", name, description,
  paper_size as "paperSize", orientation, margin_mm as "marginMm",
  header_html as "headerHtml", footer_html as "footerHtml",
  source_html as "sourceHtml", compiled_html as "compiledHtml",
  is_default as "isDefault", is_active as "isActive", revision, updated_at as "updatedAt"
`

export async function listPdfTemplates(orgId: string, recordType?: string): Promise<PdfTemplateRow[]> {
  const filter = recordType ? sql` and record_type = ${recordType}` : sql``
  const r = (await db.execute<PdfTemplateRow>(sql`
    select ${COLS} from pdf_templates
     where org_id = ${orgId}${filter}
     order by record_type, is_default desc, name
  `))
  return r.rows
}

export async function getPdfTemplate(orgId: string, id: string): Promise<PdfTemplateRow | null> {
  // pdf_templates.id is a uuid PK. A malformed id is the same miss as a
  // foreign row and must never be bound — a driver cast error is not a 404.
  if (!isUuid(id)) return null
  const r = (await db.execute<PdfTemplateRow>(sql`
    select ${COLS} from pdf_templates where org_id = ${orgId} and id = ${id}
  `))
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
  /**
   * Immutable evidence of which design produced the PDF: the saved
   * template's id + revision plus the hash of the whole printed design
   * (body, header, footer, paper, orientation, margins). A starter fallback
   * has no id or revision — its content hash still identifies the design.
   * Every issuance channel (download headers, email_log meta, backup
   * manifest) records this.
   */
  provenance: PdfTemplateProvenance
}

/**
 * Every field the renderer consumes: the compiled body plus the chrome and
 * page geometry around it. render.ts takes exactly this Pick list, so the
 * hash below and the printed bytes can never disagree about what "the
 * design" is.
 */
export type PdfPrintDesign = Pick<
  ResolvedPdfTemplate,
  'compiledHtml' | 'paperSize' | 'orientation' | 'marginMm' | 'headerHtml' | 'footerHtml'
>

/** Which template design produced an issued PDF. */
export type PdfTemplateProvenance = {
  /** Null for the built-in starter (no saved row, no revision). */
  templateId: string | null
  revision: number | null
  /** sha256 hex of the canonical PdfPrintDesign actually printed. */
  contentHash: string
}

/**
 * Hash the whole printed design, not just the body: header, footer, paper
 * size, orientation and margins all shape the bytes. Fixed key order and
 * empty-string normalization ('' prints exactly like null) keep the digest
 * stable for identical designs.
 */
export function printDesignHash(design: PdfPrintDesign): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        compiledHtml: design.compiledHtml,
        paperSize: design.paperSize,
        orientation: design.orientation,
        marginMm: design.marginMm,
        headerHtml: design.headerHtml || null,
        footerHtml: design.footerHtml || null,
      }),
      'utf8',
    )
    .digest('hex')
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

  if (templateId != null) {
    if (!isUuid(templateId)) return null
    const tpl = await getPdfTemplate(orgId, templateId)
    if (tpl && tpl.recordType === recordType && tpl.isActive) {
      return {
        ...tpl,
        provenance: { templateId: tpl.id, revision: tpl.revision, contentHash: printDesignHash(tpl) },
      }
    }
    return null
  }

  const r = (await db.execute<PdfTemplateRow>(sql`
    select ${COLS} from pdf_templates
     where org_id = ${orgId} and record_type = ${recordType} and is_active
     order by is_default desc, name limit 1
  `))
  const found = r.rows.find((t) => t.isDefault) ?? r.rows[0]
  if (found) {
    return {
      ...found,
      provenance: { templateId: found.id, revision: found.revision, contentHash: printDesignHash(found) },
    }
  }

  // Built-in fallback: compile the starter on the fly with the org accent.
  const org = (await db.execute<{ brand_primary: string | null }>(sql`
    select settings ->> 'brandPrimary' as brand_primary from orgs where id = ${orgId}
  `))
  const starter = starterTemplate(meta, org.rows[0]?.brand_primary)
  const { compiledHtml } = compileTemplateHtml(starter.sourceHtml)
  return {
    compiledHtml,
    paperSize: 'letter',
    orientation: 'portrait',
    marginMm: 14,
    headerHtml: starter.headerHtml || null,
    footerHtml: starter.footerHtml || null,
    provenance: {
      templateId: null,
      revision: null,
      contentHash: printDesignHash({
        compiledHtml,
        paperSize: 'letter',
        orientation: 'portrait',
        marginMm: 14,
        headerHtml: starter.headerHtml || null,
        footerHtml: starter.footerHtml || null,
      }),
    },
  }
}
