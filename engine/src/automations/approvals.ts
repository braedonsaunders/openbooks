import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { listUserDelegations } from "../flows/delegations.ts";
import { decideGateAsSystem } from "../flows/gates.ts";
import { loadSubjectSnapshot } from "./registry.ts";
import type { SubjectSnapshot } from "./evaluate.ts";

/**
 * HR-16 exception-only approval — scoring over the EXISTING Flows gates.
 *
 * When automation_approval_settings has exception_only on for a subject
 * kind, the gate for that subject computes a score against the org's
 * thresholds: within thresholds → the gate auto-approves as a SYSTEM
 * decision (decided_by null, audit actor kind 'system') with an audit
 * event that names EVERY threshold checked — never a bare
 * "auto-approved". Outside thresholds → the normal human route is left
 * untouched. auto_approve_when_no_rule covers subjects with no matching
 * approval rule; delegate_after_days seats the existing delegations
 * service (flows/delegations.ts — wired, not re-implemented);
 * exclude_initiator (default true) refuses an approver who initiated.
 *
 * The mechanics of the decision (lock, flip, quorum, resume, release)
 * stay in flows/gates.ts decideGateAsSystem — this module only scores.
 */

export class ApprovalPolicyError extends Error {}

export type ExceptionScore = {
  within: boolean;
  /** Every threshold checked with its configured value and the actual
   *  subject value, for the audit event. Never empty on approve. */
  checked: string[];
  /** Human-readable reasons for each breach (empty when within). */
  breaches: string[];
};

export type ApprovalSettings = {
  exceptionOnly: boolean;
  thresholds: Record<string, unknown>;
  autoApproveWhenNoRule: boolean;
  delegateAfterDays: number | null;
  excludeInitiator: boolean;
};

export async function loadApprovalSettings(
  orgId: string,
  subjectKind: string,
): Promise<ApprovalSettings | null> {
  const rows = await db.execute<ApprovalSettings>(sql`
    select exception_only as "exceptionOnly", thresholds,
           auto_approve_when_no_rule as "autoApproveWhenNoRule",
           delegate_after_days as "delegateAfterDays",
           exclude_initiator as "excludeInitiator"
      from automation_approval_settings
     where org_id = ${orgId} and subject_kind = ${subjectKind}
     limit 1
  `);
  const row = rows.rows[0];
  if (!row) return null;
  return { ...row, thresholds: (row.thresholds as Record<string, unknown>) ?? {} };
}

/**
 * Pure exception scorer. Threshold shapes per subject (brief):
 * timesheet_week {max_hours_per_day, max_week_hours, allow_missing_punch,
 * geo_required}; leave_request {max_days, requires_balance};
 * expense_report {max_amount}. Unknown subject → refusal, never a pass.
 */
