import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { unprocessable } from "@/lib/api/responses";
import { uuidId } from "@/lib/api/json";
import { apiErrorResponse } from "@/lib/api/error-response";
import { createSavedReportShortcut, deleteSavedReportShortcut } from "@/lib/saved-report-write";

const createBody = z.object({
  name: z.string().trim().min(1),
  // The string check is load-bearing: the handler calls path.startsWith,
  // which throws on a non-string. It carries the handler's message so the
  // refusal names the remedy instead of the zod type error.
  path: z.string({ error: "name and a /reports path required" }).regex(/^\/reports(?:\/|$)/),
  params: z.record(z.string(), z.string()).optional(),
});
const deleteBody = z.object({ id: uuidId });

export const POST = defineRoute({
  permission: "reports.create",
  feature: {
    none: "Saved report shortcuts are available independently of optional report capabilities.",
  },
  body: createBody,
  handler: async ({ body, authz, request: req }) => {
    const { name, path, params } = body;
    if (!name || !path.startsWith("/reports")) {
      return unprocessable("name and a /reports path required", { status: 400 });
    }
    try {
      const saved = await createSavedReportShortcut(authz, { name, path, params });
      return NextResponse.json({ ok: true, id: saved.id });
    } catch (error) {
      return apiErrorResponse(error, { request: req });
    }
  },
});

export const DELETE = defineRoute({
  permission: "reports.create",
  feature: {
    none: "Saved report shortcuts are available independently of optional report capabilities.",
  },
  body: deleteBody,
  handler: async ({ body, authz }) => {
    const { id } = body;
    if (!(await deleteSavedReportShortcut(authz, id))) {
      return NextResponse.json(
        { error: "You can only delete your own saved reports." },
        { status: 403 },
      );
    }
    return NextResponse.json({ ok: true });
  },
});
