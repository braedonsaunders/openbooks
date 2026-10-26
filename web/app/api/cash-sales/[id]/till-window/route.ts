import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { notFound } from "@/lib/api/responses";
import { readSaleTillWindow } from "@openbooks/engine/ledger/cash-deposits";
import { isDocKindEnabled } from "../../../../../lib/documents.ts";
import { can, getAuthz } from "../../../../../lib/authz";
import { isUuid } from "../../../../../lib/list-params";

export const runtime = "nodejs";

/**
 * The till window a cash sale falls in, for its close-out over/short
 * advice. Read with the cash-sale read grant, scoped like the sale itself.
 */
export const GET = defineRoute({
  public: "session",
  handler: async ({ params }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!can(authz, "cash_sales.read")) {
      return NextResponse.json({ error: "missing permission: cash_sales.read" }, { status: 403 });
    }
    if (!(await isDocKindEnabled(authz.user.orgId, "cash_sale"))) return notFound("record");
    const { id } = params as { id?: unknown };
    if (typeof id !== "string" || !isUuid(id)) return notFound("record");
    try {
      return NextResponse.json({
        till: await readSaleTillWindow(authz.user.orgId, id, authz.allowedSubsidiaryIds ?? null),
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
