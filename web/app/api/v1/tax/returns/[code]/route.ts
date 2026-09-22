import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../../lib/api/v1-request";
import { getApplicationTaxReturn } from "../../../../../../lib/application/tax-read";

export const runtime = "nodejs";

/** GET /api/v1/tax/returns/[code]?from=&to= — one filing entity's computed return. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await params;
  return withV1Request(request, "api/v1/tax/returns/[code]", async (_auth, context) => {
    const url = new URL(request.url);
    const subsidiaryIds = url.searchParams
      .getAll("subsidiary")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean);
    return {
      status: 200,
      body: await getApplicationTaxReturn(context, {
        formCode: code,
        from: url.searchParams.get("from") ?? "",
        to: url.searchParams.get("to") ?? "",
        subsidiaryIds,
        registrationId: url.searchParams.get("registration") ?? undefined,
        presentationCurrency: url.searchParams.get("presentationCurrency") ?? undefined,
        rateType: url.searchParams.get("rateType") ?? undefined,
        rateDate: url.searchParams.get("rateDate") ?? undefined,
      }),
    };
  });
}
