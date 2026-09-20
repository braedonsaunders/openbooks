import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "./canonical-json.ts";
import { isIsoCalendarDate } from "./business-date.ts";
import type { SqlExecutor } from "./db.ts";

/** Workflow evidence only. Financial calculations and subject authorization
 * stay in their owning modules; the existing Flows engine owns decisions. */
export type FinancialChangeDomain =
  "lease" | "revenue" | "asset" | "consolidation";
export interface FinancialChange {
  id: string;
  org_id: string;
  subsidiary_id: string;
  domain: FinancialChangeDomain;
  subject_id: string;
  operation: string;
  effective_on: string;
  reason: string;
  payload: Record<string, unknown>;
  before_state: Record<string, unknown>;
  status: "draft" | "pending" | "approved" | "rejected" | "applied";
  submitted_by: string;
  approved_by: string | null;
  result: Record<string, unknown> | null;
}
export async function loadFinancialChange(
  tx: SqlExecutor,
  orgId: string,
  id: string,
): Promise<FinancialChange> {
  const row = (
    await tx.execute<FinancialChange>(sql`
    select *, effective_on::text as effective_on from financial_changes
     where id=${id} and org_id=${orgId} for update
  `)
  ).rows[0];
  if (!row) throw new Error("financial change not found");
  return row;
}
export interface FinancialChangeProposal {
  orgId: string;
  subsidiaryId: string;
  domain: FinancialChangeDomain;
  subjectId: string;
  operation: string;
  effectiveOn: string;
  reason: string;
  actorId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  beforeState: Record<string, unknown>;
}
/** Replaying a request is independent of whether its original record has
 * since advanced. The frozen payload and proposer must still match. */
export async function existingFinancialChange(
  tx: SqlExecutor,
  args: Omit<FinancialChangeProposal, "beforeState">,
): Promise<string | null> {
  const existing = (
    await tx.execute<FinancialChange>(sql`
    select *, effective_on::text as effective_on from financial_changes
     where org_id=${args.orgId} and idempotency_key=${args.idempotencyKey}
  `)
  ).rows[0];
  if (!existing) return null;
  if (
    existing.domain !== args.domain ||
    existing.subject_id !== args.subjectId ||
    existing.operation !== args.operation ||
    existing.effective_on !== args.effectiveOn ||
    existing.reason !== args.reason.trim() ||
    existing.submitted_by !== args.actorId ||
    canonicalJson(existing.payload) !== canonicalJson(args.payload)
  ) {
    throw new Error(
      "request key already belongs to a different financial change",
    );
  }
  return existing.id;
}
export async function proposeFinancialChange(
  tx: SqlExecutor,
  args: FinancialChangeProposal,
): Promise<string> {
  if (!args.actorId) throw new Error("a signed-in proposer is required");
  if (!isIsoCalendarDate(args.effectiveOn))
    throw new Error("effective date must be a calendar date (YYYY-MM-DD)");
  if (args.reason.trim().length < 8 || args.reason.trim().length > 1000)
    throw new Error("record a change reason between 8 and 1,000 characters");
  if (!args.idempotencyKey || args.idempotencyKey.length > 120)
    throw new Error("provide a request key of at most 120 characters");
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`financial-change:${args.orgId}:${args.idempotencyKey}`}))`,
  );
  const existing = await existingFinancialChange(tx, args);
  if (existing) return existing;
  const id = randomUUID();
  const inserted = await tx.execute(sql`
    insert into financial_changes(id,org_id,subsidiary_id,domain,subject_id,operation,effective_on,reason,
      idempotency_key,payload,before_state,submitted_by,created_by,updated_by)
    values (${id},${args.orgId},${args.subsidiaryId},${args.domain},${args.subjectId},${args.operation},
      ${args.effectiveOn},${args.reason.trim()},${args.idempotencyKey},${JSON.stringify(args.payload)}::jsonb,
      ${JSON.stringify(args.beforeState)}::jsonb,${args.actorId},${args.actorId},${args.actorId}) returning id
  `);
  if (inserted.rows.length !== 1)
    throw new Error("financial change proposal could not be recorded");
  return id;
}
export function assertFinancialChangeApproved(
  change: FinancialChange,
  args: {
    domain: FinancialChangeDomain;
    subjectId: string;
    beforeState: Record<string, unknown>;
  },
): void {
  if (change.domain !== args.domain || change.subject_id !== args.subjectId)
    throw new Error("approval belongs to another financial record");
  if (
    change.status !== "approved" ||
    !change.approved_by ||
    change.approved_by === change.submitted_by
  ) {
    throw new Error(
      "submit this change through Flows and obtain independent approval before applying it",
    );
  }
  if (canonicalJson(change.before_state) !== canonicalJson(args.beforeState)) {
    throw new Error(
      "the financial record changed after this proposal; create and approve a new proposal against its current balances",
    );
  }
}
export async function completeFinancialChange(
  tx: SqlExecutor,
  orgId: string,
  changeId: string,
  actorId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const updated = await tx.execute(sql`
    update financial_changes set status='applied',result=${JSON.stringify(result)}::jsonb,
      applied_by=${actorId},applied_at=now(),updated_by=${actorId},updated_at=now()
     where org_id=${orgId} and id=${changeId} and status='approved' returning id
  `);
  if (updated.rows.length !== 1)
    throw new Error("approved financial change could not be completed");
}
