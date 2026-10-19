import { canonicalPeriodLabelSql, CloseError, type CloseModule } from "../periods/period-policy.ts";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { periodScopeAdvisoryLock } from "../periods/period-locks.ts";

export interface CloseReopenRequestRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  period_id: string;
  book_id: string;
  subsidiary_id: string | null;
  requested_by: string;
  approved_by: string | null;
  approved_at: Date | string | null;
  expires_at: Date | string | null;
  modules: CloseModule[];
  reason: string;
  impact_snapshot?: { amendment?: ReopenAmendment };
}

/** The requested change retains the original window and approval horizon. */
export interface ReopenAmendment {
  requestId: string;
  sourceExpiresAt: string;
  expiresAt: string;
  additionalHours: number;
  approvedAt: string;
}

/** Resolve the controlled reopen policy for both requests and decisions. */
export async function controlledReopenHours(tx: SqlExecutor, orgId: string): Promise<{ defaultHours: number; maxHours: number }> {
  const row = (await tx.execute<{ rules: { defaultHours?: number; maxHours?: number } }>(sql`
    select rules from close_policies where org_id = ${orgId} and code = 'controlled-reopen' and is_active limit 1`)).rows[0];
  const defaultHours = Number(row?.rules?.defaultHours ?? 24);
  const maxHours = Number(row?.rules?.maxHours ?? 168);
  if (!Number.isInteger(defaultHours) || !Number.isInteger(maxHours) || defaultHours < 1 || maxHours < 1 || defaultHours > maxHours) {
    throw new CloseError("the controlled reopen policy requires positive whole default and maximum hours, with the default no greater than the maximum; correct the policy in Setup");
  }
  return { defaultHours, maxHours };
}

/** Every lifecycle transition takes the period fence before request row locks. */
export async function lockReopenRequestScope(tx: SqlExecutor, orgId: string, requestId: string): Promise<void> {
  const row = (await tx.execute<{ period_id: string; book_id: string }>(sql`
    select period_id, book_id from close_reopen_requests where id = ${requestId} and org_id = ${orgId}`)).rows[0];
  if (!row) throw new CloseError("reopen request not found");
  await periodScopeAdvisoryLock(tx, orgId, row.period_id, row.book_id);
}

/** One conflict class between a reopen approver and the records the window would unlock. */
export interface ReopenApprovalConflict {
  kind: "authored_documents" | "manual_entries" | "party_records" | "equity_lines";
  count: number;
  /** Document/entry numbers or account names — operator-meaningful, never raw ids. */
  examples: string[];
}

/**
 * Conflict-of-interest scan for a reopen approver. A reopen exists to change
 * the period's records, so an approver who authored, posted, or is the party
 * on those records would approve their own change in substance — even though
 * they did not request it. The scan names counts with examples; the approval
 * path refuses on any hit (independent approval is unconditional for
 * reopens) and the drawer surfaces the same scan as a notice before deciding.
 */
