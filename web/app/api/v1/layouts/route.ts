import { NextResponse } from "next/server";
import { ApplicationError } from "../../../../lib/application/errors";
import { readV1JsonObject, withV1Request } from "../../../../lib/api/v1-request";
import { clearLayout, listLayouts, setLayout } from "../../../../lib/application/page-layouts";

export const runtime = "nodejs";

/** GET /api/v1/layouts — the routes this org has customized. */
export async function GET(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/layouts", async (_auth, context) => {
    return { status: 200, body: { ok: true, ...(await listLayouts(context)) } };
  });
}

/**
 * PUT /api/v1/layouts — replace what a route renders. The `{ route, spec,
 * note, scope }` contract is the `set_page_layout` application command; a
 * rejected layout is an ordinary 200 outcome with `stored: false` and errors,
 * never an exception to retry blindly.
 */
export async function PUT(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/layouts", async (_auth, context) => {
    const body = await readV1JsonObject(request);
    if (typeof body.route !== "string" || !body.route) {
      throw new ApplicationError("invalid_input", "route is required", 422);
    }
    if (body.spec === undefined) {
      throw new ApplicationError("invalid_input", "spec is required", 422);
    }
    if (body.scope !== undefined && body.scope !== "org" && body.scope !== "user") {
      throw new ApplicationError("invalid_input", 'scope must be "org" or "user"', 422);
    }
    const result = await setLayout(context, {
      route: body.route,
      spec: body.spec,
      note: typeof body.note === "string" ? body.note : null,
      scope: body.scope as "org" | "user" | undefined,
    });
    return { status: 200, body: { ok: true, ...result } };
  });
}

/** DELETE /api/v1/layouts?route=&scope= — drop a layout; the page returns to its built-in spec. */
export async function DELETE(request: Request): Promise<NextResponse> {
  return withV1Request(request, "api/v1/layouts", async (_auth, context) => {
    const url = new URL(request.url);
    const route = url.searchParams.get("route") ?? "";
    const scope = url.searchParams.get("scope") ?? undefined;
    if (!route) {
      throw new ApplicationError("invalid_input", "route query parameter is required", 422);
    }
    if (scope !== undefined && scope !== "org" && scope !== "user") {
      throw new ApplicationError("invalid_input", 'scope must be "org" or "user"', 422);
    }
    const result = await clearLayout(context, { route, scope: scope as "org" | "user" | undefined });
    return { status: 200, body: { ok: true, ...result } };
  });
}
