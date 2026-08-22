import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { compileTemplateHtml, sanitizeTokenizedFragment } from "@openbooks/pdf";
import { guardPermission } from "../../../../lib/authz";
import { isDocKindEnabled } from "../../../../lib/documents";
import { prettifyTemplateHtml } from "../../../../lib/pdf-templates/prettify";
import { getPdfTemplate } from "../../../../lib/pdf-templates/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET /api/pdf-templates/[id] — full template (editor payload). */
export async function GET(_req: Request, { params }: Params) {
  const gate = await guardPermission("admin.customization.manage");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  const row = await getPdfTemplate(gate.user.orgId, id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!(await isDocKindEnabled(gate.user.orgId, row.recordType))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ row });
}

/** PATCH — save design/settings. Compiles + sanitizes sourceHtml server-side. */
export async function PATCH(req: Request, { params }: Params) {
  const gate = await guardPermission("admin.customization.manage");
  if (gate instanceof NextResponse) return gate;
  const { user } = gate;
  const { id } = await params;
  const existing = await getPdfTemplate(user.orgId, id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!(await isDocKindEnabled(user.orgId, existing.recordType))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    description?: string | null;
    sourceHtml?: string;
    headerHtml?: string | null;
    footerHtml?: string | null;
    paperSize?: string;
    orientation?: string;
    marginMm?: number;
    isDefault?: boolean;
    isActive?: boolean;
  };

  const name = body.name?.trim() || existing.name;
  const source = body.sourceHtml ?? existing.sourceHtml;
  const headerHtml = body.headerHtml !== undefined ? body.headerHtml : existing.headerHtml;
  const footerHtml = body.footerHtml !== undefined ? body.footerHtml : existing.footerHtml;
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
  const paperSize = ["letter", "a4", "legal"].includes(body.paperSize ?? "")
    ? body.paperSize
    : existing.paperSize;
  const orientation = body.orientation
    ? body.orientation === "landscape" ? "landscape" : "portrait"
    : existing.orientation;
  const marginMm = body.marginMm !== undefined
    ? Math.min(50, Math.max(0, Math.round(Number(body.marginMm)) || 0))
    : existing.marginMm;
  const isDefault = body.isDefault ?? existing.isDefault;
  const isActive = body.isActive ?? existing.isActive;

  try {
    await db.transaction(async (tx) => {
      if (isDefault && !existing.isDefault)
        await tx.execute(sql`
          update pdf_templates set is_default = false, updated_at = now()
           where org_id = ${user.orgId} and record_type = ${existing.recordType} and is_default`);
      await tx.execute(sql`
        update pdf_templates
           set name = ${name}, description = ${body.description !== undefined ? body.description : existing.description},
               paper_size = ${paperSize}, orientation = ${orientation}, margin_mm = ${marginMm},
               header_html = ${header || null}, footer_html = ${footer || null},
               source_html = ${prettySource}, compiled_html = ${compiled.compiledHtml},
               is_default = ${isDefault}, is_active = ${isActive},
               updated_at = now(), updated_by = ${user.id}
         where org_id = ${user.orgId} and id = ${id}`);
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'pdf_templates', ${id}, 'update', ${JSON.stringify({ name })}, ${user.id})`);
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message ?? "update failed";
    if (msg.includes("unique"))
      return NextResponse.json({ error: "A template with that name already exists" }, { status: 409 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** DELETE — remove a template (records fall back to the org default/starter). */
export async function DELETE(_req: Request, { params }: Params) {
  const gate = await guardPermission("admin.customization.manage");
  if (gate instanceof NextResponse) return gate;
  const { user } = gate;
  const { id } = await params;
  const existing = await getPdfTemplate(user.orgId, id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!(await isDocKindEnabled(user.orgId, existing.recordType))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from pdf_templates where org_id = ${user.orgId} and id = ${id}`);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${user.orgId}, 'pdf_templates', ${id}, 'delete', ${JSON.stringify({ name: existing.name })}, ${user.id})`);
  });
  return NextResponse.json({ ok: true });
}