export async function reopenApprovalConflicts(
  executor: SqlExecutor,
  orgId: string,
  request: { period_id: string; book_id: string; subsidiary_id: string | null },
  actorId: string,
): Promise<ReopenApprovalConflict[]> {
  const party = (await executor.execute<{ party_id: string | null }>(sql`
    select party_id from users where id = ${actorId} and org_id = ${orgId}`)).rows[0]?.party_id ?? null;
  const subsidiaryScope = request.subsidiary_id == null
    ? sql`true`
    : sql`(d.subsidiary_id is null or d.subsidiary_id = ${request.subsidiary_id}::uuid)`;
  const entryScope = request.subsidiary_id == null
    ? sql`true`
    : sql`e.subsidiary_id = ${request.subsidiary_id}::uuid`;
  const conflicts: ReopenApprovalConflict[] = [];
  const authored = (await executor.execute<{ n: string; examples: string[] }>(sql`
    with hits as (
      select d.document_number
        from documents d
       where d.org_id = ${orgId} and d.posting_period_id = ${request.period_id}
         -- Live entries only: voided documents carry no activity a reopen could unlock
         and d.status in ('draft', 'pending_approval', 'approved', 'posted')
         and ${subsidiaryScope}
         and (d.created_by = ${actorId} or d.submitted_by = ${actorId}
           or d.void_requested_by = ${actorId} or d.voided_by = ${actorId})
       order by d.document_number
    )
    select (select count(*)::text from hits) as n,
           coalesce((select array_agg(document_number) from (select document_number from hits limit 3) s), '{}') as examples`));
  if (Number(authored.rows[0]?.n ?? 0) > 0) {
    conflicts.push({ kind: "authored_documents", count: Number(authored.rows[0]!.n), examples: authored.rows[0]!.examples });
  }
  // Manual entries the approver booked themselves. System postings (close,
  // revaluation, allocations) carry the duty actor, not a personal stake, so
  // origin narrows the scan to hand-booked entries — a closer approving a
  // reopen after performing the close must not trip on their duty postings.
  const posted = (await executor.execute<{ n: string; examples: string[] }>(sql`
    with hits as (
      select e.entry_number
        from journal_entries e
       where e.org_id = ${orgId} and e.period_id = ${request.period_id} and e.book_id = ${request.book_id}
         and e.status in ('posted', 'reversed') and e.origin = 'manual' and ${entryScope}
         and (e.created_by = ${actorId} or e.posted_by = ${actorId})
       order by e.entry_number
    )
    select (select count(*)::text from hits) as n,
           coalesce((select array_agg(entry_number) from (select entry_number from hits limit 3) s), '{}') as examples`));
  if (Number(posted.rows[0]?.n ?? 0) > 0) {
    conflicts.push({ kind: "manual_entries", count: Number(posted.rows[0]!.n), examples: posted.rows[0]!.examples });
  }
  if (party) {
    const partyHits = (await executor.execute<{ n: string; examples: string[] }>(sql`
      with hits as (
        select d.document_number as ref from documents d
         where d.org_id = ${orgId} and d.posting_period_id = ${request.period_id}
           -- Live entries only: voided documents carry no activity a reopen could unlock
           and d.status in ('draft', 'pending_approval', 'approved', 'posted')
           and ${subsidiaryScope} and d.party_id = ${party}
        union
        select e.entry_number as ref from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
         where l.org_id = ${orgId} and e.period_id = ${request.period_id} and e.book_id = ${request.book_id}
           and e.status in ('posted', 'reversed') and ${entryScope} and l.party_id = ${party}
      )
      select (select count(*)::text from hits) as n,
             coalesce((select array_agg(ref) from (select ref from hits order by ref limit 3) s), '{}') as examples`));
    if (Number(partyHits.rows[0]?.n ?? 0) > 0) {
      conflicts.push({ kind: "party_records", count: Number(partyHits.rows[0]!.n), examples: partyHits.rows[0]!.examples });
    }
    const equity = (await executor.execute<{ n: string; examples: string[] }>(sql`
      with hits as (
        select distinct a.name as ref from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
          join accounts a on a.id = l.account_id and a.org_id = l.org_id
         where l.org_id = ${orgId} and e.period_id = ${request.period_id} and e.book_id = ${request.book_id}
           and e.status in ('posted', 'reversed') and ${entryScope}
           and l.party_id = ${party} and a.type = 'equity'
      )
      select (select count(*)::text from hits) as n,
             coalesce((select array_agg(ref) from (select ref from hits order by ref limit 3) s), '{}') as examples`));
    if (Number(equity.rows[0]?.n ?? 0) > 0) {
      conflicts.push({ kind: "equity_lines", count: Number(equity.rows[0]!.n), examples: equity.rows[0]!.examples });
    }
  }
  return conflicts;
}

export async function loadRequestedReopen(
  executor: SqlExecutor,
  orgId: string,
  requestId: string,
): Promise<{ period_id: string; book_id: string; subsidiary_id: string | null } | null> {
  return (await executor.execute<{ period_id: string; book_id: string; subsidiary_id: string | null }>(sql`
    select period_id, book_id, subsidiary_id from close_reopen_requests
     where id = ${requestId} and org_id = ${orgId} and status = 'requested'`)).rows[0] ?? null;
}

