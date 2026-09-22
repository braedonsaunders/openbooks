import { NextResponse } from "next/server";
import { ApplicationError } from "../../../../../lib/application/errors";
import { withV1Request } from "../../../../../lib/api/v1-request";
import { describePageLayout } from "../../../../../lib/application/page-layouts";

export const runtime = "nodejs";

function readStringRecord(value: string | null, name: string): Record<string, string> | undefined {
  if (value === null || value === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ApplicationError("invalid_input", `${name} must be a JSON object of string values`, 422);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApplicationError("invalid_input", `${name} must be a JSON object of string values`, 422);
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof entry !== "string") {
      throw new ApplicationError("invalid_input", `${name} must be a JSON object of string values`, 422);
    }
    record[key] = entry;
  }
  return record;
}

/**
 * GET /api/v1/layouts/describe?route=&params=&searchParams= — what a route
 * renders today. `params`/`searchParams` are optional JSON objects of string
 * values for the route's dynamic segments and query string.
 */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/layouts/describe", async (_auth, context) => {
    const url = new URL(request.url);
    const route = url.searchParams.get("route") ?? "";
    if (!route) {
      throw new ApplicationError("invalid_input", "route query parameter is required", 422);
    }
    const result = await describePageLayout(context, {
      route,
      params: readStringRecord(url.searchParams.get("params"), "params"),
      searchParams: readStringRecord(url.searchParams.get("searchParams"), "searchParams"),
    });
    return { status: 200, body: { ok: true, ...result } };
  });
}
