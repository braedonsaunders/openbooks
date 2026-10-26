import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { documentRevisionCounterSql } from "@openbooks/engine/records/revision";
import { apiErrorResponse } from "@/lib/api/error-response";
import { isDocumentRevisionToken } from "@openbooks/engine/records/revision";
import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  DocumentVoidError,
  requestDocumentVoid,
  requestReceiptVoidWithDependents,
  resolveVoidCalendarSubsidiaryId,
  suggestVoidReversalDate,
} from "@openbooks/engine/ledger/document-void";
import { periodDisplayLabelSql } from "@openbooks/engine/periods/period-policy";
import { can, getAuthz, guardSubsidiaryScope } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { createPermission, postPermission } from "../../../../../lib/document-kinds.ts";
import { documentRouteReadPermission } from "../../../../../lib/flow-subject-authz.ts";
import { lockedDocumentScopeDenied } from "../../../../../lib/document-scope.ts";
import { isDocKindEnabled } from "../../../../../lib/documents.ts";
import { isUuid } from "../../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";
const POSTBodySchema1 = z.object({
  reason: z.string().optional(),
  reversalDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  reversalPeriodId: uuidString().nullable().optional(),
  expectedUpdatedAt: z.string().min(1),
  withDependents: z.boolean().optional(),
});

export const runtime = "nodejs";

function voidPermission(kind: string): string | null {
  if (kind === "vendor_payment") return "ap.pay";
  if (kind === "customer_payment") return "ar.pay";
  if (kind === "journal") return "gl.post";
  if (kind === "expense_report") return "ap.post";
  if (kind === "purchase_order") return "purchase_orders.create";
  if (kind === "sales_order" || kind === "quote") return "ar.create";
  // A goods receipt voids through its receiving grant; the reversal grant
  // below covers the stock and GL legs when Inventory is on.
  if (kind === "purchase_receipt") return "goods_receipts.create";
  try {
    return postPermission(kind);
  } catch {
    try {
      return createPermission(kind);
    } catch {
      return null;
    }
  }
}

type VoidGuard = {
  authz: NonNullable<Awaited<ReturnType<typeof getAuthz>>>;
  id: string;
  doc: {
    kind: string;
    subsidiaryId: string | null;
    documentDate: string;
    postingDate: string | null;
  };
};

/** The caller may drive this document's void — shared by GET and POST. */
async function guardVoidDocument(id: string): Promise<VoidGuard | NextResponse> {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isUuid(id)) return notFound("record");
  const found = await db.execute<{
    kind: string;
    subsidiaryId: string | null;
    documentDate: string;
    postingDate: string | null;
  }>(
    sql`
    select kind, subsidiary_id as "subsidiaryId", document_date::text as "documentDate",
           posting_date::text as "postingDate"
      from documents
     where id = ${id} and org_id = ${authz.user.orgId}
  `,
    "objects",
  );
  const doc = found[0];
  if (!doc) return notFound("record");
  const denied = guardSubsidiaryScope(authz, doc.subsidiaryId);
  if (denied) return denied;
  if (!(await isDocKindEnabled(authz.user.orgId, doc.kind))) {
    return notFound("record");
  }
  const permission = voidPermission(doc.kind);
  if (!permission) {
    return NextResponse.json(
      { error: "this transaction type uses its dedicated void workflow" },
      { status: 422 },
    );
  }
  // Read before void: without the kind's read grant (gl.read for journals,
  // ap.pay/ar.pay for payments, expenses.read, …) the record answers as
  // missing — shared by the periods GET and the void POST below, so neither
  // confirms the record exists or names its family.
  const readPerm = documentRouteReadPermission(doc.kind);
  if (readPerm && !can(authz, readPerm)) {
    return notFound("record");
  }
  if (!can(authz, permission)) {
    return NextResponse.json({ error: `missing permission: ${permission}` }, { status: 403 });
  }
  // Voiding a receipt reverses its stock movements and inventory journals,
  // so it takes the reversal grant on top of the receiving grant — the same
  // authority split the receive endpoint demands for posting.
  if (
    doc.kind === "purchase_receipt" &&
    (await isFeatureEnabled(authz.user.orgId, "inventory")) &&
    !can(authz, "items.reverse")
  ) {
    return NextResponse.json({ error: "missing permission: items.reverse" }, { status: 403 });
  }
  return { authz, id, doc };
}

/**
 * Adjustment periods eligible as an explicit void-reversal override. Empty
 * when the org uses none — the void UI then offers no period choice and the
 * reversal resolves by date in the regular covering period.
 */
