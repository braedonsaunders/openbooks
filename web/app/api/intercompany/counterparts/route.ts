import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { generateIntercompanyCounterpart } from "@/lib/intercompany-counterparts";
import { counterpartBody } from "../_schema";

export const runtime = "nodejs";

/**
 * Create the other entity's mirror of an intercompany document as a draft
 * through its native writer, and pair the two. Idempotent per document.
 */
export const POST = defineRoute({
  permission: "intercompany.manage",
  feature: "intercompanyTransactions",
  body: counterpartBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) =>
    NextResponse.json(await generateIntercompanyCounterpart(authz, body.documentId), {
      status: 201,
    }),
});
