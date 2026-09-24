import { NextResponse } from "next/server";
import { AutomationContractError } from "@openbooks/engine/src/automations/triggers.ts";
import { AutomationServiceError, AutomationVersionConflictError } from "@openbooks/engine/src/automations/services.ts";
import { AutomationExecuteError } from "@openbooks/engine/src/automations/execute.ts";
import { ApprovalPolicyError } from "@openbooks/engine/src/automations/approvals.ts";
import { ActionReasonError } from "@openbooks/engine/src/automations/action-reasons.ts";
import { EventVerbError } from "@openbooks/engine/src/automations/event-verbs.ts";

/**
 * Shared error mapping for /api/automations/* and the HR-16 HRM verb
 * routes. Engine refusals reach the caller with their message intact
 * (the remedy lives in the message) — never a success, never a bare
 * 'internal error' for a computed refusal.
 */
export function automationErrorResponse(e: unknown): NextResponse {
  // A save over a moved recipe is a conflict, never a validation failure:
  // the caller reloads the stored version and re-applies, so the response
  // carries it.
  if (e instanceof AutomationVersionConflictError) {
    return NextResponse.json(
      { error: e.message, code: "automation_stale_version", version: e.currentVersion },
      { status: 409 },
    );
  }
  if (
    e instanceof AutomationContractError ||
    e instanceof AutomationServiceError ||
    e instanceof AutomationExecuteError ||
    e instanceof ApprovalPolicyError ||
    e instanceof ActionReasonError ||
    e instanceof EventVerbError
  ) {
    const message = (e as Error).message;
    const status = /not found/i.test(message) ? 404 : /requires the .* permission/i.test(message) ? 403 : 422;
    return NextResponse.json({ error: message }, { status });
  }
  console.error("[automations] endpoint failed:", e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
