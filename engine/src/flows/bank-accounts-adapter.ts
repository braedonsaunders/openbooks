import { and, eq, sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { businessToday } from "../business-date.ts";
import { db, schema } from "../db.ts";
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

/** source platform's material fields: editing any of these re-enters approval. */
export const BANK_ACCOUNT_MATERIAL_FIELDS = [
  "bankName",
  "country",
  "currency",
  "routing",
  "accountNumber",
] as const;

const STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  approved: ["pending"],
  rejected: ["pending"],
  pending: ["approved", "rejected"], // material edit / resubmit re-enters approval
};

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

async function loadRow(subjectId: string): Promise<BankRow | null> {
  const [row] = await db
    .select()
    .from(schema.partyBankAccounts)
    .where(eq(schema.partyBankAccounts.id, subjectId));
  return row ?? null;
}

export const bankAccountsFlowAdapter: FlowSubjectAdapter = {
  subjectKind: BANK_ACCOUNT_SUBJECT_KIND,
  profile: bankAccountSubjectProfile,
  // Flows never write bank fields directly — the material columns are exactly
  // what approval guards, so all mutation goes through the API + re-approval.
  writableFields: new Set<string>(),

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const row = await loadRow(subjectId);
    if (!row) return null;
    let partyName: string | null = null;
    const r = (await db.execute<{ display_name: string }>(
      sql`select display_name from parties where id = ${row.partyId}`,
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
    return "/approvals";
  },

  async getStatus(subjectId: string): Promise<string | null> {
    const row = await loadRow(subjectId);
    return row?.approvalStatus ?? null;
  },

  async changeStatus(subjectId: string, to: string, ctx: FlowExecCtx): Promise<void> {
    const row = await loadRow(subjectId);
    if (!row) throw new Error(`bank account ${subjectId} not found`);
    const legalFrom = STATUS_TRANSITIONS[to];
    if (!legalFrom) throw new Error(`unknown bank-detail status "${to}"`);
    if (row.approvalStatus === to) return; // idempotent no-op (replays)
    if (!legalFrom.includes(row.approvalStatus)) {
      throw new Error(`illegal bank-detail transition ${row.approvalStatus} → ${to}`);
    }
    const today = await businessToday(ctx.orgId);
    await db
      .update(schema.partyBankAccounts)
      .set(
        to === "approved"
          ? {
              approvalStatus: "approved",
              approvedAt: today,
              approvedBy: ctx.userId ?? null,
              isActive: true,
              updatedAt: new Date(),
              updatedBy: ctx.userId ?? null,
            }
          : {
              approvalStatus: to as BankRow["approvalStatus"],
              approvedAt: null,
              approvedBy: null,
              isActive: false,
              updatedAt: new Date(),
              updatedBy: ctx.userId ?? null,
            },
      )
      .where(
        and(
          eq(schema.partyBankAccounts.id, subjectId),
          eq(schema.partyBankAccounts.orgId, ctx.orgId),
        ),
      );
  },

  async releaseApproval(subjectId, outcome, ctx): Promise<void> {
    const row = await loadRow(subjectId);
    if (!row || row.retiredAt || row.approvalStatus !== "pending") return;
    const today = await businessToday(ctx.orgId);
    await db
      .update(schema.partyBankAccounts)
      .set(
        outcome === "approved"
          ? {
              approvalStatus: "approved",
              approvedAt: today,
              approvedBy: ctx.userId ?? null,
              isActive: true,
              updatedAt: new Date(),
              updatedBy: ctx.userId ?? null,
            }
          : {
              approvalStatus: "rejected",
              approvedAt: null,
              approvedBy: null,
              isActive: false,
              updatedAt: new Date(),
              updatedBy: ctx.userId ?? null,
            },
      )
      .where(
        and(
          eq(schema.partyBankAccounts.id, subjectId),
          eq(schema.partyBankAccounts.orgId, ctx.orgId),
        ),
      );
    await db.execute(sql`
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
  },

  async setField(): Promise<void> {
    throw new Error("bank-detail fields are not writable by flows — edits go through the API and re-approval");
  },
};
