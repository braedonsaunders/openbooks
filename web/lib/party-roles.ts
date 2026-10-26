import "server-only";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "@openbooks/engine/platform/db";
import { subsidiaryVisibleFilter } from "./subsidiaries";
import {
  isNaturalPersonPartyKind,
  EmployeePartyKindError,
} from "@openbooks/engine/organization/party-kinds";

/**
 * Party kinds that name a role row. The party lists, the drawer tabs, and
 * compliance all resolve the ROLE, never `parties.kind` — so a stored
 * customer/vendor/employee kind is a claim the matching role row must back.
 */
export type PartyRoleKind = "customer" | "vendor" | "employee";

const PARTY_ROLE_TABLES: Record<
  PartyRoleKind,
  "customer_roles" | "vendor_roles" | "employee_roles"
> = {
  customer: "customer_roles",
  vendor: "vendor_roles",
  employee: "employee_roles",
};

export function partyRoleKindOf(kind: unknown): PartyRoleKind | null {
  return kind === "customer" || kind === "vendor" || kind === "employee" ? kind : null;
}

/**
 * Keep a role-kind party backed by its canonical role row.
 *
 * Writers that persist `parties.kind` without going through the parties
 * routes (master-data import, the generic v1/MCP entity writer) call this
 * after the party row lands, in the same transaction where one exists. A
 * role-kind kind with no role row strands a "Kind: Vendor" no read can
 * back, so the canonical row is created atomically with the kind that
 * names it.
 *
 * Insert-only by construction (`on conflict do nothing` — a conflict here
 * is the expected benign case of a re-import or a retry meeting the row the
 * first attempt wrote): an existing role row, active or deactivated, is
 * never flipped by a kind echo or a re-import.
 */
export async function ensurePartyRoleRow(
  executor: SqlExecutor | typeof db,
  args: { orgId: string; partyId: string; kind: unknown; isActive?: unknown; actorId: string },
): Promise<void> {
  const role = partyRoleKindOf(args.kind);
  if (!role) return;
  if (role === "employee") {
    const party = (
      await executor.execute<{ kind: string }>(
        sql`
      select kind from parties where org_id = ${args.orgId} and id = ${args.partyId} for share
    `,
        "objects",
      )
    )[0];
    if (!party || !isNaturalPersonPartyKind(party.kind)) throw new EmployeePartyKindError();
  }
  const table = PARTY_ROLE_TABLES[role];
  const active = args.isActive !== false;
  await executor.execute(sql`
    insert into ${sql.raw(table)} (org_id, party_id, is_active, created_by, updated_by)
    values (${args.orgId}, ${args.partyId}, ${active}, ${args.actorId}, ${args.actorId})
    -- An existing party role retains its active state; a kind echo cannot reactivate a disabled role.
    on conflict (party_id) do nothing`);
}

const ROLE_TABLES = {
  customer: "customer_roles",
  vendor: "vendor_roles",
  employee: "employee_roles",
} as const;

export type RemovablePartyRole = keyof typeof ROLE_TABLES;

/** A party's identity and entity, for a role change the caller's scope must admit. */
export async function readPartyForRoleChange(orgId: string, partyId: string) {
  return (
    (
      await db.execute<{
        id: string;
        kind: string;
        display_name: string;
        subsidiary_id: string | null;
        is_active: boolean;
      }>(
        sql`
    select id, kind, display_name, subsidiary_id, is_active from parties
     where id = ${partyId} and org_id = ${orgId} limit 1`,
        "objects",
      )
    )[0] ?? null
  );
}

/** The party's row for one native role, or null when it holds none. */
export async function readPartyRoleRow(orgId: string, role: RemovablePartyRole, partyId: string) {
  return (
    (
      await db.execute<Record<string, unknown>>(
        sql`
    select * from ${sql.raw(ROLE_TABLES[role])} where org_id = ${orgId} and party_id = ${partyId} limit 1`,
        "objects",
      )
    )[0] ?? null
  );
}

/**
 * Human-counted open activity per role — live documents with open balances
 * for commercial roles (the same live predicate party deactivation uses),
 * open pipeline for customers, unapproved time for employees. Empty means
 * the role removes cleanly.
 */