/** Conflict scan for one pending request and viewer — the read path behind the approval notice. */
export async function reopenRequestConflicts(
  orgId: string,
  requestId: string,
  actorId: string,
): Promise<ReopenApprovalConflict[]> {
  const scoped = await loadRequestedReopen(db, orgId, requestId);
  if (!scoped) throw new CloseError("pending reopen request not found");
  return reopenApprovalConflicts(db, orgId, scoped, actorId);
}

/**
 * Why a reopen decision still demands an independent approver. A
 * one-person company must be able to correct a mistaken close, so the
 * conflict-of-interest and self-approval controls engage only while
 * independent approval is actually available — another eligible approver
 * who could decide instead, or a configured Flow that requires it.
 */
export interface ReopenIndependence {
  required: boolean;
  reason: "another-approver" | "flow" | null;
  /** Names of the other users who may decide the request, in name order. */
  approvers: string[];
  /** The same users' ids, aligned with `approvers`. */
  approverIds: string[];
}

/**
 * Whether this request's decision requires an independent approver. An
 * eligible approver is an active user other than the requester holding the
 * reopen permission with a scope covering the request (unrestricted for an
 * org-wide request, unrestricted or the request's entity otherwise — the
 * same standing the approval surfaces require). Failing that, a configured
 * approval Flow with an independent-approval gate (preventSelfApproval not
 * explicitly opted out) still requires independence. Run on the decision
 * transaction's executor so the answer is current as of the decision.
 */
export async function reopenIndependenceRequired(
  executor: SqlExecutor,
  orgId: string,
  request: { requestedBy: string; subsidiaryId: string | null },
): Promise<ReopenIndependence> {
  const candidates = (await executor.execute<{ id: string; name: string | null; email: string }>(sql`
    select id, name, email from users
     where org_id = ${orgId} and is_active and id <> ${request.requestedBy}
     order by coalesce(name, email), id`));
  const approvers: string[] = [];
  const approverIds: string[] = [];
  for (const candidate of candidates.rows) {
    if (!(await actorHasPermission(executor, orgId, candidate.id, "close.reopen"))) continue;
    const scope = await actorAllowedSubsidiaryIds(executor, orgId, candidate.id);
    if (request.subsidiaryId == null) {
      if (scope !== null) continue;
    } else if (scope !== null && !scope.has(request.subsidiaryId)) {
      continue;
    }
    approvers.push(candidate.name?.trim() || candidate.email);
    approverIds.push(candidate.id);
  }
  if (approvers.length > 0) return { required: true, reason: "another-approver", approvers, approverIds };
  // Flows own approvals outright: an enabled Flow with an approval gate
  // that has not opted out of preventSelfApproval requires an independent
  // decider, even in a one-approver organization.
  const governed = (await executor.execute<{ one: number }>(sql`
    select 1 as one from flows
     where org_id = ${orgId} and enabled
       and jsonb_typeof(graph->'nodes') = 'array'
       and exists (
         select 1 from jsonb_array_elements(graph->'nodes') node
          where node->'data'->>'kind' = 'gate'
            and coalesce((node->'data'->'gate'->>'preventSelfApproval')::boolean, true)
       )
     limit 1`));
  if (governed.rows.length > 0) return { required: true, reason: "flow", approvers, approverIds };
  return { required: false, reason: null, approvers, approverIds };
}

/**
 * The eligible approvers other than `actorId` who hold no conflict on the
 * records the reopen would unlock. When none remain, a conflicted approver
 * may still decide with a recorded conflict acknowledgement: a small company
 * whose every approver is a payee must not be left with no governed path.
 */
export async function unconflictedReopenApprovers(
  executor: SqlExecutor,
  orgId: string,
  request: { period_id: string; book_id: string; subsidiary_id: string | null },
  independence: ReopenIndependence,
  actorId: string,
): Promise<string[]> {
  const free: string[] = [];
  for (const [index, id] of independence.approverIds.entries()) {
    if (id === actorId) continue;
    if ((await reopenApprovalConflicts(executor, orgId, request, id)).length === 0) {
      free.push(independence.approvers[index]!);
    }
  }
  return free;
}

/** One pending request's decision posture for the approval surfaces: the
 * conflict scan plus whether the engine will demand an independent
 * approver or accept a self-approval attestation. Read-only — the decision
 * transaction re-resolves eligibility authoritatively. */
