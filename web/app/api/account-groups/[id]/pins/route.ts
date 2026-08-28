import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { guardPermission } from "../../../../../lib/authz";

export const runtime = "nodejs";

/**
 * Account pins for one group — the PIN half of the rule+pin model. POST pins
 * an account into this group (moving it out of any other group in the SAME
 * dimension); DELETE removes the pin so the account falls back to rule
 * matching (or Unassigned).
 */
async function loadGroup(id: string, orgId: string) {
  const r = await db.execute(sql`
    select id, dimension from account_groups where id = ${id} and org_id = ${orgId}
  `);
  return r.rows[0] ?? null;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const { accountId } = (parsedBody.data) as { accountId?: string };
  if (!accountId) return NextResponse.json({ error: "accountId required" }, { status: 400 });

  const group = await loadGroup(id, gate.user.orgId);
  if (!group) return NextResponse.json({ error: "not found" }, { status: 404 });

  const acct = await db.execute(sql`
    select id from accounts where id = ${accountId} and org_id = ${gate.user.orgId}
  `);
  if (!acct.rows.length) return NextResponse.json({ error: "account not found" }, { status: 404 });

  // The delete and insert must share one transaction and one per-account /
  // per-dimension fence.  Otherwise two replicas can both clear siblings
  // before either insert becomes visible, leaving two legal pins behind.
  const pinLockKey = `account-group-pin:${gate.user.orgId}:${group.dimension}:${accountId}`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${pinLockKey}, 0))
    `);
    await tx.execute(sql`
      delete from account_group_members m using account_groups g
      where m.group_id = g.id and g.org_id = ${gate.user.orgId}
        and m.org_id = ${gate.user.orgId}
        and g.dimension = ${group.dimension} and m.account_id = ${accountId}
    `);
    await tx.execute(sql`
      insert into account_group_members (org_id, group_id, account_id, dimension, created_by)
      values (${gate.user.orgId}, ${id}, ${accountId}, ${group.dimension}, ${gate.user.id})
      on conflict (org_id, dimension, account_id) do update
        set group_id = excluded.group_id,
            updated_at = now(),
            updated_by = excluded.created_by
    `);
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  const accountId = new URL(req.url).searchParams.get("accountId");
  if (!accountId) return NextResponse.json({ error: "accountId required" }, { status: 400 });

  const group = await loadGroup(id, gate.user.orgId);
  if (!group) return NextResponse.json({ error: "not found" }, { status: 404 });

  const pinLockKey = `account-group-pin:${gate.user.orgId}:${group.dimension}:${accountId}`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${pinLockKey}, 0))
    `);
    await tx.execute(sql`
      delete from account_group_members
       where group_id = ${id}
         and org_id = ${gate.user.orgId}
         and account_id = ${accountId}
    `);
  });
  return NextResponse.json({ ok: true });
}
