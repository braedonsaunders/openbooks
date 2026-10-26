import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { TaxFilingError, markTaxFilingFiled } from "@openbooks/engine/tax-returns/filing";
import { guardPermission, guardUnrestrictedScope } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { TAX_FILING_WRITE_PERMISSION } from "@/lib/tax-filing-permission";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const bodyObjectSchema = z.object({ filingReference: z.string().optional() }).strict();

/** Record the one-way prepared → filed transition and government reference. */
async function legacyPATCH(
  { params }: { params: Promise<{ id: string }> },
  gate: Authz,
  body: z.infer<typeof bodyObjectSchema>,
) {
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");
  const filingReference =
    typeof body.filingReference === "string" ? body.filingReference.trim() : "";
  if (filingReference.length > 200)
    return NextResponse.json({ error: "reference is too long" }, { status: 422 });

  try {
    const updated = await markTaxFilingFiled(
      gate.user.orgId,
      id,
      gate.user.id,
      filingReference || null,
    );
    return NextResponse.json({ id: updated.id, filed_at: updated.filedAt });
  } catch (error) {
    if (error instanceof TaxFilingError) {
      if (error.code === "not-found") return notFound("record");
      // Every 409 carries its machine-readable code: the drawer localizes
      // the refusal (period-not-closed names the close-the-period remedy)
      // instead of swallowing it into a generic save failure.
      if (error.code === "already-filed") {
        return NextResponse.json(
          { code: error.code, error: "filing is already filed" },
          { status: 409 },
        );
      }
      // Stale or ungoverned: the state conflicts with what would be certified.
      if (error.code === "stale" || error.code === "period-not-closed") {
        return apiErrorResponse(error, { safeStatus: 409, details: { code: error.code } });
      }
    }
    return NextResponse.json({ error: "could not update filing" }, { status: 422 });
  }
}

export const PATCH = defineRoute({
  authorize: async ({ params }) => {
    const gate = await guardPermission(TAX_FILING_WRITE_PERMISSION);
    if (gate instanceof NextResponse) return gate;
    const id = (params as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || !isUuid(id)) return notFound("record");
    const scope = guardUnrestrictedScope(gate);
    return scope ?? gate;
  },
  feature: { none: "This route is governed by its permission and service authorization." },
  params: z.object({ id: z.string() }),
  body: bodyObjectSchema,
  opaque: {
    filingReference: "The filing reference is optional when recording the filed transition.",
  },
  handler: ({ params, authz, body }) =>
    legacyPATCH({ params: Promise.resolve(params) }, authz, body),
});
