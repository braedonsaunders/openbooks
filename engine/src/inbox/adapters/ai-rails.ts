/**
 * HR-21 AI rails inbox adapters: blocking payroll checks and overdue
 * capability reviews.
 *
 * Both adapters are live reads over the HR-21 ledger tables (migration
 * 0232), projected through the actor's own gates — the inbox never
 * widens visibility. Table presence is probed explicitly through the
 * information schema (never by catching errors): while 0232 has not
 * landed the adapters list nothing and the inbox stays up. Items carry
 * no actions — the work happens in the checks queue (/payroll/anomalies)
 * and the ledger (/admin/ai), which the subject hrefs open.
 */

import { sql } from "drizzle-orm";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { listFlags } from "../../hrm/ai/anomalies.ts";
import { overdueReviews } from "../../hrm/ai/governance.ts";
import { loadAiRailsSettings } from "../../hrm/ai/settings.ts";
import { db } from "../../platform/db.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId } from "../types.ts";
import { InboxError } from "../registry.ts";

async function tableLanded(table: string): Promise<boolean> {
  const found = (await db.execute<{ exists: boolean }>(sql`
    select to_regclass(${`public.${table}`}) is not null as exists
  `)).rows[0]?.exists;
  return found === true;
}

const KIND_LABELS: Record<string, string> = {
  terminated_with_pay: "Terminated with pay",
  duplicate_bank: "Duplicate bank details",
  retro_spike: "Retro spike",
  net_pay_spike: "Net pay spike",
  zero_hours_with_pay: "Zero hours with pay",
  hours_spike: "Hours spike",
  missing_rate: "Missing rate",
  expired_rate: "Expired rate",
  prevailing_wage_missing: "Prevailing wage missing",
  apprentice_ratio_breach: "Apprentice ratio breach",
  benefit_input_orphan: "Benefit input orphan",
  leave_input_orphan: "Leave input orphan",
  negative_balance: "Negative leave balance",
  duplicate_entry: "Duplicate time entry",
  geofence_outside: "Outside geofence",
  unrounded: "Unrounded clock event",
  custom: "Custom",
};

export const payrollAnomalyBlockAdapter: InboxAdapter = {
  kind: "payroll_anomaly_block",
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    if (!(await lockAndCheckOrgFeature(db, ctx.orgId, "hrmPayrollAnomalies"))) return [];
    if (!(await tableLanded("payroll_anomaly_flags"))) return [];
    if (!(await actorHasPermission(db, ctx.orgId, ctx.actorId, "payroll.manage"))) return [];
    // The checks queue owns the read (and its legal-entity lens): the
    // inbox projects the same open blocks the actor may open, never more.
    const rows = (await listFlags(db, {
      orgId: ctx.orgId,
      actorId: ctx.actorId,
      severity: "block",
      status: "open",
    })).slice(0, 20);
    return rows.map((row) => ({
      id: inboxItemId("payroll_anomaly_block", row.id),
      kind: "payroll_anomaly_block",
      title: `Blocking payroll check — ${KIND_LABELS[row.kind] ?? row.kind}`,
      subtitle: `${row.explanation} (period ${row.payPeriodFrom} → ${row.payPeriodTo}) — resolve it before the run can finalize`,
      dueAt: null,
      createdAt: `${row.payPeriodTo}T00:00:00Z`,
      priority: "overdue",
      subjectHref: `/payroll/anomalies?flag=${row.id}`,
      actions: [],
      source: { kind: "payroll_anomaly_flag", id: row.id },
    }));
  },
  async act(_ctx, _sourceId, actionKey): Promise<void> {
    throw new InboxError("UNKNOWN_ACTION", `action ${JSON.stringify(actionKey)} is not available on a blocking check — resolve it in the checks queue`);
  },
};

export const aiCapabilityReviewAdapter: InboxAdapter = {
  kind: "ai_capability_review",
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    if (!(await lockAndCheckOrgFeature(db, ctx.orgId, "aiGovernanceLedger"))) return [];
    if (!(await tableLanded("ai_capabilities"))) return [];
    if (!(await actorHasPermission(db, ctx.orgId, ctx.actorId, "admin.setup.manage"))) return [];
    const settings = await loadAiRailsSettings(db, ctx.orgId);
    const overdue = await overdueReviews(db, ctx.orgId, settings.reviewMonths);
    return overdue.map((cap) => ({
      id: inboxItemId("ai_capability_review", cap.key),
      kind: "ai_capability_review",
      title: `AI capability review due — ${cap.name}`,
      subtitle: cap.lastReviewedAt === null
        ? `never reviewed — the declared cadence is every ${settings.reviewMonths} months`
        : `last reviewed ${cap.lastReviewedAt.slice(0, 10)} — the declared cadence is every ${settings.reviewMonths} months`,
      dueAt: null,
      createdAt: cap.lastReviewedAt ?? `${ctx.asOf}`,
      priority: "due_soon",
      subjectHref: "/admin/ai",
      actions: [],
      source: { kind: "ai_capability", id: cap.key },
    }));
  },
  async act(_ctx, _sourceId, actionKey): Promise<void> {
    throw new InboxError("UNKNOWN_ACTION", `action ${JSON.stringify(actionKey)} is not available on a review nudge — record the review in the ledger`);
  },
};
