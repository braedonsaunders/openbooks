import { z } from 'zod'
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { defineRoute } from '@/lib/api/route'
import { unprocessable } from '@/lib/api/responses'
import { isUuid } from "../../../lib/list-params";

const createBody = z.looseObject({
  name: z.string().optional(),
  path: z.string().optional(),
  params: z.record(z.string(), z.string()).optional(),
})
const deleteBody = z.looseObject({ id: z.string().optional() })

export const POST = defineRoute({
  permission: 'reports.create',
  feature: { none: 'Saved report shortcuts are available independently of optional report capabilities.' },
  body: createBody,
  handler: async ({ body, authz }) => {
  const { name, path, params } = body
  if (!name || typeof path !== "string" || !path.startsWith("/reports")) {
    return unprocessable("name and a /reports path required", { status: 400 });
  }
  await db.execute(sql`
    insert into saved_reports (org_id, name, path, params, created_by_user_id)
    values (${authz.user.orgId}, ${name}, ${path}, ${JSON.stringify(params ?? {})}, ${authz.user.id})`);
  return NextResponse.json({ ok: true });
  },
})

export const DELETE = defineRoute({
  permission: 'reports.create',
  feature: { none: 'Saved report shortcuts are available independently of optional report capabilities.' },
  body: deleteBody,
  handler: async ({ body, authz }) => {
  const { user, permissions } = authz;
  const { id } = body;
  if (!id || !isUuid(id)) return unprocessable("id required", { status: 400 });
  const deleted = await db.execute<{ id: string }>(sql`
    delete from saved_reports
     where id = ${id}
       and org_id = ${user.orgId}
       and (${permissions.has("*")} or created_by_user_id = ${user.id})
     returning id`);
  if (!deleted.rows[0]) {
    return NextResponse.json({ error: "You can only delete your own saved reports." }, { status: 403 });
  }
  return NextResponse.json({ ok: true });
  },
})
