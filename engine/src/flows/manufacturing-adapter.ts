import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";

export const WORK_ORDER_SUBJECT_KIND = "work_order";

const WORK_ORDER_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "released", label: "Released" },
  { value: "in_progress", label: "In progress" },
  { value: "on_hold", label: "On hold" },
  { value: "done", label: "Done" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
] as const;

export const workOrderSubjectProfile: FlowSubjectProfile = {
  subjectKind: WORK_ORDER_SUBJECT_KIND,
  label: "Work order",
  // Hold changes use the shared status_change event with to="on_hold".
  triggers: ["on_submit", "status_change"],
  actions: ["send_email", "notify", "lock_record", "unlock_record"],
  statuses: [...WORK_ORDER_STATUSES],
  fields: [
    { key: "number", label: "Work-order number", type: "text" },
    { key: "producedItemId", label: "Produced item", type: "text" },
    { key: "producedItemCode", label: "Produced item code", type: "text" },
    { key: "quantityOrdered", label: "Quantity ordered", type: "number" },
    { key: "unit", label: "Unit", type: "text" },
    { key: "priority", label: "Priority", type: "enum", options: [
      { value: "low", label: "Low" }, { value: "normal", label: "Normal" },
      { value: "high", label: "High" }, { value: "rush", label: "Rush" },
    ] },
    { key: "status", label: "Status", type: "enum" },
    { key: "subsidiaryId", label: "Subsidiary", type: "text" },
    { key: "plannedStart", label: "Planned start", type: "date" },
    { key: "plannedEnd", label: "Planned end", type: "date" },
    { key: "createdBy", label: "Created by", type: "user" },
  ],
};

type WorkOrderSubjectRow = {
  id: string; org_id: string; number: string; produced_item_id: string; item_code: string | null;
  quantity_ordered: string; unit: string; priority: string; status: string; subsidiary_id: string | null;
  planned_start: string | null; planned_end: string | null; created_by: string | null;
  pending_approval: boolean;
};

async function loadSubject(subjectId: string): Promise<WorkOrderSubjectRow | null> {
  const orgId = ambientTenantOrgId();
  if (!orgId) throw new Error(`work-order flow lookup requires an ambient organization context`);
  const result = await db.execute<WorkOrderSubjectRow>(sql`
    select order_row.id, order_row.org_id, order_row.number, order_row.produced_item_id,
           item.code as item_code, order_row.quantity_ordered::text, order_row.unit,
           order_row.priority, order_row.status, order_row.subsidiary_id,
           order_row.planned_start::text, order_row.planned_end::text, order_row.created_by,
           (order_row.status='draft' and exists (
             select 1 from flow_gates gate where gate.org_id=order_row.org_id
               and gate.subject_kind='work_order' and gate.subject_id=order_row.id
               and gate.status in ('pending','escalated')
           )) as pending_approval
      from mfg_work_orders order_row
      join items item on item.org_id=order_row.org_id and item.id=order_row.produced_item_id
     where order_row.org_id=${orgId} and order_row.id=${subjectId}`);
  return result.rows[0] ?? null;
}

async function enabled(row: WorkOrderSubjectRow): Promise<boolean> {
  return orgFeatureEnabled(row.org_id, "manufacturing");
}

export const manufacturingFlowAdapter: FlowSubjectAdapter = defineTableSubjectAdapter({
  subjectKind: WORK_ORDER_SUBJECT_KIND,
  profile: workOrderSubjectProfile,
  releaseViaHandler: true,

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const order = await loadSubject(subjectId);
    if (!order || !(await enabled(order))) return null;
    return {
      values: {
        id: order.id,
        number: order.number,
        producedItemId: order.produced_item_id,
        producedItemCode: order.item_code,
        quantityOrdered: order.quantity_ordered,
        unit: order.unit,
        priority: order.priority,
        status: order.pending_approval ? "pending_approval" : order.status,
        subsidiaryId: order.subsidiary_id,
        plannedStart: order.planned_start,
        plannedEnd: order.planned_end,
        createdBy: order.created_by,
      },
      submitterUserId: order.created_by,
      makerUserId: order.created_by,
    };
  },

  label(_subjectId: string, values: Record<string, unknown>): string {
    return `Work order ${String(values.number ?? "")}`;
  },

  deepLink(subjectId: string): string {
    return `/manufacturing/work-orders?workOrder=${encodeURIComponent(subjectId)}`;
  },

  async getStatus(subjectId: string): Promise<string | null> {
    const order = await loadSubject(subjectId);
    if (!order || !(await enabled(order))) return null;
    return order.pending_approval ? "pending_approval" : order.status;
  },

  async changeStatus(_subjectId: string, to: string): Promise<void> {
    throw new Error(`Work-order status cannot be changed to ${to} by a flow action; use the work-order lifecycle actions.`);
  },

  async releaseApproval(subjectId, outcome, ctx, detail): Promise<void> {
    await releaseFlowApproval({
      subjectKind: WORK_ORDER_SUBJECT_KIND,
      subjectId,
      outcome,
      comment: detail?.comment,
      ctx,
    });
  },

  async setField(_subjectId: string, field: string, _value: unknown, _ctx: FlowExecCtx): Promise<void> {
    throw new Error(`Work-order field ${field} cannot be changed by a flow; edit a draft work order.`);
  },
});
