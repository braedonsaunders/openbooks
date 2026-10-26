import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { listCashDeposits, recordCashDeposit } from "@openbooks/engine/ledger/cash-deposits/module";
import { DocumentCreateConflict } from "../../../../../lib/documents.ts";
import { getAuthz, can } from "../../../../../lib/authz";
import { isUuid } from "../../../../../lib/list-params";
import { isDocKindEnabled } from "../../../../../lib/documents.ts";
import { notFound } from "@/lib/api/responses";

const POSTBodySchema = z.object({
  amount: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "drop date must be YYYY-MM-DD"),
  bankAccountId: uuidString(),
  slipNumber: z.string().min(1).max(120),
  sourceAccountId: uuidString().nullable().optional(),
});

export const runtime = "nodejs";

/**
 * Cashier-scoped bank drop ("Deposit cash to bank" from Cash Sales).
 *
 * Records a till drop against a posted cash sale as a native `transfer`
 * (till cash → configured bank account) carrying the sale link and the bank
 * slip number, and posts it at once so the bookkeeper confirms and matches
 * it in Banking. Gated behind `cash_sales.deposit` — held by till roles —
 * so a cashier needs no banking or GL grant: the source is limited to the
 * sale's own cash tender account, the destination to the configured deposit
 * accounts, and the amount to the sale's undropped till cash.
 *
 * A refused posting still records the draft drop with its slip (201 with
 * posted:false); the refusal rides the response for the bookkeeper to
 * resolve in Banking.
 */
/**
 * A sale's recorded till drops, for the drop list beside the deposit form.
 * Same gate as recording: the list is the cashier's surface, so it reads
 * through `cash_sales.deposit` with the same subsidiary scope.
 */
export const GET = defineRoute({
  public: "session",
  handler: async ({ params: routeParams }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const user = authz.user;
    if (!can(authz, "cash_sales.deposit")) {
      return NextResponse.json(
        { error: "missing permission: cash_sales.deposit" },
        { status: 403 },
      );
    }
    if (!(await isDocKindEnabled(user.orgId, "cash_sale"))) {
      return notFound("record");
    }
    const { id } = routeParams as { id?: unknown };
    if (typeof id !== "string" || !isUuid(id)) {
      return notFound("record");
    }
    try {
      const drops = await listCashDeposits(user.orgId, id, authz.allowedSubsidiaryIds ?? null);
      return NextResponse.json({ drops });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});

export const POST = defineRoute({
  public: "session",
  body: POSTBodySchema,
  handler: async ({ request: req, body: routeBody, params: routeParams }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const user = authz.user;
    if (!can(authz, "cash_sales.deposit")) {
      return NextResponse.json(
        { error: "missing permission: cash_sales.deposit" },
        { status: 403 },
      );
    }
    if (!(await isDocKindEnabled(user.orgId, "cash_sale"))) {
      return notFound("record");
    }
    const { id } = routeParams as { id?: unknown };
    if (typeof id !== "string" || !isUuid(id)) {
      return notFound("record");
    }
    const headerKey = req.headers.get("Idempotency-Key")?.trim() ?? "";
    if (headerKey !== "" && !isUuid(headerKey)) {
      return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
    }
    try {
      const drop = await recordCashDeposit(
        user.orgId,
        user.id,
        {
          saleId: id,
          amount: routeBody.amount,
          date: routeBody.date,
          bankAccountId: routeBody.bankAccountId,
          slipNumber: routeBody.slipNumber,
          sourceAccountId: routeBody.sourceAccountId ?? null,
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
          ...(drop.pendingApproval ? { pendingApproval: true } : {}),
          ...(drop.postRefusal ? { postRefusal: drop.postRefusal } : {}),
        },
        { status: 201 },
      );
    } catch (error) {
      // Both domain errors are typed 4xx with their remedy at their origin,
      // so the shared mapping carries them exactly as the branches did; the
      // idempotency conflict keeps its stable code, and anything unexpected
      // is logged with a request id instead of escaping as a thrown 500.
      if (error instanceof DocumentCreateConflict) {
        return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 409 });
      }
      return apiErrorResponse(error);
    }
  },
});
