import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import { paymentRunVisibleSql } from "../payments-core/payment-run-scope.ts";
import { EVENT_SOURCE_OPTIONS } from "./subject-profiles.ts";
import type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";

/**
 * Payment runs as flow subjects.
 *
 * Approval of a payment run is owned by Flows, like every other approval:
 * submitting a run fires `on_submit`, and an enabled flow that raises a gate
 * parks the run in `pending_approval` until the flow decides. An organization
 * with no gating flow has no payment-run approval at all — the submit releases
 * the run straight to `approved`.
 *
 * Runs split into two subjects by direction because they belong to different
 * functions with different grants: outbound runs (vendor payments, refunds,
 * positive pay) are payables and approve under `ap.approve`; inbound runs
 * (direct-debit collections) are receivables and approve under `ar.approve`.
 * Each organization therefore authors, routes and audits the two separately.
 *
 * The adapter owns the approval lifecycle only. Status is released inside the
 * payments engine through the registered handler (releaseViaHandler), never by
 * an authored `change_status` or `set_field`: a run's selection and totals are
 * the thing being approved, and a flow must not rewrite them.
 *
 * Separation of duties is not a tenant preference here: neither the run's
 * maker (who assembled the selection) nor its submitter may decide its gate.
 */

export const OUTBOUND_PAYMENT_RUN_SUBJECT_KIND = "outbound_payment_run";
export const INBOUND_PAYMENT_RUN_SUBJECT_KIND = "inbound_payment_run";

export type PaymentRunDirection = "outbound" | "inbound";

/** The flow subject a run approves under, from its stored direction. */
export function paymentRunSubjectKind(direction: string): string {
  return direction === "inbound" ? INBOUND_PAYMENT_RUN_SUBJECT_KIND : OUTBOUND_PAYMENT_RUN_SUBJECT_KIND;
}

const PAYMENT_RUN_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "approved", label: "Approved" },
  { value: "processing", label: "Processing" },
  { value: "generated", label: "File generated" },
  { value: "delivered", label: "Delivered" },
  { value: "partially_failed", label: "Partially failed" },
  { value: "confirmed", label: "Confirmed" },
  { value: "settled", label: "Settled" },
  { value: "returned", label: "Returned" },
  { value: "rejected", label: "Rejected" },
  { value: "rolled_back", label: "Rolled back" },
  { value: "cancelled", label: "Cancelled" },
] as const;

const METHOD_OPTIONS = [
  { value: "eft", label: "EFT" },
  { value: "ach", label: "ACH" },
  { value: "sepa", label: "SEPA" },
  { value: "wire", label: "Wire" },
  { value: "cheque", label: "Cheque" },
  { value: "direct_debit", label: "Direct debit" },
  { value: "positive_pay", label: "Positive pay" },
  { value: "custom", label: "Custom format" },
];

function paymentRunProfile(direction: PaymentRunDirection): FlowSubjectProfile {
  const outbound = direction === "outbound";
  return {
    subjectKind: outbound ? OUTBOUND_PAYMENT_RUN_SUBJECT_KIND : INBOUND_PAYMENT_RUN_SUBJECT_KIND,
    label: outbound ? "Payment run" : "Collection run",
    triggers: ["on_submit"],
    actions: ["send_email", "notify"],
    statuses: [...PAYMENT_RUN_STATUSES],
    fields: [
      { key: "runNumber", label: "Run number", type: "text" },
      {
        key: "purpose", label: "Purpose", type: "enum", options: outbound
          ? [
            { value: "vendor_payments", label: "Vendor payments" },
            { value: "refunds", label: "Refunds" },
            { value: "positive_pay", label: "Positive pay" },
          ]
          : [{ value: "customer_collections", label: "Customer collections" }],
      },
      { key: "method", label: "Payment method", type: "enum", options: METHOD_OPTIONS },
      { key: "currency", label: "Currency", type: "text" },
      { key: "totalAmount", label: "Total amount", type: "number" },
      { key: "paymentCount", label: "Payments", type: "number" },
      { key: "scheduledFor", label: "Scheduled for", type: "date" },
      { key: "bankAccountName", label: "Bank account", type: "text" },
      { key: "profileName", label: "Payment profile", type: "text" },
      {
        key: "origin", label: "Origin", type: "enum", options: [
          { value: "manual", label: "Assembled by a user" },
          { value: "scheduled", label: "Payment schedule" },
        ],
      },
      { key: "status", label: "Status", type: "enum" },
      { key: "createdBy", label: "Assembled by", type: "user" },
      { key: "submittedBy", label: "Submitted by", type: "user" },
      { key: "event_source", label: "Event source", type: "enum", options: [...EVENT_SOURCE_OPTIONS] },
    ],
  };
}

