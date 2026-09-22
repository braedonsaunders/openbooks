import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { listApplicationTaxReturnForms } from "../../../../../lib/application/tax-read";

export const runtime = "nodejs";

/** GET /api/v1/tax/returns — indirect-tax return forms for this org. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/tax/returns", async (_auth, context) => ({
    status: 200,
    body: await listApplicationTaxReturnForms(context),
  }));
}