export const GET = defineRoute({
  public: "session",
  handler: async ({ request: _req, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const { id } = await params;
    const gate = await guardVoidDocument(id);
    if (gate instanceof NextResponse) return gate;
    // Adjustment periods use fiscal labels in the viewer's locale.
    const locale = await getLocale();
    // The reversal default the dialog confirms: the entry's own date, moved
    // forward to the first open period only when the entry's period closed.
    const suggestion = await suggestVoidReversalDate(db, gate.authz.user.orgId, {
      id,
      kind: gate.doc.kind,
      documentDate: gate.doc.documentDate,
      postingDate: gate.doc.postingDate,
      subsidiaryId: gate.doc.subsidiaryId,
    });
    const calendarSubsidiaryId = await resolveVoidCalendarSubsidiaryId(
      db,
      gate.authz.user.orgId,
      id,
      gate.doc.subsidiaryId,
    );
    const periods = calendarSubsidiaryId
      ? await db.execute<{ id: string; name: string; startsOn: string; endsOn: string }>(
          sql`
          select p.id, ${periodDisplayLabelSql(locale, "p")} as name,
                 p.starts_on::text as "startsOn", p.ends_on::text as "endsOn"
            from accounting_periods p
            join fiscal_calendars fc
              on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
             and fc.is_active
             and fc.id = public.subsidiary_posting_calendar(
               ${gate.authz.user.orgId}::uuid, ${calendarSubsidiaryId}::uuid, ${suggestion.suggestedDate}::date
             )
           where p.org_id = ${gate.authz.user.orgId} and p.is_adjustment
           order by p.starts_on, p.ends_on, p.id
        `,
          "objects",
        )
      : [];
    // The revision token the void POST fences on: linked documents (a goods
    // receipt from its purchase order) have no drawer holding it, so the
    // suggestion carries it to the confirmation dialog.
    const revision =
      (
        await db.execute<{ revision: string }>(
          sql`
      select ${documentRevisionCounterSql(sql`revision_seq`)} as revision
        from documents where id = ${id} and org_id = ${gate.authz.user.orgId}
    `,
          "objects",
        )
      )[0]?.revision ?? null;
    return NextResponse.json({ adjustmentPeriods: periods, ...suggestion, revision });
  },
});

export const POST = defineRoute({
  public: "session",
  body: POSTBodySchema1,
  handler: async ({ request: _req, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const { id } = await params;
    const gate = await guardVoidDocument(id);
    if (gate instanceof NextResponse) return gate;
    const { authz } = gate;

    const body = routeBody as {
      reason?: string;
      reversalDate?: string | null;
      reversalPeriodId?: string | null;
      expectedUpdatedAt?: string;
      withDependents?: boolean;
    };
    if (!isDocumentRevisionToken(body.expectedUpdatedAt)) {
      return NextResponse.json(
        {
          error: "Reload the document and supply its exact revision before voiding",
          code: "stale-revision",
        },
        { status: 409 },
      );
    }
    // Void-with-dependents is a goods-receipt cascade only: any other kind
    // refuses closed instead of running an undefined combination.
    if (body.withDependents && gate.doc.kind !== "purchase_receipt") {
      return NextResponse.json(
        { error: "void with dependents is only offered for goods receipts", code: "invalid" },
        { status: 422 },
      );
    }
    try {
      // The void and the locked scope recheck commit as one unit: a rehome
      // that landed after the guard above meets the uniform 404 and voids
      // nothing, instead of voiding another subsidiary's document.
      // requestDocumentVoid joins the ambient transaction, so the lock and
      // the void share one snapshot.
      type VoidOutcome =
        | { denied: NextResponse; result?: undefined }
        | { denied: null; result: Awaited<ReturnType<typeof requestDocumentVoid>> };
      const outcome: VoidOutcome = await withOrgTransaction(
        authz.user.orgId,
        async (): Promise<VoidOutcome> => {
          const relocked = await lockedDocumentScopeDenied(authz, id);
          if (relocked) return { denied: relocked };
          const request = body.withDependents
            ? requestReceiptVoidWithDependents
            : requestDocumentVoid;
          const result = await request({
            documentId: id,
            orgId: authz.user.orgId,
            actorId: authz.user.id,
            reason: body.reason ?? "",
            reversalDate: body.reversalDate,
            reversalPeriodId: body.reversalPeriodId,
            source: "ui",
            expectedUpdatedAt: body.expectedUpdatedAt,
          });
          return { denied: null, result };
        },
      );
      if (outcome.denied) return outcome.denied;
      const result = outcome.result;
      return NextResponse.json(
        { ok: true, ...result },
        { status: result.status === "pending_approval" ? 202 : 200 },
      );
    } catch (error) {
      if (error instanceof DocumentVoidError) {
        return apiErrorResponse(error, { details: { code: error.code } });
      }
      throw error;
    }
  },
});
