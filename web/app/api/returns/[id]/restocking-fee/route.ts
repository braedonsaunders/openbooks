import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { assertCan } from "@/lib/authz";
import { previewReturnRestockingFee } from "@/lib/returns";

const bodySchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: uuidString(),
        accepted: z.string().max(40),
      }),
    )
    .min(1)
    .max(500),
});

export const POST = defineRoute({
  permission: "orders.fulfill",
  feature: "returnAuthorizations",
  params: z.object({ id: uuidString() }),
  body: bodySchema,
  handler: async ({ authz, params: { id }, body }) => {
    assertCan(authz, "orders.fulfill");
    const preview = await previewReturnRestockingFee({
      orgId: authz.user.orgId,
      documentId: id,
      lines: body.lines,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    });
    return NextResponse.json(preview);
  },
});
