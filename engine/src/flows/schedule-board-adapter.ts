import { sql } from "drizzle-orm";
import { canonicalJson } from "../platform/canonical-json.ts";
import { createHash } from "node:crypto";
import { automaticScheduleDeliverySchema } from "@openbooks/forms-core";
import { db, ambientTenantOrgId } from "../platform/db.ts";
import { tableScope } from "./subject-scope.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
export const scheduleBoardSubjectProfile: FlowSubjectProfile = {
  subjectKind: "schedule_board",
  label: "Schedule board delivery",
  labelKey: "subjects.schedule_board",
  triggers: ["scheduled"],
  actions: ["send_board_schedule"],
  statuses: [
    { value: "active", label: "Active" },
    { value: "archived", label: "Archived" },
  ],
  fields: [
    { key: "id", label: "Board identity", type: "text" },
    { key: "code", label: "Board code", type: "text" },
    { key: "name", label: "Board", type: "text" },
    { key: "rowKind", label: "Row kind", type: "text" },
    { key: "status", label: "Status", type: "enum" },
  ],
};
export const scheduleBoardsFlowAdapter = defineTableSubjectAdapter({
  subjectKind: "schedule_board",
  profile: scheduleBoardSubjectProfile,
  permissions: {
    read: "flows.manage",
    edit: "flows.manage",
    approve: "flows.manage",
  },
  scope: tableScope("column", "schedule_boards", "subsidiary_id"),
  async loadContext(id) {
    const orgId = ambientTenantOrgId();
    if (!orgId)
      throw new Error("Schedule board delivery requires tenant context.");
    const row = (
      await db.execute<Record<string, unknown>>(
        sql`select id,code,name,automatic_delivery_policy as policy,row_kind as "rowKind",case when is_active then 'active' else 'archived' end as status from schedule_boards where org_id=${orgId} and id=${id}`,
      )
    ).rows[0];
    if (!row) return null;
    const { policy, ...values } = row;
    return {
      values: {
        ...values,
        deliveryPolicyVersion: createHash("sha256")
          .update(canonicalJson(policy))
          .digest("hex"),
      },
    };
  },
  async scheduledActorId(id) {
    const orgId = ambientTenantOrgId();
    if (!orgId) throw new Error("Schedule delivery requires tenant context.");
    const policy = (
      await db.execute<{ policy: unknown }>(
        sql`select automatic_delivery_policy as policy from schedule_boards where org_id=${orgId} and id=${id} and is_active`,
      )
    ).rows[0]?.policy;
    if (policy == null) return null;
    return automaticScheduleDeliverySchema.parse(policy).operatorId;
  },
  async findCandidateIds(limit) {
    const orgId = ambientTenantOrgId();
    if (!orgId)
      throw new Error("Schedule board candidates require tenant context.");
    const rows = (
      await db.execute<{ id: string }>(
        sql`select id from schedule_boards where org_id=${orgId} and is_active and row_kind in('people','resources') and automatic_delivery_policy is not null order by id limit ${limit + 1}`,
      )
    ).rows;
    if (rows.length > limit)
      throw new Error(
        "More schedule boards match than the configured native fan-out limit. Increase the limit or narrow the configured board set.",
      );
    return rows.map((r) => r.id);
  },
  label: (_id, values) => String(values.name ?? "Schedule board"),
  deepLink: (id) => `/scheduling?board=${id}`,
  async getStatus(id) {
    const orgId = ambientTenantOrgId();
    if (!orgId) throw new Error("Board status requires tenant context.");
    return (
      (
        await db.execute<{ status: string }>(
          sql`select case when is_active then 'active' else 'archived' end as status from schedule_boards where org_id=${orgId} and id=${id}`,
        )
      ).rows[0]?.status ?? null
    );
  },
  async changeStatus() {
    throw new Error("Manage board status through native Board Settings.");
  },
  async setField() {
    throw new Error("Delivery does not change board configuration.");
  },
});

/** A disabled Flow draft remains explicitly board-bound while its operator reviews timing. */
export function scheduleBoardTimerGraph(
  boardId: string,
  timeZone: string,
  weekdayPreset = false,
): import("@openbooks/forms-core").AutomationGraph {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: "timer",
        position: { x: 0, y: 0 },
        data: {
          kind: "trigger",
          trigger: {
            trigger: "scheduled",
            cron: "0 8 * * 1",
            tz: timeZone,
            ...(weekdayPreset
              ? {
                  clockSchedule: {
                    days: [1, 2, 3, 4, 5],
                    times: ["06:00", "14:30"],
                  },
                }
              : {}),
            select: {
              limit: 1000,
              rule: { op: "eq", field: "id", value: boardId },
            },
          },
        },
      },
      {
        id: "deliver",
        position: { x: 240, y: 0 },
        data: { kind: "action", action: { action: "send_board_schedule" } },
      },
    ],
    edges: [
      { id: "send", source: "timer", target: "deliver", sourceHandle: "next" },
    ],
  };
}