export async function reopenDecisionPreview(
  orgId: string,
  requestId: string,
  actorId: string,
): Promise<{
  ownRequest: boolean;
  conflicts: ReopenApprovalConflict[];
  independenceRequired: boolean;
  independenceReason: "another-approver" | "flow" | null;
  selfApprovalAllowed: boolean;
  /** Who else may decide it — named so a requester knows whom to ask. */
  eligibleApprovers: string[];
  /** Eligible approvers other than the viewer with no conflict on the records. */
  unconflictedApprovers: string[];
  /** The viewer is conflicted and no unconflicted approver exists, so the
   * engine accepts approval with a recorded conflict acknowledgement. */
  conflictAcknowledgementAllowed: boolean;
}> {
  const row = (await db.execute<{ requested_by: string; subsidiary_id: string | null; period_id: string; book_id: string }>(sql`
    select requested_by, subsidiary_id, period_id, book_id from close_reopen_requests
     where id = ${requestId} and org_id = ${orgId} and status = 'requested'`)).rows[0];
  if (!row) throw new CloseError("pending reopen request not found");
  const conflicts = await reopenApprovalConflicts(
    db, orgId, { period_id: row.period_id, book_id: row.book_id, subsidiary_id: row.subsidiary_id }, actorId);
  const independence = await reopenIndependenceRequired(
    db, orgId, { requestedBy: row.requested_by, subsidiaryId: row.subsidiary_id });
  const ownRequest = row.requested_by === actorId;
  const scope = { period_id: row.period_id, book_id: row.book_id, subsidiary_id: row.subsidiary_id };
  const unconflicted = await unconflictedReopenApprovers(db, orgId, scope, independence, actorId);
  return {
    ownRequest,
    conflicts,
    independenceRequired: independence.required,
    independenceReason: independence.reason,
    selfApprovalAllowed: !independence.required,
    eligibleApprovers: independence.approvers,
    unconflictedApprovers: unconflicted,
    conflictAcknowledgementAllowed: !ownRequest && conflicts.length > 0 && independence.required && unconflicted.length === 0,
  };
}

/** The governing lock for one module at a request's scope: exact row, else org-wide. */
export async function governingLockState(
  tx: SqlExecutor,
  args: { orgId: string; periodId: string; bookId: string; subsidiaryId: string | null; module: CloseModule },
): Promise<string | null> {
  const governing = (await tx.execute<{ state: string }>(sql`
    select state from period_locks
     where org_id = ${args.orgId} and period_id = ${args.periodId}
       and book_id = ${args.bookId} and module = ${args.module}
       and (subsidiary_id is not distinct from ${args.subsidiaryId}::uuid or subsidiary_id is null)
     order by (subsidiary_id is not null) desc limit 1`));
  return governing.rows[0]?.state ?? null;
}

/**
 * End approved reopen windows whose every module is already re-closed.
 * A Setup lock (or any close outside the re-close workflow) clears the
 * window on the lock row but leaves the request approved and unexpired, so
 * without this the overlap guard blocks new requests until expiry. Each
 * consumed request is marked reclosed with a close event naming what ended
 * it; requests still guarding open modules are left active.
 */
