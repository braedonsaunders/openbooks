import { sql } from "drizzle-orm";
import { PostingError } from "./posting-contracts.ts";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * Durable controller grants for connector historical replay into closed
 * periods. The transaction-local replay flag only identifies the replaying
 * sync run; a live row here is what authorizes the write, so every
 * closed-period replay carries who allowed it, for which connector, for
 * which period range, why, and until when.
 */
export interface AuthorizeConnectorReplayInput {
  orgId: string;
  /** Connector the grant covers (the sync run's connection). */
  connectionId: string;
  /** Controller granting the window; never the sync-run actor itself. */
  authorizedBy: string;
  /** One end of the covered period range; ends are interchangeable. */
  periodFromId: string;
  /** The other end of the covered period range. */
  periodToId: string;
  /** ISO timestamp; the table refuses anything not later than now. */
  expiresAt: string;
  /** 10..1000 characters, enforced by the table check. */
  reason: string;
  actorId?: string | null;
}

export interface LiveReplayAuthorization {
  id: string;
  connectionId: string;
  reason: string;
  expiresAt: Date;
}

/** Record a bounded replay grant. A write matching zero rows is a failure. */
export async function authorizeConnectorReplay(
  executor: SqlExecutor,
  input: AuthorizeConnectorReplayInput,
): Promise<{ id: string }> {
  const inserted = (await executor.execute<{ id: string }>(sql`
    insert into connector_replay_authorizations
      (org_id, connection_id, authorized_by, period_from_id, period_to_id,
       expires_at, reason, created_by, updated_by)
    values (${input.orgId}, ${input.connectionId}, ${input.authorizedBy},
            ${input.periodFromId}, ${input.periodToId}, ${input.expiresAt},
            ${input.reason}, ${input.actorId ?? null}, ${input.actorId ?? null})
    returning id`)).rows[0];
  if (!inserted)
    throw new PostingError(
      "the connector replay authorization was not recorded — retry the grant instead of replaying without it",
    );
  return { id: inserted.id };
}

/**
 * The live grant for the connector the transaction-local replay flag names,
 * covering the posting period. Null when no row covers it: the caller
 * refuses. Expiry is decided by the caller so an expired row and a missing
 * row refuse with different remedies.
 */
export async function findLiveReplayAuthorization(
  executor: SqlExecutor,
  input: { orgId: string; periodId: string },
): Promise<LiveReplayAuthorization | null> {
  const rows = (await executor.execute<{
    id: string;
    connection_id: string;
    reason: string;
    expires_at: Date | string;
  }>(sql`
    select auth.id, auth.connection_id, auth.reason, auth.expires_at
      from connector_replay_authorizations auth
      join accounting_periods from_period
        on from_period.id = auth.period_from_id
       and from_period.org_id = auth.org_id
      join accounting_periods to_period
        on to_period.id = auth.period_to_id
       and to_period.org_id = auth.org_id
      join accounting_periods target
        on target.id = ${input.periodId}
       and target.org_id = ${input.orgId}
      join sync_runs run
        on run.id::text = current_setting('openbooks.connector_replay_request', true)
       and run.org_id = ${input.orgId}
       and run.connection_id = auth.connection_id
     where auth.org_id = ${input.orgId}
       and auth.authorized_at <= now()
       and target.starts_on >= least(from_period.starts_on, to_period.starts_on)
       and target.ends_on <= greatest(from_period.ends_on, to_period.ends_on)
     order by auth.authorized_at desc
     limit 1`)).rows;
  const found = rows[0];
  if (!found) return null;
  return {
    id: found.id,
    connectionId: found.connection_id,
    reason: found.reason,
    expiresAt: new Date(found.expires_at),
  };
}
