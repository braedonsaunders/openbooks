import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { db, withOrgContext } from "@openbooks/engine/platform/db";
import { readTipsPayableExposure } from "@openbooks/engine/sales/cash-closeout";
import { getAuthz, can } from "../../../../lib/authz";
import { isDocKindEnabled } from "../../../../lib/documents.ts";
import { notFound } from "@/lib/api/responses";

const QuerySchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

export const runtime = "nodejs";

/**
 * Tips payable carried for payroll pay-out: posted cash-sale tips legs on
 * the tips-payable control account, grouped by server (party) and sale day.
 * Sales that name no server pool under a null party for the house split.
 * Amounts are signed minor units as posted (credits negative); payroll
 * pays the magnitude and relieves the liability through its own journals.
 * Empty while the Tips payable control account is unconfigured.
 */
export const GET = defineRoute({
  public: "session",
  handler: async ({ request: req }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const user = authz.user;
    if (!can(authz, "cash_sales.read") && !can(authz, "payroll.read")) {
      return NextResponse.json({ error: "missing permission: cash_sales.read" }, { status: 403 });
    }
    if (!(await isDocKindEnabled(user.orgId, "cash_sale"))) {
      return notFound("record");
    }
    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "from and to must be YYYY-MM-DD dates" }, { status: 422 });
    }
    const rows = await withOrgContext(user.orgId, () =>
      readTipsPayableExposure(db, user.orgId, {
        from: parsed.data.from ?? undefined,
        to: parsed.data.to ?? undefined,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      }),
    );
    return NextResponse.json({ rows });
  },
});