export async function openRoleActivity(
  orgId: string,
  partyId: string,
  role: RemovablePartyRole,
  kinds: readonly string[],
): Promise<string[]> {
  if (role === "employee") {
    const weeks = (
      await db.execute<{ n: string }>(
        sql`
      select count(*)::text as n from timesheet_weeks
       where org_id = ${orgId} and employee_party_id = ${partyId} and status in ('draft', 'submitted')`,
        "objects",
      )
    )[0];
    const count = Number(weeks?.n ?? "0");
    return count > 0
      ? [`${count} unapproved timesheet ${count === 1 ? "week remains" : "weeks remain"}`]
      : [];
  }
  const kindList = sql.join(
    kinds.map((kind) => sql`${kind}`),
    sql`, `,
  );
  const docs = (
    await db.execute<{ n: string }>(
      sql`
    select count(*)::text as n from documents
     where org_id = ${orgId} and party_id = ${partyId} and kind in (${kindList})
       -- Live entries only: only standing documents with open balances block removing the role
       and (status in ('pending_approval', 'approved') or (status = 'posted' and coalesce(open_balance, 0) <> 0))`,
      "objects",
    )
  )[0];
  const blockers: string[] = [];
  const docCount = Number(docs?.n ?? "0");
  if (docCount > 0) {
    const noun =
      role === "customer"
        ? docCount === 1
          ? "open invoice with an open balance remains"
          : "open invoices with open balances remain"
        : docCount === 1
          ? "open bill with an open balance remains"
          : "open bills with open balances remain";
    blockers.push(`${docCount} ${noun}`);
  }
  if (role === "customer") {
    const pipeline = (
      await db.execute<{ n: string }>(
        sql`
      select count(*)::text as n from crm_opportunities o
        join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
       where o.org_id = ${orgId} and o.party_id = ${partyId} and o.is_active and not s.is_closed`,
        "objects",
      )
    )[0];
    const pipeCount = Number(pipeline?.n ?? "0");
    if (pipeCount > 0) {
      blockers.push(
        `${pipeCount} open ${pipeCount === 1 ? "opportunity remains" : "opportunities remain"}`,
      );
    }
  }
  return blockers;
}

/**
 * Delete a party's role row, return its kind to the base when the role named
 * it, and audit before/after — in one transaction. The role row is
 * re-checked inside the write, so a concurrent removal fails closed instead
 * of auditing a removal that never happened.
 */
export async function deletePartyRole(input: {
  orgId: string;
  actorId: string;
  partyId: string;
  role: RemovablePartyRole;
  priorKind: string;
  nextKind: string;
  roleRow: Record<string, unknown>;
}): Promise<string> {
  const { orgId, actorId, partyId, role } = input;
  return db.transaction(async (tx) => {
    const deleted = (
      await tx.execute<{ id: string }>(
        sql`
      delete from ${sql.raw(ROLE_TABLES[role])} where org_id = ${orgId} and party_id = ${partyId} returning id`,
        "objects",
      )
    )[0];
    if (!deleted)
      throw new Error(`the ${role} role changed while removing it — reload and try again`);
    if (input.nextKind !== input.priorKind) {
      const renamed = (
        await tx.execute<{ id: string }>(
          sql`
        update parties set kind = ${input.nextKind}, updated_at = now(), updated_by = ${actorId}
         where id = ${partyId} and org_id = ${orgId} returning id`,
          "objects",
        )
      )[0];
      if (!renamed)
        throw new Error("the party changed while removing its role — reload and try again");
    }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'parties', ${partyId}, 'update',
              ${JSON.stringify({
                source: "role-remove",
                role,
                before: { kind: input.priorKind, role: input.roleRow },
                after: { kind: input.nextKind, role: null },
              })}::jsonb, ${actorId})`);
    return input.nextKind;
  });
}

/** Role-less parties in a directory slice (search text, show-inactives), inside the caller's subsidiary fence. */
export async function roleLessPartiesInSlice(input: {
  orgId: string;
  q: string | null;
  includeInactive: boolean;
  limit: number;
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined;
}): Promise<{ id: string; is_active: boolean }[]> {
  return await db.execute<{ id: string; is_active: boolean }>(
    sql`
    select p.id, p.is_active from parties p
     where p.org_id = ${input.orgId}
      ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, input.allowedSubsidiaryIds ?? null, { orgWideNull: true })}
      ${input.q ? sql` and (p.display_name ilike ${input.q} or p.short_code ilike ${input.q} or p.email ilike ${input.q})` : sql``}
      ${input.includeInactive ? sql`` : sql` and p.is_active`}
      and not exists (select 1 from customer_roles r where r.party_id = p.id and r.org_id = p.org_id and r.is_active)
      and not exists (select 1 from vendor_roles r where r.party_id = p.id and r.org_id = p.org_id and r.is_active)
      and not exists (select 1 from employee_roles r where r.party_id = p.id and r.org_id = p.org_id and r.is_active)
     order by p.display_name
     limit ${input.limit}`,
    "objects",
  );
}

/** Promote one party to a native role through the insert-only role command, audited. */
export async function assignPartyRoleAudited(input: {
  orgId: string;
  actorId: string;
  partyId: string;
  role: RemovablePartyRole;
}): Promise<void> {
  const { orgId, actorId, partyId, role } = input;
  await db.transaction(async (tx) => {
    const before = await tx.execute<{ kind: string; is_active: boolean }>(
      sql`
      select kind, is_active from parties where id = ${partyId} and org_id = ${orgId}`,
      "objects",
    );
    if (!before[0]) throw new Error(`party ${partyId} not found in this organization`);
    await ensurePartyRoleRow(tx, {
      orgId,
      partyId,
      kind: role,
      isActive: before[0].is_active,
      actorId,
    });
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'parties', ${partyId}, 'update',
              ${JSON.stringify({ source: "bulk-role-assign", role, before: before[0], after: { ...before[0], [role]: true } })}::jsonb, ${actorId})`);
  });
}
