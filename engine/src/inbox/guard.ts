/**
 * HR-15 inbox source guards.
 *
 * HRM adapters return an empty list while the hrm feature is off — probed
 * explicitly through the org feature lock, never by catching a refusal.
 * The inbox is core and must stay up for every org; hrm-gated work simply
 * has no rows while its switch is off, and reappears when it is on (rows
 * are never deleted by the switch).
 *
 * The actor facts every source shares (feature switches, the actor's
 * party, the actor's pending gates) resolve through the per-read memo, so
 * one inbox read derives each fact once instead of once per source. Each
 * source still applies its own gate to the shared fact.
 */
import { sql } from "drizzle-orm";
import { HRM_FEATURE_KEY } from "../hrm/employment-read.ts";
import { HrmAuthorizationError, loadApprovalPerson } from "../hrm/authorization.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { worklistGates, type WorklistGate } from "../flows/gates.ts";
import { db } from "../platform/db.ts";
import type { WorklistScope } from "../flows/approval-worklist.ts";
import { memoizeForRead } from "./read-memo.ts";
import type { InboxListContext } from "./types.ts";

/**
 * One org feature switch, resolved through lockAndCheckOrgFeature (the
 * single authority) once per read and key. Missing orgs and unknown
 * features fail closed there.
 */
export function orgFeatureOn(ctx: InboxListContext, key: string): Promise<boolean> {
  return memoizeForRead(ctx, `feature:${key}`, () => lockAndCheckOrgFeature(ctx.exec ?? db, ctx.orgId, key));
}

/** Resolve each permission through its native authority once per read. */
export function actorPermissionOn(ctx: InboxListContext, permission: string): Promise<boolean> {
  return memoizeForRead(ctx, `permission:${permission}`, () => actorHasPermission(ctx.exec ?? db, ctx.orgId, ctx.actorId, permission));
}

export function hrmOn(ctx: InboxListContext): Promise<boolean> {
  return orgFeatureOn(ctx, HRM_FEATURE_KEY);
}

/**
 * The actor's party, or null when no identity is established in the org.
 * Personal legs (my steps, my drafts, my weeks) return [] for null — a
 * caller with no employment record has no personal rows, while the flows
 * and notice legs (which scope by user id, not party) still list. Only
 * the identity-absence refusal narrows here; every other gate still throws
 * with its message intact for established actors.
 */
export function actorPartyId(ctx: InboxListContext): Promise<string | null> {
  return memoizeForRead(ctx, "actor-party", async () => {
    try {
      return (await loadApprovalPerson(db, ctx.orgId, ctx.actorId)).partyId;
    } catch (error) {
      if (error instanceof HrmAuthorizationError) return null;
      throw error;
    }
  });
}

/**
 * Carry the session-derived union scope into the unpaged worklist reader.
 * The scope rides the server-built context (never client input) so the
 * dedicated adapters see exactly the gates the union page would show.
 */
export function toWorklistScope(ctx: InboxListContext): WorklistScope {
  const scope = ctx.scope;
  if (!scope) return {};
  return {
    ...(scope.roles ? { roles: scope.roles } : {}),
    ...(scope.allowedSubsidiaryIds !== undefined
      ? { allowedSubsidiaryIds: scope.allowedSubsidiaryIds === null ? null : new Set(scope.allowedSubsidiaryIds) }
      : {}),
  };
}

/**
 * Every pending gate the actor may decide, under the session's union scope —
 * the gate leg of the approvals worklist, read once per inbox read. The
 * dedicated gate adapters (leave, change request, timesheet week, crew
 * batch) each keep only their own subject kind.
 */
export function actorPendingGates(ctx: InboxListContext): Promise<WorklistGate[]> {
  return memoizeForRead(ctx, "pending-gates", () => {
    const scope = toWorklistScope(ctx);
    return worklistGates(ctx.orgId, ctx.actorId, scope.roles, scope.allowedSubsidiaryIds);
  });
}

/**
 * Whether a source table is installed. A database may lag the release that
 * introduced a source, so presence is probed explicitly (never by catching
 * errors) and an absent source lists nothing. Only presence is remembered
 * for the process: an installed table does not disappear at runtime, while
 * an absent one is probed again so an applied migration is picked up
 * without a restart.
 */
const installedTables = new Set<string>();

export async function sourceTableInstalled(table: string): Promise<boolean> {
  if (installedTables.has(table)) return true;
  const found = (await db.execute<{ exists: boolean }>(sql`
    select to_regclass(${`public.${table}`}) is not null as exists
  `)).rows[0]?.exists === true;
  if (found) installedTables.add(table);
  return found;
}
