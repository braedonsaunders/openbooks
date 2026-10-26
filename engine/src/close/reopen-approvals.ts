import { canonicalPeriodLabelSql, CloseError, type CloseModule } from "../periods/period-policy.ts";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
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
  submission_policy?: {
    version: 1;
    kind: "gated" | "ungated";
    flowIds: string[];
    runIds: string[];
  } | null;
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
export async function controlledReopenHours(
  tx: SqlExecutor,
  orgId: string,
): Promise<{ defaultHours: number; maxHours: number }> {
  const row = (
    await tx.execute<{
      rules: { defaultHours?: number; maxHours?: number };
    }>(
      sql`
    select rules from close_policies where org_id = ${orgId} and code = 'controlled-reopen' and is_active limit 1`,
      "objects",
    )
  )[0];
  const defaultHours = Number(row?.rules?.defaultHours ?? 24);
  const maxHours = Number(row?.rules?.maxHours ?? 168);
  if (
    !Number.isInteger(defaultHours) ||
    !Number.isInteger(maxHours) ||
    defaultHours < 1 ||
    maxHours < 1 ||
    defaultHours > maxHours
  ) {
    throw new CloseError(
      "the controlled reopen policy requires positive whole default and maximum hours, with the default no greater than the maximum; correct the policy in Setup",
    );
  }
  return { defaultHours, maxHours };
}

