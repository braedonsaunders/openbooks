import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Org-authored PDF document templates — printable documents (invoice, bill,
 * quote, journal…) authored as paper-sized HTML with {{merge}} tokens and
 * data-each/data-if repeat-row markers.
 *
 * Two HTML representations are stored so the editor round-trips losslessly and
 * rendering stays fast:
 *   source_html   — the editable, sanitized HTML the visual builder reloads
 *                   (data-each/data-if markers still present)
 *   compiled_html — sanitized + markers expanded to {{#each}}/{{#if}} blocks;
 *                   merged with record values at render time (@openbooks/pdf
 *                   renderTemplate → renderHtmlDocumentPdf)
 *
 * `record_type` is a key from @openbooks/customization (e.g. 'customer_invoice')
 * or 'journal_entry' (ledger entries live outside the documents supertype).
 * At most one default per (org, record_type) — enforced in the write API like
 * form_layouts.is_default.
 */

export const PDF_PAPER_SIZE = ["letter", "a4", "legal"] as const;
export const PDF_ORIENTATION = ["portrait", "landscape"] as const;

export const pdfTemplates = pgTable(
  "pdf_templates",
  {
    id: id(),
    orgId: orgRef(),
    /** Record-type key from @openbooks/customization, or 'journal_entry'. */
    recordType: text("record_type").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    paperSize: text("paper_size", { enum: PDF_PAPER_SIZE }).notNull().default("letter"),
    orientation: text("orientation", { enum: PDF_ORIENTATION }).notNull().default("portrait"),
    marginMm: integer("margin_mm").notNull().default(14),
    /** Running header/footer; {{tokens}} + {{page}}/{{pages}} counters. */
    headerHtml: text("header_html"),
    footerHtml: text("footer_html"),
    /** Editable builder HTML (sanitized; markers intact). */
    sourceHtml: text("source_html").notNull().default(""),
    /** Server-compiled render HTML (sanitized; markers expanded to mustache). */
    compiledHtml: text("compiled_html").notNull().default(""),
    /** The org-wide default template for this record type (≤1 per org+type). */
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("pdf_templates_org_type_name").on(t.orgId, t.recordType, t.name),
    index("pdf_templates_org_type").on(t.orgId, t.recordType, t.isDefault),
  ],
);

/*
FOREIGN KEYS (added by the integrator's migration pass):
  pdf_templates.org_id               → orgs.id
  pdf_templates.created_by/updated_by → users.id
*/