export const outboundPaymentRunSubjectProfile = paymentRunProfile("outbound");
export const inboundPaymentRunSubjectProfile = paymentRunProfile("inbound");

type PaymentRunRow = {
  id: string;
  run_number: string;
  direction: string;
  purpose: string;
  method: string;
  currency: string;
  total_amount: string;
  payment_count: number;
  scheduled_for: string | null;
  status: string;
  source_schedule_id: string | null;
  bank_account_name: string | null;
  profile_name: string | null;
  created_by: string | null;
  submitted_by: string | null;
};

/** The run as this subject sees it: a run of the other direction is not this subject. */
async function loadRun(subjectId: string, direction: PaymentRunDirection): Promise<PaymentRunRow | null> {
  const result = await db.execute<PaymentRunRow>(sql`
    select r.id, r.run_number, r.direction, r.purpose, r.method, r.currency,
           r.total_amount::text as total_amount, r.payment_count,
           r.scheduled_for::text as scheduled_for, r.status, r.source_schedule_id,
           a.name as bank_account_name, p.name as profile_name,
           r.created_by, r.submitted_by
      from payment_runs r
      left join accounts a on a.id = r.bank_account_id and a.org_id = r.org_id
      left join payment_bank_profiles p on p.id = r.payment_bank_profile_id and p.org_id = r.org_id
     where r.id = ${subjectId} and r.direction = ${direction}
  `);
  return result.rows[0] ?? null;
}