/** Every lifecycle transition takes the period fence before request row locks. */
export async function lockReopenRequestScope(
  tx: SqlExecutor,
  orgId: string,
  requestId: string,
): Promise<void> {
  const row = (
    await tx.execute<{ period_id: string; book_id: string }>(
      sql`
    select period_id, book_id from close_reopen_requests where id = ${requestId} and org_id = ${orgId}`,
      "objects",
    )
  )[0];
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
 * path applies the submitted Flow's separation policy. The drawer presents
 * the same conflict evidence before a configured approver decides.
 */
export async function reopenApprovalConflicts(
  executor: SqlExecutor,
  orgId: string,
  request: { period_id: string; book_id: string; subsidiary_id: string | null },
  actorId: string,
): Promise<ReopenApprovalConflict[]> {
  const party =
    (
      await executor.execute<{ party_id: string | null }>(
        sql`
    select party_id from users where id = ${actorId} and org_id = ${orgId}`,
        "objects",
      )
    )[0]?.party_id ?? null;
  const subsidiaryScope =
    request.subsidiary_id == null
      ? sql`true`
      : sql`(d.subsidiary_id is null or d.subsidiary_id = ${request.subsidiary_id}::uuid)`;
  const entryScope =
    request.subsidiary_id == null
      ? sql`true`
      : sql`e.subsidiary_id = ${request.subsidiary_id}::uuid`;
  const conflicts: ReopenApprovalConflict[] = [];
  const authored = await executor.execute<{
    n: string;
    examples: string[];
  }>(
    sql`
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
           coalesce((select array_agg(document_number) from (select document_number from hits limit 3) s), '{}') as examples`,
    "objects",
  );
  if (Number(authored[0]?.n ?? 0) > 0) {
    conflicts.push({
      kind: "authored_documents",
      count: Number(authored[0]!.n),
      examples: authored[0]!.examples,
    });
  }
  // Manual entries the approver booked themselves. System postings (close,
  // revaluation, allocations) carry the duty actor, not a personal stake, so
  // origin narrows the scan to hand-booked entries — a closer approving a
  // reopen after performing the close must not trip on their duty postings.
  const posted = await executor.execute<{ n: string; examples: string[] }>(
    sql`
    with hits as (
      select e.entry_number
        from journal_entries e
       where e.org_id = ${orgId} and e.period_id = ${request.period_id} and e.book_id = ${request.book_id}
         and e.status in ('posted', 'reversed') and e.origin = 'manual' and ${entryScope}
         and (e.created_by = ${actorId} or e.posted_by = ${actorId})
       order by e.entry_number
    )
    select (select count(*)::text from hits) as n,
           coalesce((select array_agg(entry_number) from (select entry_number from hits limit 3) s), '{}') as examples`,
    "objects",
  );
  if (Number(posted[0]?.n ?? 0) > 0) {
    conflicts.push({
      kind: "manual_entries",
      count: Number(posted[0]!.n),
      examples: posted[0]!.examples,
    });
  }
  if (party) {
    const partyHits = await executor.execute<{
      n: string;
      examples: string[];
    }>(
      sql`
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
             coalesce((select array_agg(ref) from (select ref from hits order by ref limit 3) s), '{}') as examples`,
      "objects",
    );
    if (Number(partyHits[0]?.n ?? 0) > 0) {
      conflicts.push({
        kind: "party_records",
        count: Number(partyHits[0]!.n),
        examples: partyHits[0]!.examples,
      });
    }
    const equity = await executor.execute<{
      n: string;
      examples: string[];
    }>(
      sql`
      with hits as (
        select distinct a.name as ref from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
          join accounts a on a.id = l.account_id and a.org_id = l.org_id
         where l.org_id = ${orgId} and e.period_id = ${request.period_id} and e.book_id = ${request.book_id}
           and e.status in ('posted', 'reversed') and ${entryScope}
           and l.party_id = ${party} and a.type = 'equity'
      )
      select (select count(*)::text from hits) as n,
             coalesce((select array_agg(ref) from (select ref from hits order by ref limit 3) s), '{}') as examples`,
      "objects",
    );
    if (Number(equity[0]?.n ?? 0) > 0) {
      conflicts.push({
        kind: "equity_lines",
        count: Number(equity[0]!.n),
        examples: equity[0]!.examples,
      });
    }
  }
  return conflicts;
}

export async function loadRequestedReopen(
  executor: SqlExecutor,
  orgId: string,
  requestId: string,
): Promise<{
  period_id: string;
  book_id: string;
  subsidiary_id: string | null;
} | null> {
  return (
    (
      await executor.execute<{
        period_id: string;
        book_id: string;
        subsidiary_id: string | null;
      }>(
        sql`
    select period_id, book_id, subsidiary_id from close_reopen_requests
     where id = ${requestId} and org_id = ${orgId} and status = 'requested'`,
        "objects",
      )
    )[0] ?? null
  );
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

/** The governing lock for one module at a request's scope: exact row, else org-wide. */
export async function governingLockState(
  tx: SqlExecutor,
  args: {
    orgId: string;
    periodId: string;
    bookId: string;
    subsidiaryId: string | null;
    module: CloseModule;
  },
): Promise<string | null> {
  const governing = await tx.execute<{ state: string }>(
    sql`
    select state from period_locks
     where org_id = ${args.orgId} and period_id = ${args.periodId}
       and book_id = ${args.bookId} and module = ${args.module}
       and (subsidiary_id is not distinct from ${args.subsidiaryId}::uuid or subsidiary_id is null)
     order by (subsidiary_id is not null) desc limit 1`,
    "objects",
  );
  return governing[0]?.state ?? null;
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
  const candidates = await tx.execute<{
    id: string;
    modules: CloseModule[];
    subsidiary_id: string | null;
  }>(
    sql`
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
     for update`,
    "objects",
  );
  const consumed: string[] = [];
  for (const candidate of candidates) {
    const states = [];
    for (const module of candidate.modules) {
      states.push(
        await governingLockState(tx, {
          orgId: args.orgId,
          periodId: args.periodId,
          bookId: args.bookId,
          subsidiaryId: candidate.subsidiary_id,
          module,
        }),
      );
    }
    if (
      states.length === 0 ||
      states.some((state) => state !== "closed" && state !== "soft_closed")
    ) {
      continue;
    }
    const updated = await tx.execute(
      sql`
      update close_reopen_requests
         set status = 'reclosed', reclosed_at = now(), updated_at = now(), updated_by = ${args.actorId}
       where id = ${candidate.id} and org_id = ${args.orgId} and status = 'approved'
      returning id`,
      "objects",
    );
    if (updated.length !== 1)
      throw new CloseError("approved reopen request changed during re-close");
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
  const row = (
    await tx.execute<{
      modules: CloseModule[];
      approved_at: string | null;
      expires_at: string | null;
      period_label: string | null;
      approver_name: string | null;
    }>(
      sql`
    select r.modules, r.approved_at::text as approved_at, r.expires_at::text as expires_at,
           ${canonicalPeriodLabelSql()} as period_label, u.name as approver_name
      from close_reopen_requests r
      left join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
      left join users u on u.id = r.approved_by and u.org_id = r.org_id
     where r.id = ${requestId} and r.org_id = ${orgId}
  `,
      "objects",
    )
  )[0];
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
  return conflicts
    .map((conflict) => {
      const more = conflict.count - conflict.examples.length;
      const listed =
        more > 0
          ? `${conflict.examples.join(", ")} and ${more} more`
          : conflict.examples.join(", ");
      return `${conflict.count} ${conflict.kind.replace(/_/g, " ")} (${listed})`;
    })
    .join("; ");
}
