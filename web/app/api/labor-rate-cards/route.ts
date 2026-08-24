import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { guardPermission } from "../../../lib/authz";
import { isFeatureEnabled } from "../../../lib/features";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "projects")))
    return NextResponse.json({ errorCode: "notFound" }, { status: 404 });
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { name?: string; currency?: string };
  // Rate-book currency is Multi-currency configuration. Turning that
  // switch off must refuse a new write; omitting currency keeps the
  // org / subsidiary base so a card can still be created and stored books stay.
  if (
    body.currency !== undefined &&
    !(await isFeatureEnabled(gate.user.orgId, "multiCurrency"))
  ) {
    return NextResponse.json({ errorCode: "notFound" }, { status: 404 });
  }
  const org = (await db.execute<{ base_currency: string }>(sql`
    select base_currency from orgs where id = ${gate.user.orgId}`));
  const currency =
    body.currency !== undefined
      ? String(body.currency).trim().toUpperCase()
      : (org.rows[0]?.base_currency ?? "");
  if (!body.name?.trim() || !/^[A-Z]{3}$/.test(currency))
    return NextResponse.json({ errorCode: "save" }, { status: 422 });
  const name = body.name.trim();
  const code = `LAB-${Date.now().toString(36).toUpperCase()}`;
  const today = await businessToday(gate.user.orgId);
  try {
    const id = await db.transaction(async (tx) => {
      const book = (await tx.execute<{ id: string }>(sql`
        insert into item_rate_books (org_id, code, name, currency, is_default, is_active, created_by, updated_by)
        values (${gate.user.orgId}, ${code}, ${name}, ${currency}, false, true, ${gate.user.id}, ${gate.user.id})
        returning id`));
      const bookRow = book.rows[0]!;
      const version = (await tx.execute<{ id: string }>(sql`
        insert into item_rate_versions (org_id, rate_book_id, effective_from, status, custom, created_by, updated_by)
        values (${gate.user.orgId}, ${bookRow.id}, ${today}, 'draft', '{}'::jsonb, ${gate.user.id}, ${gate.user.id})
        returning id`));
      const versionRow = version.rows[0]!;
      await tx.execute(sql`
        insert into labor_rate_version_policies (org_id, version_id, derivation_policy, created_by, updated_by)
        values (${gate.user.orgId}, ${versionRow.id}, 'explicit', ${gate.user.id}, ${gate.user.id})`);
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${gate.user.orgId}, 'item_rate_versions', ${versionRow.id}, 'insert',
                ${JSON.stringify({ rateBookId: bookRow.id, code, currency, effectiveFrom: today })}::jsonb,
                ${gate.user.id})`);
      return versionRow.id;
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch {
    return NextResponse.json({ errorCode: "save" }, { status: 422 });
  }
}
