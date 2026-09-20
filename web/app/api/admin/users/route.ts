import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import {
  db,
  type SqlExecutor,
  withOrgTransaction,
  withTransactionSavepoint,
} from "@openbooks/engine/src/platform/db.ts";
import { permissionsOutsideCeiling } from "@openbooks/engine/src/organization/permissions.ts";
import { guardPermission } from "../../../../lib/authz";
import { authRequestContext, normalizeLoginEmail } from "../../../../lib/auth-policy";
import { issueInviteSetPasswordLink, setPasswordUrl } from "../../../../lib/auth-reset";
import { deriveInviteDisplayName, UNUSABLE_PASSWORD_HASH } from "./invite";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

/**
 * Admin user management: assign/unassign roles, toggle active, invite users,
 * re-issue pending invite links, and link/unlink a native person (users.party_id).
 * Gated by admin.users.manage; every mutation is org-scoped and audited.
 *
 * Privilege ceiling: admin.users.manage is an ordinary permission, so an
 * administrator may only grant a role whose permissions sit inside their own
 * effective set, and never to themselves. Super admins are exempt — they
 * already hold everything. Otherwise this route is a one-call escalation.
 *
 * Separation of duties for identity links: changing a user's linked person
 * (link, unlink, or change) is refused for your own user id, even as
 * superadmin — another authorized administrator must perform and evidence it.
 */

