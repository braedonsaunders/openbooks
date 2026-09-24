import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { assertPrintablePage, compileTemplateHtml, PDF_MARGIN_MM_MAX, PDF_MARGIN_MM_MIN, sanitizeTokenizedFragment } from "@openbooks/pdf";
import { guardPermission } from "../../../lib/authz";
import { describeDbError, pgErrorCode } from "../../../lib/setup/coerce";
import { disabledDocKinds, isDocKindEnabled } from "../../../lib/documents.ts";
import { PDF_RECORD_TYPE_BY_KEY } from "../../../lib/pdf-templates/catalog";
import { prettifyTemplateHtml } from "../../../lib/pdf-templates/prettify";
import { starterTemplate } from "../../../lib/pdf-templates/starters";
import { listPdfTemplates, type PdfTemplateRow } from "../../../lib/pdf-templates/store";

export const runtime = "nodejs";

/** GET /api/pdf-templates?recordType=customer_invoice — list org templates. */
export async function GET(req: Request) {
  const gate = await guardPermission("admin.customization.manage");
  if (gate instanceof NextResponse) return gate;
  const { user } = gate;
  const recordType = new URL(req.url).searchParams.get("recordType") ?? undefined;
  if (recordType && !PDF_RECORD_TYPE_BY_KEY[recordType])
    return NextResponse.json({ error: "unknown record type" }, { status: 400 });
  if (recordType && !(await isDocKindEnabled(user.orgId, recordType))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const hidden = new Set(await disabledDocKinds(user.orgId));
  const rows = (await listPdfTemplates(user.orgId, recordType))
    .filter((row) => !hidden.has(row.recordType));
  // The list payload doesn't need the (potentially large) HTML bodies.
  return NextResponse.json({
    rows: rows.map((row): Omit<PdfTemplateRow, "sourceHtml" | "compiledHtml"> => ({
      id: row.id,
      recordType: row.recordType,
      name: row.name,
      description: row.description,
      paperSize: row.paperSize,
      orientation: row.orientation,
      marginMm: row.marginMm,
      headerHtml: row.headerHtml,
      footerHtml: row.footerHtml,
      isDefault: row.isDefault,
      isActive: row.isActive,
      revision: row.revision,
      updatedAt: row.updatedAt,
    })),
  });
}

/** POST — create a template. Body: { recordType, name, description?, sourceHtml?, … }.
 *  Omitted sourceHtml seeds the record type's starter design. */
export async function POST(req: Request) {
  const gate = await guardPermission("admin.customization.manage");
  if (gate instanceof NextResponse) return gate;
  const { user } = gate;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    recordType?: string;
    name?: string;
    description?: string | null;
    sourceHtml?: string;
    headerHtml?: string | null;
    footerHtml?: string | null;
    paperSize?: string;
    orientation?: string;
    marginMm?: number;
    isDefault?: boolean;
  };
  const meta = body.recordType ? PDF_RECORD_TYPE_BY_KEY[body.recordType] : undefined;
  if (!meta) return NextResponse.json({ error: "unknown record type" }, { status: 400 });
  if (!(await isDocKindEnabled(user.orgId, meta.key))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

  const org = (await db.execute<{ brand_primary: string | null }>(sql`
    select settings ->> 'brandPrimary' as brand_primary from orgs where id = ${user.orgId}
  `));
  const starter = starterTemplate(meta, org.rows[0]?.brand_primary);

  const source = body.sourceHtml?.trim() ? body.sourceHtml : starter.sourceHtml;
  const headerHtml = body.headerHtml ?? starter.headerHtml;
  const footerHtml = body.footerHtml ?? starter.footerHtml;
  let compiled: { sanitizedSource: string; compiledHtml: string };
  let header: string;
  let footer: string;
  try {
    compiled = compileTemplateHtml(source);
    header = headerHtml ? sanitizeTokenizedFragment(headerHtml) : "";
    footer = footerHtml ? sanitizeTokenizedFragment(footerHtml) : "";
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  // Store the source human-readable (whitespace-only change; render-neutral).
  const prettySource = await prettifyTemplateHtml(compiled.sanitizedSource);
  // Page geometry is refused, never coerced: a misspelled size printing
  // Letter, or a 500 mm margin printing blank, is a silent misprint. Omitted
  // values take the starter defaults.
  const paperSizeInput = body.paperSize ?? "letter";
  const marginMmInput = body.marginMm ?? 14;
  try {
    assertPrintablePage(paperSizeInput, marginMmInput);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  if (!Number.isInteger(marginMmInput)) {
    return NextResponse.json({ error: `Margin must be a whole number of millimetres from ${PDF_MARGIN_MM_MIN} to ${PDF_MARGIN_MM_MAX} — got ${String(marginMmInput)}.` }, { status: 400 });
  }
  // assertPrintablePage narrows paperSizeInput to the supported set.
  const paperSize = paperSizeInput;
  const marginMm = marginMmInput;
  if (body.orientation !== undefined && body.orientation !== "landscape" && body.orientation !== "portrait") {
    return NextResponse.json({ error: `Unknown orientation "${body.orientation}" — use portrait or landscape.` }, { status: 400 });
  }
  const orientation = body.orientation === "landscape" ? "landscape" : "portrait";

  try {
    const row = await db.transaction(async (tx) => {
      if (body.isDefault) {
        // Serialize default-swaps per (org, kind) under an advisory
        // transaction lock: without it two concurrent creates both clear,
        // both insert is_default=true, and the partial unique index answers
        // 500. The lock orders them; the index stays as the backstop, so a
        // 23505 here still means the name index (handled below).
        await tx.execute(sql`
          select pg_advisory_xact_lock(hashtextextended(${'pdf-template-default:' + user.orgId + ':' + body.recordType}, 0))`);
        await tx.execute(sql`
          update pdf_templates set is_default = false, updated_at = now()
           where org_id = ${user.orgId} and record_type = ${body.recordType} and is_default`);
      }
      const result = (await tx.execute<{ id: string; name: string; snapshot: Record<string, unknown> }>(sql`
        insert into pdf_templates (org_id, record_type, name, description, paper_size, orientation,
                                   margin_mm, header_html, footer_html, source_html, compiled_html,
                                   is_default, created_by, updated_by)
        values (${user.orgId}, ${body.recordType}, ${body.name!.trim()}, ${body.description ?? null},
                ${paperSize}, ${orientation}, ${marginMm}, ${header || null}, ${footer || null},
                ${prettySource}, ${compiled.compiledHtml}, ${!!body.isDefault},
                ${user.id}, ${user.id})
        returning id, name, to_jsonb(pdf_templates) as snapshot
      `));
      const inserted = result.rows[0]!;
      // Insert evidence follows the {after} convention: the created design's
      // full row, so the audit shows what was designed — not just its name.
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'pdf_templates', ${inserted.id}, 'insert',
                ${JSON.stringify({ after: inserted.snapshot })}, ${user.id})`);
      return inserted;
    });
    return NextResponse.json({ id: row.id, name: row.name });
  } catch (e) {
    // Drizzle wraps driver failures (message "Failed query: <sql>", driver
    // error in `cause`), so match the SQLSTATE — the wrapper message never
    // contains "unique", and must never reach the client (F-t13-001).
    if (pgErrorCode(e) === "23505")
      return NextResponse.json({ error: "A template with that name already exists" }, { status: 409 });
    return NextResponse.json({ error: describeDbError(e) }, { status: 500 });
  }
}
