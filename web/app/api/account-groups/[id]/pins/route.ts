import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { lockScopeRow, ScopeNotFoundError } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { guardSubsidiaryScope, guardUnrestrictedScope } from "../../../../../lib/authz";
import { isUuid } from "../../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";
const POSTBodySchema1 = z.object({ "accountId": z.string().optional() }).passthrough();



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

export const POST = defineRoute({
  permission: 'admin.setup.manage',
  feature: { none: "This always-on route is governed by admin.setup.manage; the existing route has no separate feature gate." },
  body: POSTBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");

    const { accountId } = (routeBody) as { accountId?: string };
    if (typeof accountId !== "string" || !isUuid(accountId)) {
        return NextResponse.json({ error: "accountId required" }, { status: 400 });
      }
    const group = await loadGroup(id, gate.user.orgId);
    if (!group) return notFound("record");
    const pinLockKey = `account-group-pin:${gate.user.orgId}:${group.dimension}:${accountId}`;
    const denied = await db.transaction(async (tx) => {
        let account: { subsidiaryId: string | null };
        try {
          account = await lockScopeRow(tx, gate.user.orgId, "account", accountId, gate.allowedSubsidiaryIds, "share", { orgWideNull: true });
        } catch (error) {
          if (!(error instanceof ScopeNotFoundError)) throw error;
          return notFound('record');
        }
        const scopeDenied = account.subsidiaryId === null
          ? guardUnrestrictedScope(gate)
          : guardSubsidiaryScope(gate, account.subsidiaryId);
        if (scopeDenied) return scopeDenied;
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
        return null;
      });
    if (denied) return denied;
    return NextResponse.json({ ok: true });
  },
});

export const DELETE = defineRoute({
  permission: 'admin.setup.manage',
  feature: { none: "This always-on route is governed by admin.setup.manage; the existing route has no separate feature gate." },
  handler: async ({ request: req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    const accountId = new URL(req.url).searchParams.get("accountId");
    if (!accountId || !isUuid(accountId)) {
        return NextResponse.json({ error: "accountId required" }, { status: 400 });
      }
    const group = await loadGroup(id, gate.user.orgId);
    if (!group) return notFound("record");
    const pinLockKey = `account-group-pin:${gate.user.orgId}:${group.dimension}:${accountId}`;
    const denied = await db.transaction(async (tx) => {
        let account: { subsidiaryId: string | null };
        try {
          account = await lockScopeRow(tx, gate.user.orgId, "account", accountId, gate.allowedSubsidiaryIds, "share", { orgWideNull: true });
        } catch (error) {
          if (!(error instanceof ScopeNotFoundError)) throw error;
          return notFound('record');
        }
        const scopeDenied = account.subsidiaryId === null
          ? guardUnrestrictedScope(gate)
          : guardSubsidiaryScope(gate, account.subsidiaryId);
        if (scopeDenied) return scopeDenied;
        await tx.execute(sql`
          select pg_advisory_xact_lock(hashtextextended(${pinLockKey}, 0))
        `);
        await tx.execute(sql`
          delete from account_group_members
           where group_id = ${id}
             and org_id = ${gate.user.orgId}
             and account_id = ${accountId}
        `);
        return null;
      });
    if (denied) return denied;
    return NextResponse.json({ ok: true });
  },
});
