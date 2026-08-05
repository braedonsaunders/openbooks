import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { guardPermission } from "../../../lib/authz";
import { isFeatureEnabled } from "../../../lib/features";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "projects")))
    return NextResponse.json({ errorCode: "notFound" }, { status: 404 });
  const body = (await req.json()) as { name?: string; currency?: string };
  if (!body.name?.trim() || !/^[A-Z]{3}$/.test(body.currency ?? ""))
    return NextResponse.json({ errorCode: "save" }, { status: 422 });
  const name = body.name.trim();
  const code = `LAB-${Date.now().toString(36).toUpperCase()}`;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const id = await db.transaction(async (tx) => {
      const book = (await tx.execute(sql`
        insert into item_rate_books (org_id, code, name, currency, is_default, is_active, created_by, updated_by)
        values (${gate.user.orgId}, ${code}, ${name}, ${body.currency}, false, true, ${gate.user.id}, ${gate.user.id})
        returning id`)) as unknown as { rows: { id: string }[] };
      const version = (await tx.execute(sql`
        insert into item_rate_versions (org_id, rate_book_id, effective_from, status, custom, created_by, updated_by)
        values (${gate.user.orgId}, ${book.rows[0].id}, ${today}, 'draft', '{}'::jsonb, ${gate.user.id}, ${gate.user.id})
        returning id`)) as unknown as { rows: { id: string }[] };
      await tx.execute(sql`
        insert into labor_rate_version_policies (org_id, version_id, derivation_policy, created_by, updated_by)
        values (${gate.user.orgId}, ${version.rows[0].id}, 'explicit', ${gate.user.id}, ${gate.user.id})`);
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${gate.user.orgId}, 'item_rate_versions', ${version.rows[0].id}, 'insert',
                ${JSON.stringify({ rateBookId: book.rows[0].id, code, currency: body.currency, effectiveFrom: today })}::jsonb,
                ${gate.user.id})`);
      return version.rows[0].id;
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch {
    return NextResponse.json({ errorCode: "save" }, { status: 422 });
  }
}
