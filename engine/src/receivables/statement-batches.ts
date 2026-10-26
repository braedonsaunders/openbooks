import { sql, type SQL } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { pgTextArrayLiteral } from "../platform/pg-array.ts";

/** A run is visible only when the caller covers its recorded scope and every referenced party. */
function statementBatchScopeFilter(
  runAlias: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): SQL {
  if (allowedSubsidiaryIds == null) return sql`true`;
  const run = sql.raw(runAlias);
  const allowed = [...allowedSubsidiaryIds];
  return sql`
    jsonb_typeof(${run}.authorization_snapshot->'allowedSubsidiaryIds') = 'array'
    and not exists (
      select 1
        from jsonb_array_elements_text(
          case when jsonb_typeof(${run}.authorization_snapshot->'allowedSubsidiaryIds') = 'array'
            then ${run}.authorization_snapshot->'allowedSubsidiaryIds' else '[]'::jsonb end
        ) as snapshot_scope(id)
       where not (snapshot_scope.id = any(${pgTextArrayLiteral(allowed)}::text[]))
    )
    and not exists (
      select 1
        from statement_batch_items scoped_item
        left join parties scoped_party
          on scoped_party.id = scoped_item.party_id and scoped_party.org_id = scoped_item.org_id
       where scoped_item.org_id = ${run}.org_id and scoped_item.run_id = ${run}.id
         and (scoped_party.id is null or (scoped_party.subsidiary_id is not null
           and not (scoped_party.subsidiary_id::text = any(${pgTextArrayLiteral(allowed)}::text[]))))
    )`;
}

/**
 * Batched customer statements: durable runs and per-customer delivery
 * items. Creating a run writes the audited record (who, when, period,
 * filters, recipient count) plus one item per customer, then enqueues one
 * queue job per emailable customer through the caller's enqueuer — the
 * deterministic job identity dedupes a repeated enqueue, and the
 * (run, customer) uniqueness stops a retried job from sending twice.
 */

export type StatementBatchRunStatus = "queued" | "sending" | "done";
export type StatementBatchItemStatus = "queued" | "sending" | "sent" | "failed" | "skipped";

export interface StatementBatchRecipientInput {
  partyId: string;
  balance: string;
  overdue: string;
  currency: string | null;
  toEmail: string;
}

export interface StatementBatchExclusionInput {
  partyId: string;
  balance: string;
  overdue: string;
}

export interface StatementBatchRunRow {
  id: string;
  periodFrom: string | null;
  periodTo: string;
  filters: Record<string, unknown>;
  recipientCount: number;
  status: StatementBatchRunStatus;
  authorizationSnapshot: { userId?: string; allowedSubsidiaryIds?: string[] | null } & Record<
    string,
    unknown
  >;
  createdAt: Date;
  createdBy: string | null;
}

export interface StatementBatchItemRow {
  id: string;
  runId: string;
  partyId: string;
  partyName: string | null;
  toEmail: string | null;
  balance: string;
  overdue: string;
  currency: string | null;
  status: StatementBatchItemStatus;
  error: string | null;
  deliveryKey: string | null;
  emailLogId: string | null;
  sentAt: Date | null;
}

export type StatementBatchEnqueuer = (
  jobs: { orgId: string; runId: string; partyId: string; senderId: string }[],
) => Promise<unknown>;

/**
 * A batch filing refusal: the request is well-formed but cannot run as
 * filed (no recipients, a duplicate customer, a vanished run row). It
 * filed (no recipients, a duplicate customer, an unwritten run row). It
 * answers 422 with its message, which names no internal identifiers — a
 * party or item id belongs in the server log, never in a client refusal.
 */
export class StatementBatchError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "StatementBatchError";
  }
}

function refuseZeroRowWrite(label: string): never {
  throw new Error(
    `${label} — the update matched no row, so nothing was written. ` +
      "Confirm the row exists and is visible in this organization before treating the write as recorded.",
  );
}

function refuseBatchWrite(label: string): never {
  throw new StatementBatchError(
    `${label} — the update matched no row, so nothing was written. ` +
      "Confirm the row exists and is visible in this organization before treating the write as recorded.",
  );
}

