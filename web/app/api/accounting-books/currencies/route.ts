import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { createBookCurrencyVersion, listBookCurrencies } from "@openbooks/engine/multibook";

export const runtime = "nodejs";

const createBody = z
  .object({
    bookId: uuidString(),
    subsidiaryId: uuidString(),
    currency: z.string(),
    rateType: z.enum(["spot", "month_average"]),
    effectiveFrom: z.string(),
    effectiveTo: z.string().nullable().optional(),
    reason: z.string(),
  })
  .strict();

/** Every book currency version: a secondary book's base currency per subsidiary. */
export const GET = defineRoute({
  permission: "gl.read",
  feature: "multiBookAccounting",
  handler: async ({ authz }) =>
    NextResponse.json({
      currencies: await listBookCurrencies(authz.user.orgId, undefined, authz.allowedSubsidiaryIds),
    }),
});

/** Add a book currency version; the version in effect before it closes the day before it starts. */
export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: "multiBookAccounting",
  scope: "unrestricted",
  body: createBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    const { reason, ...input } = body;
    const created = await createBookCurrencyVersion({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      input,
      reason,
    });
    return NextResponse.json(created, { status: 201 });
  },
});