export async function endFullyClosedReopenRequests(
  tx: SqlExecutor,
  args: {
    orgId: string;
    periodId: string;
    bookId: string;
    subsidiaryId: string | null;
    actorId: string;
    reason: string;
    candidateIds?: string[];
  },
): Promise<string[]> {
  const candidates = (await tx.execute<{ id: string; modules: CloseModule[]; subsidiary_id: string | null }>(sql`
    select id, modules, subsidiary_id
      from close_reopen_requests
     where org_id = ${args.orgId}
       and period_id = ${args.periodId}
       and book_id = ${args.bookId}
       and (subsidiary_id is null or ${args.subsidiaryId}::uuid is null
         or subsidiary_id = ${args.subsidiaryId}::uuid)
       and status = 'approved'
       and expires_at > now()
       ${args.candidateIds?.length ? sql`and id = any(${`{${args.candidateIds.join(",")}}`}::uuid[])` : sql``}
     for update`));
  const consumed: string[] = [];
  for (const candidate of candidates.rows) {
    const states = [];
    for (const module of candidate.modules) {
      states.push(await governingLockState(tx, {
        orgId: args.orgId,
        periodId: args.periodId,
        bookId: args.bookId,
        subsidiaryId: candidate.subsidiary_id,
        module,
      }));
    }
    if (states.length === 0 || states.some((state) => state !== "closed" && state !== "soft_closed")) {
      continue;
    }
    const updated = await tx.execute(sql`
      update close_reopen_requests
         set status = 'reclosed', reclosed_at = now(), updated_at = now(), updated_by = ${args.actorId}
       where id = ${candidate.id} and org_id = ${args.orgId} and status = 'approved'
      returning id`);
    if (updated.rows.length !== 1) throw new CloseError("approved reopen request changed during re-close");
    await tx.execute(sql`
      insert into close_events (org_id, event_type, actor_id, payload)
      values (${args.orgId}, 'period.reopen_consumed_by_reclose', ${args.actorId},
              ${JSON.stringify({
                requestId: candidate.id,
                periodId: args.periodId,
                bookId: args.bookId,
                subsidiaryId: candidate.subsidiary_id,
                modules: candidate.modules,
                reason: args.reason,
              })}::jsonb)`);
    consumed.push(candidate.id);
  }
  return consumed;
}

/**
 * Name a blocking reopen request in operator terms — period, modules,
 * approver and window — never a bare request id.
 */
export async function describeActiveReopenOverlap(
  tx: SqlExecutor,
  orgId: string,
  requestId: string,
): Promise<string> {
  const row = (await tx.execute<{
    modules: CloseModule[];
    approved_at: string | null;
    expires_at: string | null;
    period_label: string | null;
    approver_name: string | null;
  }>(sql`
    select r.modules, r.approved_at::text as approved_at, r.expires_at::text as expires_at,
           ${canonicalPeriodLabelSql()} as period_label, u.name as approver_name
      from close_reopen_requests r
      left join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
      left join users u on u.id = r.approved_by and u.org_id = r.org_id
     where r.id = ${requestId} and r.org_id = ${orgId}
  `)).rows[0];
  const stamp = (value: string | null) =>
    value == null ? "(time unknown)" : value.slice(0, 16).replace("T", " ");
  const what = row
    ? `${row.period_label ?? "the period"} ${row.modules.map((module) => module.toUpperCase()).join(", ")} reopen`
    : "another reopen";
  const by = row?.approver_name ? ` by ${row.approver_name}` : "";
  return (
    `reopen request overlaps an active reopen: ${what} approved ${stamp(row?.approved_at ?? null)}${by}, ` +
    `active until ${stamp(row?.expires_at ?? null)}; ` +
    `extend that request or widen its modules instead of opening an overlapping one`
  );
}

/**
 * Consume reopen windows ended by re-closing modules outside the re-close
 * workflow (Setup locks, period closes). Call after the locks commit: every
 * approved, unexpired request on the scope whose modules are all re-closed
 * is marked reclosed, audited, and stops counting for overlap. Requests
 * still guarding open modules stay active.
 */
export async function consumeReopenRequestsForClosedModules(args: {
  orgId: string;
  periodId: string;
  bookId: string;
  subsidiaryId?: string;
  actorId: string;
  reason: string;
}): Promise<{ consumed: string[] }> {
  let consumed: string[] = [];
  await db.transaction(async (tx) => {
    await periodScopeAdvisoryLock(tx, args.orgId, args.periodId, args.bookId);
    consumed = await endFullyClosedReopenRequests(tx, {
      orgId: args.orgId,
      periodId: args.periodId,
      bookId: args.bookId,
      subsidiaryId: args.subsidiaryId ?? null,
      actorId: args.actorId,
      reason: args.reason,
    });
  });
  return { consumed };
}

export function describeReopenConflicts(conflicts: ReopenApprovalConflict[]): string {
  return conflicts.map((conflict) => {
    const more = conflict.count - conflict.examples.length;
    const listed = more > 0 ? `${conflict.examples.join(", ")} and ${more} more` : conflict.examples.join(", ");
    return `${conflict.count} ${conflict.kind.replace(/_/g, " ")} (${listed})`;
  }).join("; ");
}
