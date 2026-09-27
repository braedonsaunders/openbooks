import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { assertPrintablePage, compileTemplateHtml, PDF_MARGIN_MM_MAX, PDF_MARGIN_MM_MIN, sanitizeTokenizedFragment } from "@openbooks/pdf";
import { describeDbError, pgErrorCode } from "../../../../lib/setup/coerce";
import { isDocKindEnabled } from "../../../../lib/documents.ts";
import { isUuid } from "../../../../lib/list-params";
import { PDF_RECORD_TYPE_BY_KEY } from "../../../../lib/pdf-templates/catalog";
import { prettifyTemplateHtml } from "../../../../lib/pdf-templates/prettify";
import { getPdfTemplate, getVisiblePdfTemplate } from "../../../../lib/pdf-templates/store";
import { notFound } from "@/lib/api/responses";


export const runtime = "nodejs";

const bodyObjectSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  sourceHtml: z.string().optional(),
  headerHtml: z.string().nullable().optional(),
  footerHtml: z.string().nullable().optional(),
  paperSize: z.enum(['letter', 'a4', 'legal']).optional(),
  orientation: z.enum(["landscape", "portrait"]).optional(),
  marginMm: z.number().optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).strict();

type Params = { params: Promise<{ id: string }> };

/** GET /api/pdf-templates/[id] — full template (editor payload). */
async function legacyGET(_req: Request, { params }: Params, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;

  const { id } = await params;
  // A malformed id is indistinguishable from a missing template and never
  // reaches the uuid column.
  if (!isUuid(id)) return notFound("record");
  const row = await getVisiblePdfTemplate(gate.user.orgId, id);
  if (!row) return notFound("record");
  return NextResponse.json({ row });
}