async function audit(
  exec: SqlExecutor,
  args: {
    orgId: string;
    tableName: string;
    rowId: string;
    action: "insert" | "update" | "delete";
    changes: Record<string, unknown>;
    actorId: string;
  },
) {
  await exec.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, ${args.tableName}, ${args.rowId}, ${args.action},
            ${JSON.stringify(args.changes)}, ${args.actorId})`);
}

export async function POST(req: Request) {
  const gate = await guardPermission("admin.users.manage");
  if (gate instanceof NextResponse) return gate;
  const actor = gate.user;

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as {
    action?: "assign" | "unassign" | "set-active" | "set-party" | "invite" | "resend-invite";
    userId?: string;
    roleId?: string;
    isActive?: boolean;
    email?: string;
    partyId?: string | null;
    expectedPartyId?: string | null;
    reason?: string;
    attestation?: boolean;
  };
  if (body.action !== "invite") {
    if (typeof body.userId !== "string" || !isUuid(body.userId)) {
      return NextResponse.json({ error: "userId required" }, { status: 400 });
    }
  }
  const userId = typeof body.userId === "string" ? body.userId.toLowerCase() : "";

  // All assignment and activation decisions serialize on the same user row.
  // Grants lock their role first, matching role deletion's role → user order.
  const lockTargetUser = async () => {
    const target = await db.execute(sql`
      select id from users where id = ${userId} and org_id = ${actor.orgId} for update`);
    return target.rows.length > 0;
  };

  switch (body.action) {
    case "assign": {
      if (typeof body.roleId !== "string" || !isUuid(body.roleId)) {
        return NextResponse.json({ error: "roleId required" }, { status: 400 });
      }
      const roleId = body.roleId.toLowerCase();
      return withOrgTransaction(actor.orgId, () => withTransactionSavepoint(db, async () => {
        const role = await db.execute<{ id: string; key: string; permissions: unknown }>(sql`
          select id, key, permissions from app_roles where id = ${roleId} and org_id = ${actor.orgId} for share`);
        if (!role.rows[0])
          return NextResponse.json({ error: "role not found" }, { status: 404 });
        if (!actor.isSuperAdmin) {
          if (userId === actor.id.toLowerCase()) {
            return NextResponse.json(
              { error: "you cannot grant a role to yourself" },
              { status: 403 },
            );
          }
          const rolePermissions = Array.isArray(role.rows[0].permissions)
            ? role.rows[0].permissions.filter((p): p is string => typeof p === "string")
            : [];
          const missing = permissionsOutsideCeiling(gate.permissions, rolePermissions);
          if (missing.length > 0) {
            return NextResponse.json(
              {
                error: `cannot grant permissions you do not hold: ${missing.join(", ")}`,
                missing,
              },
              { status: 403 },
            );
          }
        }
        if (!await lockTargetUser()) return NextResponse.json({ error: "user not found" }, { status: 404 });
        const inserted = await db.execute<{ id: string }>(sql`
          insert into role_assignments (org_id, user_id, role_id, created_by, updated_by)
          values (${actor.orgId}, ${userId}, ${roleId}, ${actor.id}, ${actor.id})
          on conflict (org_id, user_id, role_id) do nothing
          returning id`);
        if (inserted.rows[0]) {
          await audit(db, {
            orgId: actor.orgId,
            tableName: "role_assignments",
            rowId: inserted.rows[0].id,
            action: "insert",
            changes: {
              userId: [null, userId],
              roleId: [null, roleId],
            },
            actorId: actor.id,
          });
        }
        return NextResponse.json({ ok: true });
      }));
    }
    case "unassign": {
      if (typeof body.roleId !== "string" || !isUuid(body.roleId)) {
        return NextResponse.json({ error: "roleId required" }, { status: 400 });
      }
      const roleId = body.roleId.toLowerCase();
      return withOrgTransaction(actor.orgId, () => withTransactionSavepoint(db, async () => {
        if (!await lockTargetUser()) return NextResponse.json({ error: "user not found" }, { status: 404 });
        await db.execute(sql`
          select pg_advisory_xact_lock(hashtextextended(${`openbooks:user-roles:${actor.orgId}:${userId}`}, 0))
        `);
        const assignments = await db.execute<{
          id: string;
          role_id: string;
        }>(sql`
          select id, role_id from role_assignments
           where org_id = ${actor.orgId} and user_id = ${userId}
           order by id for update
        `);
        if (!assignments.rows.some((row) => row.role_id === roleId)) {
          return NextResponse.json({ ok: true });
        }
        if (assignments.rows.length === 1) {
          return NextResponse.json(
            { error: "an active user must retain at least one role" },
            { status: 409 },
          );
        }
        const deleted = await db.execute<{ id: string }>(sql`
          delete from role_assignments
           where org_id = ${actor.orgId} and user_id = ${userId} and role_id = ${roleId}
          returning id
        `);
        if (deleted.rows[0]) {
          await audit(db, {
            orgId: actor.orgId,
            tableName: "role_assignments",
            rowId: deleted.rows[0].id,
            action: "delete",
            changes: {
              userId: [userId, null],
              roleId: [roleId, null],
            },
            actorId: actor.id,
          });
        }
        return NextResponse.json({ ok: true });
      }));
    }
    case "set-active": {
      if (typeof body.isActive !== "boolean") {
        return NextResponse.json(
          { error: "isActive required" },
          { status: 400 },
        );
      }
      if (userId === actor.id.toLowerCase() && !body.isActive) {
        return NextResponse.json(
          { error: "you cannot deactivate your own account" },
          { status: 400 },
        );
      }
      return withOrgTransaction(actor.orgId, () => withTransactionSavepoint(db, async () => {
        if (!await lockTargetUser()) return NextResponse.json({ error: "user not found" }, { status: 404 });
        if (body.isActive) {
          const assignment = await db.execute<{ "?column?": number }>(sql`
            select 1
              from role_assignments
             where org_id = ${actor.orgId} and user_id = ${userId}
             limit 1 for key share
          `);
          if (!assignment.rows[0]) {
            return NextResponse.json(
              { error: "assign at least one role before activating this user" },
              { status: 409 },
            );
          }
        }
        const updated = await db.execute(sql`
          with changed_identity as (
            update users set is_active = ${body.isActive}, updated_at = now(), updated_by = ${actor.id}
             where id = ${userId} and org_id = ${actor.orgId} and is_active <> ${body.isActive}
            returning id
          ), revoked_sessions as (
            update auth_sessions
               set revoked_at = now(), revocation_reason = 'account_deactivated'
             where ${!body.isActive}
               and user_id in (select id from changed_identity)
               and revoked_at is null
            returning id
          )
          select id from changed_identity
        `);
        if (updated.rows[0]) {
          // Session revocation is in the same SQL statement as deactivation, so
          // a later reactivation cannot revive pre-disable browser sessions.
          await audit(db, {
            orgId: actor.orgId,
            tableName: "users",
            rowId: userId,
            action: "update",
            changes: { isActive: [!body.isActive, body.isActive] },
            actorId: actor.id,
          });
        }
        return NextResponse.json({ ok: true });
      }));
    }
    case "set-party": {
      // Audited native link between a login user and a person party.
      // Separation of duties: your own link is refused even as superadmin —
      // another authorized administrator must perform and evidence it. The
      // same-user check applies to unlink (null party) as well.
      if (userId === actor.id.toLowerCase()) {
        return NextResponse.json(
          { error: "you cannot change your own linked person — another administrator must perform it" },
          { status: 403 },
        );
      }
      if (!("partyId" in body)) {
        return NextResponse.json({ error: "partyId required" }, { status: 400 });
      }
      let partyId: string | null;
      if (body.partyId === null) {
        partyId = null;
      } else if (typeof body.partyId === "string" && isUuid(body.partyId)) {
        partyId = body.partyId.toLowerCase();
      } else {
        return NextResponse.json({ error: "partyId must be a uuid or null" }, { status: 400 });
      }
      // expectedPartyId is the optimistic-concurrency token, null included:
      // the caller must name the link it saw, including "saw unlinked".
      if (!("expectedPartyId" in body)) {
        return NextResponse.json({ error: "expectedPartyId required" }, { status: 400 });
      }
      let expected: string | null;
      if (body.expectedPartyId === null) {
        expected = null;
      } else if (typeof body.expectedPartyId === "string" && isUuid(body.expectedPartyId)) {
        expected = body.expectedPartyId.toLowerCase();
      } else {
        return NextResponse.json({ error: "expectedPartyId must be a uuid or null" }, { status: 400 });
      }
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!reason) {
        return NextResponse.json({ error: "reason required" }, { status: 400 });
      }
      if (reason.length > 500) {
        return NextResponse.json({ error: "reason too long" }, { status: 400 });
      }
      // Explicit administrator attestation that the selected native party is
      // the correct human identity for this login user. parties.kind is not
      // proof (drafts are kind=company even with an employee role), and the
      // service never infers employment, hire, or status from kind or flags.
      if (body.attestation !== true) {
        return NextResponse.json({ error: "attestation required" }, { status: 400 });
      }
      return withOrgTransaction(actor.orgId, () => withTransactionSavepoint(db, async () => {
        // Serialize link decisions on the target user row.
        const currentRows = await db.execute<{ id: string; party_id: string | null }>(sql`
          select id, party_id from users where id = ${userId} and org_id = ${actor.orgId} for update`);
        const currentRow = currentRows.rows[0];
        // Wrong-org and missing users share one message so callers cannot
        // probe which orgs hold which user ids.
        if (!currentRow) return NextResponse.json({ error: "user not found" }, { status: 404 });
        const current: string | null = currentRow.party_id
          ? String(currentRow.party_id).toLowerCase()
          : null;
        if (current !== expected) {
          return NextResponse.json(
            { error: "stale link: the user's linked person changed — refresh and try again" },
            { status: 409 },
          );
        }
        // Idempotent retry: already at the requested link, no audit.
        if (current === partyId) return NextResponse.json({ ok: true, userId, partyId: current });
        let partySignals: { id: string; kind: string; displayName: string; roles: string[] } | null = null;
        if (partyId !== null) {
          // Native party only: same-org, active, non-merged. No kind/role
          // inference, no automatic employee creation, no hire/status
          // changes. Wrong-org and missing parties share one message so
          // callers cannot probe which orgs hold which party ids. Inactive
          // parties (including inactive drafts/duplicates) fail as 422: the
          // row exists in this org but is not linkable. There is no separate
          // merged column on main — inactive covers drafts and merged-away
          // duplicates.
          const party = await db.execute<{
            id: string;
            kind: string;
            display_name: string;
            is_active: boolean;
          }>(sql`
            select id, kind, display_name, is_active from parties
             where id = ${partyId} and org_id = ${actor.orgId}`);
          const found = party.rows[0];
          if (!found) return NextResponse.json({ error: "party not found" }, { status: 404 });
          if (!found.is_active) {
            return NextResponse.json({ error: "party is not active" }, { status: 422 });
          }
          // Kind/role signals for audit evidence only — never proof of human
          // identity. Role membership comes exclusively from the canonical
          // role tables, matching the forms parties picker.
          const rolesR = await db.execute<{ role: string }>(sql`
            select 'vendor' as role from vendor_roles
             where org_id = ${actor.orgId} and party_id = ${partyId} and is_active
            union all
            select 'customer' as role from customer_roles
             where org_id = ${actor.orgId} and party_id = ${partyId} and is_active
            union all
            select 'employee' as role from employee_roles
             where org_id = ${actor.orgId} and party_id = ${partyId} and is_active`);
          partySignals = {
            id: partyId,
            kind: found.kind,
            displayName: found.display_name,
            roles: rolesR.rows.map((r) => r.role).sort(),
          };
        }
        // Precise affected-row count with the concurrency predicate: under a
        // race only one writer's predicate still holds, the loser sees zero
        // rows and reports 409 instead of silently winning.
        const updated = expected === null
          ? await db.execute<{ id: string }>(sql`
              update users set party_id = ${partyId}, updated_at = now(), updated_by = ${actor.id}
               where id = ${userId} and org_id = ${actor.orgId} and party_id is null
              returning id`)
          : await db.execute<{ id: string }>(sql`
              update users set party_id = ${partyId}, updated_at = now(), updated_by = ${actor.id}
               where id = ${userId} and org_id = ${actor.orgId} and party_id = ${expected}
              returning id`);
        if (!updated.rows[0]) {
          return NextResponse.json(
            { error: "stale link: the user's linked person changed — refresh and try again" },
            { status: 409 },
          );
        }
        const event = partyId === null
          ? "user-party-unlinked"
          : current === null
            ? "user-party-linked"
            : "user-party-changed";
        await audit(db, {
          orgId: actor.orgId,
          tableName: "users",
          rowId: userId,
          action: "update",
          changes: {
            event,
            actor: { kind: "user", userId: actor.id },
            actedAt: new Date().toISOString(),
            before: { party_id: current },
            after: { party_id: partyId },
            reason,
            attestation: true,
            party: partySignals,
          },
          actorId: actor.id,
        });
        return NextResponse.json({ ok: true, userId, partyId });
      }));
    }
    case "invite": {
      if (typeof body.email !== "string") {
        return NextResponse.json({ error: "email required" }, { status: 400 });
      }
      const email = normalizeLoginEmail(body.email);
      if (!email) {
        return NextResponse.json({ error: "valid email required" }, { status: 400 });
      }
      if (typeof body.roleId !== "string" || !isUuid(body.roleId)) {
        return NextResponse.json({ error: "roleId required" }, { status: 400 });
      }
      const roleId = body.roleId.toLowerCase();
      const name = deriveInviteDisplayName(email);
      // The user row, its first role, and both audit rows commit atomically.
      // ON CONFLICT DO NOTHING keeps a concurrent double-invite to a single
      // user: the loser sees no row and reports 409 instead of 500.
      const created = await withOrgTransaction(actor.orgId, () => withTransactionSavepoint(db, async () => {
        const role = await db.execute<{ id: string; key: string; permissions: unknown }>(sql`
          select id, key, permissions from app_roles where id = ${roleId} and org_id = ${actor.orgId} for share`);
        if (!role.rows[0])
          return NextResponse.json({ error: "role not found" }, { status: 404 });
        if (!actor.isSuperAdmin) {
          const rolePermissions = Array.isArray(role.rows[0].permissions)
            ? role.rows[0].permissions.filter((p): p is string => typeof p === "string")
            : [];
          const missing = permissionsOutsideCeiling(gate.permissions, rolePermissions);
          if (missing.length > 0) {
            return NextResponse.json(
              {
                error: `cannot grant permissions you do not hold: ${missing.join(", ")}`,
                missing,
              },
              { status: 403 },
            );
          }
        }
        const inserted = await db.execute<{ id: string }>(sql`
          insert into users (org_id, email, name, password_hash, is_active, created_by, updated_by)
          values (${actor.orgId}, ${email}, ${name}, ${UNUSABLE_PASSWORD_HASH}, true, ${actor.id}, ${actor.id})
          on conflict do nothing
          returning id`);
        const newUserId = inserted.rows[0]?.id;
        if (!newUserId) {
          return NextResponse.json(
            { error: "a user with this email already exists" },
            { status: 409 },
          );
        }
        const assignment = await db.execute<{ id: string }>(sql`
          insert into role_assignments (org_id, user_id, role_id, created_by, updated_by)
          values (${actor.orgId}, ${newUserId}, ${roleId}, ${actor.id}, ${actor.id})
          returning id`);
        await audit(db, {
          orgId: actor.orgId,
          tableName: "users",
          rowId: newUserId,
          action: "insert",
          changes: {
            email: [null, email],
            name: [null, name],
          },
          actorId: actor.id,
        });
        if (assignment.rows[0]) {
          await audit(db, {
            orgId: actor.orgId,
            tableName: "role_assignments",
            rowId: assignment.rows[0].id,
            action: "insert",
            changes: {
              userId: [null, newUserId],
              roleId: [null, roleId],
            },
            actorId: actor.id,
          });
        }
        return { userId: newUserId };
      }));
      if (created instanceof NextResponse) return created;
      // The set-password link travels the ordinary password-reset mail path,
      // so delivery, logging and expiry behave exactly like a self-service
      // reset. Mail trouble must not roll the user back: the invite stays
      // pending and the mailbox owner can always request a fresh link. When
      // no email transport exists the raw link is handed to the admin
      // one-time in this response instead — still pending, still single-use.
      let issuance: { raw: string; emailQueued: boolean } | null = null;
      try {
        issuance = await issueInviteSetPasswordLink({
          user: { id: created.userId, org_id: actor.orgId, name, email },
          context: authRequestContext(req),
        });
      } catch (error) {
        console.error("[admin-invite] set-password issuance failed", error);
      }
      if (!issuance) {
        return NextResponse.json(
          { error: "too many invites — try again later" },
          { status: 429 },
        );
      }
      return NextResponse.json({
        ok: true,
        userId: created.userId,
        emailQueued: issuance.emailQueued,
        // One-time admin copy: present only when the mailbox could not carry
        // it. Never persisted, never logged — the stored SHA-256 cannot
        // reproduce it.
        ...(issuance.emailQueued ? {} : { setPasswordUrl: setPasswordUrl(issuance.raw) }),
      });
    }
    case "resend-invite": {
      // Re-issue the set-password link for a still-pending invite. Grants no
      // role, so the ceiling check runs against the target's CURRENT roles:
      // a resend must not become a takeover path for accounts another admin
      // privileged above this actor's ceiling.
      const target = await withOrgTransaction(actor.orgId, () => withTransactionSavepoint(db, async () => {
        const rows = (await db.execute<{
          id: string;
          email: string;
          name: string | null;
          is_active: boolean;
          password_hash: string;
        }>(sql`
          select id, email, name, is_active, password_hash from users
           where id = ${userId} and org_id = ${actor.orgId} for update`)).rows;
        const found = rows[0];
        if (!found) return NextResponse.json({ error: "user not found" }, { status: 404 });
        if (!found.is_active) {
          return NextResponse.json(
            { error: "cannot resend an invite to a deactivated user" },
            { status: 409 },
          );
        }
        if (found.password_hash !== UNUSABLE_PASSWORD_HASH) {
          return NextResponse.json(
            { error: "user has already set a password" },
            { status: 409 },
          );
        }
        if (!actor.isSuperAdmin) {
          const granted = (await db.execute<{ permissions: unknown }>(sql`
            select r.permissions from role_assignments a
              join app_roles r on r.id = a.role_id and r.org_id = a.org_id
             where a.org_id = ${actor.orgId} and a.user_id = ${found.id}`)).rows;
          const grantedPermissions = granted.flatMap((row) =>
            Array.isArray(row.permissions)
              ? row.permissions.filter((p): p is string => typeof p === "string")
              : []);
          const missing = permissionsOutsideCeiling(gate.permissions, grantedPermissions);
          if (missing.length > 0) {
            return NextResponse.json(
              {
                error: `cannot re-issue an invite for permissions you do not hold: ${missing.join(", ")}`,
                missing,
              },
              { status: 403 },
            );
          }
        }
        return { id: found.id, email: found.email, name: found.name };
      }));
      if (target instanceof NextResponse) return target;
      let issuance: { raw: string; emailQueued: boolean } | null = null;
      try {
        issuance = await issueInviteSetPasswordLink({
          user: { id: target.id, org_id: actor.orgId, name: target.name, email: target.email },
          context: authRequestContext(req),
        });
      } catch (error) {
        console.error("[admin-invite] resend issuance failed", error);
      }
      if (!issuance) {
        return NextResponse.json(
          { error: "too many invites — try again later" },
          { status: 429 },
        );
      }
      await withOrgTransaction(actor.orgId, () => withTransactionSavepoint(db, async () => {
        await audit(db, {
          orgId: actor.orgId,
          tableName: "users",
          rowId: target.id,
          action: "update",
          changes: { inviteResent: [null, true] },
          actorId: actor.id,
        });
      }));
      return NextResponse.json({
        ok: true,
        userId: target.id,
        emailQueued: issuance.emailQueued,
        ...(issuance.emailQueued ? {} : { setPasswordUrl: setPasswordUrl(issuance.raw) }),
      });
    }
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
}

/**
 * Scoped native person search for the Admin Users link drawer.
 * Org-scoped, gated by admin.users.manage; per-query bounded page (not a
 * fixed first-N roster) so people beyond the first page stay selectable via
 * search. Options are active parties only (inactive fail closed at link
 * time); `include` preserves the currently selected option across queries
 * even when it leaves the page or becomes inactive. Cross-org and missing
 * ids share one null selected so callers cannot probe other orgs.
 */
export async function GET(req: Request) {
  const gate = await guardPermission("admin.users.manage");
  if (gate instanceof NextResponse) return gate;
  const orgId = gate.user.orgId;

  const url = new URL(req.url);
  const rawQ = (url.searchParams.get("q") ?? "").trim();
  if (rawQ.length > 200) {
    return NextResponse.json({ error: "q too long" }, { status: 400 });
  }
  const rawLimit = Number(url.searchParams.get("limit") ?? "25");
  const limit = Number.isFinite(rawLimit)
    ? Math.max(5, Math.min(50, Math.trunc(rawLimit)))
    : 25;
  const rawInclude = url.searchParams.get("include");
  let include: string | null = null;
  if (rawInclude !== null && rawInclude !== "") {
    if (!isUuid(rawInclude)) {
      return NextResponse.json({ error: "include must be a uuid" }, { status: 400 });
    }
    include = rawInclude.toLowerCase();
  }

  const like = `%${rawQ}%`;
  const optionsR = await db.execute<{
    id: string;
    display_name: string;
    kind: string;
    roles: string[] | null;
  }>(sql`
    select p.id::text as id, p.display_name, p.kind,
           coalesce(array_remove(array_agg(distinct r.role), null), '{}') as roles
      from parties p
      left join (
        select party_id, 'vendor' as role from vendor_roles where org_id = ${orgId} and is_active
        union all
        select party_id, 'customer' as role from customer_roles where org_id = ${orgId} and is_active
        union all
        select party_id, 'employee' as role from employee_roles where org_id = ${orgId} and is_active
      ) r on r.party_id = p.id
     where p.org_id = ${orgId} and p.is_active
       and (${rawQ} = '' or p.display_name ilike ${like} or coalesce(p.email, '') ilike ${like})
     group by p.id, p.display_name, p.kind
     order by p.display_name
     limit ${limit}`);

  type PersonOption = {
    value: string;
    label: string;
    hint?: string;
    kind: string;
    roles: string[];
    isActive: boolean;
  };
  const toOption = (row: { id: string; display_name: string; kind: string; roles: string[] | null }, isActive: boolean): PersonOption => {
    const roles = Array.isArray(row.roles) ? [...row.roles].sort() : [];
    const hint = roles.length > 0 ? `${row.kind} · ${roles.join(", ")}` : row.kind;
    return {
      value: String(row.id).toLowerCase(),
      label: row.display_name,
      hint,
      kind: row.kind,
      roles,
      isActive,
    };
  };
  const options: PersonOption[] = optionsR.rows.map((r) => toOption(r, true));

  let selected: PersonOption | null = null;
  if (include !== null && !options.some((o) => o.value === include)) {
    const selR = await db.execute<{
      id: string;
      display_name: string;
      kind: string;
      is_active: boolean;
      roles: string[] | null;
    }>(sql`
      select p.id::text as id, p.display_name, p.kind, p.is_active,
             coalesce(array_remove(array_agg(distinct r.role), null), '{}') as roles
        from parties p
        left join (
          select party_id, 'vendor' as role from vendor_roles where org_id = ${orgId} and is_active
          union all
          select party_id, 'customer' as role from customer_roles where org_id = ${orgId} and is_active
          union all
          select party_id, 'employee' as role from employee_roles where org_id = ${orgId} and is_active
        ) r on r.party_id = p.id
       where p.org_id = ${orgId} and p.id = ${include}
       group by p.id, p.display_name, p.kind, p.is_active`);
    const found = selR.rows[0];
    if (found) selected = toOption(found, found.is_active);
  } else if (include !== null) {
    selected = options.find((o) => o.value === include) ?? null;
  }

  return NextResponse.json({ options, selected });
}
