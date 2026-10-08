/**
 * Native inbox projections for blocking workforce checks and overdue action reviews.
 * Actor and feature gates retain subject privacy; work stays in its own queue
 * or Setup review surface. Missing source tables yield no items during rollout.
 */

import { listFlags } from "../../hrm/ai/anomalies.ts";
import { overdueReviews } from "../../hrm/ai/governance.ts";
import { loadAiRailsSettings } from "../../hrm/ai/settings.ts";
import { db } from "../../platform/db.ts";
import { actorPermissionOn, orgFeatureOn, sourceTableInstalled } from "../guard.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId } from "../types.ts";
import { InboxError } from "../registry.ts";

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
    if (!(await orgFeatureOn(ctx, "payroll"))) return [];
    if (!(await sourceTableInstalled("payroll_anomaly_flags"))) return [];
    if (!(await actorPermissionOn(ctx, "payroll.manage"))) return [];
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
    if (!(await orgFeatureOn(ctx, "aiGovernanceLedger"))) return [];
    if (!(await sourceTableInstalled("ai_capabilities"))) return [];
    if (!(await actorPermissionOn(ctx, "admin.setup.manage"))) return [];
    const settings = await loadAiRailsSettings(db, ctx.orgId);
    const overdue = await overdueReviews(db, ctx.orgId, settings.reviewMonths);
    return overdue.map((cap) => ({
      id: inboxItemId("ai_capability_review", cap.key),
      kind: "ai_capability_review",
      title: `Assistant action review due — ${cap.name}`,
      subtitle: cap.lastReviewedAt === null
        ? `never reviewed — the declared cadence is every ${settings.reviewMonths} months`
        : `last reviewed ${cap.lastReviewedAt.slice(0, 10)} — the declared cadence is every ${settings.reviewMonths} months`,
      dueAt: null,
      createdAt: cap.lastReviewedAt ?? `${ctx.asOf}`,
      priority: "due_soon",
      subjectHref: "/admin/setup/ai-capabilities",
      actions: [],
      source: { kind: "ai_capability", id: cap.key },
    }));
  },
  async act(_ctx, _sourceId, actionKey): Promise<void> {
    throw new InboxError("UNKNOWN_ACTION", `action ${JSON.stringify(actionKey)} is not available on a review nudge — record the review in Assistant action reviews`);
  },
};