export async function createStatementBatchRun(args: {
  orgId: string;
  senderId: string;
  periodFrom: string | null;
  periodTo: string;
  filters: Record<string, unknown>;
  recipients: StatementBatchRecipientInput[];
  excluded: StatementBatchExclusionInput[];
  allowedSubsidiaryIds: string[] | null;
  enqueue: StatementBatchEnqueuer;
}): Promise<{ runId: string; queued: number; skipped: number }> {
  if (args.recipients.length === 0) {
    throw new StatementBatchError(
      "statement batch has no recipients — adjust the period or filters",
    );
  }
  const runRows = await db.execute<{ id: string }>(
    sql`
    insert into statement_batch_runs
      (org_id, period_from, period_to, filters, recipient_count, status, authorization_snapshot, created_by)
    values (
      ${args.orgId}, ${args.periodFrom}, ${args.periodTo}, ${JSON.stringify(args.filters)}::jsonb,
      ${args.recipients.length}, 'sending',
      ${JSON.stringify({ version: 1, userId: args.senderId, allowedSubsidiaryIds: args.allowedSubsidiaryIds })}::jsonb,
      ${args.senderId}
    )
    returning id::text as id`,
    "objects",
  );
  const runId = runRows[0]?.id;
  // A required write matching zero rows is a failure, not a success.
  if (!runId) refuseBatchWrite("statement batch run was not recorded");
  for (const recipient of args.recipients) {
    // A fresh run id cannot collide, so a conflict here means the input
    // listed one customer twice — refusing beats sending them two letters.
    const inserted = await db.execute<{ id: string }>(
      sql`
      insert into statement_batch_items
        (org_id, run_id, party_id, to_email, balance, overdue, currency_code, status, created_by)
      values (${args.orgId}, ${runId}, ${recipient.partyId}, ${recipient.toEmail},
              ${recipient.balance}, ${recipient.overdue}, ${recipient.currency}, 'queued', ${args.senderId})
      -- Only a customer listed twice can collide; the empty result refuses below.
      on conflict (run_id, party_id) do nothing
      returning id::text as id`,
      "objects",
    );
    if (!inserted[0])
      refuseBatchWrite(
        "statement batch item was not recorded — the input listed one customer twice; refusing beats sending them two letters",
      );
  }
  for (const exclusion of args.excluded) {
    await db.execute(sql`
      insert into statement_batch_items
        (org_id, run_id, party_id, to_email, balance, overdue, status, error, created_by)
      values (${args.orgId}, ${runId}, ${exclusion.partyId}, null,
              ${exclusion.balance}, ${exclusion.overdue}, 'skipped', 'no email on file', ${args.senderId})
      -- An exclusion listed twice records once; a skipped row sends nothing.
      on conflict (run_id, party_id) do nothing`);
  }
  await args.enqueue(
    args.recipients.map((recipient) => ({
      orgId: args.orgId,
      runId,
      partyId: recipient.partyId,
      senderId: args.senderId,
    })),
  );
  return { runId, queued: args.recipients.length, skipped: args.excluded.length };
}

