import { z } from "zod";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { defineRoute } from "@/lib/api/route";
import { unprocessable } from "@/lib/api/responses";
import { uuidId } from "@/lib/api/json";
import { apiErrorResponse } from "@/lib/api/error-response";
import { assertSavedReportPeriod } from "@/lib/report-filters";

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
    // A saved custom period must carry the bounds it reopens with; a view saved
    // without them would reopen as a different, wider window.
    try {
      assertSavedReportPeriod(params ?? {});
    } catch (error) {
      return apiErrorResponse(error, { request: req });
    }
    await db.execute(sql`
    insert into saved_reports (org_id, name, path, params, created_by_user_id)
    values (${authz.user.orgId}, ${name}, ${path}, ${JSON.stringify(params ?? {})}, ${authz.user.id})`);
    return NextResponse.json({ ok: true });
  },
});

export const DELETE = defineRoute({
  permission: "reports.create",
  feature: {
    none: "Saved report shortcuts are available independently of optional report capabilities.",
  },
  body: deleteBody,
  handler: async ({ body, authz }) => {
    const { user, permissions } = authz;
    const { id } = body;
    const deleted = await db.execute<{ id: string }>(
      sql`
    delete from saved_reports
     where id = ${id}
       and org_id = ${user.orgId}
       and (${permissions.has("*")} or created_by_user_id = ${user.id})
     returning id`,
      "objects",
    );
    if (!deleted[0]) {
      return NextResponse.json(
        { error: "You can only delete your own saved reports." },
        { status: 403 },
      );
    }
    return NextResponse.json({ ok: true });
  },
});