export function scoreException(
  subjectKind: string,
  snapshot: SubjectSnapshot,
  thresholds: Record<string, unknown>,
): ExceptionScore {
  const checked: string[] = [];
  const breaches: string[] = [];
  const num = (key: string): number | null => {
    const v = thresholds[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const check = (name: string, threshold: unknown, actual: unknown, ok: boolean, breach: string) => {
    checked.push(`${name}: threshold ${JSON.stringify(threshold)}, actual ${JSON.stringify(actual)}`);
    if (!ok) breaches.push(breach);
  };

  if (subjectKind === "timesheet_week") {
    const maxDay = num("max_hours_per_day");
    const maxWeek = num("max_week_hours");
    if (maxDay === null || maxWeek === null) {
      throw new ApprovalPolicyError(
        "timesheet_week exception scoring needs max_hours_per_day and max_week_hours thresholds — configure them in approval settings before enabling exception-only",
      );
    }
    const weekHours = toNumber(snapshot.fields["total_hours"], "total_hours");
    check("max_week_hours", maxWeek, weekHours, weekHours <= maxWeek, `week total ${weekHours}h exceeds ${maxWeek}h`);
    const dayHours = toNumber(snapshot.fields["max_day_hours"] ?? weekHours, "max_day_hours");
    check("max_hours_per_day", maxDay, dayHours, dayHours <= maxDay, `busiest day ${dayHours}h exceeds ${maxDay}h`);
    if ("allow_missing_punch" in thresholds) {
      const allow = thresholds["allow_missing_punch"] === true;
      const missing = snapshot.fields["missing_punches"];
      check("allow_missing_punch", allow, missing, allow || missing === null || missing === 0 || missing === false,
        "timesheet has missing punches and the policy does not allow them");
    }
    if ("geo_required" in thresholds && thresholds["geo_required"] === true) {
      check("geo_required", true, snapshot.fields["geo_verified"], snapshot.fields["geo_verified"] === true, "geo verification is required and missing");
    }
    return { within: breaches.length === 0, checked, breaches };
  }

  if (subjectKind === "leave_request") {
    const maxDays = num("max_days");
    if (maxDays === null) {
      throw new ApprovalPolicyError(
        "leave_request exception scoring needs a max_days threshold — configure it in approval settings before enabling exception-only",
      );
    }
    const days = toNumber(snapshot.fields["days"] ?? snapshot.fields["hours"], "days");
    check("max_days", maxDays, days, days <= maxDays, `request of ${days} days exceeds ${maxDays} days`);
    if ("requires_balance" in thresholds && thresholds["requires_balance"] === true) {
      check("requires_balance", true, snapshot.fields["has_balance"], snapshot.fields["has_balance"] === true, "no leave balance evidence on the request");
    }
    return { within: breaches.length === 0, checked, breaches };
  }

  if (subjectKind === "expense_report") {
    const maxAmount = num("max_amount");
    if (maxAmount === null) {
      throw new ApprovalPolicyError(
        "expense_report exception scoring needs a max_amount threshold — configure it in approval settings before enabling exception-only",
      );
    }
    const total = toNumber(snapshot.fields["total"], "total");
    check("max_amount", maxAmount, total, total <= maxAmount, `report total ${total} exceeds ${maxAmount}`);
    return { within: breaches.length === 0, checked, breaches };
  }

  throw new ApprovalPolicyError(
    `exception-only approval is not configured for subject '${subjectKind}' — enable it per subject kind with explicit thresholds; unknown subjects never auto-pass`,
  );
}

function toNumber(value: unknown, field: string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new ApprovalPolicyError(
      `exception scoring needs a numeric '${field}' on the subject — the subject snapshot carries none; fix the subject or disable exception-only`,
    );
  }
  return n;
}

/**
 * No-rule disposition (pure): when the org configured no thresholds for
 * the subject, auto_approve_when_no_rule decides — true auto-approves with
 * an audit entry naming the absence of rules, false sends the human route.
 * Non-empty thresholds always score instead; this never overrides a score.
 */
export function decideNoRule(settings: ApprovalSettings): { disposition: "auto_approve_no_rule" | "normal_route"; checked: string[] } {
  if (Object.keys(settings.thresholds).length > 0) return { disposition: "normal_route", checked: [] };
  if (settings.autoApproveWhenNoRule) {
    return {
      disposition: "auto_approve_no_rule",
      checked: ["no thresholds configured — auto_approve_when_no_rule"],
    };
  }
  return { disposition: "normal_route", checked: [] };
}

/**
 * Apply the exception-only policy to one pending gate. Dispositions:
 * 'auto_approved' (within thresholds, system decision with named checks),
 * 'normal_route' (outside thresholds, no-rule without the flag, or policy
 * off — the human gate is untouched), 'no_policy' (no settings row).
 */
export async function applyExceptionOnly(input: {
  orgId: string;
  actorId: string;
  subjectKind: string;
  subjectId: string;
  gateId: string;
  initiatorUserId?: string | null;
}): Promise<{ disposition: "auto_approved" | "normal_route" | "no_policy"; checked: string[] }> {
  return withOrg(input.orgId, async () => {
    const settings = await loadApprovalSettings(input.orgId, input.subjectKind);
    if (!settings) return { disposition: "no_policy", checked: [] };
    if (!settings.exceptionOnly) return { disposition: "normal_route", checked: [] };

    // exclude_initiator: the policy never lets the initiator's own human
    // approval through this path — and the system decision below is not
    // the initiator either. A gate assigned to the initiator while
    // exception-only is on is a configuration refusal, not a silent pass.
    if (settings.excludeInitiator && input.initiatorUserId) {
      const gate = await db.execute<{ assignee: string | null }>(sql`
        select assignee_user_id as assignee from flow_gates
         where org_id = ${input.orgId} and id = ${input.gateId} limit 1
      `);
      if (gate.rows[0]?.assignee === input.initiatorUserId) {
        throw new ApprovalPolicyError(
          "exception-only approval refuses: the pending gate is assigned to the employee who initiated the request, and exclude_initiator is on — reassign the gate or turn exclude_initiator off",
        );
      }
    }

    const noRule = decideNoRule(settings);
    if (noRule.disposition === "auto_approve_no_rule") {
      await decideGateAsSystem({
        gateId: input.gateId,
        reason: `exception-only auto-approval: ${noRule.checked.join(", ")}`,
        checked: noRule.checked,
      });
      return { disposition: "auto_approved", checked: noRule.checked };
    }

    const snapshot = await loadSubjectSnapshot(input.orgId, input.subjectKind, input.subjectId);
    if (!snapshot) {
      throw new ApprovalPolicyError("exception scoring found no subject — the record is gone; the gate stays pending for a human");
    }
    const score = scoreException(input.subjectKind, snapshot, settings.thresholds);
    if (!score.within) return { disposition: "normal_route", checked: score.checked };

    await decideGateAsSystem({
      gateId: input.gateId,
      reason: `exception-only auto-approval: within thresholds (${score.checked.join(", ")})`,
      checked: score.checked,
    });
    return { disposition: "auto_approved", checked: score.checked };
  });
}

/**
 * delegate_after_days: seats the existing delegations service. Returns the
 * delegates currently covering the assignee (empty = no coverage, the gate
 * stays put — delegation never invents authority).
 */
export async function delegationCoverFor(
  orgId: string,
  assigneeUserId: string,
): Promise<{ delegateUserId: string }[]> {
  return withOrg(orgId, async () => {
    const delegations = await listUserDelegations(orgId, assigneeUserId);
    return delegations
      .filter((d) => d.direction === "given" && d.phase === "active")
      .map((d) => ({ delegateUserId: d.toUserId }));
  });
}
