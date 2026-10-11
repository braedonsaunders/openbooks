import { CloseError, CLOSE_MODULES, periodLockRequiresApprovedReopen, type CloseModule } from "../periods/period-policy.ts";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext, type SqlExecutor } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { assertCloseScope, upsertLock, periodScopeAdvisoryLock, tightenNarrowerLocks } from "../periods/period-locks.ts";
/** One row of close_reopen_requests as read by the approve/re-close paths. */
interface CloseReopenRequestRow extends Record<string, unknown> {
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
}

export async function requestPeriodReopen(args: {
  orgId: string;
  periodId: string;
  bookId: string;
  subsidiaryId?: string;
  modules: CloseModule[];
  reason: string;
  actorId: string;
}): Promise<string> {
  if (!args.reason.trim())
    throw new CloseError("a reopening reason is required");
  if (
    args.modules.length === 0 ||
    args.modules.some((module) => !CLOSE_MODULES.includes(module))
  ) {
    throw new CloseError("at least one valid module is required");
  }
  await assertCloseScope(db, {
    ...args,
    subsidiaryIds: args.subsidiaryId ? [args.subsidiaryId] : [],
  });
  // Scope dependencies fail at request time, not at the approver's desk: a
  // subledger-only request over a closed GL can never be approved (the
  // approval-time check below stays as the backstop against a GL that closes
  // between request and decision), so accepting it would strand the approver
  // with Reject as the only path forward. The refusal names the remedy —
  // include General ledger in the reopen scope — instead of the lock state.
  if (args.modules.some((module) => module !== "gl") && !args.modules.includes("gl")) {
    const gl = (await db.execute<{ state: string; reopen_expires_at: Date | null }>(sql`
      select state, reopen_expires_at from period_locks
       where org_id = ${args.orgId} and period_id = ${args.periodId}
         and book_id = ${args.bookId}
         and (subsidiary_id = ${args.subsidiaryId ?? null}::uuid or subsidiary_id is null)
         and module = 'gl'
       order by (subsidiary_id is not null) desc limit 1`));
    const governing = gl.rows[0];
    if (periodLockRequiresApprovedReopen(governing && {
      state: governing.state, reopenExpiresAt: governing.reopen_expires_at, reason: null,
    })) {
      throw new CloseError(
        `cannot reopen ${args.modules.map((module) => module.toUpperCase()).join(", ")} while General ledger is closed for this period and book; include General ledger in the reopen scope`,
      );
    }
  }
  const impact = (await db.execute<Record<string, unknown>>(sql`
    select
      (select count(*) from journal_entries where org_id = ${args.orgId} and period_id = ${args.periodId} and book_id = ${args.bookId}) as entries,
      (select count(*) from close_signoffs s join close_runs r on r.id = s.run_id and r.org_id = s.org_id
        where r.org_id = ${args.orgId} and r.period_id = ${args.periodId} and r.book_id = ${args.bookId}) as signoffs,
      (select count(*) from close_task_evidence e join close_runs r on r.id = e.run_id and r.org_id = e.org_id
        where r.org_id = ${args.orgId} and r.period_id = ${args.periodId} and r.book_id = ${args.bookId}) as evidence`));
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into close_reopen_requests
      (org_id, period_id, book_id, subsidiary_id, modules, reason, impact_snapshot,
       requested_by, created_by, updated_by)
    values (${args.orgId}, ${args.periodId}, ${args.bookId}, ${args.subsidiaryId ?? null},
            ${JSON.stringify(args.modules)}::jsonb, ${args.reason.trim()},
            ${JSON.stringify({ ...impact.rows[0], reports: ["balance-sheet", "pnl", "cash-flow", "trial-balance"] })}::jsonb,
            ${args.actorId}, ${args.actorId}, ${args.actorId})
    returning id`));
  return inserted.rows[0]!.id;
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

async function loadRequestedReopen(
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
  for (const candidate of candidates.rows) {
    if (!(await actorHasPermission(executor, orgId, candidate.id, "close.reopen"))) continue;
    const scope = await actorAllowedSubsidiaryIds(executor, orgId, candidate.id);
    if (request.subsidiaryId == null) {
      if (scope !== null) continue;
    } else if (scope !== null && !scope.has(request.subsidiaryId)) {
      continue;
    }
    approvers.push(candidate.name?.trim() || candidate.email);
  }
  if (approvers.length > 0) return { required: true, reason: "another-approver", approvers };
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
  if (governed.rows.length > 0) return { required: true, reason: "flow", approvers };
  return { required: false, reason: null, approvers };
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
}> {
  const row = (await db.execute<{ requested_by: string; subsidiary_id: string | null; period_id: string; book_id: string }>(sql`
    select requested_by, subsidiary_id, period_id, book_id from close_reopen_requests
     where id = ${requestId} and org_id = ${orgId} and status = 'requested'`)).rows[0];
  if (!row) throw new CloseError("pending reopen request not found");
  const conflicts = await reopenApprovalConflicts(
    db, orgId, { period_id: row.period_id, book_id: row.book_id, subsidiary_id: row.subsidiary_id }, actorId);
  const independence = await reopenIndependenceRequired(
    db, orgId, { requestedBy: row.requested_by, subsidiaryId: row.subsidiary_id });
  return {
    ownRequest: row.requested_by === actorId,
    conflicts,
    independenceRequired: independence.required,
    independenceReason: independence.reason,
    selfApprovalAllowed: !independence.required,
    eligibleApprovers: independence.approvers,
  };
}

/** The governing lock for one module at a request's scope: exact row, else org-wide. */
async function governingLockState(
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
async function endFullyClosedReopenRequests(
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
    await tx.execute(sql`
      update close_reopen_requests
         set status = 'reclosed', reclosed_at = now(), updated_at = now(), updated_by = ${args.actorId}
       where id = ${candidate.id} and org_id = ${args.orgId} and status = 'approved'`);
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
async function describeActiveReopenOverlap(
  tx: SqlExecutor,
  orgId: string,
  requestId: string,
): Promise<string> {
  const row = (await tx.execute<{
    modules: CloseModule[];
    approved_at: string | null;
    expires_at: string | null;
    period_name: string | null;
    approver_name: string | null;
  }>(sql`
    select r.modules, r.approved_at::text as approved_at, r.expires_at::text as expires_at,
           p.name as period_name, u.name as approver_name
      from close_reopen_requests r
      left join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
      left join users u on u.id = r.approved_by and u.org_id = r.org_id
     where r.id = ${requestId} and r.org_id = ${orgId}
  `)).rows[0];
  const stamp = (value: string | null) =>
    value == null ? "(time unknown)" : value.slice(0, 16).replace("T", " ");
  const what = row
    ? `${row.period_name ?? "the period"} ${row.modules.map((module) => module.toUpperCase()).join(", ")} reopen`
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
  return conflicts.map((conflict) => `${conflict.count} ${conflict.kind.replace(/_/g, " ")} (${conflict.examples.join(", ")})`).join("; ");
}

export async function decidePeriodReopen(args: {
  orgId: string;
  requestId: string;
  actorId: string;
  approve: boolean;
  hours?: number;
  /**
   * Self-approval attestation, required when the decider is the requester
   * and no independent approver is available. A 10-500 character reason
   * recording why no other approver could decide it; retained in the
   * decision audit. Refused (unused) whenever independent approval applies.
   */
  attestation?: string;
}): Promise<void> {
  // The conflict scan needs no locks — it names the approver's standing
  // relationship to the period's records — but whether it refuses is
  // decided inside the decision transaction (eligibility can change between
  // request and decision). A refused decision rolls its transaction back,
  // which would take the refusal's audit with it, so a conflict refusal
  // records its marker in-transaction and the audit commits on the way out.
  let scopedForConflicts: { period_id: string; book_id: string; subsidiary_id: string | null } | null = null;
  let conflicts: ReopenApprovalConflict[] = [];
  if (args.approve) {
    scopedForConflicts = await loadRequestedReopen(db, args.orgId, args.requestId);
    if (scopedForConflicts) {
      conflicts = await reopenApprovalConflicts(db, args.orgId, scopedForConflicts, args.actorId);
    }
  }
  // The decision audit commits after the decision transaction: a refused
  // decision rolls its transaction back, which would take the audit of a
  // real decision with it — and a decision that never commits must never
  // leave an audit row claiming it did.
  let decided: {
    status: "approved" | "rejected";
    periodId: string;
    bookId: string;
    subsidiaryId: string | null;
    modules: CloseModule[];
    reason: string;
    requestedBy: string;
    selfApproved: boolean;
    attestation: string | null;
    conflicts: ReopenApprovalConflict[];
  } | null = null;
  let conflictRefusal: ReopenApprovalConflict[] | null = null;
  const decide = async () => db.transaction(async (tx) => {
    const request = (await tx.execute<CloseReopenRequestRow>(sql`
      select * from close_reopen_requests
       where id = ${args.requestId} and org_id = ${args.orgId} and status = 'requested'
       for update`));
    const row = request.rows[0];
    if (!row) throw new CloseError("pending reopen request not found");
    const selfApproval = row.requested_by === args.actorId;
    // Eligibility resolves here, inside the decision transaction: another
    // approver may have joined (or the last one left) since the request.
    const independence = args.approve || selfApproval
      ? await reopenIndependenceRequired(tx, args.orgId, {
        requestedBy: row.requested_by, subsidiaryId: row.subsidiary_id,
      })
      : { required: false, reason: null as "another-approver" | "flow" | null, approvers: [] as string[] };
    if (selfApproval && args.approve && independence.required) {
      throw new CloseError(
        independence.approvers.length > 0
          ? `a reopen request requires independent approval: ${independence.approvers.join(", ")} `
            + `can decide it from My approvals or Accounting → Reopen requests`
          : "a reopen request requires independent approval: an approval Flow requires a decider other than the requester; "
            + "an administrator can grant another user the Close reopen permission",
      );
    }
    let attestation: string | null = null;
    if (selfApproval && args.approve) {
      // The requester is the only eligible approver: self-approval is
      // allowed with an explicit attestation, recorded as its own audit
      // entry with the conflict detail retained.
      attestation = (args.attestation ?? "").trim();
      if (attestation.length < 10 || attestation.length > 500) {
        throw new CloseError(
          "self-approving a reopen requires a 10-500 character attestation recording why no other approver could decide it",
        );
      }
    }
    if (args.approve && !selfApproval && conflicts.length > 0 && independence.required) {
      // Mark the refusal for its audit on the way out: writing it here
      // would roll back with the refused decision.
      conflictRefusal = conflicts;
      throw new CloseError(
        `conflict of interest: you are recorded on the records this reopen would unlock (${describeReopenConflicts(conflicts)}); route it to another approver`,
      );
    }
    if (!args.approve) {
      await tx.execute(sql`
        update close_reopen_requests set status = 'rejected', approved_by = ${args.actorId},
               approved_at = now(), updated_at = now(), updated_by = ${args.actorId}
         where id = ${args.requestId} and org_id = ${args.orgId}`);
      decided = {
        status: "rejected",
        periodId: row.period_id,
        bookId: row.book_id,
        subsidiaryId: row.subsidiary_id,
        modules: row.modules,
        reason: row.reason,
        requestedBy: row.requested_by,
        selfApproved: false,
        attestation: null,
        conflicts: [],
      };
      return;
    }
    await periodScopeAdvisoryLock(tx, args.orgId, row.period_id, row.book_id);
    const policy = (await tx.execute<{ rules: { defaultHours?: number; maxHours?: number } }>(sql`select rules from close_policies
      where org_id = ${args.orgId} and code = 'controlled-reopen' and is_active limit 1`));
    const defaultHours = Number(policy.rows[0]?.rules?.defaultHours ?? 24);
    const maxHours = Math.max(
      1,
      Number(policy.rows[0]?.rules?.maxHours ?? 168),
    );
    const requestedHours = Number.isFinite(args.hours)
      ? Math.trunc(args.hours!)
      : defaultHours;
    const hours = Math.min(Math.max(requestedHours, 1), maxHours);
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    const modules = row.modules;
    if (modules.some((module) => !CLOSE_MODULES.includes(module)))
      throw new CloseError("reopen request contains an invalid module");
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(
          ${`close-reopen:${args.orgId}:${row.period_id}:${row.book_id}:${row.subsidiary_id ?? "all"}`},
          0
        )
      )
    `);
    const activeRequests = (await tx.execute<{ id: string; modules: CloseModule[] }>(sql`
      select id, modules
        from close_reopen_requests
       where org_id = ${args.orgId}
         and period_id = ${row.period_id}
         and book_id = ${row.book_id}
         and (subsidiary_id is null or ${row.subsidiary_id}::uuid is null
           or subsidiary_id = ${row.subsidiary_id}::uuid)
         and id <> ${args.requestId}
         and status = 'approved'
         and expires_at > now()
       for update`));
    // A request whose modules were all re-closed outside the re-close
    // workflow (a Setup lock, never consumed) no longer guards live work:
    // end it here, audited, so it cannot block this decision.
    const consumed = await endFullyClosedReopenRequests(tx, {
      orgId: args.orgId,
      periodId: row.period_id,
      bookId: row.book_id,
      subsidiaryId: row.subsidiary_id,
      actorId: args.actorId,
      reason: "superseded by a newer reopen decision",
      candidateIds: activeRequests.rows.map((request) => request.id),
    });
    const consumedIds = new Set(consumed);
    const live = activeRequests.rows.filter((request) => !consumedIds.has(request.id));
    const overlap = live.find((request) =>
      request.modules.some((module) => modules.includes(module)),
    );
    if (overlap) {
      throw new CloseError(await describeActiveReopenOverlap(tx, args.orgId, overlap.id));
    }
    if (modules.some((module) => module !== "gl") && !modules.includes("gl")) {
      const gl = (await tx.execute<{ state: string; reopen_expires_at: Date | null }>(sql`
        select state, reopen_expires_at from period_locks
         where org_id = ${args.orgId} and period_id = ${row.period_id}
           and book_id = ${row.book_id}
           and (subsidiary_id = ${row.subsidiary_id}::uuid or subsidiary_id is null)
           and module = 'gl'
         order by (subsidiary_id is not null) desc limit 1`));
      const governing = gl.rows[0];
      if (periodLockRequiresApprovedReopen(governing && {
        state: governing.state, reopenExpiresAt: governing.reopen_expires_at, reason: null,
      })) {
        throw new CloseError("GL must be included before a closed subledger can be reopened");
      }
    }
    // A window on a scope that is not hard-closed is a pure time bomb:
    // the lock row it writes (state 'open' plus an expiry) blocks posting
    // once stale, and the automatic re-close then flips the period to
    // 'closed'. Soft-close fences posting but unlocks from Setup; treating
    // it as reopenable would escalate a management lock into a statutory
    // close. Every requested module must currently require an approved
    // reopen — exact row, else the org-wide row — so a padded request is
    // refused and the operator narrows it to the hard-closed modules.
    const openModules: CloseModule[] = [];
    for (const module of modules) {
      const governing = (await tx.execute<{ state: string; reopen_expires_at: Date | null }>(sql`
        select state, reopen_expires_at from period_locks
         where org_id = ${args.orgId} and period_id = ${row.period_id}
           and book_id = ${row.book_id} and module = ${module}
           and (subsidiary_id is not distinct from ${row.subsidiary_id}::uuid or subsidiary_id is null)
         order by (subsidiary_id is not null) desc limit 1`));
      const lock = governing.rows[0];
      if (!periodLockRequiresApprovedReopen(lock && {
        state: lock.state,
        reopenExpiresAt: lock.reopen_expires_at,
        reason: null,
      })) {
        openModules.push(module);
      }
    }
    if (openModules.length > 0) {
      throw new CloseError(
        `cannot reopen ${openModules.join(", ")}: no closed lock in the requested scope — nothing to reopen; narrow the request to the closed modules`,
      );
    }
    for (const module of modules) {
      await upsertLock({
        tx,
        orgId: args.orgId,
        periodId: row.period_id,
        bookId: row.book_id,
        subsidiaryId: row.subsidiary_id ?? undefined,
        module,
        state: "open",
        actorId: args.actorId,
        reason: row.reason,
        reopenExpiresAt: expiresAt,
      });
    }
    if (row.subsidiary_id == null) {
      // A scope-wide reopen must dominate every narrower lock, the mirror of
      // the scope-wide close tightening in setPeriodLockState: storage
      // prefers the exact subsidiary row, so a closed child would silently
      // survive the window (and the operator would believe the scope open
      // while its entities stay fenced). Relax each currently-blocking child
      // into this same window, mirrored into the audit trail. Non-blocking
      // children (an active window owned by another request, an unexpired
      // manual opening) are left alone.
      for (const module of modules) {
        const children = (await tx.execute<{ subsidiary_id: string }>(sql`
          select subsidiary_id from period_locks
           where org_id = ${args.orgId} and period_id = ${row.period_id}
             and book_id = ${row.book_id} and module = ${module}
             and subsidiary_id is not null
             and (state = 'closed'
               or state = 'soft_closed'
               or (state = 'open' and reopen_expires_at is not null and reopen_expires_at <= now()))
           for update`));
        for (const child of children.rows) {
          await upsertLock({
            tx,
            orgId: args.orgId,
            periodId: row.period_id,
            bookId: row.book_id,
            subsidiaryId: child.subsidiary_id,
            module,
            state: "open",
            actorId: args.actorId,
            reason: row.reason,
            reopenExpiresAt: expiresAt,
          });
        }
      }
    }
    await tx.execute(sql`
      update close_reopen_requests set status = 'approved', approved_by = ${args.actorId},
             approved_at = now(), expires_at = ${expiresAt.toISOString()}, updated_at = now(), updated_by = ${args.actorId}
       where id = ${args.requestId} and org_id = ${args.orgId}`);
    await tx.execute(sql`
      update close_runs set status = 'in_progress', current_stage = 'review', approved_at = null,
             approved_by = null, closed_at = null, closed_by = null, published_at = null,
             published_by = null, updated_at = now(), updated_by = ${args.actorId}
       where org_id = ${args.orgId} and period_id = ${row.period_id} and book_id = ${row.book_id}`);
    await tx.execute(sql`
      update close_run_tasks t set status = 'invalidated', completed_at = null, completed_by = null,
             reviewed_at = null, reviewed_by = null, updated_at = now(), updated_by = ${args.actorId}
       from close_runs r where r.id = t.run_id and r.org_id = ${args.orgId}
         and r.period_id = ${row.period_id} and r.book_id = ${row.book_id}
         and t.status in ('complete','waived')`);
    decided = {
      status: "approved",
      periodId: row.period_id,
      bookId: row.book_id,
      subsidiaryId: row.subsidiary_id,
      modules: row.modules,
      reason: row.reason,
      requestedBy: row.requested_by,
      selfApproved: selfApproval,
      attestation,
      conflicts: selfApproval ? conflicts : [],
    };
  });
  try {
    await decide();
  } catch (error) {
    // The conflict refusal's audit commits here, outside the rolled-back
    // decision transaction — a refused decision must still leave evidence
    // of why it was refused.
    if (conflictRefusal && error instanceof CloseError) {
      await db.execute(sql`
        insert into close_events (org_id, event_type, actor_id, payload)
        values (${args.orgId}, 'period.reopen_conflict', ${args.actorId},
                ${JSON.stringify({ requestId: args.requestId, conflicts: conflictRefusal })}::jsonb)`);
    }
    throw error;
  }
  // The decision committed: the approver owns an audit row (searchable in
  // the audit trail by actor and action) and a close-history event naming
  // the scope, the decision and the requester's reason. Nothing is written
  // when the transaction threw — a refusal leaves no decision to attest.
  if (decided) {
    const scope = {
      periodId: decided.periodId,
      bookId: decided.bookId,
      subsidiaryId: decided.subsidiaryId,
      modules: decided.modules,
    };
    // A sole-approver self-approval is its own audit entry: the action
    // names it, the note records that no other eligible approver existed,
    // and the conflict detail the requester accepted is retained.
    const action = decided.status === "rejected"
      ? "reject"
      : decided.selfApproved ? "self_approve" : "approve";
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${args.orgId}, 'close_reopen_requests', ${args.requestId}, ${action},
              ${JSON.stringify({
                before: { status: "requested" },
                after: {
                  status: decided.status,
                  reason: decided.reason,
                  ...(decided.selfApproved
                    ? {
                      selfApproved: true,
                      note: "self-approved: no other eligible approver",
                      attestation: decided.attestation,
                      conflicts: decided.conflicts,
                    }
                    : {}),
                },
                scope,
                requestedBy: decided.requestedBy,
              })}::jsonb, ${args.actorId})`);
    await db.execute(sql`
      insert into close_events (org_id, event_type, actor_id, payload)
      values (${args.orgId}, 'period.reopen_decision', ${args.actorId},
              ${JSON.stringify({
                requestId: args.requestId,
                decision: decided.status,
                reason: decided.reason,
                scope,
                requestedBy: decided.requestedBy,
                ...(decided.selfApproved
                  ? {
                    selfApproved: true,
                    note: "self-approved: no other eligible approver",
                    attestation: decided.attestation,
                    conflicts: decided.conflicts,
                  }
                  : {}),
              })}::jsonb)`);
  }
}

async function recloseApprovedReopenRow(args: {
  tx: SqlExecutor;
  row: CloseReopenRequestRow;
  actorId?: string;
  reason: string;
  automatic: boolean;
}): Promise<void> {
  const modules = args.row.modules;
  if (
    modules.length === 0 ||
    modules.some((module) => !CLOSE_MODULES.includes(module))
  ) {
    throw new CloseError("reopen request contains an invalid module");
  }
  await args.tx.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(
        ${`close-reopen:${args.row.org_id}:${args.row.period_id}:${args.row.book_id}:${args.row.subsidiary_id ?? "all"}`},
        0
      )
    )
  `);
  const overlapping = (await args.tx.execute<{ id: string; modules: CloseModule[] }>(sql`
    select id, modules
      from close_reopen_requests
     where org_id = ${args.row.org_id}
       and period_id = ${args.row.period_id}
       and book_id = ${args.row.book_id}
       and subsidiary_id is not distinct from ${args.row.subsidiary_id}
       and id <> ${args.row.id}
       and status = 'approved'
       and expires_at > now()
     for update`));
  const coveredModules = new Set(
    overlapping.rows.flatMap((request) =>
      request.modules.filter((module) => modules.includes(module)),
    ),
  );
  const modulesToClose = modules.filter((module) => !coveredModules.has(module));

  for (const module of modulesToClose.filter((item) => item !== "gl")) {
    await upsertLock({
      tx: args.tx,
      orgId: args.row.org_id,
      periodId: args.row.period_id,
      bookId: args.row.book_id,
      subsidiaryId: args.row.subsidiary_id ?? undefined,
      module,
      state: "closed",
      actorId: args.actorId,
      reason: `${args.automatic ? "Automatic" : "Controlled"} re-close: ${args.reason}`,
    });
  }
  if (modulesToClose.includes("gl")) {
    const openSubledgers = (await args.tx.execute<{ module: CloseModule }>(sql`
      select module
        from period_locks
       where org_id = ${args.row.org_id}
         and period_id = ${args.row.period_id}
         and book_id = ${args.row.book_id}
         and subsidiary_id is not distinct from ${args.row.subsidiary_id}
         and module <> 'gl'
         and state <> 'closed'
       for update`));
    if (openSubledgers.rows.length > 0) {
      throw new CloseError(
        `cannot re-close GL while ${openSubledgers.rows
          .map((item) => item.module.toUpperCase())
          .join(", ")} remains open`,
      );
    }
    await upsertLock({
      tx: args.tx,
      orgId: args.row.org_id,
      periodId: args.row.period_id,
      bookId: args.row.book_id,
      subsidiaryId: args.row.subsidiary_id ?? undefined,
      module: "gl",
      state: "closed",
      actorId: args.actorId,
      reason: `${args.automatic ? "Automatic" : "Controlled"} re-close: ${args.reason}`,
    });
  }
  if (args.row.subsidiary_id == null) {
    // Mirror of the approve-time relaxation above (and of the scope-wide
    // close tightening in setPeriodLockState): ending an org-wide window
    // must dominate every narrower lock, or an open child row shadows the
    // re-closed scope and keeps accepting postings after the window ends.
    // Only the re-closed modules' rows move; a live window owned by another
    // request covers different modules by construction of the overlap check.
    for (const module of modulesToClose) {
      await tightenNarrowerLocks({
        tx: args.tx,
        orgId: args.row.org_id,
        periodId: args.row.period_id,
        bookId: args.row.book_id,
        module,
        state: "closed",
        actorId: args.actorId,
        reason: `${args.automatic ? "Automatic" : "Controlled"} re-close: ${args.reason}`,
      });
    }
  }
  const finalStatus =
    args.automatic && coveredModules.size > 0 ? "expired" : "reclosed";
  const updated = await args.tx.execute(sql`
    update close_reopen_requests
       set status = ${finalStatus},
           reclosed_at = ${finalStatus === "reclosed" ? sql`now()` : sql`null`},
           updated_at = now(),
           updated_by = ${args.actorId ?? null}
     where id = ${args.row.id} and org_id = ${args.row.org_id} and status = 'approved'
    returning id`);
  if (updated.rows.length !== 1) {
    throw new CloseError("approved reopen request changed during re-close");
  }
  await args.tx.execute(sql`
    insert into close_events (org_id, event_type, actor_id, payload)
    values (${args.row.org_id},
            ${
              args.automatic
                ? coveredModules.size > 0
                  ? "period.reopen_expired_with_overlap"
                  : "period.automatically_reclosed"
                : coveredModules.size > 0
                  ? "period.controlled_reclosed_with_overlap"
                  : "period.controlled_reclosed"
            },
            ${args.actorId ?? null},
            ${JSON.stringify({
              requestId: args.row.id,
              periodId: args.row.period_id,
              bookId: args.row.book_id,
              modules,
              modulesClosed: modulesToClose,
              modulesStillOpen: [...coveredModules],
              overlappingRequestIds: overlapping.rows.map((row) => row.id),
              reason: args.reason,
            })}::jsonb)`);
}

