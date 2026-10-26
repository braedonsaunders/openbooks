import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { notFound } from "@/lib/api/responses";
import { readTillDropWindow, recordTillDrop } from "@openbooks/engine/ledger/cash-deposits";
import { DocumentCreateConflict, isDocKindEnabled } from "../../../../lib/documents.ts";
import { can, getAuthz } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

const WindowQuery = z.object({
  tillAccountId: uuidString(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "drop date must be YYYY-MM-DD"),
  subsidiaryId: uuidString().nullable(),
});

const POSTBodySchema = z.object({
  tillAccountId: uuidString(),
  amount: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "drop date must be YYYY-MM-DD"),
  coversThrough: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "cash cutoff must be YYYY-MM-DD")
    .nullable()
    .optional(),
  bankAccountId: uuidString(),
  slipNumber: z.string().min(1).max(120),
  subsidiaryId: uuidString().nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
});

/**
 * Till drops by till and date: cash counted out of a till and taken to the
 * bank before the back office posts the sales it came from. Same gate as the
 * per-sale drop — `cash_sales.deposit` — and the same destination fence.
 * GET reads the reconciliation window a drop covering sales through `date`
 * would close (sales tendered vs. dropped since the previous drop's cutoff)
 * for the drop form.
 */
export const GET = defineRoute({
  public: "session",
  handler: async ({ request }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!can(authz, "cash_sales.deposit")) {
      return NextResponse.json(
        { error: "missing permission: cash_sales.deposit" },
        { status: 403 },
      );
    }
    if (!(await isDocKindEnabled(authz.user.orgId, "cash_sale"))) return notFound("record");
    const url = new URL(request.url);
    const parsed = WindowQuery.safeParse({
      tillAccountId: url.searchParams.get("tillAccountId") ?? "",
      date: url.searchParams.get("date") ?? "",
      subsidiaryId: url.searchParams.get("subsidiaryId"),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Choose the till and the drop date.", code: "invalid_query" },
        { status: 422 },
      );
    }
    try {
      return NextResponse.json(
        await readTillDropWindow(authz.user.orgId, parsed.data.tillAccountId, parsed.data.date, {
          subsidiaryId: parsed.data.subsidiaryId,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds ?? null,
        }),
      );
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});

export const POST = defineRoute({
  public: "session",
  body: POSTBodySchema,
  handler: async ({ request, body }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!can(authz, "cash_sales.deposit")) {
      return NextResponse.json(
        { error: "missing permission: cash_sales.deposit" },
        { status: 403 },
      );
    }
    if (!(await isDocKindEnabled(authz.user.orgId, "cash_sale"))) return notFound("record");
    const headerKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
    if (headerKey !== "" && !isUuid(headerKey)) {
      return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
    }
    try {
      const drop = await recordTillDrop(
        authz.user.orgId,
        authz.user.id,
        {
          tillAccountId: body.tillAccountId,
          amount: body.amount,
          date: body.date,
          coversThrough: body.coversThrough ?? null,
          bankAccountId: body.bankAccountId,
          slipNumber: body.slipNumber,
          subsidiaryId: body.subsidiaryId ?? null,
          reason: body.reason ?? null,
        },
        {
          key: headerKey !== "" ? headerKey : randomUUID(),
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds ?? null,
        },
      );
      return NextResponse.json(
        {
          id: drop.transferId,
          documentNumber: drop.documentNumber,
          posted: drop.posted,
          entryId: drop.entryId,
          window: drop.window,
          ...(drop.pendingApproval ? { pendingApproval: true } : {}),
          ...(drop.postRefusal ? { postRefusal: drop.postRefusal } : {}),
        },
        { status: 201 },
      );
    } catch (error) {
      if (error instanceof DocumentCreateConflict) {
        return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 409 });
      }
      return apiErrorResponse(error);
    }
  },
});
