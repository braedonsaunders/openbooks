import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { guardPermission } from "../../../../lib/authz";

export const runtime = "nodejs";

/**
 * Mutations on one account group (the reporting-classification primitive).
 * PATCH updates the display fields and/or the auto-match rule; membership
 * pins live under ./pins. Guarded by the Setup permission — the same gate as
 * the Setup → Account Groups workspace.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;

  const body = (await req.json()) as {
    name?: string;
    color?: string | null;
    match?: { accountTypes?: string[]; numberPrefixes?: string[]; namePattern?: string } | null;
  };

  const group: any = await db.execute(sql`
    select id from account_groups where id = ${id} and org_id = ${gate.user.orgId}
  `);
  if (!group.rows.length) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (body.match?.namePattern) {
    try {
      new RegExp(body.match.namePattern, "i");
    } catch {
      return NextResponse.json({ error: "invalid namePattern regex" }, { status: 400 });
    }
  }

  const sets = [];
  if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
  if (body.color !== undefined) sets.push(sql`color = ${body.color}`);
  if (body.match !== undefined) sets.push(sql`match = ${JSON.stringify(body.match ?? {})}::jsonb`);
  if (!sets.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  await db.execute(sql`
    update account_groups set ${sql.join(sets, sql`, `)}, updated_at = now()
    where id = ${id} and org_id = ${gate.user.orgId}
  `);
  return NextResponse.json({ ok: true });
}