/** PATCH — save design/settings. Compiles + sanitizes sourceHtml server-side. */
async function legacyPATCH(req: Request, { params }: Params, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;

  const { user } = gate;
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");
  const existing = await getPdfTemplate(user.orgId, id);
  if (!existing) return notFound("record");
  const docKind = PDF_RECORD_TYPE_BY_KEY[existing.recordType]?.docKind ?? existing.recordType;
  if (!(await isDocKindEnabled(user.orgId, docKind))) {
    return notFound("record");
  }

  const parsedBody = await parseJsonBody(req, bodyObjectSchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;

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
    return apiErrorResponse(e, { safeStatus: 400 });
  }
  // Store the source human-readable (whitespace-only change; render-neutral).
  const prettySource = await prettifyTemplateHtml(compiled.sanitizedSource);
  // Page geometry is refused, never coerced (see the POST route): omitted
  // values keep the stored row.
  const paperSizeInput = body.paperSize ?? existing.paperSize;
  const marginMmInput = body.marginMm ?? existing.marginMm;
  try {
    assertPrintablePage(paperSizeInput, marginMmInput);
  } catch (e) {
    return apiErrorResponse(e, { safeStatus: 400 });
  }
  if (!Number.isInteger(marginMmInput)) {
    return NextResponse.json({ error: `Margin must be a whole number of millimetres from ${PDF_MARGIN_MM_MIN} to ${PDF_MARGIN_MM_MAX} — got ${marginMmInput}.` }, { status: 400 });
  }
  // assertPrintablePage narrows paperSizeInput to the supported set.
  const paperSize = paperSizeInput;
  const marginMm = marginMmInput;
  if (body.orientation !== undefined && body.orientation !== "landscape" && body.orientation !== "portrait") {
    return NextResponse.json({ error: `Unknown orientation "${body.orientation}" — use portrait or landscape.` }, { status: 400 });
  }
  const orientation = body.orientation
    ? body.orientation === "landscape" ? "landscape" : "portrait"
    : existing.orientation;
  const isDefault = body.isDefault ?? existing.isDefault;
  const isActive = body.isActive ?? existing.isActive;
  // Collection POST coerces isDefault with !!; an explicit PATCH value
  // outside the boolean domain would otherwise reach the column and either
  // coerce silently or abort the update with an unhandled storage 500.
  if (typeof isDefault !== 'boolean') {
    return NextResponse.json({ error: 'isDefault must be a boolean' }, { status: 400 });
  }
  if (typeof isActive !== 'boolean') {
    return NextResponse.json({ error: 'isActive must be a boolean' }, { status: 400 });
  }

  try {
    const outcome = await db.transaction(async (tx) => {
      // The before-image rides the row lock inside this transaction (never the
      // pre-transaction read above, which a concurrent PATCH could already
      // have superseded). The lock doubles as the existence check: a
      // concurrent delete between the pre-check above and this statement
      // matches zero rows here, and that is a 404 — never {ok:true} with a
      // phantom audit event, and the default-clear below never runs for a
      // vanished row.
      const before = (await tx.execute<{ snapshot: Record<string, unknown> }>(sql`
        select to_jsonb(pdf_templates) as snapshot from pdf_templates
         where org_id = ${user.orgId} and id = ${id} for update`))
      if (before.rows.length === 0) return 'missing' as const
      // A promotion clears the old default BEFORE the self-update sets the
      // new one: unique indexes are checked per statement, so setting self
      // first would trip the one-default backstop mid-transaction. The clear
      // is safe here (unlike a blind pre-check) because the lock above
      // already proved the row exists in this transaction — the self-update
      // below cannot be the zero-row case.
      if (isDefault && !existing.isDefault) {
        // Same per-(org, kind) serialization as the collection POST: two
        // concurrent promotions must order, not both commit a default.
        await tx.execute(sql`
          select pg_advisory_xact_lock(hashtextextended(${'pdf-template-default:' + user.orgId + ':' + existing.recordType}, 0))`);
        await tx.execute(sql`
          update pdf_templates set is_default = false, updated_at = now()
           where org_id = ${user.orgId} and record_type = ${existing.recordType} and is_default and id <> ${id}`);
      }
      const updated = (await tx.execute<{ snapshot: Record<string, unknown> }>(sql`
        update pdf_templates
           set name = ${name}, description = ${body.description !== undefined ? body.description : existing.description},
               paper_size = ${paperSize}, orientation = ${orientation}, margin_mm = ${marginMm},
               header_html = ${header || null}, footer_html = ${footer || null},
               source_html = ${prettySource}, compiled_html = ${compiled.compiledHtml},
               is_default = ${isDefault}, is_active = ${isActive},
               revision = revision + 1,
               updated_at = now(), updated_by = ${user.id}
         where org_id = ${user.orgId} and id = ${id}
        returning to_jsonb(pdf_templates) as snapshot`))
      if (updated.rows.length === 0) return 'missing' as const
      // The design audit carries the full before/after row — a bare {name}
      // cannot show what the save changed, and the failing audit write rolls
      // the design change back with it.
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'pdf_templates', ${id}, 'update',
                ${JSON.stringify({ before: before.rows[0]!.snapshot, after: updated.rows[0]!.snapshot })}, ${user.id})`);
      return 'ok' as const
    });
    if (outcome === 'missing') return notFound("record");
    return NextResponse.json({ ok: true });
  } catch (e) {
    // Same Drizzle-wrapper caveat as the collection POST: match
    // the SQLSTATE, never the wrapper message.
    if (pgErrorCode(e) === "23505")
      return NextResponse.json({ error: "A template with that name already exists" }, { status: 409 });
    return NextResponse.json({ error: describeDbError(e) }, { status: 500 });
  }
}

/** DELETE — remove a template (records fall back to the org default/starter). */
async function legacyDELETE(_req: Request, { params }: Params, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;

  const { user } = gate;
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");
  const existing = await getPdfTemplate(user.orgId, id);
  if (!existing) return notFound("record");
  const docKind = PDF_RECORD_TYPE_BY_KEY[existing.recordType]?.docKind ?? existing.recordType;
  if (!(await isDocKindEnabled(user.orgId, docKind))) {
    return notFound("record");
  }
  // The removed design's before-image rides the row lock, so the delete
  // event stays auditable after no read can observe the row. A concurrent
  // delete between the pre-check above and this statement matches zero rows:
  // that is a 404, and no audit event is written for a row this call did
  // not remove.
  const deleted = (await db.transaction(async (tx) => {
    const before = (await tx.execute<{ snapshot: Record<string, unknown> }>(sql`
      select to_jsonb(pdf_templates) as snapshot from pdf_templates
       where org_id = ${user.orgId} and id = ${id} for update`))
    if (before.rows.length === 0) return 'missing' as const
    const removed = (await tx.execute<{ id: string }>(sql`
      delete from pdf_templates where org_id = ${user.orgId} and id = ${id} returning id`))
    if (removed.rows.length === 0) return 'missing' as const
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${user.orgId}, 'pdf_templates', ${id}, 'delete',
              ${JSON.stringify({ before: before.rows[0]!.snapshot })}, ${user.id})`);
    return 'ok' as const
  }));
  if (deleted === 'missing') return notFound("record");
  return NextResponse.json({ ok: true });
}

export const GET = defineRoute({
  permission: "admin.customization.manage", feature: { none: "This route is governed by its permission and service authorization." },
  params: z.object({ "id": z.string() }),
  handler: ({ request, params, authz }) => legacyGET(request, { params: Promise.resolve(params) }, authz),
});

export const PATCH = defineRoute({
  permission: "admin.customization.manage", feature: { none: "This route is governed by its permission and service authorization." },
  params: z.object({ "id": z.string() }),
  handler: ({ request, params, authz }) => legacyPATCH(request, { params: Promise.resolve(params) }, authz),
});

export const DELETE = defineRoute({
  permission: "admin.customization.manage", feature: { none: "This route is governed by its permission and service authorization." },
  params: z.object({ "id": z.string() }),
  handler: ({ request, params, authz }) => legacyDELETE(request, { params: Promise.resolve(params) }, authz),
});
