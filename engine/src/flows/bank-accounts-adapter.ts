import { and, eq, sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { businessToday } from "../platform/business-date.ts";
import { db, schema } from "../platform/db.ts";
import { lockScopeRow } from "../organization/subsidiary-scope.ts";
import type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
import { BUILT_IN_ROLE_NAMES, EVENT_SOURCE_OPTIONS } from "./subject-profiles.ts";

/**
 * party_bank_accounts FlowSubjectAdapter — the first non-document subject.
 * Bank-detail change approval: bank-detail rows are fraud-sensitive,
 * so new/edited details sit `pending` — INACTIVE and invisible to payment
 * runs (payments.ts selects `is_active AND approved_at IS NOT NULL`) — until
 * a gate approves them. The adapter maintains that invariant on every status
 * transition:
 *
 *   pending  → approval_status='pending',  approved_at=null, is_active=false
 *   approved → approval_status='approved', approved_at=today, is_active=true
 *   rejected → approval_status='rejected', approved_at=null, is_active=false
 */

export const BANK_ACCOUNT_SUBJECT_KIND = "party_bank_account";

const BANK_ACCOUNT_STATUSES = [
  { value: "pending", label: "Pending approval" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
] as const;

const STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  rejected: ["pending"],
  pending: ["approved", "rejected"], // material edit / resubmit re-enters approval
};

// Approval is an engine outcome (decideGate → releaseApproval), never an
// authored status side effect. Keep this vocabulary next to the adapter so
// author-time lint and the runtime write boundary cannot drift apart.
export const BANK_ACCOUNT_ENGINE_MANAGED_RELEASE_STATUSES: ReadonlySet<string> =
  new Set(["approved"]);

export const bankAccountSubjectProfile: FlowSubjectProfile = {
  subjectKind: BANK_ACCOUNT_SUBJECT_KIND,
  label: "Vendor bank details",
  triggers: ["on_create", "on_update", "status_change", "on_field_value", "manual"],
  actions: ["send_email", "notify", "change_status"],
  statuses: [...BANK_ACCOUNT_STATUSES],
  fields: [
    { key: "partyId", label: "Party", type: "text" },
    { key: "partyName", label: "Party name", type: "text" },
    { key: "bankName", label: "Bank name", type: "text" },
    { key: "country", label: "Country", type: "text" },
    { key: "currency", label: "Currency", type: "enum" },
    { key: "accountLastFour", label: "Account last four", type: "text" },
    {
      key: "approvalStatus",
      label: "Approval status",
      type: "enum",
      options: BANK_ACCOUNT_STATUSES.map((status) => ({ ...status })),
    },
    {
      key: "status",
      label: "Status",
      type: "enum",
      options: BANK_ACCOUNT_STATUSES.map((status) => ({ ...status })),
    },
    { key: "isActive", label: "Active", type: "bool" },
    { key: "createdBy", label: "Created by (user)", type: "user" },
    // Present only on on_update dispatches (injected from the event):
    { key: "changedFields", label: "Changed fields (on update)", type: "text" },
    {
      key: "event_source",
      label: "Event source",
      type: "enum",
      options: [...EVENT_SOURCE_OPTIONS],
    },
  ],
  roles: [...BUILT_IN_ROLE_NAMES],
};

type BankRow = typeof schema.partyBankAccounts.$inferSelect;

async function loadRow(subjectId: string, orgId?: string): Promise<BankRow | null> {
  const [row] = await db
    .select()
    .from(schema.partyBankAccounts)
    .where(
      orgId
        ? and(eq(schema.partyBankAccounts.id, subjectId), eq(schema.partyBankAccounts.orgId, orgId))
        : eq(schema.partyBankAccounts.id, subjectId),
    );
  return row ?? null;
}

export const bankAccountsFlowAdapter: FlowSubjectAdapter = {
  subjectKind: BANK_ACCOUNT_SUBJECT_KIND,
  profile: bankAccountSubjectProfile,
  // Flows never write bank fields directly — the material columns are exactly
  // what approval guards, so all mutation goes through the API + re-approval.
  writableFields: new Set<string>(),
  // Vendor bank details are fraud-sensitive: the submitter must never be able
  // to approve their own details, even if a tenant opts out on the gate node.
  selfApprovalPolicy: "forbidden",

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const row = await loadRow(subjectId);
    if (!row) return null;
    let partyName: string | null = null;
    const r = (await db.execute<{ display_name: string }>(
      sql`select display_name from parties where id = ${row.partyId} and org_id = ${row.orgId}`,
    ));
    partyName = r.rows[0]?.display_name ?? null;
    const routing = (row.routing ?? {}) as Record<string, string>;
    return {
      values: {
        id: row.id,
        partyId: row.partyId,
        partyName,
        bankName: row.bankName,
        country: row.country,
        currency: row.currency,
        accountLastFour: row.accountLastFour,
        approvalStatus: row.approvalStatus,
        status: row.approvalStatus, // alias so shared gate/status UX reads it
        isActive: row.isActive,
        approvedAt: row.approvedAt,
        createdBy: row.createdBy,
        // Routing keys flattened for {{interpolation}} (institution/transit/…).
        ...Object.fromEntries(Object.entries(routing).map(([k, v]) => [`routing_${k}`, v])),
      },
      submitterUserId: row.submittedBy ?? row.createdBy ?? null,
    };
  },

  label(_subjectId: string, values: Record<string, unknown>): string {
    const last4 = values.accountLastFour ? ` ****${String(values.accountLastFour)}` : "";
    const party = values.partyName ? ` — ${String(values.partyName)}` : "";
    return `Bank account${last4}${party}`;
  },

  deepLink(): string {
    // Bank details render inside the party flyout, which needs the party id —
    // not derivable synchronously here. The approvals worklist row still
    // shows the label; the hub is the landing surface.
    return "/inbox";
  },

  async getStatus(subjectId: string): Promise<string | null> {
    const row = await loadRow(subjectId);
    return row?.approvalStatus ?? null;
  },

  async changeStatus(subjectId: string, to: string, ctx: FlowExecCtx): Promise<void> {
    if (BANK_ACCOUNT_ENGINE_MANAGED_RELEASE_STATUSES.has(to)) {
      throw new Error(
        `bank-detail approval release is engine-enforced; approve through an approval gate`,
      );
    }
    const legalFrom = STATUS_TRANSITIONS[to];
    if (!legalFrom) throw new Error(`unknown bank-detail status "${to}"`);
    await db.transaction(async (tx) => {
      // Pre-read the party link so locks order party-then-bank (the submit
      // route's order); the link is re-verified once both locks are held.
      const link = (await tx.execute<{ partyId: string }>(sql`
        select party_id as "partyId" from party_bank_accounts
         where id = ${subjectId} and org_id = ${ctx.orgId}
      `)).rows[0];
      if (!link) throw new Error(`bank account ${subjectId} not found`);
      // Locked subsidiary recheck (I1-refix-108): the route's precheck can
      // pass while a concurrent party rehome lands before this write
      // commits. Under the party lock the verdict sees the latest
      // subsidiary — never the precheck's stale one — and the rehome
      // blocks until this transaction commits. Answers exactly like a
      // missing record. System dispatches carry no request scope
      // (undefined) and keep their legacy behavior.
      if (ctx.allowedSubsidiaryIds !== undefined) {
        await lockScopeRow(tx, ctx.orgId, "party", link.partyId, ctx.allowedSubsidiaryIds, "update", {
          orgWideNull: true,
        });
      }
      const row = (await tx.execute<{
        partyId: string;
        approvalStatus: string;
      }>(sql`
        select party_id as "partyId", approval_status as "approvalStatus"
          from party_bank_accounts
         where id = ${subjectId} and org_id = ${ctx.orgId}
         for update
      `)).rows[0];
      if (!row) throw new Error(`bank account ${subjectId} not found`);
      if (row.partyId !== link.partyId) {
        throw new Error(`bank account ${subjectId} changed while its flow ran — retry the action`);
      }
      if (row.approvalStatus === to) return; // idempotent no-op (replays)
      if (!legalFrom.includes(row.approvalStatus)) {
        throw new Error(`illegal bank-detail transition ${row.approvalStatus} → ${to}`);
      }
      const written = (await tx.execute(sql`
        update party_bank_accounts
           set approval_status = ${to}, approved_at = null, approved_by = null,
               is_active = false, updated_at = now(), updated_by = ${ctx.userId ?? null}
         where id = ${subjectId} and org_id = ${ctx.orgId}
      `)).rowCount ?? 0;
      if (written !== 1) {
        throw new Error(`bank account ${subjectId} changed while its flow ran — retry the action`);
      }
    });
  },

  async releaseApproval(subjectId, outcome, ctx): Promise<void> {
    const today = await businessToday(ctx.orgId);
    await db.transaction(async (tx) => {
      const link = (await tx.execute<{ partyId: string }>(sql`
        select party_id as "partyId" from party_bank_accounts
         where id = ${subjectId} and org_id = ${ctx.orgId}
      `)).rows[0];
      if (!link) return;
      // Same locked subsidiary recheck as changeStatus: an approval that
      // was in scope when its gate was decided must not release onto a
      // party rehomed out of scope before the release commits.
      if (ctx.allowedSubsidiaryIds !== undefined) {
        await lockScopeRow(tx, ctx.orgId, "party", link.partyId, ctx.allowedSubsidiaryIds, "update", {
          orgWideNull: true,
        });
      }
      const row = (await tx.execute<{
        partyId: string;
        approvalStatus: string;
        retiredAt: string | null;
        submittedBy: string | null;
        createdBy: string | null;
      }>(sql`
        select party_id as "partyId", approval_status as "approvalStatus",
               retired_at as "retiredAt", submitted_by as "submittedBy",
               created_by as "createdBy"
          from party_bank_accounts
         where id = ${subjectId} and org_id = ${ctx.orgId}
         for update
      `)).rows[0];
      if (!row || row.retiredAt || row.approvalStatus !== "pending") return;
      if (row.partyId !== link.partyId) {
        throw new Error(`bank account ${subjectId} changed while its approval released — retry the action`);
      }
      const written = (await tx.execute(sql`
        update party_bank_accounts
           set approval_status = ${outcome === "approved" ? "approved" : "rejected"},
               approved_at = ${outcome === "approved" ? today : null},
               approved_by = ${outcome === "approved" ? (ctx.userId ?? null) : null},
               is_active = ${outcome === "approved"},
               updated_at = now(), updated_by = ${ctx.userId ?? null}
         where id = ${subjectId} and org_id = ${ctx.orgId}
      `)).rowCount ?? 0;
      if (written !== 1) {
        throw new Error(`bank account ${subjectId} changed while its approval released — retry the action`);
      }
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (
          ${ctx.orgId}, 'party_bank_accounts', ${subjectId},
          ${outcome === "approved" ? "approve" : "reject"},
          ${JSON.stringify({
            mode: "bank_detail_approval",
            outcome,
            submittedBy: row.submittedBy ?? row.createdBy,
          })}::jsonb,
          ${ctx.userId ?? null}, 'flows'
        )
      `);
    });
  },

  async setField(): Promise<void> {
    throw new Error("bank-detail fields are not writable by flows — edits go through the API and re-approval");
  },
};
