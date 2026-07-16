import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { compileTemplateHtml, sanitizeTokenizedFragment } from "@openbooks/pdf";
import { guardPermission } from "../../../lib/authz";
import { PDF_RECORD_TYPE_BY_KEY } from "../../../lib/pdf-templates/catalog";
import { prettifyTemplateHtml } from "../../../lib/pdf-templates/prettify";
import { starterTemplate } from "../../../lib/pdf-templates/starters";
import { listPdfTemplates } from "../../../lib/pdf-templates/store";

export const runtime = "nodejs";

/** GET /api/pdf-templates?recordType=customer_invoice — list org templates. */
export async function GET(req: Request) {
  const gate = await guardPermission("admin.customization.manage");
  if (gate instanceof NextResponse) return gate;
  const { user } = gate;
  const recordType = new URL(req.url).searchParams.get("recordType") ?? undefined;
  if (recordType && !PDF_RECORD_TYPE_BY_KEY[recordType])
    return NextResponse.json({ error: "unknown record type" }, { status: 400 });
  const rows = await listPdfTemplates(user.orgId, recordType);
  // The list payload doesn't need the (potentially large) HTML bodies.
  return NextResponse.json({
    rows: rows.map(({ sourceHtml: _s, compiledHtml: _c, ...row }) => row),
  });
}

/** POST — create a template. Body: { recordType, name, description?, sourceHtml?, … }.
 *  Omitted sourceHtml seeds the record type's starter design. */
export async function POST(req: Request) {
  const gate = await guardPermission("admin.customization.manage");
  if (gate instanceof NextResponse) return gate;
  const { user } = gate;
  const body = (await req.json().catch(() => ({}))) as {
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
  if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

  const org = (await db.execute(sql`
    select settings ->> 'brandPrimary' as brand_primary from orgs where id = ${user.orgId}
  `)) as unknown as { rows: { brand_primary: string | null }[] };
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
  const paperSize = ["letter", "a4", "legal"].includes(body.paperSize ?? "") ? body.paperSize : "letter";
  const orientation = body.orientation === "landscape" ? "landscape" : "portrait";
  const marginMm = Math.min(50, Math.max(0, Math.round(Number(body.marginMm ?? 14)) || 14));

  try {
    const row = await db.transaction(async (tx) => {
      if (body.isDefault)
        await tx.execute(sql`
          update pdf_templates set is_default = false, updated_at = now()
           where org_id = ${user.orgId} and record_type = ${body.recordType} and is_default`);
      const result = (await tx.execute(sql`
        insert into pdf_templates (org_id, record_type, name, description, paper_size, orientation,
                                   margin_mm, header_html, footer_html, source_html, compiled_html,
                                   is_default, created_by, updated_by)
        values (${user.orgId}, ${body.recordType}, ${body.name!.trim()}, ${body.description ?? null},
                ${paperSize}, ${orientation}, ${marginMm}, ${header || null}, ${footer || null},
                ${prettySource}, ${compiled.compiledHtml}, ${!!body.isDefault},
                ${user.id}, ${user.id})
        returning id, name
      `)) as any;
      const inserted = result.rows[0];
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'pdf_templates', ${inserted.id}, 'insert', ${JSON.stringify({ name: body.name })}, ${user.id})`);
      return inserted;
    });
    return NextResponse.json({ id: row.id, name: row.name });
  } catch (e) {
    const msg = (e as Error).message ?? "insert failed";
    if (msg.includes("unique"))
      return NextResponse.json({ error: "A template with that name already exists" }, { status: 409 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