export async function getStatementBatchRun(
  orgId: string,
  runId: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<StatementBatchRunRow | null> {
  const rows = await db.execute<{
    id: string;
    period_from: string | null;
    period_to: string;
    filters: Record<string, unknown>;
    recipient_count: number;
    status: StatementBatchRunStatus;
    authorization_snapshot: StatementBatchRunRow["authorizationSnapshot"];
    created_at: Date;
    created_by: string | null;
  }>(
    sql`
    select id::text as id, period_from::text as period_from, period_to::text as period_to,
           filters, recipient_count, status, authorization_snapshot, created_at, created_by::text as created_by
      from statement_batch_runs where id = ${runId} and org_id = ${orgId}
        and ${statementBatchScopeFilter("statement_batch_runs", allowedSubsidiaryIds)}
      limit 1`,
    "objects",
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    filters: row.filters ?? {},
    recipientCount: row.recipient_count,
    status: row.status,
    authorizationSnapshot: row.authorization_snapshot ?? {},
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export async function listStatementBatchItems(
  orgId: string,
  runId: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<StatementBatchItemRow[]> {
  const rows = await db.execute<{
    id: string;
    run_id: string;
    party_id: string;
    party_name: string | null;
    to_email: string | null;
    balance: string;
    overdue: string;
    currency_code: string | null;
    status: StatementBatchItemStatus;
    error: string | null;
    delivery_key: string | null;
    email_log_id: string | null;
    sent_at: Date | null;
  }>(
    sql`
    select i.id::text as id, i.run_id::text as run_id, i.party_id::text as party_id, p.display_name as party_name,
           i.to_email, i.balance, i.overdue, i.currency_code, i.status, i.error,
           i.delivery_key, i.email_log_id::text as email_log_id, i.sent_at
      from statement_batch_items i
      join statement_batch_runs r on r.id = i.run_id and r.org_id = i.org_id
      left join parties p on p.id = i.party_id and p.org_id = i.org_id
     where i.org_id = ${orgId} and i.run_id = ${runId}
       and ${statementBatchScopeFilter("r", allowedSubsidiaryIds)}
     order by p.display_name nulls last, i.created_at`,
    "objects",
  );
  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    partyId: row.party_id,
    partyName: row.party_name,
    toEmail: row.to_email,
    balance: row.balance,
    overdue: row.overdue,
    currency: row.currency_code,
    status: row.status,
    error: row.error,
    deliveryKey: row.delivery_key,
    emailLogId: row.email_log_id,
    sentAt: row.sent_at,
  }));
}

export async function listStatementBatchRuns(
  orgId: string,
  opts: { limit?: number; offset?: number; allowedSubsidiaryIds?: ReadonlySet<string> | null } = {},
): Promise<(StatementBatchRunRow & { sent: number; failed: number; skipped: number })[]> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await db.execute<{
    id: string;
    period_from: string | null;
    period_to: string;
    filters: Record<string, unknown>;
    recipient_count: number;
    status: StatementBatchRunStatus;
    authorization_snapshot: StatementBatchRunRow["authorizationSnapshot"];
    created_at: Date;
    created_by: string | null;
    sent: string;
    failed: string;
    skipped: string;
  }>(
    sql`
    select r.id::text as id, r.period_from::text as period_from, r.period_to::text as period_to,
           r.filters, r.recipient_count, r.status, r.authorization_snapshot, r.created_at, r.created_by::text as created_by,
           count(*) filter (where i.status = 'sent') as sent,
           count(*) filter (where i.status = 'failed') as failed,
           count(*) filter (where i.status = 'skipped') as skipped
      from statement_batch_runs r
      left join statement_batch_items i on i.run_id = r.id and i.org_id = r.org_id
     where r.org_id = ${orgId}
       and ${statementBatchScopeFilter("r", opts.allowedSubsidiaryIds)}
     group by r.id
     order by r.created_at desc
     limit ${limit} offset ${offset}`,
    "objects",
  );
  return rows.map((row) => ({
    id: row.id,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    filters: row.filters ?? {},
    recipientCount: row.recipient_count,
    status: row.status,
    authorizationSnapshot: row.authorization_snapshot ?? {},
    createdAt: row.created_at,
    createdBy: row.created_by,
    sent: Number(row.sent),
    failed: Number(row.failed),
    skipped: Number(row.skipped),
  }));
}

/**
 * Claim one item for delivery: a guarded transition out of
 * queued/sending/failed, so a retried job re-enters sending while a sent
 * or skipped item never transmits again.
 */
export async function claimStatementBatchItem(
  orgId: string,
  runId: string,
  partyId: string,
): Promise<
  | { state: "claimed"; item: StatementBatchItemRow }
  | { state: "already-sent" }
  | { state: "skipped" }
  | null
> {
  const updated = await db.execute<{ id: string }>(
    sql`
    update statement_batch_items
       set status = 'sending', error = null, updated_at = now()
     where org_id = ${orgId} and run_id = ${runId} and party_id = ${partyId}
       and status in ('queued', 'sending', 'failed')
    returning id::text as id`,
    "objects",
  );
  if (updated[0]) {
    const items = await listStatementBatchItems(orgId, runId);
    const item = items.find((candidate) => candidate.partyId === partyId);
    if (!item) throw new Error("statement batch item vanished between claim and read");
    return { state: "claimed", item };
  }
  const current = (
    await db.execute<{ status: string }>(
      sql`
    select status from statement_batch_items
     where org_id = ${orgId} and run_id = ${runId} and party_id = ${partyId} limit 1`,
      "objects",
    )
  )[0];
  if (!current) return null;
  if (current.status === "sent") return { state: "already-sent" };
  if (current.status === "skipped") return { state: "skipped" };
  return null;
}

