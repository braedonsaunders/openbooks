import { NextResponse } from "next/server";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { listApplicationPayrollEmployees } from "../../../../../lib/application/payroll-read";

export const runtime = "nodejs";

/** GET /api/v1/payroll/employees — payroll profiles; never elections or government ids. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/payroll/employees", async (_auth, context) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: await listApplicationPayrollEmployees(context, {
        query: url.searchParams.get("q")?.trim() || undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  });
}
