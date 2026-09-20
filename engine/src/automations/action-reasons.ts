import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { HRM_ACTIONS } from "@openbooks/schema/src/hrm-automations.ts";

/**
 * HR-16 action/reason codes — the Setup-owned vocabulary behind
 * hrm_action_reasons (0227). Reasons are cheap and every enterprise
 * suite has them: the feature defaults ON.
 *
 * When hrmActionReasons is on, the change-request service REQUIRES both
 * action and reason_code on submit and validates the code against this
 * table (active rows only); when off, submit ignores them. A code that
 * requires_comment refuses a blank submission reason — the audit needs
 * the sentence.
 */

export class ActionReasonError extends Error {}

export const actionReasonBody = z.object({
  action: z.enum(HRM_ACTIONS),
  reasonCode: z.string().min(1),
  label: z.string().min(1),
  requiresComment: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export type ActionReasonRow = {
  id: string;
  action: string;
  reasonCode: string;
  label: string;
  requiresComment: boolean;
  isActive: boolean;
};

async function requireManage(orgId: string, actorId: string): Promise<void> {
  const ok = await actorHasPermission(db, orgId, actorId, "hrm.employment.manage");
  if (!ok) {
    throw new ActionReasonError(
      "reason codes require the hrm.employment.manage permission — ask an administrator to grant it in /admin/roles",
    );
  }
}

export async function listActionReasons(
  orgId: string,
  actorId: string,
  action?: string,
): Promise<ActionReasonRow[]> {
  const ok = await actorHasPermission(db, orgId, actorId, "hrm.employment.read");
  if (!ok) {
    throw new ActionReasonError(
      "reason codes require the hrm.employment.read permission — ask an administrator to grant it in /admin/roles",
    );
  }
  return withOrg(orgId, async () => {
    const rows = await db.execute<ActionReasonRow>(sql`
      select id, action, reason_code as "reasonCode", label,
             requires_comment as "requiresComment", is_active as "isActive"
        from hrm_action_reasons
       where org_id = ${orgId}
         and (${action ?? null}::text is null or action = ${action ?? null}::text)
       order by action, reason_code
    `);
    return rows.rows;
  });
}

export async function upsertActionReason(input: {
  orgId: string;
  actorId: string;
  action: string;
  reasonCode: string;
  label: string;
  requiresComment?: boolean;
  isActive?: boolean;
}): Promise<ActionReasonRow> {
  await requireManage(input.orgId, input.actorId);
  const parsed = actionReasonBody.safeParse({
    action: input.action,
    reasonCode: input.reasonCode.trim(),
    label: input.label.trim(),
    requiresComment: input.requiresComment ?? false,
    isActive: input.isActive ?? true,
  });
  if (!parsed.success) {
    throw new ActionReasonError(
      `reason code is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")} — use a known action and a non-blank code and label`,
    );
  }
  return withOrg(input.orgId, async () => {
    const rows = await db.execute<ActionReasonRow>(sql`
      insert into hrm_action_reasons (org_id, action, reason_code, label, requires_comment, is_active, created_by, updated_by)
      values (${input.orgId}, ${parsed.data.action}, ${parsed.data.reasonCode},
              ${parsed.data.label}, ${parsed.data.requiresComment}, ${parsed.data.isActive},
              ${input.actorId}, ${input.actorId})
      on conflict (org_id, action, reason_code)
      do update set label = excluded.label,
                    requires_comment = excluded.requires_comment,
                    is_active = excluded.is_active,
                    updated_by = excluded.updated_by, updated_at = now()
      returning id, action, reason_code as "reasonCode", label,
                requires_comment as "requiresComment", is_active as "isActive"
    `);
    // ON CONFLICT here is the Setup upsert contract (same key = same
    // code, revised label): the conflict is expected and the row is
    // re-read via RETURNING, never silently dropped.
    const row = rows.rows[0];
    if (!row) throw new ActionReasonError("the reason code write matched no row — reload and try again");
    return row;
  });
}

/**
 * Submit-time validation: when the feature is on, both action and
 * reason_code are REQUIRED and the code must be an active row for that
 * action; a requires_comment code needs a non-blank reason. When the
 * feature is off, everything is ignored (never a refusal).
 */
export async function validateSubmitActionReason(input: {
  orgId: string;
  featureOn: boolean;
  action?: string | null;
  reasonCode?: string | null;
  reason?: string | null;
}): Promise<void> {
  if (!input.featureOn) return;
  if (!input.action || !input.reasonCode) {
    throw new ActionReasonError(
      "this org requires an action and a reason code on every change request — pick both in the propose-change dialog and submit again",
    );
  }
  if (!(HRM_ACTIONS as readonly string[]).includes(input.action)) {
    throw new ActionReasonError(
      `unknown HR action '${input.action}' — pick one the reason-code setup declares`,
    );
  }
  const rows = await db.execute<{ requiresComment: boolean }>(sql`
    select requires_comment as "requiresComment" from hrm_action_reasons
     where org_id = ${input.orgId} and action = ${input.action}
       and reason_code = ${input.reasonCode} and is_active
     limit 1
  `);
  if (rows.rows.length === 0) {
    throw new ActionReasonError(
      `reason code '${input.reasonCode}' is not active for action '${input.action}' — pick an active code in the propose-change dialog`,
    );
  }
  if (rows.rows[0]!.requiresComment && !input.reason?.trim()) {
    throw new ActionReasonError(
      `reason code '${input.reasonCode}' requires a written explanation — add the comment and submit again`,
    );
  }
}
