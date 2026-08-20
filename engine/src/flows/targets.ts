import { sql } from "drizzle-orm";
import type { AssigneeTarget, RecipientTarget } from "@openbooks/forms-core";
import { db } from "../db.ts";

/**
 * AssigneeTarget / RecipientTarget → concrete users and email addresses using
 * OpenBooks' identity model:
 *
 *   role       — resolved from explicit app_roles/role_assignments membership.
 *   submitter  — the run's submitter (documents.created_by).
 *   supervisor — submitter's users.partyId → employee_roles.supervisorId
 *                (a party) → the user linked to that party.
 *   field      — a record field holding a user id, verified in-org.
 *   email      — literal (recipients only): one address or a comma/semicolon/
 *                space-separated list.
 */

export type ResolvedUser = {
  id: string;
  name: string;
  email: string;
};

export interface TargetResolutionCtx {
  orgId: string;
  submitterUserId?: string | null;
  values: Record<string, unknown>;
}

type Rows<T> = { rows: T[] };

/** Active users explicitly assigned to `role`. */
export async function roleUsers(orgId: string, role: string): Promise<ResolvedUser[]> {
  if (!role) return [];
  const r = (await db.execute<ResolvedUser>(sql`
    select distinct u.id, u.name, u.email
      from users u
      join role_assignments ra on ra.user_id = u.id and ra.org_id = u.org_id
      join app_roles ar on ar.id = ra.role_id and ar.org_id = u.org_id
     where u.org_id = ${orgId} and u.is_active
       and ar.key = ${role}
  `));
  return r.rows;
}

/** One active in-org user by id (verification for user/field targets). */
export async function verifyUser(orgId: string, userId: string): Promise<ResolvedUser | null> {
  if (!userId) return null;
  const r = (await db.execute<ResolvedUser>(sql`
    select id, name, email from users
     where id = ${userId} and org_id = ${orgId} and is_active
  `));
  return r.rows[0] ?? null;
}

/** The submitter's supervisor: users.partyId → employee_roles.supervisorId → user. */
export async function supervisorOf(orgId: string, userId: string | null | undefined): Promise<ResolvedUser | null> {
  if (!userId) return null;
  const r = (await db.execute<ResolvedUser>(sql`
    select su.id, su.name, su.email
      from users u
      join employee_roles er on er.party_id = u.party_id and er.org_id = u.org_id
      join users su on su.party_id = er.supervisor_id and su.org_id = u.org_id and su.is_active
     where u.id = ${userId} and u.org_id = ${orgId}
     limit 1
  `));
  return r.rows[0] ?? null;
}

/** Explicit role keys assigned to the user. */
export async function userRoleKeys(orgId: string, userId: string): Promise<Set<string>> {
  const r = (await db.execute<{ key: string }>(sql`
    select ar.key from role_assignments ra
      join app_roles ar on ar.id = ra.role_id
     where ra.user_id = ${userId} and ra.org_id = ${orgId}
  `));
  return new Set(r.rows.map((x) => x.key));
}

/**
 * Resolve one assignee-shaped target (no email literals) to users. `role`
 * fans out to every holder — the gate layer decides quorum semantics.
 */
async function resolveTargetUsers(
  target: AssigneeTarget,
  ctx: TargetResolutionCtx,
): Promise<ResolvedUser[]> {
  switch (target.type) {
    case "user": {
      const u = await verifyUser(ctx.orgId, target.userId);
      return u ? [u] : [];
    }
    case "role":
      return roleUsers(ctx.orgId, target.role);
    case "submitter": {
      const u = ctx.submitterUserId ? await verifyUser(ctx.orgId, ctx.submitterUserId) : null;
      return u ? [u] : [];
    }
    case "supervisor": {
      const u = await supervisorOf(ctx.orgId, ctx.submitterUserId);
      return u ? [u] : [];
    }
    case "field": {
      const v = ctx.values[target.field];
      const u = typeof v === "string" && v ? await verifyUser(ctx.orgId, v) : null;
      return u ? [u] : [];
    }
  }
}

/** Union of users behind a list of assignee targets, deduped by user id. */
export async function resolveAssigneeUsers(
  targets: AssigneeTarget[],
  ctx: TargetResolutionCtx,
): Promise<ResolvedUser[]> {
  const out = new Map<string, ResolvedUser>();
  for (const t of targets) {
    for (const u of await resolveTargetUsers(t, ctx)) out.set(u.id, u);
  }
  return [...out.values()];
}

/** Recipient targets → in-org users (email literals have no user; skipped). */
export async function resolveRecipientUsers(
  targets: RecipientTarget[],
  ctx: TargetResolutionCtx,
): Promise<ResolvedUser[]> {
  const out = new Map<string, ResolvedUser>();
  for (const t of targets) {
    if (t.type === "email") continue;
    for (const u of await resolveTargetUsers(t, ctx)) out.set(u.id, u);
  }
  return [...out.values()];
}

/** Recipient targets → deduped email addresses (users + literal lists). */
export async function resolveRecipientEmails(
  targets: RecipientTarget[],
  ctx: TargetResolutionCtx,
): Promise<string[]> {
  const out = new Set<string>();
  const add = (e: string | null | undefined) => {
    const v = e?.trim();
    if (v && v.includes("@")) out.add(v);
  };
  for (const t of targets) {
    if (t.type === "email") {
      for (const part of t.email.split(/[,;\s]+/)) add(part);
      continue;
    }
    // A `field` target whose record value LOOKS like an email address (or a
    // list of them) is delivered directly — the source platform "email a recipient
    // from a record field" pattern (e.g. the vendor's EFT notification
    // address). Values that don't contain '@' resolve as user ids as usual.
    if (t.type === "field") {
      const v = ctx.values[t.field];
      if (typeof v === "string" && v.includes("@")) {
        for (const part of v.split(/[,;\s]+/)) add(part);
        continue;
      }
    }
    for (const u of await resolveTargetUsers(t, ctx)) add(u.email);
  }
  return [...out];
}