/** End an approved reopen window early with a stated reason.
 * Any holder of the reopen-approval permission (`close.reopen`) may end any
 * active window — including a stale window whose modules are already closed,
 * which otherwise blocks new reopens with no user path to clear it. Ending
 * re-closes the modules the window opened, exactly like the re-close path.
 * The original approval remains immutable; the actor, timestamp and reason
 * are appended to the close event stream and the audit trail. The automatic
 * expiry tick carries no actor and keeps its own path. */
export async function recloseApprovedReopen(args: {
  orgId: string;
  requestId: string;
  actorId: string;
  reason: string;
}): Promise<void> {
  const reason = args.reason.trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new CloseError("a 10-500 character re-close reason is required");
  }
  await db.transaction(async (tx) => {
    const request = (await tx.execute<CloseReopenRequestRow>(sql`
      select *
        from close_reopen_requests
       where id = ${args.requestId}
         and org_id = ${args.orgId}
         and status = 'approved'
       for update`));
    const row = request.rows[0];
    if (!row) throw new CloseError("approved reopen request not found");
    // Ending a window closes modules, so the gate is the reopen-approval
    // permission resolved in-transaction — never identity. A stale window's
    // requester or approver may be unavailable, and the route already
    // requires the same permission; unknown or inactive principals fail
    // closed inside the permission check.
    if (!(await actorHasPermission(tx, args.orgId, args.actorId, "close.reopen"))) {
      throw new CloseError(
        "ending a reopen window requires the close reopen permission; ask an administrator for access",
      );
    }
    await recloseApprovedReopenRow({
      tx,
      row,
      actorId: args.actorId,
      reason,
      automatic: false,
    });
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${args.orgId}, 'close_reopen_requests', ${args.requestId}, 'end',
              ${JSON.stringify({
                before: { status: "approved" },
                after: { status: "reclosed", reason },
                scope: {
                  periodId: row.period_id,
                  bookId: row.book_id,
                  subsidiaryId: row.subsidiary_id,
                  modules: row.modules,
                },
              })}::jsonb, ${args.actorId})`);
  });
}

/**
 * Extend an active reopen window, widen it to more modules, or both — the
 * alternative the overlap refusal offers instead of an overlapping request.
 * Extending prolongs an independent approval, so the requester cannot extend
 * their own window; ending early is any reopen-permission holder's call
 * (see recloseApprovedReopen). Added modules must currently need a window
 * (closed locks), and inherit the window's expiry.
 */
export async function extendReopenRequest(args: {
  orgId: string;
  requestId: string;
  actorId: string;
  reason: string;
  additionalHours?: number;
  addModules?: CloseModule[];
}): Promise<{ expiresAt: string; modules: CloseModule[] }> {
  const reason = args.reason.trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new CloseError("a 10-500 character extension reason is required");
  }
  const addModules = [...new Set(args.addModules ?? [])];
  if (addModules.some((module) => !CLOSE_MODULES.includes(module))) {
    throw new CloseError("extension contains an invalid module");
  }
  const additionalHours = args.additionalHours ?? null;
  if (additionalHours !== null && (!Number.isInteger(additionalHours) || additionalHours < 1 || additionalHours > 168)) {
    throw new CloseError("additional hours must be between 1 and 168");
  }
  if (additionalHours === null && addModules.length === 0) {
    throw new CloseError("an extension must add time, modules, or both");
  }
  return db.transaction(async (tx) => {
    const request = (await tx.execute<CloseReopenRequestRow>(sql`
      select *
        from close_reopen_requests
       where id = ${args.requestId}
         and org_id = ${args.orgId}
         and status = 'approved'
         and expires_at > now()
       for update`));
    const row = request.rows[0];
    if (!row) throw new CloseError("only an active approved reopen window can be extended");
    if (args.actorId === row.requested_by) {
      throw new CloseError("extending a reopen window requires an independent approver, not the requester");
    }
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(
          ${`close-reopen:${args.orgId}:${row.period_id}:${row.book_id}:${row.subsidiary_id ?? "all"}`},
          0
        )
      )
    `);
    const policy = (await tx.execute<{ rules: { defaultHours?: number; maxHours?: number } }>(sql`select rules from close_policies
      where org_id = ${args.orgId} and code = 'controlled-reopen' and is_active limit 1`));
    const maxHours = Math.max(
      1,
      Number(policy.rows[0]?.rules?.maxHours ?? 168),
    );
    const approvedAt = row.approved_at == null ? null : new Date(row.approved_at);
    const cap = approvedAt == null
      ? new Date(Date.now() + maxHours * 60 * 60 * 1000)
      : new Date(approvedAt.getTime() + maxHours * 60 * 60 * 1000);
    let expiresAt = new Date(row.expires_at!);
    if (additionalHours !== null) {
      const wanted = new Date(Math.max(expiresAt.getTime(), Date.now() + additionalHours * 60 * 60 * 1000));
      expiresAt = wanted > cap ? cap : wanted;
    }
    const modules = [...row.modules];
    const added: CloseModule[] = [];
    for (const module of addModules) {
      if (modules.includes(module)) continue;
      const state = await governingLockState(tx, {
        orgId: args.orgId,
        periodId: row.period_id,
        bookId: row.book_id,
        subsidiaryId: row.subsidiary_id,
        module,
      });
      // Only a module that currently needs a window can join one; anything
      // else has nothing to reopen and its window would be pure time bomb.
      if (!periodLockRequiresApprovedReopen(state == null ? null : { state, reopenExpiresAt: null, reason: null })) {
        throw new CloseError(
          `cannot widen to ${module}: no closed lock in the requested scope — nothing to reopen`,
        );
      }
      modules.push(module);
      added.push(module);
    }
    const union = [...new Set(modules)];
    if (union.some((module) => module !== "gl") && !union.includes("gl")) {
      const glState = await governingLockState(tx, {
        orgId: args.orgId,
        periodId: row.period_id,
        bookId: row.book_id,
        subsidiaryId: row.subsidiary_id,
        module: "gl",
      });
      if (periodLockRequiresApprovedReopen(glState == null ? null : { state: glState, reopenExpiresAt: null, reason: null })) {
        throw new CloseError("GL must be included before a closed subledger can be reopened; widen to GL as well");
      }
    }
    for (const module of added) {
      await upsertLock({
        tx,
        orgId: args.orgId,
        periodId: row.period_id,
        bookId: row.book_id,
        subsidiaryId: row.subsidiary_id ?? undefined,
        module,
        state: "open",
        actorId: args.actorId,
        reason: row.reason,
        reopenExpiresAt: expiresAt,
      });
    }
    if (row.subsidiary_id == null) {
      for (const module of added) {
        const children = (await tx.execute<{ subsidiary_id: string }>(sql`
          select subsidiary_id from period_locks
           where org_id = ${args.orgId} and period_id = ${row.period_id}
             and book_id = ${row.book_id} and module = ${module}
             and subsidiary_id is not null
             and (state = 'closed'
               or state = 'soft_closed'
               or (state = 'open' and reopen_expires_at is not null and reopen_expires_at <= now()))
           for update`));
        for (const child of children.rows) {
          await upsertLock({
            tx,
            orgId: args.orgId,
            periodId: row.period_id,
            bookId: row.book_id,
            subsidiaryId: child.subsidiary_id,
            module,
            state: "open",
            actorId: args.actorId,
            reason: row.reason,
            reopenExpiresAt: expiresAt,
          });
        }
      }
    }
    const previousExpiresAt = new Date(row.expires_at!);
    await tx.execute(sql`
      update close_reopen_requests
         set modules = ${JSON.stringify(union)}::jsonb,
             expires_at = ${expiresAt.toISOString()},
             updated_at = now(), updated_by = ${args.actorId}
       where id = ${row.id} and org_id = ${args.orgId} and status = 'approved'`);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${args.orgId}, 'close_reopen_requests', ${row.id}, 'extend',
              ${JSON.stringify({
                before: { expiresAt: previousExpiresAt.toISOString(), modules: row.modules },
                after: { expiresAt: expiresAt.toISOString(), modules: union },
                reason,
              })}::jsonb, ${args.actorId})`);
    await tx.execute(sql`
      insert into close_events (org_id, event_type, actor_id, payload)
      values (${args.orgId}, 'period.reopen_extended', ${args.actorId},
              ${JSON.stringify({
                requestId: row.id,
                periodId: row.period_id,
                bookId: row.book_id,
                subsidiaryId: row.subsidiary_id,
                previousExpiresAt: previousExpiresAt.toISOString(),
                expiresAt: expiresAt.toISOString(),
                addedModules: added,
                reason,
              })}::jsonb)`);
    return { expiresAt: expiresAt.toISOString(), modules: union };
  });
}

export async function recloseExpiredReopens(actorId?: string): Promise<number> {
  // Finding expired reopen windows spans organizations and crosses an explicit
  // trusted boundary; each re-close then commits inside its own tenant. The
  // scheduler tick that calls this holds no request store, so without the
  // boundary RLS denies by default and no window is ever closed again.
  // bypass: scheduler-tick — expired reopen windows are found across every organization.
  const expired = await withBypassContext(() =>
    db.execute<{
      id: string;
      org_id: string;
      period_id: string;
      book_id: string;
      subsidiary_id: string | null;
      modules: CloseModule[];
      reason: string;
    }>(sql`
    select request.id, request.org_id, request.period_id, request.book_id,
           request.subsidiary_id, request.modules, request.reason
      from close_reopen_requests request
      join orgs organization on organization.id = request.org_id
     where request.status = 'approved' and request.expires_at <= now()
       and organization.env_kind = 'production'`));
  // A concurrent tick may lock a candidate first: its re-close commits and
  // this tick's lock finds no approved row. Only committed re-closes count —
  // returning the candidate count would double-count the same window across
  // the two ticks.
  let reclosed = 0;
  for (const row of expired.rows) {
    const didReclose = await withOrgContext(row.org_id, () =>
      db.transaction(async (tx) => {
      const locked = (await tx.execute<CloseReopenRequestRow>(sql`
        select *
          from close_reopen_requests
         where id = ${row.id}
           and org_id = ${row.org_id}
           and status = 'approved'
           and expires_at <= now()
         for update`));
      const lockedRow = locked.rows[0];
      if (!lockedRow) return false;
      await recloseApprovedReopenRow({
        tx,
        row: lockedRow,
        actorId,
        reason: lockedRow.reason,
        automatic: true,
      });
      return true;
    }));
    if (didReclose) reclosed += 1;
  }
  return reclosed;
}