/** Delivery succeeded: sending (or an already-reconciled sent) becomes sent with its evidence. */
export async function settleStatementBatchItemSent(
  orgId: string,
  itemId: string,
  emailLogId: string,
  deliveryKey: string,
): Promise<void> {
  const updated = await db.execute<{ id: string }>(
    sql`
    update statement_batch_items
       set status = 'sent', error = null, email_log_id = ${emailLogId},
           delivery_key = ${deliveryKey}, sent_at = coalesce(sent_at, now()), updated_at = now()
     where id = ${itemId} and org_id = ${orgId} and status in ('sending', 'sent')
    returning id::text as id`,
    "objects",
  );
  if (!updated[0]) refuseZeroRowWrite(`statement batch item ${itemId} was not marked sent`);
  await maybeFinishStatementBatchRun(orgId, (await itemRunId(orgId, itemId))!);
}

/** Delivery failed: the error stays on the run for Retry; a sent item is never overwritten. */
export async function settleStatementBatchItemFailed(
  orgId: string,
  itemId: string,
  error: string,
): Promise<void> {
  const updated = await db.execute<{ id: string }>(
    sql`
    update statement_batch_items
       set status = 'failed', error = ${error.slice(0, 500)}, updated_at = now()
     where id = ${itemId} and org_id = ${orgId} and status in ('sending', 'failed')
    returning id::text as id`,
    "objects",
  );
  if (!updated[0]) refuseZeroRowWrite(`statement batch item ${itemId} was not marked failed`);
  await maybeFinishStatementBatchRun(orgId, (await itemRunId(orgId, itemId))!);
}

async function itemRunId(orgId: string, itemId: string): Promise<string | null> {
  const rows = await db.execute<{ run_id: string }>(
    sql`
    select run_id::text as run_id from statement_batch_items where id = ${itemId} and org_id = ${orgId} limit 1`,
    "objects",
  );
  return rows[0]?.run_id ?? null;
}

/** A run is done when no item is still queued or sending; failed items stay retryable. */
async function maybeFinishStatementBatchRun(orgId: string, runId: string): Promise<void> {
  await db.execute(sql`
    update statement_batch_runs set status = 'done', updated_at = now()
     where id = ${runId} and org_id = ${orgId} and status <> 'done'
       and not exists (
         select 1 from statement_batch_items
          where run_id = ${runId} and org_id = ${orgId} and status in ('queued', 'sending'))`);
}

/** Re-arm failed (and never-attempted queued) items and re-enqueue their jobs; BullMQ dedupes the live ones. */
export async function retryStatementBatchRun(
  orgId: string,
  runId: string,
  senderId: string,
  enqueue: StatementBatchEnqueuer,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<{ requeued: number }> {
  const run = await getStatementBatchRun(orgId, runId, allowedSubsidiaryIds);
  if (!run) throw new Error("statement batch run was not found");
  const rearmed = await db.execute<{ party_id: string }>(
    sql`
    update statement_batch_items
       set status = 'queued', error = null, updated_at = now()
     where org_id = ${orgId} and run_id = ${runId} and status in ('failed', 'queued') and to_email is not null
       and exists (
         select 1 from statement_batch_runs r
          where r.org_id = ${orgId} and r.id = ${runId}
            and ${statementBatchScopeFilter("r", allowedSubsidiaryIds)}
       )
    returning party_id::text as party_id`,
    "objects",
  );
  if (rearmed.length === 0) return { requeued: 0 };
  await db.execute(sql`
    update statement_batch_runs set status = 'sending', updated_at = now()
     where id = ${runId} and org_id = ${orgId}`);
  await enqueue(rearmed.map((row) => ({ orgId, runId, partyId: row.party_id, senderId })));
  return { requeued: rearmed.length };
}