function createPaymentRunsFlowAdapter(direction: PaymentRunDirection): FlowSubjectAdapter {
  const subjectKind = paymentRunSubjectKind(direction);
  const area = direction === "inbound" ? "ar" : "ap";
  const getStatusFor = async (subjectId: string) => (await loadRun(subjectId, direction))?.status ?? null;
  return defineTableSubjectAdapter({
    subjectKind,
    // The same grants the run drawer and its verbs require for this direction.
    permissions: { read: `${area}.pay`, edit: `${area}.pay`, approve: `${area}.approve` },
    scope: {
      via: "custom",
      // A run is visible only when its header and every source document are
      // (the shared payment-run record boundary). A visible run with no header
      // entity reports the entity its evidence proves, so restricted callers
      // see the same runs here as on the run list.
      async subsidiaryOf(orgId, ids, allowed, lock) {
        const rows = (await db.execute<{ id: string; subsidiaryId: string | null }>(sql`
          select r.id,
                 coalesce(r.subsidiary_id, (
                   select d.subsidiary_id from payment_run_items i
                     join documents d on d.id = i.source_document_id and d.org_id = i.org_id
                    where i.payment_run_id = r.id and i.org_id = r.org_id
                    order by d.subsidiary_id limit 1
                 )) as "subsidiaryId",
                 ${paymentRunVisibleSql(orgId, allowed, "r")} as visible
            from payment_runs r
           where r.org_id = ${orgId}
             and r.id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
           ${lock ? sql`for share of r` : sql``}
        `)).rows as Array<{ id: string; subsidiaryId: string | null; visible: boolean }>;
        return new Map(rows.map((row) => [row.id, row.visible ? row.subsidiaryId : null]));
      },
      worklistPredicate(allowedIdsJson) {
        const allowed = new Set<string>(JSON.parse(allowedIdsJson) as string[]);
        return sql`exists (
          select 1 from payment_runs wr
           where wr.org_id = g.org_id and wr.id = g.subject_id
             and ${paymentRunVisibleSql(sql`g.org_id`, allowed, "wr")}
        )`;
      },
    },
    profile: direction === "inbound" ? inboundPaymentRunSubjectProfile : outboundPaymentRunSubjectProfile,
    releaseViaHandler: true,
    selfApprovalPolicy: "forbidden",

    async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
      const run = await loadRun(subjectId, direction);
      if (!run) return null;
      return {
        values: {
          id: run.id,
          runNumber: run.run_number,
          purpose: run.purpose,
          method: run.method,
          currency: run.currency,
          totalAmount: run.total_amount,
          paymentCount: run.payment_count,
          scheduledFor: run.scheduled_for,
          bankAccountName: run.bank_account_name,
          profileName: run.profile_name,
          origin: run.source_schedule_id ? "scheduled" : "manual",
          status: run.status,
          createdBy: run.created_by,
          submittedBy: run.submitted_by,
        },
        submitterUserId: run.submitted_by,
        makerUserId: run.created_by,
      };
    },

    label(subjectId: string, values: Record<string, unknown>): string {
      return `${direction === "inbound" ? "Collection run" : "Payment run"} ${String(values.runNumber ?? subjectId)}`;
    },

    deepLink(subjectId: string): string {
      return `${direction === "inbound" ? "/receipts" : "/payments"}?view=runs&run=${subjectId}`;
    },

    async getStatus(subjectId: string): Promise<string | null> {
      return getStatusFor(subjectId);
    },

    async changeStatus(): Promise<void> {
      throw new Error("payment run status is released by the approval engine, not a flow action");
    },

    async releaseApproval(
      subjectId: string,
      outcome: "approved" | "rejected",
      ctx: FlowExecCtx,
      detail?: { comment?: string | null },
    ): Promise<void> {
      await releaseFlowApproval({ subjectKind, subjectId, outcome, comment: detail?.comment, ctx });
    },

    /**
     * A retried flow run that now gates parks the run, exactly as the first
     * submission would have. Only a non-empty draft moves; a run already
     * awaiting approval is left alone, and anything else refuses so the
     * retried run fails closed instead of gating a run that cannot be
     * released.
     */
    async markAwaitingApproval(subjectId: string, ctx: FlowExecCtx): Promise<void> {
      const parked = await db.execute<{ id: string; status: string }>(sql`
        update payment_runs set status = 'pending_approval',
               submitted_at = coalesce(submitted_at, now()),
               submitted_by = coalesce(submitted_by, ${ctx.userId ?? null}::uuid),
               updated_at = now(), updated_by = ${ctx.userId ?? null}
         where id = ${subjectId} and org_id = ${ctx.orgId} and direction = ${direction}
           and status = 'draft' and payment_count > 0 and total_amount > 0
        returning id, status
      `);
      if (parked.rows[0]) {
        await db.execute(sql`
          insert into payment_events (org_id, payment_run_id, event_type, from_status, to_status, details, actor_id)
          values (${ctx.orgId}, ${subjectId}, 'run_submitted', 'draft', 'pending_approval',
                  ${JSON.stringify({ source: "flow_retry" })}::jsonb, ${ctx.userId ?? null})
        `);
        return;
      }
      const current = await getStatusFor(subjectId);
      if (current !== "pending_approval") {
        throw new Error(`payment run is ${current ?? "missing"}; only a submitted draft can await approval`);
      }
    },

    async setField(): Promise<void> {
      throw new Error("payment run fields are not writable by flows; reassemble the run instead");
    },

    /** Runs awaiting a decision, for scheduled fan-out (reminders). */
    async findCandidateIds(limit: number): Promise<string[]> {
      // The explicit org_id predicate is the tenant boundary, never the RLS
      // settings alone: pooled sibling connections can otherwise see every
      // tenant. Fails closed without an ambient tenant.
      const orgId = ambientTenantOrgId();
      if (!orgId) {
        throw new Error(`findCandidateIds for "${subjectKind}" requires an ambient tenant context (withOrg)`);
      }
      const result = await db.execute<{ id: string }>(sql`
        select id::text as id from payment_runs
         where org_id = ${orgId} and direction = ${direction} and status = 'pending_approval'
         order by submitted_at desc nulls last
         limit ${limit}
      `);
      return result.rows.map((row) => row.id);
    },
  });
}

export const outboundPaymentRunsFlowAdapter = createPaymentRunsFlowAdapter("outbound");
export const inboundPaymentRunsFlowAdapter = createPaymentRunsFlowAdapter("inbound");
