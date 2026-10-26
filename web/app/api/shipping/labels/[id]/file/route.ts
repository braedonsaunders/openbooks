import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/database";
import { readLabelFile } from "@openbooks/engine/sales/shipping-labels";
import { notFound } from "@/lib/api/responses";
import { fileContentDisposition } from "@/lib/export";
import { defineRoute } from "@/lib/api/route";

const labelParams = z.object({ id: uuidString() });

/** Download the stored label PDF for printing. */
export const GET = defineRoute({
  permission: "orders.fulfill",
  feature: "shippingHub",
  params: labelParams,
  handler: async ({ authz, params: { id } }) => {
    const file = await readLabelFile(db, authz.user.orgId, id, authz.allowedSubsidiaryIds).catch(
      (error: unknown) => {
        if (error instanceof Error && (error as { code?: unknown }).code === "not_found")
          return null;
        throw error;
      },
    );
    if (!file) return notFound("label", id);
    return new NextResponse(file.bytes as unknown as BodyInit, {
      headers: {
        "content-type": file.contentType,
        "content-disposition": fileContentDisposition("attachment", file.filename),
      },
    });
  },
});
